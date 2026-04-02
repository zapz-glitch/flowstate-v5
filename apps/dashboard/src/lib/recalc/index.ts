/**
 * Client-side Recalculation Orchestrator
 *
 * Takes the original analysis data and user's evaluation settings,
 * re-evaluates all comps, computes new ARV, and calculates full valuation.
 *
 * Uses @flowstate-api/shared for all calculations — single source of truth
 * with the server.
 *
 * Hard filters (sqft_diff, sale_age) must pass — comp is rejected if failed.
 * Soft filters (subdivision, style, distance, year_built) add score but don't reject.
 * When user changes filter settings, comps are re-evaluated with hard/soft scoring.
 */

import type { AnalyzeData, CompItem, SubjectData, ValuationData } from '@/app/(dashboard)/dashboard/analyze/actions'
import type { DealParamsConfig, TierRangeDefinition } from '@/lib/client-api'
import { getCompKey } from '@/components/analysis/format-helpers'
import type { EvaluationSettings, RecalcResult, CompEvaluation, RecalcValuationResult } from './types'
import { PROXIMITY_DEFAULTS, type ProximityConfig } from '../client-api'
import {
  evaluateComparable,
  calculateARV,
  getCompAvgSqft,
  calculateValuation,
  calculateAllRehabLevelEstimates,
  DEFAULT_REHAB_TABLE,
  getArvTier,
  type ArvCompLike,
  type FilterType,
  type AdjustmentType,
  type RehabTable,
  passesHardFilters,
  scoreComp,
} from '@flowstate-api/shared'

/**
 * Check whether the user has changed any filter or adjustment settings
 * compared to what the server used.
 */
function hasFilterChanges(data: AnalyzeData, settings: EvaluationSettings): boolean {
  const applied = data.appliedSettings
  if (!applied) return true // No appliedSettings → always re-evaluate

  // Check filters
  const appliedFilters = applied.filters ?? []
  for (const sf of settings.filters) {
    const af = appliedFilters.find((f) => f.type === sf.type)
    if (!af) continue
    if (sf.enabled !== af.enabled || sf.value !== af.value) return true
  }

  // Check adjustments
  const appliedAdj = applied.adjustments ?? []
  for (const sa of settings.adjustments) {
    const aa = appliedAdj.find((a) => a.type === sa.type)
    if (!aa) continue
    if (sa.enabled !== aa.enabled || sa.amount !== aa.amount || sa.percent !== aa.percent) return true
  }

  return false
}

/**
 * Recalculate a report with new evaluation settings.
 * All logic is pure and synchronous — safe for useMemo.
 */
export function recalculateReport(
  data: AnalyzeData,
  settings: EvaluationSettings
): RecalcResult {
  const subject = data.subject
  const comps = data.comps?.items || []
  const rehabTable = (settings.rehabTable ?? DEFAULT_REHAB_TABLE) as RehabTable

  if (!subject || comps.length === 0) {
    const valResult = calculateValuation(
      {
        arv: data.valuation?.arv ?? 0,
        subjectSqft: subject?.squareFeet ?? 0,
        rehabLevelIndex: settings.rehabLevelIndex,
        additionPlay: settings.additionPlay ?? 0,
        closingCostsPercent: settings.dealParams.closingCostsPercent,
        carryingCostsPercent: settings.dealParams.carryingCostsPercent,
        wholesaleFee: settings.dealParams.wholesaleFee,
        majorItems: settings.majorItems
          .map((item) => ({ id: item.id as 'roof', enabled: item.enabled, cost: item.cost })),
      },
      rehabTable,
      settings.tierRanges
    )

    return {
      compEvaluations: [],
      arv: data.valuation?.arv ?? 0,
      enabledCount: 0,
      disabledCount: 0,
      avgPricePerSqft: null,
      medianPrice: null,
      valuation: mapValuationResult(valResult, settings.rehabLevelIndex, rehabTable, settings, settings.tierRanges, subject?.squareFeet ?? 0),
      hasChanges: false,
    }
  }

  // Determine if user changed filters/adjustments vs server's appliedSettings
  const filtersChanged = hasFilterChanges(data, settings)

  // 1. Evaluate all comps with shared evaluator
  const compEvaluations: CompEvaluation[] = comps.map((comp) => {
    const evaluation = evaluateComparable(
      subject,
      comp,
      settings.filters.map((f) => ({ type: f.type as FilterType, enabled: f.enabled, value: f.value })),
      settings.adjustments.map((a) => ({ type: a.type as AdjustmentType, enabled: a.enabled, amount: a.amount, percent: a.percent }))
    )

    // Hard/soft filter scoring: comp must pass hard filters (sqft, sale_age),
    // soft filters (subdivision, style, distance, year) add score but don't reject.
    const serverEnabled = comp.isEnabled !== false
    const passesHard = passesHardFilters(evaluation.filterResults)
    const compScore = passesHard ? scoreComp(evaluation.filterResults, comp.distanceMiles) : 0

    // If user changed filters: re-evaluate. Otherwise: preserve server state.
    const isEnabled = filtersChanged
      ? passesHard  // Re-evaluate: enabled if passes hard filters
      : serverEnabled  // No changes: preserve server selection

    return {
      isEnabled,
      compScore,
      compGroup: null as 'arv' | 'as_is' | null, // computed after ARV is known
      pricePercentile: null as number | null, // computed after all comps scored
      disableReasons: evaluation.disableReasons,
      filterResults: evaluation.filterResults,
      adjustmentResults: evaluation.adjustmentResults,
      totalAdjustment: evaluation.totalAdjustment,
      adjustedPrice: evaluation.adjustedPrice,
    }
  })

  // 2. Build ArvCompLike array for ARV calculation
  const arvComps: ArvCompLike[] = compEvaluations.map((ev, i) => ({
    isEnabled: ev.isEnabled,
    adjustedPrice: ev.adjustedPrice,
    salePrice: comps[i].salePrice ?? null,
    squareFeet: comps[i].squareFeet ?? null,
    distanceMiles: comps[i].distanceMiles ?? null,
    filterResults: ev.filterResults.map((f) => ({
      type: f.type as FilterType,
      passed: f.passed,
      reason: f.reason,
      actualValue: f.actualValue,
      threshold: f.threshold,
    })),
  }))

  // 3. Use all enabled comps for ARV (no cap — users can enable/disable comps freely)
  const enabledCount = arvComps.filter((c) => c.isEnabled).length
  const disabledCount = comps.length - enabledCount

  // 4. Calculate ARV using shared function
  const arv = calculateARV(arvComps, subject.squareFeet)

  // 4b. Classify comps into groups:
  //   1. Among ALL comps, find top arvThresholdPercent% by sale price
  //   2. Comps that pass filters AND are in top price percentile = 'arv'
  //   3. Remaining comps with salePrice ≤ ARV × asIsThreshold% = 'as_is'
  const arvThresholdPct = settings.dealParams.arvThresholdPercent ?? 15
  const asIsThreshold = settings.asIsThresholdPercent ?? settings.dealParams.asIsThresholdPercent ?? 70
  const priceCeiling = arv * asIsThreshold / 100

  // Find top percentile by sale price (mirrors server classifyCompsByPrice)
  const withPrice = comps
    .map((c, i) => ({ i, price: c.salePrice ?? 0 }))
    .filter((c) => c.price > 0)
    .sort((a, b) => b.price - a.price)
  const topCount = Math.max(1, Math.ceil(withPrice.length * arvThresholdPct / 100))
  const topPriceIndices = new Set(withPrice.slice(0, topCount).map((c) => c.i))

  // Build a rank map: comp index → rank position (0 = highest price)
  const rankMap = new Map<number, number>()
  withPrice.forEach((c, rank) => rankMap.set(c.i, rank))

  compEvaluations.forEach((ev, i) => {
    const salePrice = comps[i].salePrice ?? 0
    const passesFilters = ev.isEnabled
    const inTopPrice = topPriceIndices.has(i)

    if (passesFilters && inTopPrice) {
      ev.compGroup = 'arv'
    } else if (salePrice > 0 && salePrice <= priceCeiling) {
      ev.compGroup = 'as_is'
    } else {
      ev.compGroup = null
    }

    // Compute price percentile (Top X%): rank 0 out of N = Top 1/N %
    const rank = rankMap.get(i)
    if (rank != null && withPrice.length > 0) {
      ev.pricePercentile = Math.max(1, Math.round(((rank + 1) / withPrice.length) * 100))
    }
  })

  // 5. Calculate compAvgSqft for valuation (fallback to compAvgSqft when subjectSqft=0)
  const compAvgSqft = getCompAvgSqft(arvComps)

  // Stats
  let avgPricePerSqft: number | null = null
  let medianPrice: number | null = null

  if (enabledCount > 0) {
    // Average $/sqft across enabled comps (each comp's adjustedPrice / compSqft)
    const enabledCompPricesPerSqft = arvComps
      .filter((c) => c.isEnabled)
      .map((c) => {
        const price = c.adjustedPrice ?? c.salePrice
        const sqft = c.squareFeet
        return price != null && price > 0 && sqft != null && sqft > 0 ? price / sqft : null
      })
      .filter((v): v is number => v != null)
    if (enabledCompPricesPerSqft.length > 0) {
      avgPricePerSqft = Math.round(enabledCompPricesPerSqft.reduce((a, b) => a + b, 0) / enabledCompPricesPerSqft.length)
    }

    const enabledIndices: number[] = []
    for (let i = 0; i < arvComps.length; i++) {
      if (arvComps[i].isEnabled) enabledIndices.push(i)
    }

    const salePrices = enabledIndices
      .map((i) => comps[i]?.salePrice)
      .filter((p): p is number => p != null)
      .sort((a, b) => a - b)

    if (salePrices.length > 0) {
      const mid = Math.floor(salePrices.length / 2)
      medianPrice = salePrices.length % 2 !== 0
        ? salePrices[mid]
        : Math.round((salePrices[mid - 1] + salePrices[mid]) / 2)
    }
  }

  // 6. Calculate full valuation using shared function (Bug #4 & #5 fix)
  const majorItems = settings.majorItems
    .map((item) => ({ id: item.id as 'roof', enabled: item.enabled, cost: item.cost }))

  const valResult = calculateValuation(
    {
      arv,
      subjectSqft: subject.squareFeet ?? 0,
      compAvgSqft,
      rehabLevelIndex: settings.rehabLevelIndex,
      majorItems,
      additionPlay: settings.additionPlay ?? 0,
      closingCostsPercent: settings.dealParams.closingCostsPercent,
      carryingCostsPercent: settings.dealParams.carryingCostsPercent,
      wholesaleFee: settings.dealParams.wholesaleFee,
    },
    rehabTable,
    settings.tierRanges
  )

  // 7. Check if values differ from original
  const originalArv = data.valuation?.arv ?? 0
  const hasChanges = arv !== originalArv

  return {
    compEvaluations,
    arv,
    enabledCount,
    disabledCount,
    avgPricePerSqft,
    medianPrice,
    valuation: mapValuationResult(valResult, settings.rehabLevelIndex, rehabTable, settings, settings.tierRanges, subject.squareFeet ?? 0, compAvgSqft),
    hasChanges,
  }
}

/**
 * Map shared ValuationResult to client RecalcValuationResult shape.
 */
function mapValuationResult(
  v: ReturnType<typeof calculateValuation>,
  rehabLevelIndex: number,
  rehabTable: RehabTable,
  settings: EvaluationSettings,
  tierRanges?: TierRangeDefinition[],
  subjectSqft?: number,
  compAvgSqft?: number,
) {
  const majorItems = settings.majorItems
    .map((item) => ({ id: item.id as 'roof', enabled: item.enabled, cost: item.cost }))

  // Use actual sqft values passed in, fall back to deriving from result only if not provided
  const resolvedSubjectSqft = subjectSqft ?? (v.baseRehabCost > 0 && v.rehabPerSqft > 0 ? Math.round(v.baseRehabCost / v.rehabPerSqft) : 0)
  const resolvedCompAvgSqft = compAvgSqft ?? (v.pricePerSqft > 0 ? Math.round(v.arv / v.pricePerSqft) : resolvedSubjectSqft)

  const rehabLevelEstimates = calculateAllRehabLevelEstimates(
    {
      arv: v.arv,
      subjectSqft: resolvedSubjectSqft,
      compAvgSqft: resolvedCompAvgSqft,
      majorItems,
      additionPlay: settings.additionPlay ?? 0,
      closingCostsPercent: settings.dealParams.closingCostsPercent,
      carryingCostsPercent: settings.dealParams.carryingCostsPercent,
      wholesaleFee: settings.dealParams.wholesaleFee,
    },
    rehabTable,
    rehabLevelIndex,
    tierRanges
  )

  // Calculate proximity deduction from toggles — reduces ARV
  const proximityDeduction = calculateProximityDeduction(v.arv, settings)
  const adjustedArv = v.arv - proximityDeduction

  // Recalculate everything from adjusted ARV
  const adjustedClosing = adjustedArv * (settings.dealParams.closingCostsPercent / 100)
  const adjustedCarrying = adjustedArv * (settings.dealParams.carryingCostsPercent / 100)
  const adjustedBuyPrice = adjustedArv - v.totalRehabCost - adjustedClosing - adjustedCarrying - v.projectedProfit
  const adjustedWholesalePrice = adjustedBuyPrice - settings.dealParams.wholesaleFee
  const adjustedTotalInvestment = adjustedBuyPrice + v.totalRehabCost
  const adjustedProfit = adjustedArv - adjustedTotalInvestment - adjustedClosing - adjustedCarrying
  const adjustedROI = adjustedTotalInvestment > 0 ? (adjustedProfit / adjustedTotalInvestment) * 100 : 0

  // Also adjust rehab level estimates from adjusted ARV
  const adjustedEstimates = rehabLevelEstimates.map((est) => {
    const estBuyPrice = adjustedArv - est.estimatedCost - adjustedClosing - adjustedCarrying - v.projectedProfit
    return {
      ...est,
      buyPrice: estBuyPrice,
      wholesalePrice: estBuyPrice - settings.dealParams.wholesaleFee,
    }
  })

  return {
    arv: adjustedArv,
    arvTier: v.arvTier,
    arvPerSqft: resolvedSubjectSqft > 0 ? Math.round(adjustedArv / resolvedSubjectSqft) : v.pricePerSqft,
    buyPrice: adjustedBuyPrice,
    buyPricePercent: adjustedArv > 0 ? Math.round((adjustedBuyPrice / adjustedArv) * 100) : 0,
    rehabLevel: v.rehabLevel,
    rehabPerSqft: v.rehabPerSqft,
    baseRehabCost: v.baseRehabCost,
    majorItemsCost: v.majorItemsCost,
    rehabCost: v.totalRehabCost,
    closingCosts: adjustedClosing,
    carryingCosts: adjustedCarrying,
    proximityDeduction,
    totalCosts: adjustedClosing + adjustedCarrying,
    totalInvestment: adjustedTotalInvestment,
    projectedProfit: adjustedProfit,
    projectedROI: adjustedROI,
    wholesalePrice: adjustedWholesalePrice,
    rehabLevelEstimates: adjustedEstimates,
  } satisfies RecalcValuationResult
}

/**
 * Calculate total proximity deduction based on enabled toggles and ARV tier.
 */
function calculateProximityDeduction(arv: number, settings: EvaluationSettings): number {
  const toggles = settings.proximityAdjustments
  if (!toggles) return 0

  const config = settings.proximityConfig ?? PROXIMITY_DEFAULTS
  const usePercent = arv >= config.arvThreshold
  let total = 0

  for (const pos of ['siding', 'backing', 'fronting'] as const) {
    if (!toggles[pos]) continue
    total += usePercent
      ? Math.round(arv * config[pos].percent / 100)
      : config[pos].flat
  }

  return total
}

/**
 * Recalculate valuation when user manually toggles comps.
 * Uses shared calculateARV + calculateValuation for consistency with server.
 */
export function recalculateValuationFromComps(
  allComps: CompItem[],
  subject: SubjectData,
  selectedCompKeys: Set<string>,
  originalValuation: ValuationData,
  settings: EvaluationSettings,
): ValuationData {
  const rehabTable = (settings.rehabTable ?? DEFAULT_REHAB_TABLE) as RehabTable
  const tierRanges = settings.tierRanges
  const subjectSqft = subject.squareFeet ?? 0
  const selectedComps = allComps.filter((c, i) => selectedCompKeys.has(getCompKey(c, i)))

  const arvComps: ArvCompLike[] = selectedComps.map((c) => ({
    isEnabled: true,
    adjustedPrice: c.adjustedPrice ?? c.salePrice ?? null,
    salePrice: c.salePrice ?? null,
    squareFeet: c.squareFeet ?? null,
    distanceMiles: c.distanceMiles ?? null,
    filterResults: [],
  }))

  const newArv = arvComps.length > 0 ? calculateARV(arvComps, subjectSqft) : (originalValuation.arv ?? 0)
  const compAvgSqft = arvComps.length > 0 ? getCompAvgSqft(arvComps) : subjectSqft

  const selectedLevel = originalValuation.rehabLevelEstimates?.find((l) => l.isSelected)
  const rehabLevelIndex = selectedLevel?.index ?? settings.rehabLevelIndex ?? 2
  const majorItems = settings.majorItems
    .map((item) => ({ id: item.id as 'roof', enabled: item.enabled, cost: item.cost }))
  const { dealParams } = settings

  const val = calculateValuation(
    {
      arv: newArv,
      subjectSqft,
      compAvgSqft,
      rehabLevelIndex,
      majorItems,
      additionPlay: settings.additionPlay ?? 0,
      closingCostsPercent: dealParams.closingCostsPercent,
      carryingCostsPercent: dealParams.carryingCostsPercent,
      wholesaleFee: dealParams.wholesaleFee,
    },
    rehabTable,
    tierRanges
  )

  const rehabLevelEstimates = calculateAllRehabLevelEstimates(
    {
      arv: newArv,
      subjectSqft,
      compAvgSqft,
      majorItems,
      additionPlay: settings.additionPlay ?? 0,
      closingCostsPercent: dealParams.closingCostsPercent,
      carryingCostsPercent: dealParams.carryingCostsPercent,
      wholesaleFee: dealParams.wholesaleFee,
    },
    rehabTable,
    rehabLevelIndex,
    tierRanges
  )

  return {
    ...originalValuation,
    arv: newArv,
    arvPerSqft: val.pricePerSqft,
    buyPrice: val.buyPrice,
    buyPricePercent: val.buyPricePercent,
    rehabCost: val.totalRehabCost,
    baseRehabCost: val.baseRehabCost,
    majorItemsCost: val.majorItemsCost,
    wholesalePrice: val.wholesalePrice,
    totalInvestment: val.totalInvestment,
    closingCosts: val.closingCosts,
    carryingCosts: val.carryingCosts,
    totalCosts: val.closingCosts + val.carryingCosts,
    projectedProfit: val.projectedProfit,
    projectedROI: val.projectedROI,
    rehabLevelEstimates,
  }
}

// Re-export everything needed by consumers
export type { EvaluationSettings, RecalcResult, RecalcFilter, RecalcAdjustment, CompEvaluation, MajorItemSetting, ProximityToggles } from './types'
export { MAJOR_ITEMS_LIST } from './types'
export { DEFAULT_REHAB_TABLE, getArvTier } from '@flowstate-api/shared'
