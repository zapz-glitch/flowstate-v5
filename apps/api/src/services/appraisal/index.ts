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
import { evaluateComparables, evaluateComparable, neighborhoodsMatch, isValueEquivalent, pocketHardScopesMatch, subjectRefPpsf, subjectPocketRefPpsf, pocketValueEquivalent, adjacentScopeKey, adjacentScopeRanks } from './evaluator'
import {
  describeLadderConcessions, filtersForLadder, ladderTiersAt, lastUsefulLadderStep, type LadderScope,
} from './filter-ladder'
import type {
  AppraisalFilter,
  AppraisalAdjustment,
  AppraisalOptions,
  AppraisalResult,
  AppraisedComparable,
  ComparableEvaluation,
  ExpansionPolicy,
} from './types'
import { DEFAULT_FILTERS, DEFAULT_ADJUSTMENTS, DEFAULT_EXPANSION_POLICY, saleAgeExpansionSteps, vintageYearCap } from './types'
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
export { DEFAULT_FILTERS, DEFAULT_ADJUSTMENTS, DEFAULT_EXPANSION_POLICY, defaultFilterPriority, saleAgeExpansionSteps, vintageYearCap } from './types'
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
  calculateARV(comparables: AppraisedComparable[], subjectSqft?: number | null): number

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
    | 'pocket_expansion'
    | 'sqft_expansion'
    | 'neighborhood_expansion'
    | 'subdivision_expansion'
    | 'geographic_expansion'
    | 'sale_age_expansion'
    | 'nearest_comps'
    | 'pocket_catch'
    | 'insufficient'
  /** Message explaining the fallback */
  fallbackReason?: string
}

/** Number of valid comps required for ARV (classical appraisal model) */
const REQUIRED_ARV_COMPS = 3

/**
 * How many rule-passing comps make a set sufficient. Product rule
 * (docs/FILTER-LADDER.md): one is enough to build an evaluation on — more is
 * better, but the server must not loosen rules just to collect a third.
 * REQUIRED_ARV_COMPS above still caps how many comps are SELECTED.
 */
const MIN_COMPS_TO_ANSWER = 1

/**
 * Top-of-market band: only eligible comps priced within this fraction of the
 * highest-priced eligible comp may drive ARV. Guards against as-is /
 * original-condition sales dragging ARV down when vision can't verify
 * condition — price is the proxy for ARV-spec condition.
 */
const ARV_PRICE_BAND_PCT = 0.10

/**
 * Normalize an address to its street name for same-street matching.
 * "21660 FOREST WATERS CIR, SAN ANTONIO, TX 78266" → "forest waters cir"
 * Street suffixes are canonicalized (DRIVE→DR, COURT→CT, ...) so "CV"/"COVE"
 * style variations still compare equal.
 */
const STREET_SUFFIXES: Record<string, string> = {
  drive: 'dr', dr: 'dr', street: 'st', st: 'st', avenue: 'ave', ave: 'ave',
  boulevard: 'blvd', blvd: 'blvd', court: 'ct', ct: 'ct', circle: 'cir', cir: 'cir',
  cove: 'cv', cv: 'cv', lane: 'ln', ln: 'ln', road: 'rd', rd: 'rd', trail: 'trl',
  trl: 'trl', way: 'way', place: 'pl', pl: 'pl', terrace: 'ter', ter: 'ter',
  parkway: 'pkwy', pkwy: 'pkwy', highway: 'hwy', hwy: 'hwy', crossing: 'xing',
  xing: 'xing', bend: 'bnd', bnd: 'bnd', run: 'run', pass: 'pass', canyon: 'cyn',
  cyn: 'cyn', heights: 'hts', hts: 'hts',
}
export function streetNameKey(address?: string | null): string | null {
  if (!address) return null
  const first = address.split(',')[0].trim()
  const noNumber = first.replace(/^\d+[\w-]*\s+/, '')
  if (!noNumber) return null
  const words = noNumber.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean)
  if (words.length === 0) return null
  const last = words[words.length - 1]
  words[words.length - 1] = STREET_SUFFIXES[last] ?? last
  return words.join(' ')
}

/**
 * Proximity comparator shared by ARV selection and the nearest_comps
 * fallback: same street beats everything, then ascending distance, then
 * sale recency, then price. Analysts weight proximity to the subject over
 * recency when comps otherwise satisfy the appraisal rules.
 */
function proximityCompare(
  a: { address?: string; distanceMiles?: number | null; saleDate?: string | null },
  b: { address?: string; distanceMiles?: number | null; saleDate?: string | null },
  subjectStreet: string | null
): number {
  const aStreet = streetNameKey(a.address)
  const bStreet = streetNameKey(b.address)
  if (subjectStreet) {
    const aSame = aStreet === subjectStreet ? 1 : 0
    const bSame = bStreet === subjectStreet ? 1 : 0
    if (aSame !== bSame) return bSame - aSame
  }
  const distDiff = (a.distanceMiles ?? Infinity) - (b.distanceMiles ?? Infinity)
  if (distDiff !== 0) return distDiff
  const aTime = a.saleDate ? new Date(a.saleDate).getTime() : 0
  const bTime = b.saleDate ? new Date(b.saleDate).getTime() : 0
  return bTime - aTime
}

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

    // Closest-first selection: within the eligible+in-band set, proximity to
    // the subject leads — same street beats everything, then ascending
    // distance, then sale recency. Verified match passes break the remaining
    // ties (a comp that slid through on missing data ranks below an
    // equidistant verified match), and adjusted price is the last resort.
    // Nearby comps are only skipped when scrutiny actually rejects them —
    // never because a farther comp merely carried more verified fields.
    const verifiedPasses = (c: AppraisedComparable) =>
      c.evaluation.filterResults.filter((r) => r.status === 'passed').length
    const subjectStreet = streetNameKey(subject.address)
    const sorted = [...banded].sort((a, b) => {
      const proximity = proximityCompare(a, b, subjectStreet)
      if (proximity !== 0) return proximity
      const diff = verifiedPasses(b) - verifiedPasses(a)
      if (diff !== 0) return diff
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
      insufficientComps: eligible.length < MIN_COMPS_TO_ANSWER,
    }
  }

  /**
   * Evaluate under the filter ladder (docs/FILTER-LADDER.md) — the one way
   * the server loosens rules. Strict first; then only sale age, square feet
   * and year built widen, one small turn at a time; geography loosens last
   * (tract/block group → neighborhood name → value-equivalent pocket). The
   * first turn that admits a rule-passing comp wins. There is no fixed cap:
   * the data ends the ladder. When nothing passes anywhere the result is
   * `insufficient` — no comp is forced in.
   */
  evaluateWithFallback(
    subject: NormalizedProperty,
    comparables: NormalizedComparable[],
    options?: AppraisalOptions & FallbackOptions
  ): AppraisalResultWithFallback {
    const adjustments = options?.adjustments ?? DEFAULT_ADJUSTMENTS
    const filters = options?.filters ?? DEFAULT_FILTERS
    const expansion: Required<ExpansionPolicy> = {
      ...DEFAULT_EXPANSION_POLICY,
      ...(options?.expansion ?? {}),
    }

    const strict = this.evaluate(subject, comparables, { filters, adjustments })
    if (!strict.insufficientComps) {
      console.log(`Appraisal: ${strict.selectedCompIds?.length} comps selected under strict rules`)
      return { ...strict, fallbackUsed: 'none' }
    }
    if (!expansion.enabled) {
      return {
        ...strict,
        fallbackUsed: 'insufficient',
        fallbackReason: `Only ${strict.selectedCompIds?.length ?? 0} comps passed appraisal rules; expansion policy disabled.`,
      }
    }

    const ladderRules = new Set(['sqft_diff', 'year_built_diff', 'sale_age'])
    const scopes: LadderScope[] = ['tract', 'neighborhood', 'value_equivalent']
    for (const scope of scopes) {
      // Comps that fail a rule the ladder never loosens cannot be admitted,
      // so they must not stretch it either.
      const otherRulesOnly = filtersForLadder(filters, 0, scope, subject.squareFeet)
        .map((f) => (ladderRules.has(f.type) ? { ...f, enabled: false } : f))
      const candidates = comparables.filter((c) =>
        !evaluateComparable(subject, c, otherRulesOnly, []).shouldDisable)
      if (candidates.length === 0) continue
      const lastStep = lastUsefulLadderStep(filters, subject, candidates)
      for (let step = scope === 'tract' ? 1 : 0; step <= lastStep; step++) {
        const r = this.evaluate(subject, comparables, {
          filters: filtersForLadder(filters, step, scope, subject.squareFeet),
          adjustments,
        })
        if (r.insufficientComps) continue
        const tiers = ladderTiersAt(step)
        const applied: NonNullable<AppraisalResult['expansionApplied']> = []
        if (tiers.year > 0) applied.push('year_built')
        if (tiers.sqft > 0) applied.push('sqft_diff')
        if (tiers.saleAge > 0) applied.push('sale_age')
        if (scope === 'neighborhood') applied.push('neighborhood')
        if (scope === 'value_equivalent') applied.push('geographic')
        const moved = describeLadderConcessions(filters, step, subject.squareFeet)
        console.log(`Appraisal: ${r.selectedCompIds?.length} comps selected at ladder turn ${step} (${scope})`)
        return {
          ...r,
          fallbackUsed: scope === 'neighborhood' ? 'neighborhood_expansion'
            : scope === 'value_equivalent' ? 'geographic_expansion'
            : tiers.sqft > 0 ? 'sqft_expansion'
            : tiers.year > 0 ? 'year_built_expansion'
            : 'sale_age_expansion',
          fallbackReason: [
            scope === 'tract' ? null : scope === 'neighborhood'
              ? 'No comp passed inside the census tract — widened to the same neighborhood name.'
              : 'No comp passed in the tract or neighborhood — widened to a value-equivalent adjacent pocket.',
            moved.length ? `Widened ${moved.join('; ')}.` : null,
          ].filter(Boolean).join(' '),
          expansionApplied: applied,
        }
      }
    }

    console.log('Appraisal: no comp passes at any ladder turn — INSUFFICIENT_COMPS')
    return {
      ...strict,
      fallbackUsed: 'insufficient',
      fallbackReason: 'No comparable passes the appraisal rules at any ladder turn in the tract, neighborhood, or an equivalent pocket.',
    }
  }

  calculateARV(comparables: AppraisedComparable[], subjectSqft?: number | null): number {
    // Canonical formula (same as shared calculateARV): normalize each comp's
    // adjusted price to the subject's size — a comp of a different size must
    // scale, not average raw. avg(adjustedPrice/compSqft × subjectSqft).
    const valid: Array<{ value: number; weight: number }> = []
    for (const c of comparables.filter((x) => x.isEnabled)) {
      const price = c.adjustedSalePrice ?? c.salePrice
      if (price == null || price <= 0) continue
      if (c.squareFeet != null && c.squareFeet > 0 && subjectSqft != null && subjectSqft > 0) {
        // Sqft-proximity weight — in-band comps carry more weight; smaller
        // homes' inflated $/sf shouldn't dominate the average.
        const weight = 1 / (1 + Math.abs(c.squareFeet - subjectSqft) / subjectSqft)
        valid.push({ value: (price / c.squareFeet) * subjectSqft, weight })
      } else {
        valid.push({ value: price, weight: 1 })
      }
    }
    if (valid.length === 0) return 0
    const totalWeight = valid.reduce((s, v) => s + v.weight, 0)
    return Math.round(valid.reduce((sum, v) => sum + v.value * v.weight, 0) / totalWeight)
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
      this.calculateARV(enabledComps, subject.squareFeet)
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
  compClassifications: Map<string, ClassificationResult>,
  subjectAvm?: number | null,
): ClassificationSummaryResult {
  const enabledComps = comparables.filter((c) => c.isEnabled)
  const asIsCompIds: string[] = []
  const afterRenovationCompIds: string[] = []

  for (const comp of enabledComps) {
    const cls = compClassifications.get(comp.id)?.classification
    if (cls === 'after_renovation') {
      afterRenovationCompIds.push(comp.id)
    } else if (
      cls === 'as_is' &&
      // Investor-priced only — a distressed deed priced at market isn't an
      // investor purchase; it reads as as-is but doesn't feed the floor.
      (subjectAvm == null || (comp.salePrice != null && comp.salePrice <= subjectAvm))
    ) {
      asIsCompIds.push(comp.id)
    }
    // transitional → market tier: display only, feeds neither bucket
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
