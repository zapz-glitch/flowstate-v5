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
import { PROXIMITY_DEFAULTS, type ProximityConfig, type ArvAdjustmentRule, type ArvAdjustmentOverride } from '../client-api'
import {
  evaluateComparable,
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
import { evaluateB, type BComp } from '@flowstate-api/shared/appraisal'

/**
 * Check whether the user has changed any filter or adjustment settings
 * compared to what the server used.
 */
/** Check if appraisal FILTERS changed (not adjustments — adjustments only affect price, not comp selection) */
function hasFilterChanges(data: AnalyzeData, settings: EvaluationSettings): boolean {
  const applied = data.appliedSettings
  if (!applied) return true // No appliedSettings → always re-evaluate

  const appliedFilters = applied.filters ?? []
  for (const sf of settings.filters) {
    const af = appliedFilters.find((f) => f.type === sf.type)
    if (!af) continue
    if (sf.enabled !== af.enabled || sf.value !== af.value || (sf.priority ?? 'hard') !== (af.priority ?? 'hard')) return true
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
      valuation: mapValuationResult(valResult, settings.rehabLevelIndex, rehabTable, settings, settings.tierRanges, subject?.squareFeet ?? 0, undefined, subject),
      hasChanges: false,
    }
  }

  // Determine if user changed filters/adjustments vs server's appliedSettings
  const filtersChanged = hasFilterChanges(data, settings)

  // Map flat fields to the shape the shared evaluator expects
  const subjectWithFeatures = {
    ...subject,
    construction: {
      buildingStyle: subject.buildingStyle ?? null,
    },
    features: {
      poolType: subject.pool ? [subject.pool] : null,
      garageType: subject.garage ? [subject.garage] : null,
      garageSquareFeet: subject.garageSquareFeet ?? null,
      carportType: subject.carport ?? null,
    },
  }

  // 1. Evaluate all comps with shared evaluator
  const compEvaluations: CompEvaluation[] = comps.map((comp) => {
    // Map flat buildingStyle to construction shape for the shared evaluator
    const compWithConstruction = {
      ...comp,
      construction: { buildingStyle: comp.buildingStyle ?? null },
    }
    const evaluation = evaluateComparable(
      subjectWithFeatures,
      compWithConstruction,
      settings.filters.map((f) => ({ type: f.type as FilterType, enabled: f.enabled, value: f.value, priority: f.priority })),
      settings.adjustments.map((a) => ({ type: a.type as AdjustmentType, enabled: a.enabled, amount: a.amount, percent: a.percent, thresholdDays: a.thresholdDays }))
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
    // Server-adjusted price is authoritative — it was computed against the
    // enriched comp data; the client re-derivation can drift (missing/extra
    // adjustment signals). Fall back to the client's own eval when absent.
    adjustedPrice: comps[i].adjustedPrice ?? ev.adjustedPrice,
    salePrice: comps[i].salePrice ?? null,
    squareFeet: comps[i].squareFeet ?? null,
    distanceMiles: comps[i].distanceMiles ?? null,
    filterResults: ev.filterResults.map((f) => ({
      type: f.type as FilterType,
      passed: f.passed,
      status: f.status,
      reason: f.reason,
      actualValue: f.actualValue,
      threshold: f.threshold,
    })),
  }))

  // 3. ARV pool = evidence-classified comps only — 'after_renovation'
  //    (flip/premium/above-AVM) or an explicit operator ARV pin. Median
  //    (transitional) comps never feed ARV; investor floor comps never can.
  const subjectAvm = (subject as { avm?: { value?: number | null } | null }).avm?.value ?? null
  const isArvComp = (i: number) =>
    comps[i].classification?.type === 'after_renovation' || comps[i].userTier === 'arv'
  const isAsIsComp = (i: number) => {
    const c = comps[i]
    if (c.classification?.type !== 'as_is' && c.userTier !== 'as_is') return false
    // Investor-priced only — a distressed deed priced at/above the subject's
    // AVM is not an investor purchase.
    return subjectAvm == null || (c.salePrice != null && c.salePrice <= subjectAvm)
  }

  const enabledCount = arvComps.filter((c) => c.isEnabled).length
  const disabledCount = comps.length - enabledCount

  // 4. ARV — the same Set-B engine the pipeline runs, on the serialized
  //    (stamped) comps. When B produces nothing (pre-stamp reports), the
  //    stored ARV carries through unchanged — no retired math.
  const bComps: BComp[] = comps.map((c, i) => ({
    address: c.address ?? null,
    isEnabled: compEvaluations[i].isEnabled,
    salePrice: c.salePrice ?? null,
    saleDate: c.saleDate ?? null,
    squareFeet: c.squareFeet ?? null,
    pricePerSqft: c.pricePerSqft ?? null,
    adjustedPrice: c.adjustedPrice ?? null,
    distanceMiles: c.distanceMiles ?? null,
    sameBlockGroup: c.sameBlockGroup ?? null,
    censusTract: c.censusTract ?? null,
    subdivision: c.subdivision ?? null,
    yearBuilt: c.yearBuilt ?? null,
    lotSizeAcres: c.lotSizeAcres ?? null,
    lotSizeSquareFeet: c.lotSizeSquareFeet ?? null,
    landAssessedValue: c.landAssessedValue ?? null,
    propertyType: c.propertyType ?? null,
    crossesMajorRoad: c.crossesMajorRoad ?? null,
    disableReasons: (c.disableReasons as string[] | null) ?? null,
    classification: c.userTier === 'as_is' ? { type: 'as_is' }
      : c.userTier === 'arv' ? { type: 'after_renovation' }
      : c.classification ?? null,
    curbAppeal: (c.curbAppeal as BComp['curbAppeal']) ?? null,
    evidenceVerification: (c.evidenceVerification as BComp['evidenceVerification']) ?? null,
    appraisalRules: c.appraisalRules
      ? { totalAdjustment: (c.appraisalRules as { totalAdjustment?: number | null }).totalAdjustment ?? null }
      : null,
  }))
  const bSubject = {
    squareFeet: subject.squareFeet ?? null,
    yearBuilt: subject.yearBuilt ?? null,
    censusTract: subject.censusTract ?? null,
    subdivision: subject.subdivision ?? null,
    landAssessedValue: subject.landAssessedValue ?? null,
    taxAssessment: (subject as { taxAssessment?: number | null }).taxAssessment ?? (subject as { assessedValue?: number | null }).assessedValue ?? null,
    assessedValue: (subject as { assessedValue?: number | null }).assessedValue ?? null,
    avmValue: subjectAvm,
    lotSizeAcres: subject.lotSizeAcres ?? null,
    lotSizeSquareFeet: subject.lotSizeSquareFeet ?? null,
    condition: data.valuation?.rehabLevel ?? null,
  }
  const bResult = evaluateB(bSubject, bComps, { rehabCost: data.valuation?.rehabCost ?? null })
  // Server ARV is authoritative — the pipeline's evidence pool (rescues,
  // widened comps, permit/geo/exclusion gates, devalue ladder) is richer
  // than anything the browser can reconstruct. Client evaluateB stays as
  // the fallback only when the server produced no ARV.
  const arv = data.valuation?.arv ?? bResult.arv ?? 0

  // 4b. Groups come from evidence classification — not price percentile.
  //     'arv' = after_renovation evidence; 'as_is' = investor-priced
  //     distressed; transitional stays ungrouped (market tier).
  const rankMap = new Map<number, number>()
  const allWithPrice = comps
    .map((c, i) => ({ i, price: c.salePrice ?? 0 }))
    .filter((c) => c.price > 0)
    .sort((a, b) => b.price - a.price)
  allWithPrice.forEach((c, rank) => rankMap.set(c.i, rank))

  compEvaluations.forEach((ev, i) => {
    ev.compGroup = ev.isEnabled && isArvComp(i) ? 'arv'
      : ev.isEnabled && isAsIsComp(i) ? 'as_is'
      : null

    // Percentile among ALL comps by sale price
    const rank = rankMap.get(i)
    if (rank != null && allWithPrice.length > 0) {
      ev.pricePercentile = allWithPrice.length === 1
        ? 1
        : Math.max(1, Math.round((rank / (allWithPrice.length - 1)) * 100))
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
    valuation: mapValuationResult(valResult, settings.rehabLevelIndex, rehabTable, settings, settings.tierRanges, subject.squareFeet ?? 0, compAvgSqft, subject),
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
  subject?: SubjectData | null,
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

  // A manual per-report override is the final ARV. Percent-of-ARV physical
  // characteristic rules are retained in settings for compatibility but are
  // no longer applied to displayed valuation.
  const manualArv = settings.arvOverride != null && settings.arvOverride > 0 ? settings.arvOverride : null
  const baseArv = manualArv ?? v.arv
  const proximityDeduction = manualArv != null ? 0 : calculateProximityDeduction(baseArv, settings)
  const arvAdj = { delta: 0, lines: [] as ArvAdjustmentLine[] }
  const adjustedArv = baseArv - proximityDeduction

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
    arvAdjustments: arvAdj.lines,
    totalCosts: adjustedClosing + adjustedCarrying,
    totalInvestment: adjustedTotalInvestment,
    projectedProfit: adjustedProfit,
    projectedROI: adjustedROI,
    wholesalePrice: adjustedWholesalePrice,
    rehabLevelEstimates: adjustedEstimates,
  } satisfies RecalcValuationResult
}

/** Does a rule's characteristic trigger match the subject? Absent/blank
 *  values read as 'missing'; 'None'/'N/A' strings count as missing too. */
export function arvRuleMatches(rule: ArvAdjustmentRule, subject: object | null | undefined): boolean {
  if (!subject) return false
  const raw = (subject as Record<string, unknown>)[rule.field]
  const missing = raw == null || raw === '' || (typeof raw === 'string' && /^(none|n\/a|na|no)$/i.test(raw.trim()))
  switch (rule.op) {
    case 'missing': return missing
    case 'present': return !missing
    case 'eq': return !missing && String(raw).toLowerCase() === String(rule.value ?? '').toLowerCase()
    case 'neq': return !missing && String(raw).toLowerCase() !== String(rule.value ?? '').toLowerCase()
    case 'contains': return !missing && String(raw).toLowerCase().includes(String(rule.value ?? '').toLowerCase())
    case 'lt': return typeof raw === 'number' && raw < Number(rule.value)
    case 'gt': return typeof raw === 'number' && raw > Number(rule.value)
    default: return false
  }
}

export interface ArvAdjustmentLine { id: string; label: string; amount: number; direction: 'deduction' | 'addition' }

/** Signed dollar delta of ARV adjustments on this subject. A rule applies
 *  when the characteristic matches — or when the per-report override forces
 *  it on; overrides can also flip direction or value. */
export function calculateArvAdjustmentDelta(
  arv: number,
  subject: object | null | undefined,
  settings: EvaluationSettings,
): { delta: number; lines: ArvAdjustmentLine[] } {
  const rules = settings.arvAdjustmentRules ?? []
  const overrides = settings.arvAdjustments ?? {}
  let delta = 0
  const lines: ArvAdjustmentLine[] = []
  for (const rule of rules) {
    const o = overrides[rule.id]
    const applied = o?.applied ?? arvRuleMatches(rule, subject)
    if (!applied) continue
    const pct = o?.percent ?? rule.percent
    const direction = o?.direction ?? rule.direction
    if (!(pct > 0)) continue
    const amount = Math.round(arv * pct / 100)
    delta += direction === 'addition' ? amount : -amount
    lines.push({ id: rule.id, label: rule.label, amount, direction })
  }
  return { delta, lines }
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
 * Runs Set-B on the stamped comp pool — the operator selection constrains
 * which comps are enabled; B does the tiering/anchoring math itself.
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

  // Operator selection = enabled evidence. B reads classification + stamps
  // for tiering; 'as_is' pins re-class the comp out of the ARV pool.
  const bComps: BComp[] = allComps.map((c, i) => ({
    address: c.address ?? null,
    isEnabled: selectedCompKeys.has(getCompKey(c, i)),
    salePrice: c.salePrice ?? null,
    saleDate: c.saleDate ?? null,
    squareFeet: c.squareFeet ?? null,
    pricePerSqft: c.pricePerSqft ?? null,
    adjustedPrice: c.adjustedPrice ?? null,
    distanceMiles: c.distanceMiles ?? null,
    sameBlockGroup: c.sameBlockGroup ?? null,
    censusTract: c.censusTract ?? null,
    subdivision: c.subdivision ?? null,
    yearBuilt: c.yearBuilt ?? null,
    lotSizeAcres: c.lotSizeAcres ?? null,
    lotSizeSquareFeet: c.lotSizeSquareFeet ?? null,
    landAssessedValue: c.landAssessedValue ?? null,
    propertyType: c.propertyType ?? null,
    crossesMajorRoad: c.crossesMajorRoad ?? null,
    disableReasons: (c.disableReasons as string[] | null) ?? null,
    classification: c.userTier === 'as_is' ? { type: 'as_is' }
      : c.userTier === 'arv' ? { type: 'after_renovation' }
      : c.classification ?? null,
    curbAppeal: (c.curbAppeal as BComp['curbAppeal']) ?? null,
    evidenceVerification: (c.evidenceVerification as BComp['evidenceVerification']) ?? null,
    appraisalRules: c.appraisalRules
      ? { totalAdjustment: (c.appraisalRules as { totalAdjustment?: number | null }).totalAdjustment ?? null }
      : null,
  }))
  const bResult = evaluateB(
    {
      squareFeet: subject.squareFeet ?? null,
      yearBuilt: subject.yearBuilt ?? null,
      censusTract: subject.censusTract ?? null,
      subdivision: subject.subdivision ?? null,
      landAssessedValue: subject.landAssessedValue ?? null,
      taxAssessment: (subject as { taxAssessment?: number | null }).taxAssessment ?? (subject as { assessedValue?: number | null }).assessedValue ?? null,
      assessedValue: (subject as { assessedValue?: number | null }).assessedValue ?? null,
      avmValue: (subject as { avm?: { value?: number | null } | null }).avm?.value ?? null,
      lotSizeAcres: subject.lotSizeAcres ?? null,
      lotSizeSquareFeet: subject.lotSizeSquareFeet ?? null,
      condition: originalValuation.rehabLevel ?? null,
    },
    bComps,
    { rehabCost: originalValuation.rehabCost ?? null },
  )
  const arvComps = selectedComps.map((c) => ({
    isEnabled: true,
    adjustedPrice: c.adjustedPrice ?? c.salePrice ?? null,
    salePrice: c.salePrice ?? null,
    squareFeet: c.squareFeet ?? null,
    distanceMiles: c.distanceMiles ?? null,
    filterResults: [],
  }))
  const newArv = bResult.arv ?? (originalValuation.arv ?? 0)
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
      // Carry the server's position-tiered proximity deduction through recalc —
      // recomputing it here would need the OSM risk data the client lacks.
      locationPenaltyAmount: originalValuation.locationPenalty,
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
