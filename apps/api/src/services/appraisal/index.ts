/**
 * Appraisal Service
 *
 * Evaluates comparables using appraisal rules (filters and adjustments)
 * and calculates ARV based on enabled comparables.
 *
 * This is a data-only service - it does not fetch data, only processes it.
 * Use PropertyApi.getPropertyBundle() to fetch data, then pass to this service.
 *
 * Usage:
 *   import { createAppraisalService } from '../services/appraisal'
 *
 *   const appraisal = createAppraisalService()
 *
 *   // Evaluate comparables
 *   const result = appraisal.evaluate(property, comparables, {
 *     filters: [...],
 *     adjustments: [...]
 *   })
 */

import type { NormalizedProperty, NormalizedComparable } from '../property-api/types'
import { evaluateComparables, evaluateComparable, neighborhoodsMatch } from './evaluator'
import type {
  AppraisalFilter,
  AppraisalAdjustment,
  AppraisalOptions,
  AppraisalResult,
  AppraisedComparable,
  ComparableEvaluation,
  ExpansionPolicy,
} from './types'
import { DEFAULT_FILTERS, DEFAULT_ADJUSTMENTS, DEFAULT_EXPANSION_POLICY } from './types'
import type { ClassificationResult, PropertyClassification } from '../classification'

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
  ExpansionPolicy,
} from './types'
export { DEFAULT_FILTERS, DEFAULT_ADJUSTMENTS, DEFAULT_EXPANSION_POLICY, defaultFilterPriority } from './types'
export { evaluateComparable, evaluateComparables } from './evaluator'
// Note: WeightFactors, CompWeightBreakdown, WeightedARVResult are defined below and exported from this file

// Note: FallbackOptions and AppraisalResultWithFallback are exported via interface definitions below

// ─── Fallback Options ─────────────────────────────────────────────────────────

export interface FallbackOptions {
  /** Minimum number of comps required before trying fallback */
  minComps?: number
  /** Maximum comps to use when falling back to nearest */
  maxNearestComps?: number
}

// ─── Weighted ARV Types ───────────────────────────────────────────────────────

/**
 * Weight factors for individual comp scoring
 *
 * Expert Underwriter Methodology:
 * - Comps matching subject condition (As-Is or After-Renovation) are PRIMARY
 * - Transitional comps provide supporting data
 * - Opposite-condition comps are used for spread analysis only
 */
export interface WeightFactors {
  /** Distance factor (0.3-2.0) - closer = better */
  distance: number
  /** Sqft similarity factor (0.5-1.5) */
  sqftSimilarity: number
  /** Recency factor (0.6-1.4) - more recent = better */
  recency: number
  /** Classification match factor (0.0-2.0) - KEY FACTOR */
  classificationMatch: number
  /** Classification confidence (0.8-1.2) */
  confidenceBonus: number
  /** Appraisal filter pass rate bonus (0.5-1.5) */
  filterPassRate: number
}

export interface CompWeightBreakdown {
  compId: string
  price: number
  weight: number
  normalizedWeight: number
  factors: WeightFactors
  classification?: PropertyClassification
  /** Whether this comp is a primary match (same classification as subject) */
  isPrimaryMatch: boolean
  /** Tier: 1=same classification, 2=transitional, 3=opposite */
  tier: 1 | 2 | 3
}

/**
 * Investment scenario breakdown
 * Provides different values for different investment strategies
 */
export interface InvestmentScenario {
  /** Strategy type */
  strategy: 'flip' | 'rental' | 'wholesale'
  /** Target ARV for this strategy */
  targetArv: number
  /** Recommended comps for this strategy */
  recommendedCompIds: string[]
  /** Confidence level (0-100) */
  confidence: number
  /** Notes for underwriter */
  notes: string
}

export interface WeightedARVResult {
  /** Final ARV (weighted by classification match and data quality) */
  arv: number
  /** As-Is value (weighted average of as_is comps) */
  asIsValue: number | null
  /** After-Renovation value (weighted average of after_renovation comps) */
  afterRenovationValue: number | null
  /** Spread between As-Is and After-Renovation */
  spread: number | null
  /** Weight breakdown for each comp */
  weightBreakdown: CompWeightBreakdown[]
  /** IDs of comps classified as as_is */
  asIsCompIds: string[]
  /** IDs of comps classified as after_renovation */
  afterRenovationCompIds: string[]
  /** IDs of transitional comps */
  transitionalCompIds: string[]
  /** ID of the best matching comp (highest weight in subject's tier) */
  bestCompId: string | null
  /** Investment scenarios for different strategies */
  scenarios: InvestmentScenario[]
  /** Underwriter notes */
  methodology: string
}

// ─── Service Interface ─────────────────────────────────────────────────────────

export interface AppraisalService {
  /**
   * Evaluate comparables against a subject property using appraisal rules.
   * This is the main method - takes already-fetched data and applies filters/adjustments.
   */
  evaluate(
    subject: NormalizedProperty,
    comparables: NormalizedComparable[],
    options?: AppraisalOptions
  ): AppraisalResult

  /**
   * Evaluate comparables with automatic fallback when no comps pass filters.
   *
   * Fallback strategy:
   * 1. Try with default filters (including subdivision match)
   * 2. If no comps pass, disable subdivision_match and retry
   * 3. If still no comps, use nearest comps by distance
   *
   * @returns AppraisalResult with fallbackUsed flag indicating which strategy was used
   */
  evaluateWithFallback(
    subject: NormalizedProperty,
    comparables: NormalizedComparable[],
    options?: AppraisalOptions & FallbackOptions
  ): AppraisalResultWithFallback

  /**
   * Calculate ARV from appraised comparables
   */
  calculateARV(comparables: AppraisedComparable[]): number

  /**
   * Calculate weighted ARV based on property classifications
   *
   * Uses multiple factors to weight each comp:
   * - Distance to subject
   * - Sqft similarity
   * - Sale recency
   * - Classification match (as_is vs after_renovation)
   */
  calculateWeightedARV(
    subject: NormalizedProperty,
    comparables: AppraisedComparable[],
    subjectClassification: ClassificationResult,
    compClassifications: Map<string, ClassificationResult>
  ): WeightedARVResult

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
  fallbackUsed:
    | 'none'
    | 'year_built_expansion'
    | 'neighborhood_expansion'
    | 'subdivision_expansion'
    | 'geographic_expansion'
    | 'nearest_comps'
    | 'insufficient'
  /** Message explaining the fallback */
  fallbackReason?: string
}

/** Number of valid comps required for ARV (classical appraisal model) */
const REQUIRED_ARV_COMPS = 3

/**
 * Top-of-market band: only eligible comps priced within this fraction of the
 * highest-priced eligible comp may drive ARV. Guards against as-is /
 * original-condition sales dragging ARV down when vision can't verify
 * condition — price is the proxy for ARV-spec condition.
 */
const ARV_PRICE_BAND_PCT = 0.10

// ─── Implementation ────────────────────────────────────────────────────────────

class PropertyAppraisalService implements AppraisalService {
  /**
   * Mark ARV selection status and compute ARV from the accepted comps.
   *
   * ARV selection stops at the REQUIRED_ARV_COMPS highest-priced valid
   * comps. Eligible comps beyond the third are NOT_EXAMINED_FOR_ARV.
   * ARV = mean adjusted $/sqft of selected comps × subject sqft
   * (falls back to mean adjusted price when sqft data is missing).
   */
  private selectArvComps(
    subject: NormalizedProperty,
    appraisedComps: AppraisedComparable[]
  ): { comparables: AppraisedComparable[]; selected: AppraisedComparable[]; eligible: AppraisedComparable[]; arv: number } {
    const eligible = appraisedComps.filter((c) => {
      const price = c.adjustedSalePrice ?? c.salePrice
      return c.isEnabled && price != null && price > 0
    })

    // Top-of-market band — drop eligible comps priced below 90% of the best
    // eligible comp. When condition can't be verified (no vision), price is
    // the signal that a comp is renovated/ARV-spec rather than as-is.
    const compPrice = (c: AppraisedComparable) => c.adjustedSalePrice ?? c.salePrice ?? 0
    const topPrice = eligible.reduce((m, c) => Math.max(m, compPrice(c)), 0)
    const banded = eligible.filter((c) => compPrice(c) >= topPrice * (1 - ARV_PRICE_BAND_PCT))

    // Best apples-to-apples first: comps with more verified match passes
    // (status 'passed') outrank comps that slid through on missing data
    // ('not_verified'). Then most-recent sale wins — sale age is an
    // absolute rule, so recency is the ranking signal — and adjusted
    // price breaks the final tie.
    const verifiedPasses = (c: AppraisedComparable) =>
      c.evaluation.filterResults.filter((r) => r.status === 'passed').length
    const saleTime = (c: AppraisedComparable) =>
      c.saleDate ? new Date(c.saleDate).getTime() : 0
    const sorted = [...banded].sort((a, b) => {
      const diff = verifiedPasses(b) - verifiedPasses(a)
      if (diff !== 0) return diff
      const recency = saleTime(b) - saleTime(a)
      if (recency !== 0) return recency
      return (
        (b.adjustedSalePrice ?? b.salePrice ?? 0) -
        (a.adjustedSalePrice ?? a.salePrice ?? 0)
      )
    })
    const selected = sorted.slice(0, REQUIRED_ARV_COMPS)
    const selectedIds = new Set(selected.map((c) => c.id))

    const comparables = appraisedComps.map((c) => ({
      ...c,
      arvStatus: !c.isEnabled
        ? ('disqualified' as const)
        : selectedIds.has(c.id)
          ? ('selected' as const)
          : ('not_examined' as const),
    }))

    // ARV via adjusted $/sqft when sqft data exists on every selected comp
    // and the subject; otherwise mean adjusted price.
    let arv = 0
    const canUsePpsf =
      subject.squareFeet != null &&
      subject.squareFeet > 0 &&
      selected.length > 0 &&
      selected.every((c) => c.squareFeet != null && c.squareFeet > 0)

    if (canUsePpsf) {
      const meanPpsf =
        selected.reduce(
          (sum, c) =>
            sum + (c.adjustedSalePrice ?? c.salePrice ?? 0) / (c.squareFeet as number),
          0
        ) / selected.length
      arv = Math.round(meanPpsf * (subject.squareFeet as number))
    } else if (selected.length > 0) {
      arv = Math.round(
        selected.reduce((sum, c) => sum + (c.adjustedSalePrice ?? c.salePrice ?? 0), 0) /
          selected.length
      )
    }

    return { comparables, selected, eligible, arv }
  }

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

    // ARV comp selection: top-3 highest-priced valid, early stop
    const { comparables: marked, selected, eligible, arv } = this.selectArvComps(subject, appraisedComps)
    const enabledComps = marked.filter((c) => c.isEnabled)

    const enabledPrices = enabledComps
      .map((c) => c.adjustedSalePrice ?? c.salePrice)
      .filter((p): p is number => p != null && p > 0)

    const selectedSqfts = selected
      .map((c) => c.squareFeet)
      .filter((s): s is number => s != null && s > 0)

    const avgPricePerSqft =
      selected.length > 0 && selectedSqfts.length === selected.length
        ? Math.round(
            selected.reduce(
              (sum, c) => sum + (c.adjustedSalePrice ?? c.salePrice ?? 0) / (c.squareFeet as number),
              0
            ) / selected.length
          )
        : null

    const medianSalePrice = enabledPrices.length > 0 ? calculateMedian(enabledPrices) : null

    return {
      subject,
      comparables: marked,
      enabledCount: enabledComps.length,
      disabledCount: marked.length - enabledComps.length,
      appliedFilters: filters,
      appliedAdjustments: adjustments,
      arv,
      avgPricePerSqft,
      medianSalePrice,
      selectedCompIds: selected.map((c) => c.id),
      // Fewer than REQUIRED_ARV_COMPS verified comps is insufficient — thin
      // sets must trigger the expansion fallbacks (geography → older sales →
      // nearest) rather than silently anchoring ARV on 1–2 sales.
      insufficientComps: eligible.length < REQUIRED_ARV_COMPS,
    }
  }

  evaluateWithFallback(
    subject: NormalizedProperty,
    comparables: NormalizedComparable[],
    options?: AppraisalOptions & FallbackOptions
  ): AppraisalResultWithFallback {
    const adjustments = options?.adjustments ?? DEFAULT_ADJUSTMENTS
    const expansion: Required<ExpansionPolicy> = {
      ...DEFAULT_EXPANSION_POLICY,
      ...(options?.expansion ?? {}),
    }

    // Step 1: Strict rules — never silently weakened
    const defaultFilters = options?.filters ?? DEFAULT_FILTERS
    const result1 = this.evaluate(subject, comparables, {
      filters: defaultFilters,
      adjustments,
    })

    if (!result1.insufficientComps) {
      console.log(`Appraisal: ${result1.selectedCompIds?.length} comps selected under strict rules`)
      return { ...result1, fallbackUsed: 'none' }
    }

    if (!expansion.enabled) {
      console.log(`Appraisal: ${result1.selectedCompIds?.length ?? 0} valid comps — INSUFFICIENT_COMPS (expansion disabled)`)
      return {
        ...result1,
        fallbackUsed: 'insufficient',
        fallbackReason: `Only ${result1.selectedCompIds?.length ?? 0} comps passed appraisal rules; expansion policy disabled.`,
      }
    }

    // Steps 2+: every tier keeps the FULL rule set evaluated so the per-comp
    // audit trail never disappears — a comp always shows exactly which rules
    // passed, failed, or were unverifiable at that tier's thresholds.
    //
    // Ladder (each tier requires ≥REQUIRED_ARV_COMPS selected):
    //   1. strict rules (done above)
    //   2. widen year_built INSIDE the subdivision — ±10 → ±12 → ±14
    //   3. verified same-NEIGHBORHOOD comps (name/code) at strict radius,
    //      year ladder restarts — subdivision_match may be rescued
    //   4. leave the subdivision (radius ×mult), re-walking the year ladder
    //   5. drop the radius gate entirely, re-walking the year ladder
    //   6. most recent sales — only location failures may be carried
    //
    // sale_age is NEVER relaxed: every comp must be within the configured
    // max (default 180d) at every tier — the most recent sales win. Older
    // qualifying sales get the configurable old_comp_discount adjustment
    // (threshold + percent live on the adjustment, not this policy).
    // Year-widening is a real threshold change, not a rescue: a comp at
    // ±12 passes year_built_diff with threshold:12 on its audit record.

    const strictYear = defaultFilters.find((f) => f.type === 'year_built_diff')?.value ?? 10
    const yearSteps = expansion.allowYearBuiltExpansion
      ? expansion.yearBuiltExpansionSteps.map((s) => strictYear + s)
      : []
    const yearLadder = [strictYear, ...yearSteps]
    const maxYear = yearLadder[yearLadder.length - 1]
    const subdivisionName = subject.subdivision || subject.neighborhoodName || 'subject area'

    const filtersAt = (yearLimit: number, distanceMult = 1) =>
      defaultFilters.map((f) => {
        if (f.type === 'year_built_diff') return { ...f, value: yearLimit }
        if (f.type === 'distance' && distanceMult !== 1) {
          return { ...f, value: f.value * distanceMult }
        }
        return f
      })
    const yearNote = (yearLimit: number) =>
      yearLimit > strictYear ? ` (year-built widened to ±${yearLimit}yr)` : ''
    const appliedFor = (
      yearLimit: number,
      scope: 'subdivision' | 'neighborhood' | 'geographic' | null
    ): NonNullable<AppraisalResult['expansionApplied']> => {
      const applied: NonNullable<AppraisalResult['expansionApplied']> = []
      if (yearLimit > strictYear) applied.push('year_built')
      if (scope) applied.push(scope)
      return applied
    }

    // Rescue helper: force-enable disabled comps whose hard failures are all
    // in `allowed` (and that satisfy `extra` when given), then re-run ARV
    // selection over the combined pool so verified matches still outrank
    // unverified and price breaks ties.
    const rescue = (
      base: AppraisalResult,
      allowed: ReadonlySet<string>,
      extra?: (c: AppraisedComparable) => boolean
    ) => {
      const priorityByType = new Map(
        base.appliedFilters.map((f) => [f.type, f.priority ?? 'hard'])
      )
      const rescuedIds = new Set(
        base.comparables
          .filter((c) => {
            if (c.isEnabled) return false
            if ((c.adjustedSalePrice ?? c.salePrice ?? 0) <= 0) return false
            if (extra && !extra(c)) return false
            const failures = (c.evaluation?.filterResults ?? []).filter(
              (f) => !f.passed && f.status === 'failed' && priorityByType.get(f.type) !== 'soft'
            )
            return failures.length > 0 && failures.every((f) => allowed.has(f.type))
          })
          .map((c) => c.id)
      )
      if (rescuedIds.size === 0) return null
      const marked = base.comparables.map((c) =>
        rescuedIds.has(c.id) ? { ...c, isEnabled: true } : c
      )
      return this.selectArvComps(subject, marked)
    }

    const applyRescued = (
      base: AppraisalResult,
      picked: { comparables: AppraisedComparable[]; selected: AppraisedComparable[]; eligible: AppraisedComparable[]; arv: number }
    ) => ({
      ...base,
      comparables: picked.comparables,
      arv: picked.arv,
      enabledCount: picked.comparables.filter((c) => c.isEnabled).length,
      selectedCompIds: picked.selected.map((c) => c.id),
      insufficientComps: picked.eligible.length < REQUIRED_ARV_COMPS,
    })

    // Step 2: widen the build-era INSIDE the subdivision first — better a
    // slightly older/newer comp in-area than a perfect-year comp out-of-area.
    // Comps legitimately pass at the tier's threshold — nothing is rescued.
    for (const yearLimit of yearSteps) {
      const r = this.evaluate(subject, comparables, {
        filters: filtersAt(yearLimit),
        adjustments,
      })
      if (!r.insufficientComps) {
        console.log(`Appraisal: ${r.selectedCompIds?.length} comps selected after year-built widening to ±${yearLimit}yr`)
        return {
          ...r,
          fallbackUsed: 'year_built_expansion',
          fallbackReason: `Insufficient comps within ±${strictYear}yr of the subject's build year in "${subdivisionName}". Widened year-built tolerance to ±${yearLimit}yr — sale age, subdivision and all other hard rules still enforced.`,
          expansionApplied: ['year_built'],
        }
      }
    }

    // Step 3: neighborhood tier — when the subdivision can't fill the pool,
    // prefer verified same-neighborhood comps (name OR code) at the strict
    // radius before expanding geography. Rescue subdivision_match only when
    // neighborhood_match verified-passed; any other hard failure still kills.
    if (expansion.allowNeighborhoodExpansion && (subject.neighborhoodName || subject.neighborhoodCode)) {
      for (const yearLimit of yearLadder) {
        const resultNb = this.evaluate(subject, comparables, {
          filters: filtersAt(yearLimit),
          adjustments,
        })
        const picked = rescue(resultNb, new Set(['subdivision_match']), (c) =>
          neighborhoodsMatch(subject, c) === true
        )
        if (picked && picked.eligible.length >= REQUIRED_ARV_COMPS) {
          console.log(`Appraisal: ${picked.selected.length} comps selected via neighborhood match${yearNote(yearLimit)}`)
          return {
            ...applyRescued(resultNb, picked),
            fallbackUsed: 'neighborhood_expansion',
            fallbackReason: `Insufficient comps in subdivision "${subject.subdivision || 'unknown'}". Expanded to neighborhood "${subject.neighborhoodName ?? subject.neighborhoodCode}" (verified name/code match)${yearNote(yearLimit)} — all other rules apply at the tier's thresholds.`,
            expansionApplied: appliedFor(yearLimit, 'neighborhood'),
          }
        }
      }
    }

    // Step 4: leave the subdivision — radius ×mult, year ladder restarts at
    // each scope. Rescue is subdivision_match-only: a comp failing any other
    // hard rule at this tier's thresholds stays disqualified.
    if (expansion.allowGeographicExpansion) {
      for (const yearLimit of yearLadder) {
        const resultSub = this.evaluate(subject, comparables, {
          filters: filtersAt(yearLimit, expansion.geographicDistanceMultiplier),
          adjustments,
        })
        const picked = rescue(resultSub, new Set(['subdivision_match']))
        if (picked && picked.eligible.length >= REQUIRED_ARV_COMPS) {
          console.log(`Appraisal: ${picked.selected.length} comps selected after subdivision expansion${yearNote(yearLimit)}`)
          return {
            ...applyRescued(resultSub, picked),
            fallbackUsed: 'subdivision_expansion',
            fallbackReason: `Insufficient comps in subdivision "${subject.subdivision || 'unknown'}". Expanded to the surrounding area (radius ×${expansion.geographicDistanceMultiplier})${yearNote(yearLimit)} — all other rules apply at the tier's thresholds.`,
            expansionApplied: appliedFor(yearLimit, 'subdivision'),
          }
        }
      }

      // Step 5: drop the radius gate — rescue comps whose only hard
      // failures are subdivision and/or distance, year ladder restarts.
      {
        let resultGeo = result1
        for (const yearLimit of yearLadder) {
          resultGeo = this.evaluate(subject, comparables, {
            filters: filtersAt(yearLimit),
            adjustments,
          })
          const picked = rescue(resultGeo, new Set(['subdivision_match', 'distance']))
          if (picked && picked.eligible.length >= REQUIRED_ARV_COMPS) {
            console.log(`Appraisal: ${picked.selected.length} comps selected after geographic expansion${yearNote(yearLimit)}`)
            return {
              ...applyRescued(resultGeo, picked),
              fallbackUsed: 'geographic_expansion',
              fallbackReason: `Insufficient comps in "${subdivisionName}". Expanded to radius-only geography${yearNote(yearLimit)} — failed location rules remain visible per comp.`,
              expansionApplied: appliedFor(yearLimit, 'geographic'),
            }
          }
        }

        // Step 6: No rule-qualified set exists. Final fallback — the most
        // recent sales that still satisfy every intrinsic hard rule (sale
        // age, sqft, property type, road barrier, year built at the widest
        // sanctioned tolerance ±maxYear); only location failures
        // (subdivision/distance) may be carried. A comp that breaches a
        // hard property rule is never enabled — better INSUFFICIENT_COMPS
        // than a valuation on a rule-breaker.
        console.log('Appraisal: no comps passed all rules — checking for recent sales')
        const saleAgeDays = defaultFilters.find((f) => f.type === 'sale_age')?.value ?? 180
        const LOCATION_FAILURES = new Set(['subdivision_match', 'distance'])
        const geoPriority = new Map(
          resultGeo.appliedFilters.map((f) => [f.type, f.priority ?? 'hard'])
        )
        const now = Date.now()
        const recentComps = resultGeo.comparables
          .filter((c) => {
            if (!c.saleDate || (c.adjustedSalePrice ?? c.salePrice ?? 0) <= 0) return false
            const days = (now - new Date(c.saleDate).getTime()) / 86_400_000
            if (!Number.isFinite(days) || days > saleAgeDays) return false
            // Intrinsic hard rules must all pass — only location may fail
            const hardFailures = (c.evaluation?.filterResults ?? []).filter(
              (f) =>
                !f.passed &&
                f.status === 'failed' &&
                geoPriority.get(f.type) !== 'soft' &&
                !LOCATION_FAILURES.has(f.type)
            )
            return hardFailures.length === 0
          })
          .sort(
            (a, b) =>
              new Date(b.saleDate!).getTime() - new Date(a.saleDate!).getTime()
          )
          .slice(0, REQUIRED_ARV_COMPS)

        if (recentComps.length === 0) {
          console.log('Appraisal: INSUFFICIENT_COMPS — no comps satisfy the hard rules')
          return {
            ...resultGeo,
            insufficientComps: true,
            fallbackUsed: 'insufficient',
            fallbackReason: `INSUFFICIENT_COMPS: no comparables sold within the last ${saleAgeDays} days satisfy appraisal rules.`,
          }
        }

        const recentIds = new Set(recentComps.map((c) => c.id))
        const marked = resultGeo.comparables.map((c) =>
          recentIds.has(c.id) ? { ...c, isEnabled: true } : c
        )
        const relaxed = this.selectArvComps(subject, marked)
        console.log(`Appraisal: relaxed to ${recentComps.length} most-recent comps (no rule-qualified set exists)`)
        return {
          ...resultGeo,
          comparables: relaxed.comparables,
          arv: relaxed.arv,
          enabledCount: relaxed.comparables.filter((c) => c.isEnabled).length,
          selectedCompIds: relaxed.selected.map((c) => c.id),
          insufficientComps: false,
          fallbackUsed: 'nearest_comps',
          fallbackReason: `No comps satisfied all appraisal rules; using the ${recentComps.length} most recent sale(s) within ${saleAgeDays} days (year-built tolerance ±${maxYear}yr). Failed rules remain visible per comp.`,
          expansionApplied: appliedFor(maxYear, 'geographic'),
        }
      }
    }

    // Expansion disabled at some level and strict rules found too few comps —
    // honest insufficient rather than silently picking the nearest sales.
    console.log(`Appraisal: ${result1.selectedCompIds?.length ?? 0} valid comps — INSUFFICIENT_COMPS (expansion limited)`)
    return {
      ...result1,
      insufficientComps: true,
      fallbackUsed: 'insufficient',
      fallbackReason: `Only ${result1.selectedCompIds?.length ?? 0} comps passed appraisal rules within the allowed expansion policy.`,
    }
  }

  calculateARV(comparables: AppraisedComparable[]): number {
    // Use adjustedSalePrice if available, otherwise fall back to salePrice
    // This ensures ARV is calculated even if adjustments couldn't be applied
    const validPrices = comparables
      .filter((c) => c.isEnabled)
      .map((c) => c.adjustedSalePrice ?? c.salePrice)
      .filter((p): p is number => p != null && p > 0)

    if (validPrices.length === 0) return 0

    return Math.round(validPrices.reduce((sum, p) => sum + p, 0) / validPrices.length)
  }

  getDefaultFilters(): AppraisalFilter[] {
    return [...DEFAULT_FILTERS]
  }

  getDefaultAdjustments(): AppraisalAdjustment[] {
    return [...DEFAULT_ADJUSTMENTS]
  }

  /**
   * Calculate Weighted ARV using Expert Underwriter Methodology
   *
   * ALGORITHM OVERVIEW:
   * 1. Categorize comps into tiers based on classification match
   * 2. Apply weighted scoring within each tier
   * 3. Calculate tier-specific values (As-Is, After-Renovation)
   * 4. Determine final ARV based on subject classification
   * 5. Generate investment scenarios
   *
   * TIER SYSTEM:
   * - Tier 1 (Primary): Comps matching subject classification (weight: 60-80%)
   * - Tier 2 (Support): Transitional comps (weight: 15-30%)
   * - Tier 3 (Reference): Opposite classification (weight: 5-15%, for spread analysis)
   *
   * WEIGHTING PHILOSOPHY:
   * - For As-Is subjects: As-Is comps = current market value
   * - For After-Renovation subjects: ARV comps = target sale price
   * - Spread analysis helps calculate renovation ROI
   */
  calculateWeightedARV(
    subject: NormalizedProperty,
    comparables: AppraisedComparable[],
    subjectClassification: ClassificationResult,
    compClassifications: Map<string, ClassificationResult>
  ): WeightedARVResult {
    const enabledComps = comparables.filter((c) => c.isEnabled)
    const subjectClass = subjectClassification.classification

    // Categorize comps by classification
    const asIsCompIds: string[] = []
    const afterRenovationCompIds: string[] = []
    const transitionalCompIds: string[] = []

    for (const comp of enabledComps) {
      const classification = compClassifications.get(comp.id)?.classification
      if (classification === 'as_is') {
        asIsCompIds.push(comp.id)
      } else if (classification === 'after_renovation') {
        afterRenovationCompIds.push(comp.id)
      } else {
        transitionalCompIds.push(comp.id)
      }
    }

    // Calculate weight factors and breakdown for each comp
    const weightBreakdown: CompWeightBreakdown[] = []

    for (const comp of enabledComps) {
      const price = comp.adjustedSalePrice ?? comp.salePrice
      if (price == null || price <= 0) continue

      const compClassification = compClassifications.get(comp.id)
      const compClass = compClassification?.classification ?? 'transitional'

      // Determine tier based on classification match
      const tier = this.determineCompTier(subjectClass, compClass)
      const isPrimaryMatch = tier === 1

      // Calculate individual factors
      const factors = this.calculateWeightFactors(
        subject,
        comp,
        subjectClassification,
        compClassification
      )

      // Calculate total weight (multiplicative)
      const weight =
        factors.distance *
        factors.sqftSimilarity *
        factors.recency *
        factors.classificationMatch *
        factors.confidenceBonus *
        factors.filterPassRate

      weightBreakdown.push({
        compId: comp.id,
        price,
        weight,
        normalizedWeight: 0, // Normalized after
        factors,
        classification: compClass,
        isPrimaryMatch,
        tier,
      })
    }

    // Normalize weights to sum to 1
    const totalWeight = weightBreakdown.reduce((sum, item) => sum + item.weight, 0)
    if (totalWeight > 0) {
      for (const item of weightBreakdown) {
        item.normalizedWeight = item.weight / totalWeight
      }
    }

    // Calculate weighted values for each classification group
    const asIsValue = this.calculateGroupWeightedValue(weightBreakdown, 'as_is')
    const afterRenovationValue = this.calculateGroupWeightedValue(weightBreakdown, 'after_renovation')
    const transitionalValue = this.calculateGroupWeightedValue(weightBreakdown, 'transitional')

    // Calculate spread
    const spread = asIsValue !== null && afterRenovationValue !== null
      ? afterRenovationValue - asIsValue
      : null

    // Determine final ARV based on subject classification and available data
    const { arv, methodology } = this.calculateFinalARV(
      subjectClass,
      weightBreakdown,
      asIsValue,
      afterRenovationValue,
      transitionalValue,
      this.calculateARV(enabledComps)
    )

    // Find best comp (highest weight in primary tier)
    const primaryComps = weightBreakdown.filter((c) => c.tier === 1)
    const bestComp = primaryComps.length > 0
      ? primaryComps.reduce((best, item) =>
          item.normalizedWeight > best.normalizedWeight ? item : best
        )
      : weightBreakdown.reduce<CompWeightBreakdown | null>(
          (best, item) => (!best || item.normalizedWeight > best.normalizedWeight ? item : best),
          null
        )

    // Generate investment scenarios
    const scenarios = this.generateInvestmentScenarios(
      subjectClass,
      asIsValue,
      afterRenovationValue,
      spread,
      asIsCompIds,
      afterRenovationCompIds
    )

    return {
      arv,
      asIsValue,
      afterRenovationValue,
      spread,
      weightBreakdown,
      asIsCompIds,
      afterRenovationCompIds,
      transitionalCompIds,
      bestCompId: bestComp?.compId ?? null,
      scenarios,
      methodology,
    }
  }

  /**
   * Determine comp tier based on classification match
   *
   * Tier 1: Same classification as subject (PRIMARY)
   * Tier 2: Transitional (either subject or comp)
   * Tier 3: Opposite classification (REFERENCE ONLY)
   */
  private determineCompTier(
    subjectClass: PropertyClassification,
    compClass: PropertyClassification
  ): 1 | 2 | 3 {
    if (subjectClass === compClass) {
      return 1 // Same classification = primary match
    }

    if (subjectClass === 'transitional' || compClass === 'transitional') {
      return 2 // Transitional involved = supporting data
    }

    // Opposite classifications (as_is vs after_renovation)
    return 3
  }

  /**
   * Calculate weight factors for a single comp
   *
   * Expert Underwriter Weighting:
   * - Classification match is the MOST IMPORTANT factor (0.0-2.0)
   * - Filter pass rate rewards comps meeting appraisal criteria
   * - Distance, sqft, recency are secondary but important
   */
  private calculateWeightFactors(
    subject: NormalizedProperty,
    comp: AppraisedComparable,
    subjectClassification: ClassificationResult,
    compClassification: ClassificationResult | undefined
  ): WeightFactors {
    const subjectClass = subjectClassification.classification
    const compClass = compClassification?.classification ?? 'transitional'

    // 1. CLASSIFICATION MATCH (0.0 to 2.0) - CRITICAL FACTOR
    // This is the most important factor for accurate valuation
    let classificationMatch: number
    if (compClass === subjectClass) {
      // Same classification = full weight
      classificationMatch = 2.0
    } else if (subjectClass === 'transitional') {
      // Subject is transitional - both As-Is and ARV comps are relevant
      classificationMatch = compClass === 'after_renovation' ? 1.3 : 1.2
    } else if (compClass === 'transitional') {
      // Comp is transitional - moderate relevance
      classificationMatch = 1.0
    } else {
      // Opposite classifications (as_is vs after_renovation)
      // Still useful for spread analysis, but low weight for ARV
      classificationMatch = 0.3
    }

    // 2. Distance factor (0.3 to 2.0) - closer is better
    let distanceFactor = 1.0
    if (comp.distanceMiles != null) {
      if (comp.distanceMiles <= 0.25) {
        distanceFactor = 2.0 // Same block
      } else if (comp.distanceMiles <= 0.5) {
        distanceFactor = 1.5 // Very close
      } else if (comp.distanceMiles <= 1.0) {
        distanceFactor = 1.0 // Within 1 mile
      } else if (comp.distanceMiles <= 2.0) {
        distanceFactor = 0.6 // 1-2 miles
      } else {
        distanceFactor = 0.3 // Far
      }
    }

    // 3. Sqft similarity factor (0.5 to 1.5)
    let sqftSimilarity = 1.0
    if (comp.squareFeet && subject.squareFeet) {
      const pctDiff = Math.abs(comp.squareFeet - subject.squareFeet) / subject.squareFeet
      if (pctDiff <= 0.05) {
        sqftSimilarity = 1.5 // Within 5%
      } else if (pctDiff <= 0.10) {
        sqftSimilarity = 1.3 // Within 10%
      } else if (pctDiff <= 0.15) {
        sqftSimilarity = 1.1 // Within 15%
      } else if (pctDiff <= 0.25) {
        sqftSimilarity = 0.8 // Within 25%
      } else {
        sqftSimilarity = 0.5 // >25% different
      }
    }

    // 4. Recency factor (0.6 to 1.4) - more recent is better
    let recencyFactor = 1.0
    if (comp.saleDate) {
      const saleDate = new Date(comp.saleDate)
      if (!isNaN(saleDate.getTime())) {
        const daysSinceSale = Math.floor(
          (Date.now() - saleDate.getTime()) / (1000 * 60 * 60 * 24)
        )
        if (daysSinceSale <= 30) {
          recencyFactor = 1.4 // Very recent
        } else if (daysSinceSale <= 60) {
          recencyFactor = 1.2 // Recent
        } else if (daysSinceSale <= 120) {
          recencyFactor = 1.0 // Normal
        } else if (daysSinceSale <= 180) {
          recencyFactor = 0.9 // Getting old
        } else if (daysSinceSale <= 365) {
          recencyFactor = 0.7 // Old
        } else {
          recencyFactor = 0.6 // Very old
        }
      }
    }

    // 5. Confidence bonus (0.8 to 1.2)
    let confidenceBonus = 1.0
    if (compClassification) {
      confidenceBonus = 0.8 + (compClassification.confidence / 100) * 0.4
    }

    // 6. Filter pass rate bonus (0.5 to 1.5)
    // Comps that pass more appraisal filters are more reliable
    let filterPassRate = 1.0
    if (comp.evaluation?.filterResults) {
      const total = comp.evaluation.filterResults.length
      const passed = comp.evaluation.filterResults.filter((f) => f.passed).length
      if (total > 0) {
        const passRate = passed / total
        // 0.5 at 0%, 1.0 at 60%, 1.5 at 100%
        filterPassRate = 0.5 + passRate
      }
    }

    return {
      distance: Math.round(distanceFactor * 100) / 100,
      sqftSimilarity: Math.round(sqftSimilarity * 100) / 100,
      recency: Math.round(recencyFactor * 100) / 100,
      classificationMatch: Math.round(classificationMatch * 100) / 100,
      confidenceBonus: Math.round(confidenceBonus * 100) / 100,
      filterPassRate: Math.round(filterPassRate * 100) / 100,
    }
  }

  /**
   * Calculate weighted average value for a classification group
   */
  private calculateGroupWeightedValue(
    breakdown: CompWeightBreakdown[],
    classification: PropertyClassification
  ): number | null {
    const groupComps = breakdown.filter((c) => c.classification === classification)
    if (groupComps.length === 0) return null

    // Calculate weights within this group
    const groupTotal = groupComps.reduce((sum, c) => sum + c.weight, 0)
    if (groupTotal === 0) return null

    // Weighted average
    const weightedSum = groupComps.reduce((sum, c) => {
      const groupWeight = c.weight / groupTotal
      return sum + c.price * groupWeight
    }, 0)

    return Math.round(weightedSum)
  }

  /**
   * Calculate final ARV based on subject classification and available data
   *
   * Expert Underwriter Logic:
   * - As-Is subject → Primary value is current market (As-Is comps)
   * - After-Renovation subject → Primary value is target ARV (After-Reno comps)
   * - Transitional → Blend of both with heavier weight on After-Renovation
   */
  private calculateFinalARV(
    subjectClass: PropertyClassification,
    breakdown: CompWeightBreakdown[],
    asIsValue: number | null,
    afterRenovationValue: number | null,
    transitionalValue: number | null,
    fallbackArv: number
  ): { arv: number; methodology: string } {
    // Count comps in each tier
    const tier1Comps = breakdown.filter((c) => c.tier === 1)
    const tier2Comps = breakdown.filter((c) => c.tier === 2)

    // Calculate tier-weighted ARV
    let arv: number
    let methodology: string

    if (tier1Comps.length >= 2) {
      // We have enough primary comps - use weighted average of Tier 1
      const tier1Total = tier1Comps.reduce((sum, c) => sum + c.weight, 0)
      arv = Math.round(
        tier1Comps.reduce((sum, c) => sum + c.price * (c.weight / tier1Total), 0)
      )
      methodology = `Weighted average of ${tier1Comps.length} ${subjectClass === 'as_is' ? 'As-Is' : subjectClass === 'after_renovation' ? 'After-Renovation' : 'matching'} comps (Tier 1 primary)`
    } else if (tier1Comps.length === 1 && tier2Comps.length >= 1) {
      // One primary comp + transitional support
      const tier1Weight = 0.6
      const tier2Weight = 0.4
      const tier1Price = tier1Comps[0].price
      const tier2Total = tier2Comps.reduce((sum, c) => sum + c.weight, 0)
      const tier2Avg = tier2Comps.reduce((sum, c) => sum + c.price * (c.weight / tier2Total), 0)
      arv = Math.round(tier1Price * tier1Weight + tier2Avg * tier2Weight)
      methodology = `Blended: 1 primary comp (60%) + ${tier2Comps.length} transitional comps (40%)`
    } else if (tier2Comps.length >= 2) {
      // No primary comps - use transitional
      const tier2Total = tier2Comps.reduce((sum, c) => sum + c.weight, 0)
      arv = Math.round(
        tier2Comps.reduce((sum, c) => sum + c.price * (c.weight / tier2Total), 0)
      )
      methodology = `Weighted average of ${tier2Comps.length} transitional comps (no ${subjectClass} comps found)`
    } else {
      // Fallback to all comps weighted
      const totalWeight = breakdown.reduce((sum, c) => sum + c.weight, 0)
      if (totalWeight > 0) {
        arv = Math.round(
          breakdown.reduce((sum, c) => sum + c.price * (c.weight / totalWeight), 0)
        )
        methodology = `Weighted average of all ${breakdown.length} comps (insufficient matching comps)`
      } else {
        arv = fallbackArv
        methodology = 'Simple average (fallback - no weighted data available)'
      }
    }

    return { arv, methodology }
  }

  /**
   * Generate investment scenarios based on classification analysis
   */
  private generateInvestmentScenarios(
    subjectClass: PropertyClassification,
    asIsValue: number | null,
    afterRenovationValue: number | null,
    spread: number | null,
    asIsCompIds: string[],
    afterRenovationCompIds: string[]
  ): InvestmentScenario[] {
    const scenarios: InvestmentScenario[] = []

    // Flip scenario (if we have both values)
    if (asIsValue !== null && afterRenovationValue !== null && spread !== null) {
      scenarios.push({
        strategy: 'flip',
        targetArv: afterRenovationValue,
        recommendedCompIds: afterRenovationCompIds,
        confidence: Math.min(95, 50 + afterRenovationCompIds.length * 15),
        notes: `Potential spread: $${spread.toLocaleString()}. Based on ${afterRenovationCompIds.length} renovated comps. ` +
          (subjectClass === 'as_is'
            ? 'Subject is As-Is - good flip candidate.'
            : subjectClass === 'after_renovation'
              ? 'Subject already renovated - limited upside.'
              : 'Subject is transitional - moderate renovation needed.')
      })
    }

    // Wholesale scenario (As-Is focused)
    if (asIsValue !== null) {
      scenarios.push({
        strategy: 'wholesale',
        targetArv: asIsValue,
        recommendedCompIds: asIsCompIds,
        confidence: Math.min(90, 50 + asIsCompIds.length * 15),
        notes: `Current market value: $${asIsValue.toLocaleString()}. Based on ${asIsCompIds.length} As-Is comps. ` +
          'Use for wholesale assignment fee calculation.'
      })
    }

    // Rental scenario (conservative ARV)
    const rentalArv = asIsValue !== null && afterRenovationValue !== null
      ? Math.round(asIsValue + (afterRenovationValue - asIsValue) * 0.4) // 40% of spread
      : asIsValue ?? afterRenovationValue

    if (rentalArv !== null) {
      scenarios.push({
        strategy: 'rental',
        targetArv: rentalArv,
        recommendedCompIds: [...asIsCompIds, ...afterRenovationCompIds.slice(0, 2)],
        confidence: 70,
        notes: `Conservative rental ARV: $${rentalArv.toLocaleString()}. ` +
          'Assumes cosmetic updates only, not full renovation.'
      })
    }

    return scenarios
  }
}

// ─── Classification Summary ───────────────────────────────────────────────────

/**
 * Result of summarizing comp classifications alongside ARV.
 * Classifications label comps for display; ARV is computed by the appraisal engine.
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

/**
 * Summarize classifications for enabled comps.
 * Labels comps as as_is or after_renovation and computes simple group averages.
 */
export function summarizeClassifications(
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

// ─── Helper Functions ──────────────────────────────────────────────────────────

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
