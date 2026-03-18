/**
 * Property Evaluation Service
 *
 * Synchronous evaluation pipeline: appraisal → price classification → valuation.
 * No external API calls — pure CPU computation on CoreLogic data.
 */

import type { PropertyBundle } from '../property-api'
import type { NormalizedComparable, NormalizedProperty } from '../property-api/types'
import {
  createAppraisalService,
  DEFAULT_FILTERS,
  DEFAULT_ADJUSTMENTS,
  type AppraisedComparable,
  type AppraisalResultWithFallback,
  type AppraisalFilter,
  type AppraisalAdjustment,
} from '../appraisal'
import { createValuationService, MAJOR_ITEMS, type MajorItem } from '../valuation'
import type { ClassificationResult } from '../classification'
import type { RehabTable, TierRangeDefinition } from '@flowstate-api/shared/valuation'
import {
  buildAnalysisResponse,
  calculateAllRehabLevelEstimates,
  type AnalysisResponse,
  type ApiCallStats,
} from '../analysis'
import { generateZillowUrl } from '../photo-provider'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EvaluationParams {
  jobId: string
  bundle: PropertyBundle
  appraisalRules?: {
    filters?: AppraisalFilter[]
    adjustments?: AppraisalAdjustment[]
  }
  buybox?: {
    rehabLevelIndex?: number
    majorItems?: MajorItem[]
    additionPlay?: number
    closingCostsPercent?: number
    carryingCostsPercent?: number
    wholesaleFee?: number
    desiredProfit?: number
  }
  customRehabTable?: RehabTable
  customTierRanges?: TierRangeDefinition[]
  customMajorItemCosts?: Record<string, number>
  /** ARV comp threshold: top % of comps by sale price for ARV calculation */
  arvThreshold?: { percent: number }
  /** Threshold for Group B: comps with salePrice <= X% of ARV (default: 70) */
  asIsThresholdPercent?: number
  apiCallStats?: ApiCallStats
}

export interface GroupBResult {
  /** Comp IDs included in Group B (as-is market comps) */
  compIds: string[]
  /** Weighted average as-is price (sqft-scaled to subject) */
  asIsMarketPrice: number | null
  /** Average $/sqft across Group B comps */
  avgPricePerSqft: number | null
  /** Number of comps that qualified */
  count: number
  /** Threshold used: salePrice <= X% of ARV */
  thresholdPercent: number
  /** The ARV value used to determine the threshold */
  arvUsed: number
  /** Price ceiling: arvUsed * thresholdPercent / 100 */
  priceCeiling: number
}

export interface EvaluationResult {
  response: AnalysisResponse
  appraisalResult: AppraisalResultWithFallback
  compClassifications: Map<string, ClassificationResult>
  /** Group B as-is market intelligence (display only) */
  groupB: GroupBResult | null
}

// ─── Price Classification ────────────────────────────────────────────────────

/**
 * Classify comps by sale price percentile.
 * Top X% by sale price are considered "renovated" (higher price = better condition).
 */
export function classifyCompsByPrice(
  comparables: NormalizedComparable[],
  topPercentile: number
): Map<string, ClassificationResult> {
  const classifications = new Map<string, ClassificationResult>()

  const withPrice = comparables
    .filter(c => c.salePrice != null && c.salePrice > 0)
    .map(c => ({ id: c.id, salePrice: c.salePrice! }))
    .sort((a, b) => b.salePrice - a.salePrice)

  if (withPrice.length === 0) return classifications

  const topCount = Math.max(1, Math.ceil(withPrice.length * topPercentile / 100))
  const topIds = new Set(withPrice.slice(0, topCount).map(c => c.id))
  const threshold = withPrice[topCount - 1]?.salePrice ?? 0

  for (const comp of comparables) {
    const isRenovated = topIds.has(comp.id)
    classifications.set(comp.id, {
      classification: isRenovated ? 'after_renovation' : 'as_is',
      confidence: isRenovated ? 75 : 60,
      method: 'price_analysis',
      reasoning: isRenovated
        ? `Sale price in top ${topPercentile}% (≥$${Math.round(threshold).toLocaleString()})`
        : `Sale price below top ${topPercentile}% threshold`,
      indicators: {},
    })
  }

  return classifications
}

// ─── Best Match Selection ────────────────────────────────────────────────────

function selectBestMatch(
  subject: NormalizedProperty,
  enabledComps: AppraisedComparable[]
): { compId: string; reasoning: string } | undefined {
  if (enabledComps.length === 0) return undefined
  if (enabledComps.length === 1) {
    return { compId: enabledComps[0].id, reasoning: 'Only comparable that passed all appraisal criteria.' }
  }

  const scored = enabledComps.map((comp) => {
    let score = 0
    const reasons: string[] = []

    // Higher price per sqft
    if (comp.salePrice && comp.squareFeet && comp.squareFeet > 0) {
      const pricePerSqft = comp.salePrice / comp.squareFeet
      score += Math.min(100, Math.round(pricePerSqft / 3))
      reasons.push(`$${Math.round(pricePerSqft)}/sqft`)
    }

    // Subdivision match
    const subMatch = comp.evaluation.filterResults.find((f) => f.type === 'subdivision_match')?.passed
    if (subMatch) {
      score += 50
      reasons.push('same subdivision')
    }

    // Sqft similarity
    if (subject.squareFeet && comp.squareFeet) {
      const sqftDiff = Math.abs(subject.squareFeet - comp.squareFeet) / subject.squareFeet
      score += Math.max(0, 30 - Math.round(sqftDiff * 100))
    }

    // Proximity
    if (comp.distanceMiles != null) {
      score += Math.max(0, 20 - Math.round(comp.distanceMiles * 20))
    }

    // Fewer adjustments = more reliable
    const adjCount = comp.evaluation.adjustmentResults.filter((a) => a.applied).length
    score += Math.max(0, 10 - adjCount * 3)

    return { comp, score, reasons }
  })

  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]

  return {
    compId: best.comp.id,
    reasoning: `Best match: ${best.reasons.join(', ')}. Score: ${best.score}.`,
  }
}

// ─── Group A: Smart Comp Selection ──────────────────────────────────────────

/**
 * Select Group A comps (top percentile by sale price) with smart relaxation.
 *
 * Relaxation order within each percentile attempt:
 *   Pass 1: ALL filters (subdivision + building style + numeric)
 *   Pass 2: Relax boolean filters only (disable subdivision_match + building_style_match)
 * Then widen percentile by 1.5x and repeat (up to 3 attempts).
 * Final fallback: all comps with standard 3-pass system.
 */
function selectGroupAComps(
  subject: NormalizedProperty,
  allComparables: NormalizedComparable[],
  baseThreshold: number,
  appraisalService: ReturnType<typeof createAppraisalService>,
  filters: AppraisalFilter[],
  adjustments: AppraisalAdjustment[],
): {
  appraisalResult: AppraisalResultWithFallback
  arvCompsSource: 'group_a' | 'all_comps'
  compClassifications: Map<string, ClassificationResult>
  groupACompIds: Set<string>
} {
  const MAX_ATTEMPTS = 3
  const BOOLEAN_FILTER_TYPES = new Set(['subdivision_match', 'building_style_match'])

  // Filters without boolean matchers (for relaxation pass 2)
  const numericOnlyFilters = filters.map((f) =>
    BOOLEAN_FILTER_TYPES.has(f.type) ? { ...f, enabled: false } : f
  )

  let currentThreshold = baseThreshold
  let compClassifications: Map<string, ClassificationResult> = new Map()
  let groupACompIds = new Set<string>()

  for (let attempt = 0; attempt < MAX_ATTEMPTS && currentThreshold <= 100; attempt++) {
    compClassifications = classifyCompsByPrice(allComparables, currentThreshold)
    groupACompIds = new Set<string>()
    for (const [id, cls] of compClassifications) {
      if (cls.classification === 'after_renovation') groupACompIds.add(id)
    }
    const candidateComps = allComparables.filter((c) => groupACompIds.has(c.id))

    if (candidateComps.length > 0) {
      // Pass 1: Full filters (including subdivision + building style)
      const fullResult = appraisalService.evaluateWithFallback(
        subject, candidateComps, { filters, adjustments, minComps: 1 }
      )
      if (fullResult.fallbackUsed !== 'no_comps') {
        if (currentThreshold !== baseThreshold) {
          console.log(`[Evaluate] Group A threshold widened: ${baseThreshold}% → ${currentThreshold}%`)
        }
        // Evaluate ALL comps for display context
        const allResult = appraisalService.evaluate(subject, allComparables, { filters, adjustments })
        const enabledIds = new Set(fullResult.comparables.filter((c) => c.isEnabled).map((c) => c.id))
        return {
          appraisalResult: buildGroupAResult(allResult, fullResult, enabledIds, groupACompIds, allComparables),
          arvCompsSource: 'group_a',
          compClassifications,
          groupACompIds: enabledIds,
        }
      }

      // Pass 2: Relax boolean filters only (keep numeric strict)
      const relaxedResult = appraisalService.evaluateWithFallback(
        subject, candidateComps, { filters: numericOnlyFilters, adjustments, minComps: 1 }
      )
      if (relaxedResult.fallbackUsed !== 'no_comps') {
        console.log(`[Evaluate] Group A: relaxed boolean filters at ${currentThreshold}%`)
        const allResult = appraisalService.evaluate(subject, allComparables, { filters, adjustments })
        const enabledIds = new Set(relaxedResult.comparables.filter((c) => c.isEnabled).map((c) => c.id))
        return {
          appraisalResult: buildGroupAResult(allResult, relaxedResult, enabledIds, groupACompIds, allComparables),
          arvCompsSource: 'group_a',
          compClassifications,
          groupACompIds: enabledIds,
        }
      }
    }

    // Widen by 1.5x for next attempt
    const nextThreshold = Math.ceil(currentThreshold * 1.5)
    if (nextThreshold === currentThreshold) break
    currentThreshold = Math.min(nextThreshold, 100)
  }

  // Final fallback: all comps with standard 3-pass
  console.log(`[Evaluate] Group A: falling back to all comps`)
  const fallbackResult = appraisalService.evaluateWithFallback(
    subject, allComparables, { filters, adjustments, minComps: 3 }
  )
  const enabledIds = new Set(fallbackResult.comparables.filter((c) => c.isEnabled).map((c) => c.id))
  return {
    appraisalResult: fallbackResult,
    arvCompsSource: 'all_comps',
    compClassifications,
    groupACompIds: enabledIds,
  }
}

/** Build the final Group A appraisal result with proper enable/disable reasons for all comps */
function buildGroupAResult(
  allCompsResult: import('../appraisal').AppraisalResult,
  groupAResult: AppraisalResultWithFallback,
  enabledIds: Set<string>,
  topPercentileIds: Set<string>,
  allComparables: NormalizedComparable[],
): AppraisalResultWithFallback {
  return {
    ...allCompsResult,
    comparables: allCompsResult.comparables.map((c) => {
      if (enabledIds.has(c.id)) {
        const groupComp = groupAResult.comparables.find((rc) => rc.id === c.id)
        return groupComp ? { ...groupComp, isEnabled: true } : { ...c, isEnabled: true }
      }
      const inTopPercentile = topPercentileIds.has(c.id)
      const disableReason = inTopPercentile
        ? 'In top price percentile but excluded by appraisal rules'
        : 'Below ARV comp threshold (not in top price percentile)'
      return {
        ...c,
        isEnabled: false,
        evaluation: {
          ...c.evaluation,
          shouldDisable: true,
          disableReasons: [...(c.evaluation.disableReasons ?? []), disableReason],
        },
      }
    }),
    arv: groupAResult.arv,
    enabledCount: enabledIds.size,
    disabledCount: allComparables.length - enabledIds.size,
    fallbackUsed: groupAResult.fallbackUsed,
    confidence: groupAResult.confidence,
  }
}

// ─── Group B: As-Is Market Intelligence ─────────────────────────────────────

/**
 * Select Group B comps: sale price ≤ X% of ARV, not in Group A.
 * Single-pass evaluation (no fallback) — informational only.
 * Returns sqft-scaled average price as the as-is market price.
 */
function selectGroupBComps(
  subject: NormalizedProperty,
  allComparables: NormalizedComparable[],
  arv: number,
  thresholdPercent: number,
  groupACompIds: Set<string>,
  appraisalService: ReturnType<typeof createAppraisalService>,
  filters: AppraisalFilter[],
  adjustments: AppraisalAdjustment[],
): GroupBResult | null {
  const priceCeiling = arv * thresholdPercent / 100
  const subjectSqft = subject.squareFeet || 0

  // Filter: below price ceiling AND not in Group A
  const candidates = allComparables.filter((c) =>
    c.salePrice != null && c.salePrice > 0 && c.salePrice <= priceCeiling && !groupACompIds.has(c.id)
  )

  if (candidates.length === 0) return null

  // Single-pass evaluation (no fallback — informational)
  const result = appraisalService.evaluate(subject, candidates, { filters, adjustments })
  const passingComps = result.comparables.filter((c) => c.isEnabled)

  if (passingComps.length === 0) {
    // Even without filter matches, show the raw candidates as Group B
    const rawPrices = candidates
      .filter((c) => c.salePrice != null && c.squareFeet && c.squareFeet > 0)
      .map((c) => (c.salePrice! / c.squareFeet!) * subjectSqft)
    const avgPrice = rawPrices.length > 0 ? Math.round(rawPrices.reduce((a, b) => a + b, 0) / rawPrices.length) : null
    const avgPsf = rawPrices.length > 0 && subjectSqft > 0 ? Math.round((avgPrice ?? 0) / subjectSqft) : null

    return {
      compIds: candidates.map((c) => c.id),
      asIsMarketPrice: avgPrice,
      avgPricePerSqft: avgPsf,
      count: candidates.length,
      thresholdPercent,
      arvUsed: arv,
      priceCeiling: Math.round(priceCeiling),
    }
  }

  // Calculate sqft-scaled average from passing comps (same formula as ARV)
  const scaledPrices = passingComps
    .filter((c) => c.adjustedSalePrice != null && c.squareFeet && c.squareFeet > 0)
    .map((c) => (c.adjustedSalePrice! / c.squareFeet!) * subjectSqft)

  const asIsMarketPrice = scaledPrices.length > 0
    ? Math.round(scaledPrices.reduce((a, b) => a + b, 0) / scaledPrices.length)
    : null
  const avgPricePerSqft = asIsMarketPrice != null && subjectSqft > 0
    ? Math.round(asIsMarketPrice / subjectSqft)
    : null

  return {
    compIds: passingComps.map((c) => c.id),
    asIsMarketPrice,
    avgPricePerSqft,
    count: passingComps.length,
    thresholdPercent,
    arvUsed: arv,
    priceCeiling: Math.round(priceCeiling),
  }
}

// ─── Main Evaluation ─────────────────────────────────────────────────────────

/**
 * Perform full property evaluation synchronously.
 * Returns the complete analysis response ready to send to the client.
 *
 * Pipeline:
 * 1. Group A: Select top-percentile comps by sale price with smart relaxation
 * 2. Calculate ARV from Group A comps
 * 3. Group B: Select as-is comps (≤70% of ARV) — market intelligence only
 * 4. Calculate valuation (ARV, rehab, buy price, profit, ROI)
 * 5. Build response
 */
export function performAnalysis(params: EvaluationParams): EvaluationResult {
  const { bundle, jobId } = params
  const appraisalService = createAppraisalService()
  const rules = params.appraisalRules ?? {}
  const filters = rules.filters ?? DEFAULT_FILTERS
  const adjustments = rules.adjustments ?? DEFAULT_ADJUSTMENTS

  // ── 1. Group A: Select top-percentile comps ────────────────────────────────
  const arvThreshold = params.arvThreshold ?? { percent: 10 }
  const allComparables = bundle.comparables

  const groupA = selectGroupAComps(
    bundle.property, allComparables, arvThreshold.percent,
    appraisalService, filters, adjustments
  )

  const finalAppraisalResult = groupA.appraisalResult
  const compClassifications = groupA.compClassifications

  if (finalAppraisalResult.fallbackUsed === 'no_comps') {
    throw new Error('BAD_DEAL: No comparable sales found even with relaxed criteria. Insufficient data to determine ARV.')
  }

  // ── 2. Calculate ARV from Group A ──────────────────────────────────────────
  const enabledComps = finalAppraisalResult.comparables.filter((c) => c.isEnabled)
  const finalArv = finalAppraisalResult.arv

  // ── 3. Group B: As-is market intelligence ──────────────────────────────────
  const asIsThresholdPercent = params.asIsThresholdPercent ?? 70
  const groupBResult = selectGroupBComps(
    bundle.property, allComparables, finalArv, asIsThresholdPercent,
    groupA.groupACompIds, appraisalService, filters, adjustments
  )

  if (groupBResult) {
    console.log(`[Evaluate] Group B: ${groupBResult.count} as-is comps (≤$${groupBResult.priceCeiling.toLocaleString()}, ${asIsThresholdPercent}% of ARV)`)
  }

  // Classification summary
  const classificationSummary = appraisalService.summarizeClassifications(
    finalAppraisalResult.comparables,
    compClassifications
  )

  // ── 4. Best match + valuation ──────────────────────────────────────────────
  const bestMatch = selectBestMatch(bundle.property, enabledComps)

  const buybox = params.buybox ?? {}
  const subjectSqft = bundle.property.squareFeet || 0
  const compAvgSqft =
    enabledComps.length > 0
      ? enabledComps.reduce((sum, c) => sum + (c.squareFeet || 0), 0) / enabledComps.length
      : subjectSqft

  const selectedRehabLevelIndex = buybox.rehabLevelIndex ?? 2

  const resolvedMajorItems = buybox.majorItems ?? (
    params.customMajorItemCosts
      ? MAJOR_ITEMS.map((item) => ({
          id: item.id,
          enabled: false,
          cost: params.customMajorItemCosts![item.id] ?? item.defaultCost,
        }))
      : undefined
  )

  const valuationService = createValuationService(params.customRehabTable, params.customTierRanges)
  const valuation = valuationService.calculateValuation({
    arv: finalArv,
    subjectSqft,
    compAvgSqft,
    rehabLevelIndex: selectedRehabLevelIndex,
    majorItems: resolvedMajorItems,
    additionPlay: buybox.additionPlay ?? 0,
    closingCostsPercent: buybox.closingCostsPercent ?? 8,
    carryingCostsPercent: buybox.carryingCostsPercent ?? 2,
    wholesaleFee: buybox.wholesaleFee ?? 10000,
  })

  const rehabLevelEstimates = calculateAllRehabLevelEstimates(valuationService, {
    arv: finalArv,
    subjectSqft,
    compAvgSqft,
    selectedRehabLevelIndex,
    majorItems: resolvedMajorItems,
    additionPlay: buybox.additionPlay ?? 0,
    closingCostsPercent: buybox.closingCostsPercent ?? 8,
    carryingCostsPercent: buybox.carryingCostsPercent ?? 2,
    wholesaleFee: buybox.wholesaleFee ?? 10000,
  })

  const appliedSettings = {
    filters: filters.map((f) => ({
      type: f.type,
      enabled: f.enabled,
      value: f.value,
    })),
    adjustments: adjustments.map((a) => ({
      type: a.type,
      enabled: a.enabled,
      amount: a.amount,
      percent: a.percent,
    })),
    dealParams: {
      closingCostsPercent: buybox.closingCostsPercent ?? 8,
      carryingCostsPercent: buybox.carryingCostsPercent ?? 2,
      wholesaleFee: buybox.wholesaleFee ?? 10000,
    },
    rehabLevelIndex: selectedRehabLevelIndex,
    rehabTable: valuationService.getRehabTable(),
    majorItems: resolvedMajorItems,
    additionPlay: buybox.additionPlay ?? 0,
  }

  // ── 5. Build response ──────────────────────────────────────────────────────
  const arvSource: 'appraisal' | 'comp-selection' = groupA.arvCompsSource === 'group_a' ? 'comp-selection' : 'appraisal'
  const groupBCompIds = new Set(groupBResult?.compIds ?? [])

  const response = buildAnalysisResponse(
    bundle,
    finalAppraisalResult,
    null, // no photo bundle
    valuation,
    {
      arvSource,
      finalArv,
      analysisId: jobId,
      subjectClassification: undefined,
      compClassifications,
      classificationSummary,
      subjectSupplementedFields: [],
      compSupplementedFields: new Map(),
      rehabLevelEstimates,
      appliedSettings,
      visionAnalysis: undefined,
      apiCallStats: params.apiCallStats,
      bestMatch,
      groupBResult,
      groupACompIds: groupA.groupACompIds,
      groupBCompIds,
    }
  )

  return {
    response,
    appraisalResult: finalAppraisalResult,
    compClassifications,
    groupB: groupBResult,
  }
}
