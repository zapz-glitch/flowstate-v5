/**
 * Appraisal Service
 *
 * Evaluates comparables using appraisal rules (filters and adjustments)
 * and calculates ARV based on enabled comparables.
 *
 * ARV Formula (per comp):
 *   adjustedPrice  = salePrice ± appraisal rule adjustments
 *   netPricePerSqft = adjustedPrice / comp.squareFeet
 *   compARV         = netPricePerSqft × subject.squareFeet
 *   ARV             = avg(compARV) across all passing comps
 *
 * This is a data-only service - it does not fetch data, only processes it.
 * Use PropertyApi.getPropertyBundle() to fetch data, then pass to this service.
 */

import type { NormalizedProperty, NormalizedComparable } from '../property-api/types'
import { evaluateComparables } from './evaluator'
import type {
  AppraisalFilter,
  AppraisalAdjustment,
  AppraisalOptions,
  AppraisalResult,
  AppraisedComparable,
  ComparableEvaluation,
} from './types'
import { DEFAULT_FILTERS, DEFAULT_ADJUSTMENTS } from './types'
import type { ClassificationResult } from '../classification'

// Re-export types
export type {
  AppraisalFilter,
  AppraisalAdjustment,
  AppraisalOptions,
  AppraisalResult,
  AppraisedComparable,
  AppraisalRulePreset,
  FilterType,
  AdjustmentType,
} from './types'
export { DEFAULT_FILTERS, DEFAULT_ADJUSTMENTS, FILTER_LABELS, ADJUSTMENT_LABELS } from './types'
export { evaluateComparable, evaluateComparables } from './evaluator'
export { FILTER_RULES } from './filters'
export type { FilterRuleDefinition } from './filters'
export { ADJUSTMENT_RULES } from './adjustments'
export type { AdjustmentRuleDefinition } from './adjustments'

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Maximum comps picked during fallback passes — no cap, use all that pass */
const MAX_FALLBACK_COMPS = Infinity

// ─── Fallback Options ─────────────────────────────────────────────────────────

export interface FallbackOptions {
  /** Minimum number of comps to qualify as "sufficient" for high confidence (default: 3) */
  minComps?: number
}

// ─── Classification Summary ───────────────────────────────────────────────────

/**
 * Result of summarizing comp classifications alongside ARV.
 * Classifications label comps for display; ARV is computed by the formula above.
 */
export interface ClassificationSummaryResult {
  /** IDs of comps classified as as_is */
  asIsCompIds: string[]
  /** IDs of comps classified as after_renovation */
  afterRenovationCompIds: string[]
  /** Simple average price of as-is comps (current market value) */
  asIsValue: number | null
  /** Simple average price of after-renovation comps */
  afterRenovationValue: number | null
  /** Spread between after-renovation and as-is values */
  spread: number | null
  /** ARV methodology description */
  methodology: string
}

// ─── Service Interface ─────────────────────────────────────────────────────────

export interface AppraisalService {
  /**
   * Evaluate comparables against a subject property using appraisal rules.
   * All comps that pass filters are enabled. Users can enable/disable freely.
   */
  evaluate(
    subject: NormalizedProperty,
    comparables: NormalizedComparable[],
    options?: AppraisalOptions
  ): AppraisalResult

  /**
   * Evaluate comparables with automatic 3-pass fallback.
   *
   * Pass 1 — Full filters (including subdivision match), up to 3 comps:
   *   If 1+ comps pass, use up to 3 best (highest filter-pass rate, closest).
   *
   * Pass 2 — Relax subdivision, keep all other filters:
   *   Sort by distance, use up to 3 nearest comps.
   *
   * Pass 3 — Triple the numeric filter thresholds (sale_age × 3, sqft_diff × 3,
   *   year_built_diff × 3, distance × 3), no subdivision filter:
   *   Use up to 3 best comps from expanded search area.
   *
   * No comps — fallbackUsed: 'no_comps'. Caller should treat as a bad deal.
   *
   * ARV = avg(adjustedPrice/compSqft × subjectSqft) across selected comps
   *
   * @returns AppraisalResultWithFallback with fallbackUsed and confidence fields
   */
  evaluateWithFallback(
    subject: NormalizedProperty,
    comparables: NormalizedComparable[],
    options?: AppraisalOptions & FallbackOptions
  ): AppraisalResultWithFallback

  /**
   * Calculate ARV from appraised comparables.
   * Formula: avg(adjustedPrice / comp.squareFeet) × subject.squareFeet
   */
  calculateARV(comparables: AppraisedComparable[], subjectSqft?: number | null): number

  /**
   * Summarize classifications for enabled comps.
   * Labels comps as as_is or after_renovation and computes simple group averages.
   * ARV itself comes from evaluateWithFallback.
   */
  summarizeClassifications(
    comparables: AppraisedComparable[],
    compClassifications: Map<string, ClassificationResult>
  ): ClassificationSummaryResult

  /**
   * Get default filters
   */
  getDefaultFilters(): AppraisalFilter[]

  /**
   * Get default adjustments
   */
  getDefaultAdjustments(): AppraisalAdjustment[]
}

export interface AppraisalResultWithFallback extends AppraisalResult {
  /** Indicates which fallback strategy was used, if any */
  fallbackUsed: 'none' | 'no_subdivision' | 'relaxed_filters' | 'no_comps'
  /** Message explaining the fallback */
  fallbackReason?: string
  /**
   * Confidence score for the ARV (0-100).
   * High (80-100): 3 comps, full filters passed.
   * Medium (50-79): 1-2 comps full filters, or subdivision relaxed.
   * Low (20-49): relaxed / tripled filters used.
   * Zero (0): no comps matched anything — bad deal.
   */
  confidence: number
}

// ─── Implementation ────────────────────────────────────────────────────────────

class PropertyAppraisalService implements AppraisalService {
  evaluate(
    subject: NormalizedProperty,
    comparables: NormalizedComparable[],
    options?: AppraisalOptions
  ): AppraisalResult {
    const filters = options?.filters ?? DEFAULT_FILTERS
    const adjustments = options?.adjustments ?? DEFAULT_ADJUSTMENTS

    const evaluations = evaluateComparables(subject, comparables, filters, adjustments)

    // Build appraised comparables with enable/disable state based on rules
    const appraisedComps: AppraisedComparable[] = comparables.map((comp) => {
      const evaluation = evaluations.get(comp.id) as ComparableEvaluation

      return {
        ...comp,
        evaluation,
        isEnabled: !evaluation.shouldDisable,
        adjustedSalePrice: evaluation.adjustedPrice,
      }
    })

    sortBySubdivisionThenDistance(appraisedComps)

    // All comps that pass filters stay enabled — users can enable/disable freely
    const enabledComps = appraisedComps.filter((c) => c.isEnabled)
    const arv = this.calculateARV(enabledComps, subject.squareFeet)
    const { avgPricePerSqft, medianSalePrice } = calculateStats(enabledComps, arv)

    return {
      subject,
      comparables: appraisedComps,
      enabledCount: enabledComps.length,
      disabledCount: appraisedComps.length - enabledComps.length,
      appliedFilters: filters,
      appliedAdjustments: adjustments,
      arv,
      avgPricePerSqft,
      medianSalePrice,
    }
  }

  evaluateWithFallback(
    subject: NormalizedProperty,
    comparables: NormalizedComparable[],
    options?: AppraisalOptions & FallbackOptions
  ): AppraisalResultWithFallback {
    const minCompsForHighConfidence = options?.minComps ?? 3
    const adjustments = options?.adjustments ?? DEFAULT_ADJUSTMENTS
    const defaultFilters = options?.filters ?? DEFAULT_FILTERS

    // ── Pass 1: Full filters including subdivision match ──────────────────────
    const result1 = this.evaluate(subject, comparables, { filters: defaultFilters, adjustments })

    if (result1.enabledCount >= 1) {
      const confidence = result1.enabledCount >= minCompsForHighConfidence ? 90
        : result1.enabledCount === 2 ? 70
        : 55 // 1 comp
      return {
        ...result1,
        fallbackUsed: 'none',
        confidence,
      }
    }

    // ── Pass 2: Relax subdivision, keep all other filters ─────────────────────
    // Score every comp by how many non-subdivision rules it satisfies, pick best 3.
    const filtersNoSubdivision = defaultFilters.map((f) =>
      f.type === 'subdivision_match' ? { ...f, enabled: false } : f
    )
    const result2 = this.evaluateRaw(subject, comparables, filtersNoSubdivision, adjustments)
    const pass2Picked = pickBestCompsByRuleMatch(result2, MAX_FALLBACK_COMPS, defaultFilters)

    if (pass2Picked.length >= 1) {
      const pickedResult = buildResultFromPicked(
        subject, result2, pass2Picked, filtersNoSubdivision, adjustments, this.calculateARV.bind(this)
      )
      const enabledCount = pass2Picked.length
      const confidence = enabledCount >= minCompsForHighConfidence ? 65
        : enabledCount === 2 ? 50
        : 40
      return {
        ...pickedResult,
        fallbackUsed: 'no_subdivision',
        fallbackReason: `No comps matched subdivision "${subject.subdivision || 'unknown'}". Using ${enabledCount} best-matching comp${enabledCount !== 1 ? 's' : ''} (by filter-pass count) from surrounding area.`,
        confidence,
      }
    }

    // ── Pass 3: Triple numeric thresholds, no subdivision ────────────────────
    // Score every comp by how many tripled-threshold rules it satisfies, pick best 3.
    const relaxedFilters = defaultFilters.map((f) => {
      if (f.type === 'subdivision_match') return { ...f, enabled: false }
      if (
        f.type === 'sale_age' ||
        f.type === 'sqft_diff' ||
        f.type === 'year_built_diff' ||
        f.type === 'distance'
      ) {
        return { ...f, value: f.value * 3 }
      }
      return f
    })
    const result3 = this.evaluateRaw(subject, comparables, relaxedFilters, adjustments)
    const pass3Picked = pickBestCompsByRuleMatch(result3, MAX_FALLBACK_COMPS, relaxedFilters)

    if (pass3Picked.length >= 1) {
      const pickedResult = buildResultFromPicked(
        subject, result3, pass3Picked, relaxedFilters, adjustments, this.calculateARV.bind(this)
      )
      const enabledCount = pass3Picked.length
      const confidence = enabledCount >= minCompsForHighConfidence ? 35
        : enabledCount === 2 ? 25
        : 20
      return {
        ...pickedResult,
        fallbackUsed: 'relaxed_filters',
        fallbackReason: `No comps matched standard criteria. Using ${enabledCount} best-matching comp${enabledCount !== 1 ? 's' : ''} with tripled filter thresholds (sale age, sqft, year built, distance).`,
        confidence,
      }
    }

    // ── No comps — no matching comps at any filter level ─────────────────────
    // Build a zero-ARV result with all comps disabled for context
    sortBySubdivisionThenDistance(result3)
    return {
      subject,
      comparables: result3,
      enabledCount: 0,
      disabledCount: result3.length,
      appliedFilters: relaxedFilters,
      appliedAdjustments: adjustments,
      arv: 0,
      avgPricePerSqft: null,
      medianSalePrice: null,
      fallbackUsed: 'no_comps',
      fallbackReason: `No comparable sales found for "${subject.subdivision || subject.address}" even with relaxed criteria. Insufficient data to determine ARV.`,
      confidence: 0,
    }
  }

  calculateARV(comparables: AppraisedComparable[], subjectSqft?: number | null): number {
    const enabled = comparables.filter((c) => c.isEnabled)

    // Per-comp ARV: (adjustedPrice / comp.squareFeet) × subject.squareFeet
    // Then average across all enabled comps
    const compArvValues: number[] = []
    for (const comp of enabled) {
      const adjustedPrice = comp.adjustedSalePrice ?? comp.salePrice
      const compSqft = comp.squareFeet
      if (adjustedPrice != null && adjustedPrice > 0 && compSqft != null && compSqft > 0) {
        const netPricePerSqft = adjustedPrice / compSqft
        // Use subject sqft for the comp ARV projection; fall back to comp sqft if not available
        const targetSqft = subjectSqft && subjectSqft > 0 ? subjectSqft : compSqft
        compArvValues.push(netPricePerSqft * targetSqft)
      }
    }

    if (compArvValues.length === 0) return 0

    const avgArv = compArvValues.reduce((sum, v) => sum + v, 0) / compArvValues.length
    return Math.round(avgArv)
  }

  /**
   * Evaluate all comps against filters/adjustments WITHOUT capping at MAX_FALLBACK_COMPS.
   * Returns the raw appraised comp array — used by fallback passes before picking best comps.
   */
  evaluateRaw(
    subject: NormalizedProperty,
    comparables: NormalizedComparable[],
    filters: AppraisalFilter[],
    adjustments: AppraisalAdjustment[]
  ): AppraisedComparable[] {
    const evaluations = evaluateComparables(subject, comparables, filters, adjustments)
    return comparables.map((comp) => {
      const evaluation = evaluations.get(comp.id) as ComparableEvaluation
      return {
        ...comp,
        evaluation,
        isEnabled: !evaluation.shouldDisable,
        adjustedSalePrice: evaluation.adjustedPrice,
      }
    })
  }

  getDefaultFilters(): AppraisalFilter[] {
    return [...DEFAULT_FILTERS]
  }

  getDefaultAdjustments(): AppraisalAdjustment[] {
    return [...DEFAULT_ADJUSTMENTS]
  }

  /**
   * Summarize comp classifications for display.
   * Labels each comp as as_is or after_renovation and computes simple group averages.
   * Does NOT affect ARV — that is computed by evaluateWithFallback.
   */
  summarizeClassifications(
    comparables: AppraisedComparable[],
    compClassifications: Map<string, ClassificationResult>
  ): ClassificationSummaryResult {
    const enabledComps = comparables.filter((c) => c.isEnabled)
    const asIsCompIds: string[] = []
    const afterRenovationCompIds: string[] = []

    for (const comp of enabledComps) {
      const cls = compClassifications.get(comp.id)?.classification ?? 'as_is'
      if (cls === 'as_is') {
        asIsCompIds.push(comp.id)
      } else {
        afterRenovationCompIds.push(comp.id)
      }
    }

    // Simple average adjusted price for each group
    const avgPrice = (ids: string[]): number | null => {
      const prices = ids
        .map((id) => enabledComps.find((c) => c.id === id))
        .map((c) => c?.adjustedSalePrice ?? c?.salePrice)
        .filter((p): p is number => p != null && p > 0)
      return prices.length > 0 ? Math.round(prices.reduce((s, p) => s + p, 0) / prices.length) : null
    }

    const asIsValue = avgPrice(asIsCompIds)
    const afterRenovationValue = avgPrice(afterRenovationCompIds)
    const spread =
      asIsValue !== null && afterRenovationValue !== null
        ? afterRenovationValue - asIsValue
        : null

    const methodology = `avg(adjustedPrice/compSqft × subjectSqft) across ${enabledComps.length} comp${enabledComps.length !== 1 ? 's' : ''}`

    return { asIsCompIds, afterRenovationCompIds, asIsValue, afterRenovationValue, spread, methodology }
  }
}

// ─── Helper Functions ──────────────────────────────────────────────────────────

/**
 * Pick the best N comps from a list of enabled comps.
 * Sorts by: subdivision match first, then highest filter-pass rate, then closest distance.
 */
function pickBestComps(enabledComps: AppraisedComparable[], max: number): AppraisedComparable[] {
  const scored = enabledComps.map((comp) => {
    const filters = comp.evaluation.filterResults
    const passRate = filters.length > 0
      ? filters.filter((f) => f.passed).length / filters.length
      : 1
    const subMatch = filters.find((f) => f.type === 'subdivision_match')?.passed ?? false
    return { comp, passRate, subMatch, distance: comp.distanceMiles ?? 999 }
  })

  scored.sort((a, b) => {
    // Subdivision match first
    if (a.subMatch && !b.subMatch) return -1
    if (!a.subMatch && b.subMatch) return 1
    // Then by pass rate (descending)
    if (b.passRate !== a.passRate) return b.passRate - a.passRate
    // Then by distance (ascending)
    return a.distance - b.distance
  })

  return scored.slice(0, max).map((s) => s.comp)
}

/**
 * For fallback passes: score each comp by how many of the active filter rules it satisfies
 * (ignoring subdivision_match), then pick the top N by: rules passed desc → distance asc.
 *
 * @param allComps    - raw evaluated comps (isEnabled may be false for some)
 * @param max         - maximum number of comps to return
 * @param activeFilters - the filter set used to evaluate (for counting non-subdivision rules)
 */
function pickBestCompsByRuleMatch(
  allComps: AppraisedComparable[],
  max: number,
  activeFilters: AppraisalFilter[]
): AppraisedComparable[] {
  // Count non-subdivision rules that are enabled — these are what we score against
  const scorableTypes = new Set(
    activeFilters
      .filter((f) => f.enabled && f.type !== 'subdivision_match')
      .map((f) => f.type)
  )

  const scored = allComps.map((comp) => {
    const passed = comp.evaluation.filterResults.filter(
      (r) => scorableTypes.has(r.type) && r.passed
    ).length
    return { comp, passed, distance: comp.distanceMiles ?? 999 }
  })

  // Sort: most rules passed first, then nearest
  scored.sort((a, b) => {
    if (b.passed !== a.passed) return b.passed - a.passed
    return a.distance - b.distance
  })

  return scored.slice(0, max).map((s) => s.comp)
}

/**
 * Build an AppraisalResult-shaped object from a specific set of hand-picked comps.
 * All picked comps are marked enabled; all others disabled.
 */
function buildResultFromPicked(
  subject: NormalizedProperty,
  allComps: AppraisedComparable[],
  pickedComps: AppraisedComparable[],
  appliedFilters: AppraisalFilter[],
  appliedAdjustments: AppraisalAdjustment[],
  calculateARV: (comps: AppraisedComparable[], sqft?: number | null) => number
): AppraisalResult {
  const pickedIds = new Set(pickedComps.map((c) => c.id))

  // Clone array marking only picked comps as enabled
  const comparables = allComps.map((c) => ({
    ...c,
    isEnabled: pickedIds.has(c.id),
  }))

  // Sort: picked (enabled) first by distance, then disabled by distance
  comparables.sort((a, b) => {
    if (a.isEnabled && !b.isEnabled) return -1
    if (!a.isEnabled && b.isEnabled) return 1
    return (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999)
  })

  const enabledComps = comparables.filter((c) => c.isEnabled)
  const arv = calculateARV(enabledComps, subject.squareFeet)
  const { avgPricePerSqft, medianSalePrice } = calculateStats(enabledComps, arv)

  return {
    subject,
    comparables,
    enabledCount: enabledComps.length,
    disabledCount: comparables.length - enabledComps.length,
    appliedFilters,
    appliedAdjustments,
    arv,
    avgPricePerSqft,
    medianSalePrice,
  }
}

/**
 * Sort comparables: subdivision matches first, then by distance.
 * Mutates the array in place.
 */
function sortBySubdivisionThenDistance(comps: AppraisedComparable[]): void {
  comps.sort((a, b) => {
    const aSubMatch = a.evaluation.filterResults.find((f) => f.type === 'subdivision_match')?.passed ?? false
    const bSubMatch = b.evaluation.filterResults.find((f) => f.type === 'subdivision_match')?.passed ?? false

    if (aSubMatch && !bSubMatch) return -1
    if (!aSubMatch && bSubMatch) return 1

    return (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999)
  })
}

/**
 * Calculate stats (avgPricePerSqft, medianSalePrice) from enabled comparables.
 */
function calculateStats(
  enabledComps: AppraisedComparable[],
  arv: number
): { avgPricePerSqft: number | null; medianSalePrice: number | null } {
  const enabledPrices = enabledComps
    .map((c) => c.adjustedSalePrice ?? c.salePrice)
    .filter((p): p is number => p != null && p > 0)

  // Average $/sqft across enabled comps (each comp's adjustedPrice / compSqft)
  const compPricesPerSqft = enabledComps
    .map((c) => {
      const price = c.adjustedSalePrice ?? c.salePrice
      const sqft = c.squareFeet
      return price != null && price > 0 && sqft != null && sqft > 0 ? price / sqft : null
    })
    .filter((v): v is number => v != null)

  const avgPricePerSqft = compPricesPerSqft.length > 0
    ? Math.round(compPricesPerSqft.reduce((a, b) => a + b, 0) / compPricesPerSqft.length)
    : null

  const medianSalePrice = enabledPrices.length > 0 ? calculateMedian(enabledPrices) : null

  return { avgPricePerSqft, medianSalePrice }
}

function calculateMedian(values: number[]): number {
  if (values.length === 0) return 0

  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)

  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1] + sorted[mid]) / 2)
  }

  return sorted[mid]
}

// ─── Factory Function ──────────────────────────────────────────────────────────

/**
 * Create a new appraisal service instance.
 * No dependencies required - this is a pure data processing service.
 */
export function createAppraisalService(): AppraisalService {
  return new PropertyAppraisalService()
}
