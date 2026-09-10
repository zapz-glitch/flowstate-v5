/**
 * Saved-Report Comp Recalculation
 *
 * Recomputes ARV and valuation for a saved report when the operator
 * re-selects comparables from the report UI. Works entirely from the
 * saved response payload — the appraisal filter evidence, adjusted
 * prices, and applied settings snapshot are already embedded, so no
 * external calls are needed.
 *
 * Semantics mirror the ARV engine: the ARV group is the up-to-3
 * highest-priced *eligible* comps (comps that passed appraisal filters);
 * the operator's selection is honored among eligible comps only.
 */

import type { Env } from '../../types'
import { createValuationService } from '../valuation'
import type { ValuationResult, MajorItem } from '../valuation/types'
import type { AnalysisResponse } from '../analysis'

const MAX_ARV_COMPS = 3

interface SavedCompItem {
  id: string
  salePrice: number | null
  adjustedPrice: number | null
  squareFeet: number | null
  isEnabled: boolean
  compGroup: 'arv' | 'as_is' | null
  classification?: { type?: string } | null
  appraisalRules?: { passedFilters?: boolean } | null
  [key: string]: unknown
}

interface SavedReport {
  [key: string]: unknown
  subject?: { squareFeet?: number | null } & Record<string, unknown>
  valuation?: Record<string, unknown>
  appliedSettings?: {
    rehabLevelIndex?: number
    rehabTable?: Record<string, Array<{ perSqft: number; minProfit: number }>>
    majorItems?: Array<{ id: string; enabled: boolean; cost: number }>
    additionPlay?: number
    dealParams?: {
      closingCostsPercent?: number
      carryingCostsPercent?: number
      wholesaleFee?: number
    }
  }
  evaluationRevision?: number
  comps?: {
    total?: number
    enabledCount?: number
    disabledCount?: number
    avgPricePerSqft?: number | null
    medianPrice?: number | null
    asIsCompIds?: string[]
    afterRenovationCompIds?: string[]
    bestMatch?: { compId: string; reasoning: string }
    items?: SavedCompItem[]
  }
}

/**
 * Recalculate a saved report with an operator-selected comp set.
 *
 * @param selectedCompIds Comp IDs to use for ARV, or null to restore the
 *                        engine's automatic selection.
 */
export async function recalculateReport(
  saved: SavedReport,
  _jobId: string,
  selectedCompIds: string[] | null,
  _env: Env,
  _userId?: string
): Promise<SavedReport> {
  const items = saved.comps?.items
  if (!items || items.length === 0) {
    throw Object.assign(new Error('This report has no comparable data to recalculate from. Run a new analysis first.'), { status: 409 })
  }
  const subjectSqft = saved.subject?.squareFeet ?? 0

  // Eligible = passed appraisal filters and has usable price evidence
  const eligible = items.filter(
    (c) =>
      (c.appraisalRules?.passedFilters !== false) &&
      (c.adjustedPrice ?? c.salePrice) != null &&
      (c.adjustedPrice ?? c.salePrice)! > 0
  )

  let arvComps: SavedCompItem[]
  if (selectedCompIds === null) {
    // Restore automatic selection: top-3 highest-priced eligible comps
    arvComps = [...eligible]
      .sort((a, b) => (b.adjustedPrice ?? b.salePrice ?? 0) - (a.adjustedPrice ?? a.salePrice ?? 0))
      .slice(0, MAX_ARV_COMPS)
  } else {
    const eligibleIds = new Set(eligible.map((c) => c.id))
    const invalid = selectedCompIds.filter((id) => !eligibleIds.has(id))
    if (invalid.length > 0) {
      throw Object.assign(
        new Error(`One or more comparables lack valid sale evidence or failed appraisal rules: ${invalid.join(', ')}`),
        { status: 422 }
      )
    }
    arvComps = eligible.filter((c) => selectedCompIds.includes(c.id))
  }

  if (arvComps.length === 0) {
    throw Object.assign(new Error('No comparable sales selected for ARV calculation.'), { status: 422 })
  }

  // ARV = mean(adjustedPrice / compSqft) × subjectSqft, with a
  // mean-adjusted-price fallback when sqft data is missing
  const withSqft = arvComps.filter((c) => (c.squareFeet ?? 0) > 0)
  let arv: number
  if (withSqft.length === arvComps.length && subjectSqft > 0) {
    const meanPerSqft = arvComps.reduce(
      (sum, c) => sum + (c.adjustedPrice ?? c.salePrice!) / (c.squareFeet as number),
      0
    ) / arvComps.length
    arv = Math.round(meanPerSqft * subjectSqft)
  } else {
    arv = Math.round(
      arvComps.reduce((sum, c) => sum + (c.adjustedPrice ?? c.salePrice!), 0) / arvComps.length
    )
  }

  // Re-run valuation with the report's applied settings snapshot
  const applied = saved.appliedSettings
  const settings = applied
    ? {
        rehabLevelIndex: applied.rehabLevelIndex,
        majorItems: applied.majorItems,
        additionPlay: applied.additionPlay,
        closingCostsPercent: applied.dealParams?.closingCostsPercent,
        carryingCostsPercent: applied.dealParams?.carryingCostsPercent,
        wholesaleFee: applied.dealParams?.wholesaleFee,
      }
    : undefined
  const valuationService = createValuationService(applied?.rehabTable as never)
  const compAvgSqft =
    arvComps.reduce((sum, c) => sum + (c.squareFeet ?? 0), 0) / arvComps.length || subjectSqft
  const valuation: ValuationResult = valuationService.calculateValuation({
    arv,
    subjectSqft,
    compAvgSqft,
    rehabLevelIndex: settings?.rehabLevelIndex ?? 2,
    majorItems: (settings?.majorItems ?? []) as MajorItem[],
    additionPlay: settings?.additionPlay ?? 0,
    closingCostsPercent: settings?.closingCostsPercent ?? 8,
    carryingCostsPercent: settings?.carryingCostsPercent ?? 2,
    wholesaleFee: settings?.wholesaleFee ?? 10000,
  })

  // Recompute comp group tags + enabled counts
  const arvIds = new Set(arvComps.map((c) => c.id))
  const nextItems = items.map((c) => ({
    ...c,
    isEnabled: c.appraisalRules?.passedFilters !== false,
    compGroup: arvIds.has(c.id) ? ('arv' as const) : c.compGroup === 'arv' ? null : c.compGroup,
    isBestMatch: false,
  }))
  const enabledCount = nextItems.filter((c) => c.isEnabled).length
  const asIsCompIds = nextItems.filter((c) => c.isEnabled && c.classification?.type === 'as_is').map((c) => c.id)
  const afterRenovationCompIds = nextItems.filter((c) => c.isEnabled && c.classification?.type !== 'as_is').map((c) => c.id)

  const bestId = arvComps[0]?.id
  const next = nextItems.map((c) => ({ ...c, isBestMatch: c.id === bestId }))

  return {
    ...saved,
    valuation: {
      ...(saved.valuation ?? {}),
      arv,
      arvPerSqft: subjectSqft > 0 ? Math.round(arv / subjectSqft) : null,
      arvSource: 'appraisal',
      arvMethodology: `avg(adjustedPrice/compSqft × subjectSqft) across ${arvComps.length} operator-selected comp${arvComps.length !== 1 ? 's' : ''}`,
      buyPrice: valuation.buyPrice,
      buyPricePercent: valuation.buyPricePercent,
      rehabCost: valuation.totalRehabCost,
      projectedProfit: valuation.projectedProfit,
      projectedROI: valuation.projectedROI,
      totalInvestment: valuation.totalInvestment,
      wholesalePrice: valuation.wholesalePrice,
      closingCosts: valuation.closingCosts,
      carryingCosts: valuation.carryingCosts,
      recommendation: valuation.recommendation,
      recommendationReason: valuation.recommendationReason,
      breakdown: valuation.breakdown,
    } as never,
    comps: {
      ...saved.comps,
      enabledCount,
      disabledCount: nextItems.length - enabledCount,
      asIsCompIds,
      afterRenovationCompIds,
      bestMatch: bestId
        ? { compId: bestId, reasoning: 'Highest-priced comp in the selected ARV set.' }
        : undefined,
      items: next,
    },
    evaluationRevision: (saved.evaluationRevision ?? 0) + 1,
  }
}
