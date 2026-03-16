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
  /** Top X% of comps by price/sqft considered "renovated" (default: 10) */
  renovatedPricePercentile?: number
  apiCallStats?: ApiCallStats
}

export interface EvaluationResult {
  response: AnalysisResponse
  appraisalResult: AppraisalResultWithFallback
  compClassifications: Map<string, ClassificationResult>
}

// ─── Price Classification ────────────────────────────────────────────────────

/**
 * Classify comps by sale price percentile.
 * Top X% by price per sqft are considered "renovated" (higher price = better condition).
 */
export function classifyCompsByPrice(
  comparables: NormalizedComparable[],
  topPercentile: number
): Map<string, ClassificationResult> {
  const classifications = new Map<string, ClassificationResult>()

  const withPricePerSqft = comparables
    .filter(c => c.salePrice != null && c.squareFeet && c.squareFeet > 0)
    .map(c => ({ id: c.id, pricePerSqft: c.salePrice! / c.squareFeet! }))
    .sort((a, b) => b.pricePerSqft - a.pricePerSqft)

  if (withPricePerSqft.length === 0) return classifications

  const topCount = Math.max(1, Math.ceil(withPricePerSqft.length * topPercentile / 100))
  const topIds = new Set(withPricePerSqft.slice(0, topCount).map(c => c.id))
  const threshold = withPricePerSqft[topCount - 1]?.pricePerSqft ?? 0

  for (const comp of comparables) {
    const isRenovated = topIds.has(comp.id)
    classifications.set(comp.id, {
      classification: isRenovated ? 'after_renovation' : 'as_is',
      confidence: isRenovated ? 75 : 60,
      method: 'price_analysis',
      reasoning: isRenovated
        ? `Price/sqft in top ${topPercentile}% (≥$${Math.round(threshold)}/sqft)`
        : `Price/sqft below top ${topPercentile}% threshold`,
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

// ─── Main Evaluation ─────────────────────────────────────────────────────────

/**
 * Perform full property evaluation synchronously.
 * Returns the complete analysis response ready to send to the client.
 *
 * Pipeline:
 * 1. Apply appraisal rules (3-pass fallback)
 * 2. Price classification (top X% = renovated)
 * 3. Renovated-first comp selection
 * 4. Calculate valuation (ARV, rehab, buy price, profit, ROI)
 * 5. Build response
 */
export function performAnalysis(params: EvaluationParams): EvaluationResult {
  const { bundle, jobId } = params
  const appraisalService = createAppraisalService()
  const rules = params.appraisalRules ?? {}
  const filters = rules.filters ?? DEFAULT_FILTERS
  const adjustments = rules.adjustments ?? DEFAULT_ADJUSTMENTS

  // ── 1. Apply appraisal rules ───────────────────────────────────────────────
  const appraisalResult = appraisalService.evaluateWithFallback(
    bundle.property,
    bundle.comparables,
    { filters, adjustments, minComps: 3 }
  )
  if (appraisalResult.fallbackUsed === 'no_comps') {
    throw new Error('BAD_DEAL: No comparable sales found even with relaxed criteria. Insufficient data to determine ARV.')
  }

  // ── 2. Price classification ────────────────────────────────────────────────
  const renovatedPricePercentile = params.renovatedPricePercentile ?? 10
  const compClassifications = classifyCompsByPrice(bundle.comparables, renovatedPricePercentile)

  // ── 3. Renovated-first comp selection ──────────────────────────────────────
  const allComparables = bundle.comparables
  const renovatedCompIds = new Set<string>()
  for (const [id, cls] of compClassifications) {
    if (cls.classification === 'after_renovation') {
      renovatedCompIds.add(id)
    }
  }
  const renovatedComps = allComparables.filter((c) => renovatedCompIds.has(c.id))

  let finalAppraisalResult: AppraisalResultWithFallback
  let arvCompsSource: 'renovated_only' | 'all_comps'

  if (renovatedComps.length > 0) {
    const renovatedAppraisal = appraisalService.evaluateWithFallback(
      bundle.property, renovatedComps, { filters, adjustments, minComps: 1 }
    )

    if (renovatedAppraisal.fallbackUsed !== 'no_comps') {
      arvCompsSource = 'renovated_only'
      const renovatedEnabledIds = new Set(
        renovatedAppraisal.comparables.filter((c) => c.isEnabled).map((c) => c.id)
      )

      finalAppraisalResult = {
        ...appraisalResult,
        comparables: appraisalResult.comparables.map((c) => {
          if (renovatedEnabledIds.has(c.id)) {
            const renovatedComp = renovatedAppraisal.comparables.find((rc) => rc.id === c.id)
            return renovatedComp ? { ...renovatedComp, isEnabled: true } : { ...c, isEnabled: true }
          }
          const isRenovated = renovatedCompIds.has(c.id)
          const disableReason = isRenovated
            ? 'Renovated comp excluded by appraisal rules'
            : 'Not in top price percentile (excluded from ARV)'
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
        arv: renovatedAppraisal.arv,
        enabledCount: renovatedEnabledIds.size,
        disabledCount: allComparables.length - renovatedEnabledIds.size,
        fallbackUsed: renovatedAppraisal.fallbackUsed,
        confidence: renovatedAppraisal.confidence,
      }
    } else {
      arvCompsSource = 'all_comps'
      finalAppraisalResult = appraisalResult
    }
  } else {
    arvCompsSource = 'all_comps'
    finalAppraisalResult = appraisalResult
  }

  const enabledComps = finalAppraisalResult.comparables.filter((c) => c.isEnabled)
  const finalArv = finalAppraisalResult.arv

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
  const arvSource: 'appraisal' | 'comp-selection' = arvCompsSource === 'renovated_only' ? 'comp-selection' : 'appraisal'

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
    }
  )

  return { response, appraisalResult: finalAppraisalResult, compClassifications }
}
