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
import { evaluateComparables, evaluateComparable } from './evaluator'
import type {
  AppraisalFilter,
  AppraisalAdjustment,
  AppraisalOptions,
  AppraisalResult,
  AppraisedComparable,
  ComparableEvaluation,
} from './types'
import { DEFAULT_FILTERS, DEFAULT_ADJUSTMENTS } from './types'
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
} from './types'
export { DEFAULT_FILTERS, DEFAULT_ADJUSTMENTS } from './types'
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
 * - After-Renovation comps are used for ARV calculation
 * - As-Is comps are used for buy price/wholesale weighted averages
 * - Classification match is a key factor in weighting
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
  /** Tier: 1=same classification, 2=opposite classification */
  tier: 1 | 2
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
  fallbackUsed: 'none' | 'no_subdivision' | 'nearest_comps'
  /** Message explaining the fallback */
  fallbackReason?: string
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

    // Evaluate all comparables
    // Debug: Log salePrice values before evaluation
    console.log(`[Appraisal] Input comparables salePrice values:`, comparables.map(c => ({
      id: c.id.substring(0, 8),
      salePrice: c.salePrice,
      pricePerSqft: c.pricePerSqft,
      squareFeet: c.squareFeet,
    })))
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

    // Sort comparables: subdivision matches first, then by distance
    // This ensures comps that don't match subdivision go to the bottom
    appraisedComps.sort((a, b) => {
      const aSubdivisionMatch = a.evaluation.filterResults.find(f => f.type === 'subdivision_match')?.passed ?? false
      const bSubdivisionMatch = b.evaluation.filterResults.find(f => f.type === 'subdivision_match')?.passed ?? false

      // Subdivision matches come first
      if (aSubdivisionMatch && !bSubdivisionMatch) return -1
      if (!aSubdivisionMatch && bSubdivisionMatch) return 1

      // Within the same subdivision match status, sort by distance
      const distA = a.distanceMiles ?? 999
      const distB = b.distanceMiles ?? 999
      return distA - distB
    })

    // Calculate ARV from enabled comparables
    const enabledComps = appraisedComps.filter((c) => c.isEnabled)
    const arv = this.calculateARV(enabledComps)

    // Calculate statistics - use adjustedSalePrice if available, fall back to salePrice
    const enabledPrices = enabledComps
      .map((c) => c.adjustedSalePrice ?? c.salePrice)
      .filter((p): p is number => p != null && p > 0)

    const enabledSqfts = enabledComps
      .map((c) => c.squareFeet)
      .filter((s): s is number => s != null && s > 0)

    const avgPricePerSqft =
      enabledSqfts.length > 0 && arv > 0
        ? Math.round(arv / (enabledSqfts.reduce((a, b) => a + b, 0) / enabledSqfts.length))
        : null

    const medianSalePrice = enabledPrices.length > 0 ? calculateMedian(enabledPrices) : null

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
    const minComps = options?.minComps ?? 3
    const maxNearestComps = options?.maxNearestComps ?? 5
    const adjustments = options?.adjustments ?? DEFAULT_ADJUSTMENTS

    // Step 1: Try with default filters (including subdivision match)
    const defaultFilters = options?.filters ?? DEFAULT_FILTERS
    const result1 = this.evaluate(subject, comparables, { filters: defaultFilters, adjustments })

    if (result1.enabledCount >= minComps) {
      console.log(`Appraisal: ${result1.enabledCount} comps passed default filters`)
      return {
        ...result1,
        fallbackUsed: 'none',
      }
    }

    // Step 2: Disable subdivision_match filter and retry
    const filtersWithoutSubdivision = defaultFilters.map((f) =>
      f.type === 'subdivision_match' ? { ...f, enabled: false } : f
    )
    const result2 = this.evaluate(subject, comparables, { filters: filtersWithoutSubdivision, adjustments })

    if (result2.enabledCount >= minComps) {
      console.log(`Appraisal: ${result2.enabledCount} comps passed after disabling subdivision match`)
      return {
        ...result2,
        fallbackUsed: 'no_subdivision',
        fallbackReason: `No comps matched subdivision "${subject.subdivision || 'unknown'}". Using ${result2.enabledCount} comps from nearby areas.`,
      }
    }

    // Step 3: Use nearest comps by distance (disable most filters, keep only basic ones)
    console.log(`Appraisal: Only ${result2.enabledCount} comps passed. Falling back to nearest comps.`)

    // Sort comparables by distance
    const sortedByDistance = [...comparables].sort((a, b) => {
      const distA = a.distanceMiles ?? 999
      const distB = b.distanceMiles ?? 999
      return distA - distB
    })

    // Get IDs of nearest comps that will be used for ARV
    const nearestCompIds = new Set(
      sortedByDistance.slice(0, maxNearestComps).map((c) => c.id)
    )

    // Evaluate ALL comps with original filters to show why they failed
    // But mark only the nearest ones as enabled for ARV calculation
    const allCompsWithEvaluation: AppraisedComparable[] = result2.comparables.map((comp) => {
      const isNearestComp = nearestCompIds.has(comp.id)
      const hasValidSaleData = comp.salePrice != null && comp.salePrice > 0

      // For nearest comps with valid data: enable them (used for ARV)
      // For others: keep them disabled but show their original evaluation
      return {
        ...comp,
        isEnabled: isNearestComp && hasValidSaleData,
        // Add a note in evaluation about why it's disabled if not nearest
        evaluation: {
          ...comp.evaluation,
          // Append "not in nearest comps" reason if applicable
          disableReasons: !isNearestComp && hasValidSaleData
            ? [...comp.evaluation.disableReasons, `Not in ${maxNearestComps} nearest comps (fallback mode)`]
            : comp.evaluation.disableReasons,
        },
      }
    })

    // Sort comparables: subdivision matches first, then by distance
    // This ensures comps that don't match subdivision go to the bottom
    allCompsWithEvaluation.sort((a, b) => {
      const aSubdivisionMatch = a.evaluation.filterResults.find(f => f.type === 'subdivision_match')?.passed ?? false
      const bSubdivisionMatch = b.evaluation.filterResults.find(f => f.type === 'subdivision_match')?.passed ?? false

      // Subdivision matches come first
      if (aSubdivisionMatch && !bSubdivisionMatch) return -1
      if (!aSubdivisionMatch && bSubdivisionMatch) return 1

      // Within the same subdivision match status, sort by distance
      const distA = a.distanceMiles ?? 999
      const distB = b.distanceMiles ?? 999
      return distA - distB
    })

    const enabledComps = allCompsWithEvaluation.filter((c) => c.isEnabled)
    const arv = this.calculateARV(enabledComps)

    // Use adjustedSalePrice if available, fall back to salePrice
    const enabledPrices = enabledComps
      .map((c) => c.adjustedSalePrice ?? c.salePrice)
      .filter((p): p is number => p != null && p > 0)

    const enabledSqfts = enabledComps
      .map((c) => c.squareFeet)
      .filter((s): s is number => s != null && s > 0)

    const avgPricePerSqft =
      enabledSqfts.length > 0 && arv > 0
        ? Math.round(arv / (enabledSqfts.reduce((a, b) => a + b, 0) / enabledSqfts.length))
        : null

    const medianSalePrice = enabledPrices.length > 0 ? calculateMedian(enabledPrices) : null

    // Get the farthest enabled comp's distance for the reason message
    const farthestEnabledComp = enabledComps[enabledComps.length - 1]

    return {
      subject,
      comparables: allCompsWithEvaluation,
      enabledCount: enabledComps.length,
      disabledCount: allCompsWithEvaluation.length - enabledComps.length,
      appliedFilters: defaultFilters, // Show original filters (not minimal) so user sees why comps failed
      appliedAdjustments: adjustments,
      arv,
      avgPricePerSqft,
      medianSalePrice,
      fallbackUsed: 'nearest_comps',
      fallbackReason: `Insufficient matching comps. Using ${enabledComps.length} nearest comps within ${farthestEnabledComp?.distanceMiles?.toFixed(2) ?? '?'} miles.`,
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
   * - Tier 1 (Primary): Comps matching subject classification (weight: 70-90%)
   * - Tier 2 (Support): Comps with opposite classification (weight: 10-30%)
   *
   * WEIGHTING PHILOSOPHY:
   * - For ARV: After-Renovation comps weighted heavily
   * - For Buy Price: As-Is comps provide current market value
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

    for (const comp of enabledComps) {
      const classification = compClassifications.get(comp.id)?.classification ?? 'as_is'
      if (classification === 'as_is') {
        asIsCompIds.push(comp.id)
      } else {
        afterRenovationCompIds.push(comp.id)
      }
    }

    // Calculate weight factors and breakdown for each comp
    const weightBreakdown: CompWeightBreakdown[] = []

    for (const comp of enabledComps) {
      const price = comp.adjustedSalePrice ?? comp.salePrice
      if (price == null || price <= 0) continue

      const compClassification = compClassifications.get(comp.id)
      const compClass = compClassification?.classification ?? 'as_is'

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
      this.calculateARV(enabledComps)
    )

    // Find best comp for ARV - ALWAYS prioritize after_renovation comps
    // ARV = After Repair Value, so we need renovated comps to determine target value
    const afterRenovationComps = weightBreakdown.filter((c) =>
      afterRenovationCompIds.includes(c.compId)
    )
    const bestComp = afterRenovationComps.length > 0
      ? afterRenovationComps.reduce((best, item) =>
          item.normalizedWeight > best.normalizedWeight ? item : best
        )
      : // Fallback to highest weighted comp if no after_renovation comps
        weightBreakdown.reduce<CompWeightBreakdown | null>(
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
      bestCompId: bestComp?.compId ?? null,
      scenarios,
      methodology,
    }
  }

  /**
   * Determine comp tier based on classification match
   *
   * Tier 1: Same classification as subject (PRIMARY)
   * Tier 2: Opposite classification (SUPPORTING)
   *
   * With only as_is and after_renovation:
   * - Same classification = Tier 1
   * - Different classification = Tier 2
   */
  private determineCompTier(
    subjectClass: PropertyClassification,
    compClass: PropertyClassification
  ): 1 | 2 {
    if (subjectClass === compClass) {
      return 1 // Same classification = primary match
    }

    // Different classification = supporting data
    return 2
  }

  /**
   * Calculate weight factors for a single comp
   *
   * Expert Underwriter Weighting:
   * - Classification match is the MOST IMPORTANT factor (0.5-2.0)
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
    const compClass = compClassification?.classification ?? 'as_is'

    // 1. CLASSIFICATION MATCH (0.5 to 2.0) - CRITICAL FACTOR
    // This is the most important factor for accurate valuation
    let classificationMatch: number
    if (compClass === subjectClass) {
      // Same classification = full weight
      classificationMatch = 2.0
    } else {
      // Different classification = reduced weight
      // after_renovation comps for as_is subject help estimate potential ARV
      // as_is comps for after_renovation subject help validate discount
      classificationMatch = 0.7
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
   * - Tier 1 comps (same classification) are primary
   * - Tier 2 comps (opposite classification) are supporting
   */
  private calculateFinalARV(
    subjectClass: PropertyClassification,
    breakdown: CompWeightBreakdown[],
    asIsValue: number | null,
    afterRenovationValue: number | null,
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
      methodology = `Weighted average of ${tier1Comps.length} ${subjectClass === 'as_is' ? 'As-Is' : 'After-Renovation'} comps (Tier 1 primary)`
    } else if (tier1Comps.length === 1 && tier2Comps.length >= 1) {
      // One primary comp + opposite classification support
      const tier1Weight = 0.7
      const tier2Weight = 0.3
      const tier1Price = tier1Comps[0].price
      const tier2Total = tier2Comps.reduce((sum, c) => sum + c.weight, 0)
      const tier2Avg = tier2Comps.reduce((sum, c) => sum + c.price * (c.weight / tier2Total), 0)
      arv = Math.round(tier1Price * tier1Weight + tier2Avg * tier2Weight)
      methodology = `Blended: 1 primary ${subjectClass} comp (70%) + ${tier2Comps.length} supporting comps (30%)`
    } else if (tier2Comps.length >= 2) {
      // No primary comps - use opposite classification comps
      const tier2Total = tier2Comps.reduce((sum, c) => sum + c.weight, 0)
      arv = Math.round(
        tier2Comps.reduce((sum, c) => sum + c.price * (c.weight / tier2Total), 0)
      )
      methodology = `Weighted average of ${tier2Comps.length} ${subjectClass === 'as_is' ? 'After-Renovation' : 'As-Is'} comps (no ${subjectClass} comps found)`
    } else if (breakdown.length > 0) {
      // Use all available comps
      const totalWeight = breakdown.reduce((sum, c) => sum + c.weight, 0)
      arv = Math.round(
        breakdown.reduce((sum, c) => sum + c.price * (c.weight / totalWeight), 0)
      )
      methodology = `Weighted average of ${breakdown.length} available comps`
    } else {
      // Last resort: use after_renovation value if available, otherwise fallback
      arv = afterRenovationValue ?? asIsValue ?? fallbackArv
      methodology = 'Fallback ARV (no comps with valid pricing)'
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
            : 'Subject already renovated - limited upside.')
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
