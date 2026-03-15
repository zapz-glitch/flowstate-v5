/**
 * Client-side Recalculation Orchestrator
 *
 * Takes the original analysis data and user's evaluation settings,
 * re-evaluates all comps, computes new ARV, and calculates full valuation.
 *
 * Uses @flowstate-api/shared for all calculations — single source of truth
 * with the server.
 *
 * Important: The server uses a 3-pass fallback (strict → relax subdivision →
 * relax all filters). The client distinguishes between "relaxing" changes
 * (disabling a filter or raising its threshold) and "tightening" changes
 * (enabling a new filter or lowering a threshold). When the user relaxes,
 * server-enabled comps stay enabled. Only when the user tightens a filter
 * do we strictly re-evaluate — this prevents ARV from dropping to 0 when
 * the user disables a filter that the server's fallback had already relaxed.
 */

import type { AnalyzeData, CompItem, SubjectData, ValuationData } from '@/app/(dashboard)/dashboard/analyze/actions'
import type { DealParamsConfig, TierRangeDefinition } from '@/lib/client-api'
import { getCompKey } from '@/components/analysis/format-helpers'
import type { EvaluationSettings, RecalcResult, CompEvaluation } from './types'
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
 * Check whether any filter was strictly tightened compared to what the
 * server used. "Tightened" means a filter that was disabled is now enabled,
 * or a numeric threshold was lowered (stricter). Disabling a filter or
 * increasing its threshold is considered "relaxing" — it should never cause
 * a server-enabled comp to become disabled.
 */
function hasStricterFilters(data: AnalyzeData, settings: EvaluationSettings): boolean {
  const applied = data.appliedSettings
  if (!applied) return true

  const appliedFilters = applied.filters ?? []
  for (const sf of settings.filters) {
    const af = appliedFilters.find((f) => f.type === sf.type)
    if (!af) continue

    // Filter was disabled on server, now enabled by user → stricter
    if (!af.enabled && sf.enabled) return true

    // Both enabled, but user lowered the threshold → stricter
    if (af.enabled && sf.enabled && sf.value < af.value) return true
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
          .filter((item) => item.enabled)
          .map((item) => ({ id: item.id as 'roof', enabled: true, cost: item.cost })),
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
      valuation: mapValuationResult(valResult, settings.rehabLevelIndex, rehabTable, settings, settings.tierRanges),
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

    // The server uses a 3-pass fallback that may relax filters (e.g. triple
    // thresholds, drop subdivision) to find viable comps. If the user only
    // relaxed filters (disabled a filter or raised a threshold), server-enabled
    // comps must stay enabled. Only use strict re-evaluation when the user
    // tightened a filter (enabled a new one or lowered a threshold).
    const serverEnabled = comp.isEnabled !== false
    const stricterFilters = filtersChanged && hasStricterFilters(data, settings)
    const isEnabled = stricterFilters
      ? !evaluation.shouldDisable       // User tightened filters → strict re-eval
      : filtersChanged
        ? serverEnabled || !evaluation.shouldDisable  // User relaxed → keep server-enabled, also enable any newly passing
        : serverEnabled                  // No changes → preserve server state

    return {
      isEnabled,
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
    valuation: mapValuationResult(valResult, settings.rehabLevelIndex, rehabTable, settings, settings.tierRanges),
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
  tierRanges?: TierRangeDefinition[]
) {
  const majorItems = settings.majorItems
    .map((item) => ({ id: item.id as 'roof', enabled: item.enabled, cost: item.cost }))

  // Derive subjectSqft and compAvgSqft from valuation result
  const subjectSqft = v.baseRehabCost > 0 && v.rehabPerSqft > 0 ? Math.round(v.baseRehabCost / v.rehabPerSqft) : 0
  const compAvgSqft = v.pricePerSqft > 0 ? Math.round(v.arv / v.pricePerSqft) : subjectSqft

  const rehabLevelEstimates = calculateAllRehabLevelEstimates(
    {
      arv: v.arv,
      subjectSqft,
      compAvgSqft,
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

  return {
    arv: v.arv,
    arvTier: v.arvTier,
    arvPerSqft: v.pricePerSqft,
    buyPrice: v.buyPrice,
    buyPricePercent: v.buyPricePercent,
    rehabLevel: v.rehabLevel,
    rehabPerSqft: v.rehabPerSqft,
    baseRehabCost: v.baseRehabCost,
    majorItemsCost: v.majorItemsCost,
    rehabCost: v.totalRehabCost,
    closingCosts: v.closingCosts,
    carryingCosts: v.carryingCosts,
    totalCosts: v.closingCosts + v.carryingCosts,
    totalInvestment: v.totalInvestment,
    projectedProfit: v.projectedProfit,
    projectedROI: v.projectedROI,
    wholesalePrice: v.wholesalePrice,
    rehabLevelEstimates,
  }
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
  rehabTable: RehabTable = DEFAULT_REHAB_TABLE as RehabTable,
  tierRanges?: TierRangeDefinition[]
): ValuationData {
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
export type { EvaluationSettings, RecalcResult, RecalcFilter, RecalcAdjustment, CompEvaluation, MajorItemSetting } from './types'
export { MAJOR_ITEMS_LIST } from './types'
export { DEFAULT_REHAB_TABLE, getArvTier } from '@flowstate-api/shared'
