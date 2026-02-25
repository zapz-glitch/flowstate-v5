/**
 * Shared Analysis Service
 *
 * Common functions used by both sync and async analysis endpoints.
 * Ensures consistent behavior between /analyze (sync) and /analyze/async (queue-based).
 */

import type { PropertyBundle } from '../property-api'
import type { AppraisedComparable, AppraisalResultWithFallback, WeightedARVResult } from '../appraisal'
import type { CompSelectionResult } from '../comp-selection'
import type { PhotoBundle } from '../photo-provider'
import type { MajorItem } from '../valuation'
import type { ClassificationResult, PropertyClassification } from '../classification'

// Re-export for convenience
export type { PropertyBundle } from '../property-api'
export type { AppraisedComparable, AppraisalResultWithFallback } from '../appraisal'
export type { CompSelectionResult } from '../comp-selection'
export type { PhotoBundle } from '../photo-provider'

// ─── Date Formatting ─────────────────────────────────────────────────────────

/**
 * Format date to ISO format (YYYY-MM-DD)
 * Handles both YYYYMMDD and ISO formats
 */
export function formatDate(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null

  // Already in ISO format
  if (dateStr.includes('-')) {
    return dateStr.split('T')[0]
  }

  // Parse YYYYMMDD format
  if (/^\d{8}$/.test(dateStr)) {
    const year = dateStr.substring(0, 4)
    const month = dateStr.substring(4, 6)
    const day = dateStr.substring(6, 8)
    return `${year}-${month}-${day}`
  }

  return dateStr
}

// ─── Comp Quality Scoring ────────────────────────────────────────────────────

/**
 * Get the number of filters passed by a comp
 */
export function getFilterPassCount(comp: AppraisedComparable): {
  passed: number
  total: number
  passRate: number
} {
  if (!comp.evaluation?.filterResults) {
    return { passed: 0, total: 0, passRate: comp.isEnabled ? 1 : 0 }
  }

  const total = comp.evaluation.filterResults.length
  const passed = comp.evaluation.filterResults.filter((f) => f.passed).length

  return {
    passed,
    total,
    passRate: total > 0 ? passed / total : comp.isEnabled ? 1 : 0,
  }
}

/**
 * Calculate a quality score for a comp based on:
 * 1. Appraisal filter pass rate (PRIMARY - 50 points)
 * 2. Data similarity to subject (SECONDARY - 50 points)
 *
 * Higher score = better comp
 *
 * Scoring breakdown:
 * - Filter pass rate: 0-50 points (more filters passed = better)
 * - Distance: 0-15 points penalty (closer is better)
 * - Square footage similarity: 0-12 points penalty
 * - Recency: 0-12 points bonus (more recent is better)
 * - Year built similarity: 0-11 points penalty
 */
export function calculateCompQualityScore(
  comp: AppraisedComparable,
  subjectSqft: number | null,
  subjectYearBuilt: number | null
): number {
  let score = 0

  // ─── PRIMARY: Appraisal Filter Pass Rate (0-50 points) ───────────────────
  // This is the most important factor - comps that pass more filters are better
  const filterStats = getFilterPassCount(comp)
  score += filterStats.passRate * 50

  // ─── SECONDARY: Data Similarity (0-50 points, starts at 50) ──────────────
  let dataScore = 50

  // Distance penalty (0-15 points) - closer is better
  if (comp.distanceMiles !== null) {
    // 0 miles = 0 penalty, 1 mile = 15 penalty
    const distancePenalty = Math.min(15, comp.distanceMiles * 15)
    dataScore -= distancePenalty
  }

  // Square footage similarity (0-12 points penalty)
  if (subjectSqft && comp.squareFeet) {
    const sqftDiff = Math.abs(comp.squareFeet - subjectSqft)
    const sqftPctDiff = sqftDiff / subjectSqft
    // 0% diff = 0 penalty, 20%+ diff = 12 penalty
    const sqftPenalty = Math.min(12, sqftPctDiff * 60)
    dataScore -= sqftPenalty
  }

  // Recency bonus (0-12 points) - more recent is better
  if (comp.saleDate) {
    const saleDate = new Date(formatDate(comp.saleDate) || comp.saleDate)
    const daysSinceSale = Math.floor((Date.now() - saleDate.getTime()) / (1000 * 60 * 60 * 24))
    // 0 days = 12 bonus, 365 days = 0 bonus
    const recencyBonus = Math.max(0, 12 - (daysSinceSale / 365) * 12)
    dataScore += recencyBonus - 12 // Normalize: recent sales don't get penalized
  } else {
    dataScore -= 8 // No sale date = penalty
  }

  // Year built similarity (0-11 points penalty)
  if (subjectYearBuilt && comp.yearBuilt) {
    const yearDiff = Math.abs(comp.yearBuilt - subjectYearBuilt)
    // 0 years diff = 0 penalty, 20+ years = 11 penalty
    const yearPenalty = Math.min(11, yearDiff * 0.55)
    dataScore -= yearPenalty
  }

  score += Math.max(0, dataScore)

  return Math.max(0, Math.min(100, score))
}

/**
 * Select best comp based on data quality when LLM selection is not available
 */
export function selectBestCompFromData(
  comps: AppraisedComparable[],
  subjectSqft: number | null,
  subjectYearBuilt: number | null
): { bestCompId: string | null; scores: Map<string, number> } {
  if (comps.length === 0) {
    return { bestCompId: null, scores: new Map() }
  }

  const scores = new Map<string, number>()
  let bestCompId: string | null = null
  let bestScore = -1

  for (const comp of comps) {
    const score = calculateCompQualityScore(comp, subjectSqft, subjectYearBuilt)
    scores.set(comp.id, score)

    if (score > bestScore) {
      bestScore = score
      bestCompId = comp.id
    }
  }

  return { bestCompId, scores }
}

// ─── Response Building ───────────────────────────────────────────────────────

/**
 * Valuation result type (matches output from ValuationService.calculateValuation)
 */
export interface ValuationResult {
  buyPrice: number
  buyPricePercent: number
  pricePerSqft: number
  totalRehabCost: number
  rehabLevel: string
  rehabPerSqft: number
  closingCosts: number
  carryingCosts: number
  totalInvestment: number
  projectedProfit: number
  projectedROI: number
  wholesalePrice: number
  recommendation: string
  recommendationReason: string
}

/**
 * Context required for building analysis response
 */
export interface ResponseContext {
  arvSource: 'appraisal' | 'comp-selection'
  finalArv: number
  bestCompId: string | null
  selectedCompIds: string[]
  dataBasedScores: Map<string, number>
  zillowUrls?: Map<string, { searchUrl: string; directUrl?: string }>
  photoProvider?: string | null
  analysisId?: string
  /** Subject property classification */
  subjectClassification?: ClassificationResult
  /** Comp classifications by ID */
  compClassifications?: Map<string, ClassificationResult>
  /** Weighted ARV result (if classification was performed) */
  weightedARVResult?: WeightedARVResult
}

/**
 * Buybox parameters for valuation
 */
export interface BuyboxParams {
  rehabLevelIndex?: number
  majorItems?: MajorItem[]
  additionPlay?: number
  closingCostsPercent?: number
  carryingCostsPercent?: number
  wholesaleFee?: number
  desiredProfit?: number
}

/**
 * Classification summary for response
 */
export interface ClassificationSummary {
  type: PropertyClassification
  confidence: number
  reasoning: string
  method?: string
}

/**
 * Analysis response structure (simplified underwriter format)
 */
export interface AnalysisResponse {
  subject: {
    address: string
    county: string | null
    bedrooms: number | null
    bathrooms: number | null
    /** @deprecated Use bedrooms and bathrooms separately */
    bedsBaths: string
    squareFeet: number | null
    lotSizeAcres: number | null
    yearBuilt: number | null
    propertyType: string | null
    /** Subdivision name (if available) */
    subdivision: string | null
    lastSale: {
      price: number
      date: string | null
      pricePerSqft: number | null
    } | null
    taxAssessment: number | null
    photos: string[]
    /** Property classification (as_is, after_renovation, transitional) */
    classification: ClassificationSummary | null
  }
  valuation: {
    arv: number
    arvSource: 'appraisal' | 'comp-selection'
    /** Methodology used to calculate ARV */
    arvMethodology: string
    arvPerSqft: number
    /** As-Is value (current market value based on as_is comps) */
    asIsValue: number | null
    /** After-Renovation value (based on after_renovation comps) */
    afterRenovationValue: number | null
    /** Raw spread between As-Is and After-Renovation */
    spread: number | null
    /** Spread analysis with profit calculation */
    spreadAnalysis: {
      asIsToArv: number | null
      potentialProfit: number | null
    } | null
    /** Investment scenarios for different strategies */
    investmentScenarios: Array<{
      strategy: 'flip' | 'rental' | 'wholesale'
      targetArv: number
      confidence: number
      notes: string
    }>
    buyPrice: number
    buyPricePercent: number
    rehabCost: number
    rehabLevel: string
    rehabPerSqft: number
    totalCosts: number
    totalInvestment: number
    projectedProfit: number
    projectedROI: number
    wholesalePrice: number
    recommendation: string
    recommendationReason: string
  }
  comps: {
    /** Total number of comps returned from API */
    total: number
    /** Number of comps that passed all filters (enabled) */
    enabledCount: number
    /** Number of comps that failed filters (disabled) */
    disabledCount: number
    avgPricePerSqft: number | null
    medianPrice: number | null
    /** IDs of comps classified as As-Is */
    asIsCompIds: string[]
    /** IDs of comps classified as After-Renovation */
    afterRenovationCompIds: string[]
    /** IDs of transitional comps */
    transitionalCompIds: string[]
    items: Array<{
      id: string
      address: string
      salePrice: number | null
      saleDate: string | null
      squareFeet: number | null
      pricePerSqft: number | null
      distanceMiles: number | null
      bedrooms: number | null
      bathrooms: number | null
      /** @deprecated Use bedrooms and bathrooms separately */
      bedsBaths: string
      yearBuilt: number | null
      adjustedPrice: number | null
      qualityScore: number | null
      condition: string | null
      isBestComp: boolean
      photos: string[]
      /** Subdivision name (if available) */
      subdivision: string | null
      /** Reason this comp was selected/analyzed (LLM reasoning) */
      selectionReason: string | null
      /** Key features identified by LLM analysis */
      keyFeatures: string[] | null
      /** Whether this comp is enabled (passed all filters) */
      isEnabled: boolean
      /** Reasons why this comp was disabled (if any) */
      disableReasons: string[]
      /** Property classification (as_is, after_renovation, transitional) */
      classification: ClassificationSummary | null
      /** Weight contribution to ARV calculation (0-1) */
      weightInArv: number | null
      /** Appraisal rule evaluation details */
      appraisalRules: {
        /** Whether this comp passed all filters */
        passedFilters: boolean
        /** Total adjustment amount applied to price */
        totalAdjustment: number
        /** Filter results - which rules matched/failed */
        filters: Array<{
          type: string
          passed: boolean
          reason?: string
          actualValue?: number | string | null
          threshold?: number | string | null
        }>
        /** Adjustment results - what price adjustments were applied */
        adjustments: Array<{
          type: string
          applied: boolean
          amount: number
          reason?: string
        }>
      } | null
    }>
  }
  riskFlags: string[] | null
  permits: {
    count: number
    totalValue: number | null
    recentTypes: string[]
  } | null
  floodZone: {
    zone: string | null
    inFloodZone: boolean
    description: string | null
  } | null
  meta: {
    analysisId: string
    timestamp: string
    dataProvider: string | null
  }
}

/**
 * Build streamlined underwriter-focused response
 * Returns only essential data for investment decisions
 *
 * This is the single source of truth for response format.
 * Used by both sync and async endpoints.
 */
export function buildAnalysisResponse(
  bundle: PropertyBundle,
  appraisalResult: AppraisalResultWithFallback,
  photoBundle: PhotoBundle | null,
  compSelectionResult: CompSelectionResult | null,
  valuation: ValuationResult,
  ctx: ResponseContext
): AnalysisResponse {
  const { property, enrichment } = bundle
  const { arvSource, finalArv, bestCompId, selectedCompIds, dataBasedScores } = ctx

  // Get subject photos
  const subjectPhotos = photoBundle?.subject?.photos.slice(0, 5) ?? []

  // Build risk flags for underwriter attention
  const riskFlags: string[] = []
  if (enrichment.floodZone?.isInFloodZone) {
    riskFlags.push(`Flood Zone: ${enrichment.floodZone.floodZone}`)
  }
  if (property.transaction?.isForeclosure) riskFlags.push('Foreclosure')
  if (property.transaction?.isShortSale) riskFlags.push('Short Sale')
  if (property.yearBuilt && property.yearBuilt < 1978) riskFlags.push('Pre-1978 (Lead Paint)')
  if (enrichment.permits?.items.some((p) => p.jobValue && p.jobValue > 50000)) {
    riskFlags.push('Major Permits (>$50K)')
  }

  // Get enabled and disabled comp counts
  const enabledComps = appraisalResult.comparables.filter((c) => c.isEnabled)
  const disabledComps = appraisalResult.comparables.filter((c) => !c.isEnabled)

  // Get best comp selection reason if this is the best comp
  const bestCompSelectionReason = compSelectionResult?.bestComp?.selectionReason ?? null

  // Return ALL comps (both enabled and disabled) with evaluation details
  // Sort: enabled comps first (sorted by quality), then disabled comps (sorted by distance)
  const allComps = [
    ...enabledComps.sort((a, b) => {
      // Sort enabled comps by quality score (higher first) or distance (closer first)
      const scoreA = dataBasedScores.get(a.id) ?? 0
      const scoreB = dataBasedScores.get(b.id) ?? 0
      if (scoreA !== scoreB) return scoreB - scoreA
      return (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999)
    }),
    ...disabledComps.sort((a, b) => {
      // Sort disabled comps by distance (closer first)
      return (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999)
    }),
  ].map((comp) => {
    const analysis = compSelectionResult?.allAnalyses.find((a) => a.compId === comp.id)
    const compPhotos = photoBundle?.comps[comp.id]?.photos.slice(0, 3) ?? []

    // Use LLM analysis score if available, otherwise use data-based score (only for enabled comps)
    const qualityScore = comp.isEnabled
      ? (analysis?.qualityScore ?? dataBasedScores.get(comp.id) ?? null)
      : null

    // For best comp, use the selection reason; for others, use the analysis reasoning
    const isBest = comp.id === bestCompId
    const selectionReason = isBest
      ? bestCompSelectionReason
      : analysis?.reasoning ?? null

    // Build appraisal rule details from evaluation
    const evaluation = comp.evaluation
    const appraisalRules = evaluation
      ? {
          passedFilters: !evaluation.shouldDisable,
          totalAdjustment: evaluation.totalAdjustment,
          filters: evaluation.filterResults.map((f) => ({
            type: f.type,
            passed: f.passed,
            reason: f.reason,
            actualValue: f.actualValue ?? null,
            threshold: f.threshold ?? null,
          })),
          adjustments: evaluation.adjustmentResults
            .filter((a) => a.applied) // Only show adjustments that were actually applied
            .map((a) => ({
              type: a.type,
              applied: a.applied,
              amount: a.amount,
              reason: a.reason,
            })),
        }
      : null

    // Get classification for this comp
    const compClassification = ctx.compClassifications?.get(comp.id)
    const classificationSummary: ClassificationSummary | null = compClassification
      ? {
          type: compClassification.classification,
          confidence: compClassification.confidence,
          reasoning: compClassification.reasoning,
          method: compClassification.method,
        }
      : null

    // Get weight from weighted ARV result
    const weightBreakdown = ctx.weightedARVResult?.weightBreakdown.find((w) => w.compId === comp.id)
    const weightInArv = weightBreakdown?.normalizedWeight ?? null

    return {
      id: comp.id,
      address: `${comp.address}, ${comp.city}, ${comp.state}`,
      salePrice: comp.salePrice,
      saleDate: formatDate(comp.saleDate),
      squareFeet: comp.squareFeet,
      pricePerSqft: comp.pricePerSqft,
      distanceMiles: comp.distanceMiles,
      bedrooms: comp.bedrooms ?? null,
      bathrooms: comp.bathrooms ?? null,
      bedsBaths: `${comp.bedrooms ?? '-'}/${comp.bathrooms ?? '-'}`,
      yearBuilt: comp.yearBuilt,
      adjustedPrice: comp.adjustedSalePrice,
      qualityScore: qualityScore !== null ? Math.round(qualityScore) : null,
      condition: analysis?.comparisonToSubject ?? null,
      isBestComp: isBest,
      photos: compPhotos,
      subdivision: comp.subdivision ?? null,
      selectionReason,
      keyFeatures: analysis?.keyFeatures ?? null,
      isEnabled: comp.isEnabled,
      disableReasons: evaluation?.disableReasons ?? [],
      classification: classificationSummary,
      weightInArv: weightInArv !== null ? Math.round(weightInArv * 1000) / 1000 : null,
      appraisalRules,
    }
  })

  // Generate analysis ID if not provided
  const analysisId = ctx.analysisId || `analysis_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`

  // Build subject classification summary
  const subjectClassificationSummary: ClassificationSummary | null = ctx.subjectClassification
    ? {
        type: ctx.subjectClassification.classification,
        confidence: ctx.subjectClassification.confidence,
        reasoning: ctx.subjectClassification.reasoning,
        method: ctx.subjectClassification.method,
      }
    : null

  // Build spread analysis (if we have both as-is and ARV values)
  const asIsValue = ctx.weightedARVResult?.asIsValue ?? null
  const afterRenovationValue = ctx.weightedARVResult?.afterRenovationValue ?? null
  const spread = ctx.weightedARVResult?.spread ?? null
  const spreadAnalysis =
    asIsValue !== null && afterRenovationValue !== null
      ? {
          asIsToArv: afterRenovationValue - asIsValue,
          potentialProfit: afterRenovationValue - asIsValue - valuation.totalRehabCost,
        }
      : null

  // Get investment scenarios and methodology from weighted ARV result
  const investmentScenarios = ctx.weightedARVResult?.scenarios ?? []
  const arvMethodology = ctx.weightedARVResult?.methodology ?? 'Simple average'

  return {
    // ═══ SUBJECT PROPERTY ═══════════════════════════════════════════════════
    subject: {
      address: `${property.address}, ${property.city}, ${property.state} ${property.zipCode}`,
      county: property.county ?? null,
      bedrooms: property.bedrooms ?? null,
      bathrooms: property.bathrooms ?? null,
      bedsBaths: `${property.bedrooms ?? '-'}/${property.bathrooms ?? '-'}`,
      squareFeet: property.squareFeet ?? null,
      lotSizeAcres: property.lotSizeAcres ?? null,
      yearBuilt: property.yearBuilt ?? null,
      propertyType: property.propertyType ?? null,
      subdivision: property.subdivision ?? null,
      lastSale: property.lastSalePrice
        ? {
            price: property.lastSalePrice,
            date: property.lastSaleDate ?? null,
            pricePerSqft: property.pricePerSqft ?? null,
          }
        : null,
      taxAssessment: property.assessedValue ?? null,
      photos: subjectPhotos,
      classification: subjectClassificationSummary,
    },

    // ═══ VALUATION SUMMARY ══════════════════════════════════════════════════
    valuation: {
      arv: finalArv,
      arvSource: arvSource,
      arvMethodology,
      arvPerSqft: valuation.pricePerSqft,
      asIsValue,
      afterRenovationValue,
      spread,
      spreadAnalysis,
      investmentScenarios: investmentScenarios.map((s) => ({
        strategy: s.strategy,
        targetArv: s.targetArv,
        confidence: s.confidence,
        notes: s.notes,
      })),
      buyPrice: valuation.buyPrice,
      buyPricePercent: valuation.buyPricePercent,
      rehabCost: valuation.totalRehabCost,
      rehabLevel: valuation.rehabLevel,
      rehabPerSqft: valuation.rehabPerSqft,
      totalCosts: valuation.closingCosts + valuation.carryingCosts,
      totalInvestment: valuation.totalInvestment,
      projectedProfit: valuation.projectedProfit,
      projectedROI: valuation.projectedROI,
      wholesalePrice: valuation.wholesalePrice,
      recommendation: valuation.recommendation,
      recommendationReason: valuation.recommendationReason,
    },

    // ═══ COMPARABLE SALES (All comps with enable/disable status) ═══════════════
    comps: {
      total: appraisalResult.comparables.length,
      enabledCount: enabledComps.length,
      disabledCount: disabledComps.length,
      avgPricePerSqft: appraisalResult.avgPricePerSqft,
      medianPrice: appraisalResult.medianSalePrice,
      asIsCompIds: ctx.weightedARVResult?.asIsCompIds ?? [],
      afterRenovationCompIds: ctx.weightedARVResult?.afterRenovationCompIds ?? [],
      transitionalCompIds: ctx.weightedARVResult?.transitionalCompIds ?? [],
      items: allComps,
    },

    // ═══ RISK FLAGS ═════════════════════════════════════════════════════════
    riskFlags: riskFlags.length > 0 ? riskFlags : null,

    // ═══ PERMITS (if significant) ═══════════════════════════════════════════
    permits: enrichment.permits
      ? {
          count: enrichment.permits.count,
          totalValue: enrichment.permits.totalJobValue ?? null,
          recentTypes: (enrichment.permits.recentPermitTypes ?? []).slice(0, 5),
        }
      : null,

    // ═══ FLOOD ZONE ═════════════════════════════════════════════════════════
    floodZone: enrichment.floodZone
      ? {
          zone: enrichment.floodZone.floodZone,
          inFloodZone: enrichment.floodZone.isInFloodZone,
          description: enrichment.floodZone.floodZoneDescription,
        }
      : null,

    // ═══ METADATA ═══════════════════════════════════════════════════════════
    meta: {
      analysisId,
      timestamp: new Date().toISOString(),
      dataProvider: property.provider,
    },
  }
}
