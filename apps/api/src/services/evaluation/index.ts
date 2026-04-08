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
import { AnalysisError } from '../../utils/analysis-error'

import { scoreComp, calculateARV, getFiltersAtStep, MAX_RELAXATION_STEPS, type ArvCompLike } from '@flowstate-api/shared/appraisal'

function formatUsd(amount: number): string {
  return `$${Math.round(amount).toLocaleString()}`
}

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
  /** Reason when no comps qualify */
  noDataReason?: string
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

type GroupAResult = {
  appraisalResult: AppraisalResultWithFallback
  arvCompsSource: 'group_a' | 'all_comps'
  compClassifications: Map<string, ClassificationResult>
  groupACompIds: Set<string>
}

/** Minimum percentage of enabled filters a comp must pass to be selected for ARV */
const MIN_FILTER_PASS_RATE = 0.7 // 70% of filters must pass

/**
 * Score, select top comps, build ARV, and return the final Group A result.
 */
function finalizeGroupASelection(
  candidates: AppraisedComparable[],
  allComparables: NormalizedComparable[],
  groupAIds: Set<string>,
  classifications: Map<string, ClassificationResult>,
  subject: NormalizedProperty,
  appraisalService: ReturnType<typeof createAppraisalService>,
  filters: AppraisalFilter[],
  adjustments: AppraisalAdjustment[],
  fallbackUsed: 'none' | 'relaxed_filters' | 'relaxed_all',
): GroupAResult {
  // Calculate filter pass rate for each comp
  const enabledFilterCount = filters.filter((f) => f.enabled).length || 1
  const scored = candidates
    .filter((c) => c.salePrice != null && c.salePrice > 0)
    .map((c) => {
      const passedCount = c.evaluation.filterResults.filter((f) => f.passed).length
      const passRate = passedCount / enabledFilterCount
      return {
        comp: c,
        score: scoreComp(c.evaluation.filterResults, c.distanceMiles),
        passRate,
        passedCount,
      }
    })
    .sort((a, b) => {
      // Primary: more filters passed
      if (b.passedCount !== a.passedCount) return b.passedCount - a.passedCount
      // Secondary: higher score
      if (b.score !== a.score) return b.score - a.score
      // Tertiary: higher sale price
      return (b.comp.salePrice ?? 0) - (a.comp.salePrice ?? 0)
    })

  // Select comps that pass ALL filters first, then fall back to MOST filters
  let selected = scored.filter((s) => s.passRate >= 1.0) // all filters pass
  if (selected.length === 0) {
    selected = scored.filter((s) => s.passRate >= MIN_FILTER_PASS_RATE) // 70%+ filters pass
  }
  if (selected.length === 0 && scored.length > 0) {
    // Last resort: take the best available (highest pass count)
    const bestPassCount = scored[0].passedCount
    selected = scored.filter((s) => s.passedCount === bestPassCount)
  }
  const enabledIds = new Set(selected.map((s) => s.comp.id))

  console.log(`[Evaluate] ${scored.length} scored, ${selected.length} selected (pass rates: ${scored.slice(0, 5).map((s) => `${s.comp.address?.split(',')[0]}(${s.passedCount}/${enabledFilterCount}=${Math.round(s.passRate * 100)}%)`).join(', ')})`)

  const arvComps: ArvCompLike[] = selected.map((s) => ({
    isEnabled: true,
    adjustedPrice: s.comp.adjustedSalePrice ?? s.comp.salePrice ?? null,
    salePrice: s.comp.salePrice ?? null,
    squareFeet: s.comp.squareFeet ?? null,
    distanceMiles: s.comp.distanceMiles ?? null,
    filterResults: s.comp.evaluation.filterResults.map((f) => ({
      type: f.type, passed: f.passed, reason: f.reason, actualValue: f.actualValue, threshold: f.threshold,
    })),
  }))
  const selectedArv = calculateARV(arvComps, subject.squareFeet)
  console.log(`[Evaluate] ARV from ${selected.length} comps: $${selectedArv.toLocaleString()}`)

  const allResult = appraisalService.evaluate(subject, allComparables, { filters, adjustments })
  const confidence = fallbackUsed === 'none'
    ? (selected.length >= 3 ? 90 : selected.length >= 2 ? 70 : 55)
    : fallbackUsed === 'relaxed_filters'
      ? (selected.length >= 3 ? 60 : selected.length >= 2 ? 45 : 30)
      : (selected.length >= 3 ? 30 : selected.length >= 2 ? 20 : 10)

  return {
    appraisalResult: buildGroupAResult(allResult, {
      ...allResult, fallbackUsed, confidence,
    }, enabledIds, groupAIds, allComparables, selectedArv),
    arvCompsSource: fallbackUsed === 'relaxed_all' ? 'all_comps' : 'group_a',
    compClassifications: classifications,
    groupACompIds: enabledIds,
  }
}

/**
 * Select Group A comps: appraisal-first, then price preference.
 *
 * Algorithm:
 * 1. Evaluate ALL comps against appraisal filters and score them
 * 2. Select top-scoring comps that meet minimum score threshold
 * 3. Among qualifying comps, prefer higher-priced (after-renovation)
 * 4. If not enough qualify, relax filters one step and retry:
 *    - sqft_diff:       20 →  30 →  40 →   50  (±% of subject sqft)
 *    - year_built_diff:  10 →  15 →  20 →   25
 *    - sale_age:        180 → 270 → 360 →  540
 *    - distance:        0.5 → 1.0 → 1.5 →  2.0
 * 5. Price classification applied AFTER filter selection for display
 * 6. If all steps exhausted, picks best available comps with low confidence
 */
function selectGroupAComps(
  subject: NormalizedProperty,
  allComparables: NormalizedComparable[],
  baseThreshold: number,
  appraisalService: ReturnType<typeof createAppraisalService>,
  filters: AppraisalFilter[],
  adjustments: AppraisalAdjustment[],
): GroupAResult {

  // Step 1: Evaluate ALL comps against appraisal filters first, then select best
  for (let step = 0; step < MAX_RELAXATION_STEPS; step++) {
    const stepFilters = step === 0 ? filters : getFiltersAtStep(filters, step) as AppraisalFilter[]

    // Evaluate ALL comps (no price gate)
    const result = appraisalService.evaluate(subject, allComparables, { filters: stepFilters, adjustments })

    // Score and calculate filter pass rate for each comp
    const enabledFilterCount = stepFilters.filter((f) => f.enabled).length || 1
    const scored = result.comparables
      .filter((c) => c.salePrice != null && c.salePrice > 0)
      .map((c) => {
        const passedCount = c.evaluation.filterResults.filter((f) => f.passed).length
        const passRate = passedCount / enabledFilterCount
        return {
          comp: c,
          score: scoreComp(c.evaluation.filterResults, c.distanceMiles),
          passRate,
          passedCount,
        }
      })

    // Check for comps passing all filters, then 70%+
    const allPassCount = scored.filter((s) => s.passRate >= 1.0).length
    const mostPassCount = scored.filter((s) => s.passRate >= MIN_FILTER_PASS_RATE).length

    console.log(`[Evaluate] Step ${step}: ${allComparables.length} comps, ${allPassCount} pass all filters, ${mostPassCount} pass 70%+`)

    if (mostPassCount === 0) continue

    // Select comps that match all filters first, fall back to 70%+
    const filterQualifying = (allPassCount > 0
      ? scored.filter((s) => s.passRate >= 1.0)
      : scored.filter((s) => s.passRate >= MIN_FILTER_PASS_RATE)
    ).sort((a, b) => {
      if (b.passedCount !== a.passedCount) return b.passedCount - a.passedCount
      if (b.score !== a.score) return b.score - a.score
      return (b.comp.salePrice ?? 0) - (a.comp.salePrice ?? 0)
    })

    // Apply ARV threshold: only select comps in the top X% by sale price
    // This ensures we use higher-priced comps that represent after-renovation value
    const stepThreshold = Math.min(Math.ceil(baseThreshold * Math.pow(1.5, step)), 100)
    const classifications = classifyCompsByPrice(allComparables, stepThreshold)
    const topPriceIds = new Set(
      [...classifications.entries()]
        .filter(([, c]) => c.classification === 'after_renovation')
        .map(([id]) => id)
    )

    // Prefer comps that pass filters AND are in the top price percentile
    const topPriceQualifying = filterQualifying.filter((s) => topPriceIds.has(s.comp.id))
    // Fall back to all qualifying comps if none are in the top percentile
    const qualifying = topPriceQualifying.length > 0 ? topPriceQualifying : filterQualifying

    if (topPriceQualifying.length > 0 && topPriceQualifying.length < filterQualifying.length) {
      console.log(`[Evaluate] ARV threshold ${stepThreshold}%: ${topPriceQualifying.length}/${filterQualifying.length} qualifying comps in top price percentile`)
    }

    const groupAIds = new Set(qualifying.map((s) => s.comp.id))

    const fallbackUsed = step === 0 ? 'none' as const : 'relaxed_filters' as const
    if (step > 0) {
      console.log(`[Evaluate] Relaxation step ${step}: filters relaxed to find ${qualifying.length} comps`)
    }

    return finalizeGroupASelection(
      qualifying.map((s) => s.comp), allComparables, groupAIds, classifications,
      subject, appraisalService, stepFilters, adjustments, fallbackUsed,
    )
  }

  // All steps exhausted — pick best available with loosest filters
  console.log(`[Evaluate] All relaxation steps exhausted. Selecting best available comps.`)

  const looseFilters = getFiltersAtStep(filters, MAX_RELAXATION_STEPS - 1) as AppraisalFilter[]
  const allResult = appraisalService.evaluate(subject, allComparables, { filters: looseFilters, adjustments })
  const allClassifications = classifyCompsByPrice(allComparables, 100)
  const allGroupAIds = new Set(allComparables.map((c) => c.id))

  const scored = allResult.comparables
    .filter((c) => c.salePrice != null && c.salePrice > 0)
    .map((c) => ({ comp: c, score: scoreComp(c.evaluation.filterResults, c.distanceMiles) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return (b.comp.salePrice ?? 0) - (a.comp.salePrice ?? 0)
    })

  if (scored.length === 0) {
    const reason = allComparables.length === 0
      ? 'No comparable sales were found in this area. Try expanding the search radius or date range.'
      : `${allComparables.length} comparable${allComparables.length === 1 ? ' was' : 's were'} found but none had valid sale price data. The comps in this area may not have recent recorded sales.`
    throw new AnalysisError(reason, { code: 'INSUFFICIENT_COMPARABLES' })
  }

  console.log(`[Evaluate] Best-available fallback: ${scored.slice(0, 5).map((s) => `${s.comp.address}(${s.score})`).join(', ')}`)

  return finalizeGroupASelection(
    scored.map((s) => s.comp), allComparables, allGroupAIds, allClassifications,
    subject, appraisalService, looseFilters, adjustments, 'relaxed_all',
  )
}

/** Build the final Group A appraisal result with proper enable/disable reasons for all comps */
function buildGroupAResult(
  allCompsResult: import('../appraisal').AppraisalResult,
  groupAResult: AppraisalResultWithFallback,
  enabledIds: Set<string>,
  topPercentileIds: Set<string>,
  allComparables: NormalizedComparable[],
  selectedArv?: number,
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
    arv: selectedArv ?? groupAResult.arv,
    enabledCount: enabledIds.size,
    disabledCount: allComparables.length - enabledIds.size,
    fallbackUsed: groupAResult.fallbackUsed,
    confidence: groupAResult.confidence,
  }
}

// ─── Group B: As-Is Market Intelligence ─────────────────────────────────────

/**
 * Select Group B comps: sale price ≤ 70% of ARV = As-Is market price.
 * These are properties selling "as-is" — used for market intelligence only.
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

  // Comps with sale price ≤ 70% of ARV AND not in Group A
  const candidates = allComparables.filter((c) =>
    c.salePrice != null && c.salePrice > 0 && c.salePrice <= priceCeiling && !groupACompIds.has(c.id)
  )

  if (candidates.length === 0) {
    // Find the lowest-priced non-Group-A comp to explain why
    const nonGroupA = allComparables
      .filter((c) => c.salePrice != null && c.salePrice > 0 && !groupACompIds.has(c.id))
      .sort((a, b) => a.salePrice! - b.salePrice!)
    const lowestPrice = nonGroupA[0]?.salePrice
    const reason = lowestPrice
      ? `No comps priced at or below ${thresholdPercent}% of ARV (${formatUsd(priceCeiling)}). Lowest non-ARV comp is ${formatUsd(lowestPrice)}.`
      : `All comps are selected for ARV calculation — none available for as-is comparison.`
    return {
      compIds: [],
      asIsMarketPrice: null,
      avgPricePerSqft: null,
      count: 0,
      thresholdPercent,
      arvUsed: arv,
      priceCeiling: Math.round(priceCeiling),
      noDataReason: reason,
    }
  }

  // Single-pass evaluation (no fallback — informational)
  const result = appraisalService.evaluate(subject, candidates, { filters, adjustments })
  const passingComps = result.comparables.filter((c) => c.isEnabled)

  if (passingComps.length === 0) {
    // Even without filter matches, show the raw candidates as Group B
    const rawPrices = candidates
      .filter((c) => c.salePrice != null && c.squareFeet && c.squareFeet > 0)
      .map((c) => (c.salePrice! / c.squareFeet!) * subjectSqft)
    const avgPrice = rawPrices.length > 0 ? Math.round(rawPrices.reduce((a, b) => a + b, 0) / rawPrices.length) : null
    const avgPricePerSqft = avgPrice != null && subjectSqft > 0 ? Math.round(avgPrice / subjectSqft) : null
    return {
      compIds: candidates.map((c) => c.id),
      asIsMarketPrice: avgPrice,
      avgPricePerSqft,
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
 * 1. Group A: Select top-percentile comps by sale price with strict filter matching
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
  const arvThreshold = params.arvThreshold ?? { percent: 15 }
  const allComparables = bundle.comparables

  const groupA = selectGroupAComps(
    bundle.property, allComparables, arvThreshold.percent,
    appraisalService, filters, adjustments
  )

  const finalAppraisalResult = groupA.appraisalResult
  const compClassifications = groupA.compClassifications
  // Note: selectGroupAComps throws BAD_DEAL error with filter advice if no comps pass

  // ── 2. Calculate ARV from Group A ──────────────────────────────────────────
  const enabledComps = finalAppraisalResult.comparables.filter((c) => c.isEnabled)
  if (enabledComps.length === 0) {
    throw new AnalysisError('No comparable sales were selected for ARV calculation. Try adjusting your appraisal filters or increasing the ARV threshold.')
  }
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
    arvThresholdPercent: arvThreshold.percent,
    asIsThresholdPercent,
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
