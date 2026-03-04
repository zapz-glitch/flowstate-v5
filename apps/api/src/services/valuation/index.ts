/**
 * Valuation Service
 *
 * Calculates property valuations including ARV, rehab costs, buy prices,
 * and investment metrics.
 *
 * This is a data-only service - it does not fetch data, only processes it.
 * Use PropertyApi.getPropertyBundle() to fetch data, then pass ARV to this service.
 *
 * Usage:
 *   import { createValuationService } from '../services/valuation'
 *
 *   const valuation = createValuationService()
 *
 *   // Calculate valuation from ARV
 *   const result = valuation.calculate({
 *     arv: 500000,
 *     subjectSqft: 2000,
 *     rehabLevelIndex: 2
 *   })
 */

import type {
  ArvTier,
  RehabLevel,
  RehabEstimate,
  MajorItem,
  ValuationParams,
  ValuationResult,
  ValuationResponse,
} from './types'
import { REHAB_LEVELS, MAJOR_ITEMS } from './types'

// Re-export types
export type {
  ArvTier,
  RehabLevel,
  RehabEstimate,
  MajorItem,
  ValuationParams,
  ValuationResult,
  ValuationResponse,
  PropertyAnalysisResult,
  AnalysisResponse,
} from './types'
export { REHAB_LEVELS, MAJOR_ITEMS } from './types'

// ─── Rehab Cost Table ──────────────────────────────────────────────────────────

export const DEFAULT_REHAB_TABLE: Record<ArvTier, RehabEstimate[]> = {
  under501k: [
    { perSqft: 25, minProfit: 30000 },
    { perSqft: 30, minProfit: 40000 },
    { perSqft: 35, minProfit: 40000 },
    { perSqft: 45, minProfit: 50000 },
    { perSqft: 60, minProfit: 50000 },
    { perSqft: 40, minProfit: 30000 },
    { perSqft: 50, minProfit: 40000 },
  ],
  '501kTo999k': [
    { perSqft: 30, minProfit: 50000 },
    { perSqft: 40, minProfit: 60000 },
    { perSqft: 45, minProfit: 60000 },
    { perSqft: 55, minProfit: 70000 },
    { perSqft: 75, minProfit: 70000 },
    { perSqft: 50, minProfit: 60000 },
    { perSqft: 60, minProfit: 70000 },
  ],
  '1mTo3m': [
    { perSqft: 60, minProfit: 100000 },
    { perSqft: 65, minProfit: 100000 },
    { perSqft: 70, minProfit: 100000 },
    { perSqft: 80, minProfit: 100000 },
    { perSqft: 100, minProfit: 100000 },
    { perSqft: 75, minProfit: 100000 },
    { perSqft: 85, minProfit: 100000 },
  ],
  over3m: [
    { perSqft: 80, minProfit: 150000 },
    { perSqft: 90, minProfit: 150000 },
    { perSqft: 100, minProfit: 150000 },
    { perSqft: 110, minProfit: 150000 },
    { perSqft: 120, minProfit: 150000 },
    { perSqft: 105, minProfit: 150000 },
    { perSqft: 115, minProfit: 150000 },
  ],
}

// ─── Helper Functions ──────────────────────────────────────────────────────────

function getArvTierInternal(arv: number): ArvTier {
  if (arv >= 3000000) return 'over3m'
  if (arv >= 1000000) return '1mTo3m'
  if (arv >= 501000) return '501kTo999k'
  return 'under501k'
}

function getRehabEstimateFromTable(table: Record<ArvTier, RehabEstimate[]>, arv: number, levelIndex: number): RehabEstimate {
  const tier = getArvTierInternal(arv)
  return table[tier][levelIndex] ?? table[tier][0]
}

// ─── Service Interface ─────────────────────────────────────────────────────────

export interface ValuationService {
  /**
   * Calculate valuation from provided ARV and parameters.
   * Returns the raw result (throws on error).
   */
  calculateValuation(params: ValuationParams): ValuationResult

  /**
   * Calculate valuation as response (with success/error handling).
   * This is the main method for external use.
   */
  calculate(params: ValuationParams): ValuationResponse

  /**
   * Get rehab level options for a given ARV and sqft.
   * Returns all 7 rehab levels with their estimated costs.
   */
  getRehabOptions(
    arv: number,
    subjectSqft: number
  ): Array<{
    index: number
    name: RehabLevel
    perSqft: number
    estimatedCost: number
  }>

  /**
   * Get major items list with defaults.
   */
  getMajorItems(): typeof MAJOR_ITEMS

  /**
   * Get ARV tier for a value.
   */
  getArvTier(arv: number): ArvTier
}

// ─── Implementation ────────────────────────────────────────────────────────────

class PropertyValuationService implements ValuationService {
  private readonly rehabTable: Record<ArvTier, RehabEstimate[]>

  constructor(customRehabTable?: Record<ArvTier, RehabEstimate[]>) {
    this.rehabTable = customRehabTable ?? DEFAULT_REHAB_TABLE
  }

  calculateValuation(params: ValuationParams): ValuationResult {
    const {
      arv,
      subjectSqft,
      compAvgSqft = subjectSqft,
      rehabLevelIndex = 2,
      majorItems = [],
      additionPlay = 0,
      closingCostsPercent = 10,
      carryingCostsPercent = 5,
      wholesaleFee = 10000,
      desiredProfit,
    } = params

    const arvTier = getArvTierInternal(arv)
    const rehabEstimate = getRehabEstimateFromTable(this.rehabTable, arv, rehabLevelIndex)
    const rehabLevel = REHAB_LEVELS[rehabLevelIndex]

    // Calculate costs
    const pricePerSqft = compAvgSqft > 0 ? Math.round(arv / compAvgSqft) : 0
    const baseRehabCost = (subjectSqft || compAvgSqft) * rehabEstimate.perSqft
    const majorItemsCost = majorItems
      .filter((item) => item.enabled)
      .reduce((sum, item) => sum + item.cost, 0)
    const totalRehabCost = baseRehabCost + majorItemsCost + additionPlay

    const closingCosts = Math.round(arv * (closingCostsPercent / 100))
    const carryingCosts = Math.round(arv * (carryingCostsPercent / 100))
    const minProfit = desiredProfit ?? rehabEstimate.minProfit

    // Buy Price = ARV − Rehab − Closing Costs − Carrying Costs − Profit Target
    const buyPrice = arv - totalRehabCost - closingCosts - carryingCosts - minProfit
    const buyPricePercent = arv > 0 ? Math.round((buyPrice / arv) * 100) : 0

    // Wholesale Price = Buy Price − Wholesale Fee
    const wholesalePrice = buyPrice - wholesaleFee
    const wholesalePricePercent = arv > 0 ? Math.round((wholesalePrice / arv) * 100) : 0

    // Total Investment = Buy Price + Rehab Cost
    const totalInvestment = buyPrice + totalRehabCost

    // Projected Profit = ARV − Total Investment − Closing − Carrying
    const projectedProfit = arv - totalInvestment - closingCosts - carryingCosts

    // ROI = (Projected Profit / Total Investment) × 100
    const projectedROI = totalInvestment > 0 ? Math.round((projectedProfit / totalInvestment) * 1000) / 10 : 0

    // Build breakdown
    const breakdown = [
      { label: 'After Repair Value (ARV)', amount: arv, percent: 100 },
      { label: 'Base Rehab Cost', amount: -baseRehabCost },
      { label: 'Major Items', amount: -majorItemsCost },
      { label: 'Addition Play', amount: -additionPlay },
      { label: 'Closing Costs', amount: -closingCosts, percent: closingCostsPercent },
      { label: 'Carrying Costs', amount: -carryingCosts, percent: carryingCostsPercent },
      { label: 'Desired Profit', amount: -minProfit },
      { label: 'Maximum Buy Price', amount: buyPrice, percent: buyPricePercent },
      { label: 'Wholesale Fee', amount: -wholesaleFee },
      { label: 'Wholesale Price', amount: wholesalePrice, percent: wholesalePricePercent },
    ]

    return {
      arv,
      arvTier,
      pricePerSqft,
      rehabLevel,
      rehabPerSqft: rehabEstimate.perSqft,
      baseRehabCost: Math.round(baseRehabCost),
      majorItemsCost,
      additionPlay,
      totalRehabCost: Math.round(totalRehabCost),
      closingCostsPercent,
      closingCosts,
      carryingCostsPercent,
      carryingCosts,
      buyPrice: Math.round(buyPrice),
      buyPricePercent,
      wholesaleFee,
      wholesalePrice: Math.round(wholesalePrice),
      wholesalePricePercent,
      desiredProfit: minProfit,
      projectedProfit: Math.round(projectedProfit),
      projectedROI,
      totalInvestment: Math.round(totalInvestment),
      breakdown,
    }
  }

  calculate(params: ValuationParams): ValuationResponse {
    try {
      if (!params.arv || params.arv <= 0) {
        return { success: false, error: 'ARV must be greater than 0', code: 'INVALID_ARV' }
      }
      if (!params.subjectSqft || params.subjectSqft <= 0) {
        return { success: false, error: 'Subject sqft must be greater than 0', code: 'INVALID_SQFT' }
      }

      return { success: true, data: this.calculateValuation(params) }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Valuation calculation failed',
        code: 'CALCULATION_ERROR',
      }
    }
  }

  getRehabOptions(
    arv: number,
    subjectSqft: number
  ): Array<{
    index: number
    name: RehabLevel
    perSqft: number
    estimatedCost: number
  }> {
    return REHAB_LEVELS.map((name, index) => {
      const estimate = getRehabEstimateFromTable(this.rehabTable, arv, index)
      return {
        index,
        name,
        perSqft: estimate.perSqft,
        estimatedCost: subjectSqft * estimate.perSqft,
      }
    })
  }

  getMajorItems(): typeof MAJOR_ITEMS {
    return MAJOR_ITEMS
  }

  getArvTier(arv: number): ArvTier {
    return getArvTierInternal(arv)
  }
}

// ─── Factory Function ──────────────────────────────────────────────────────────

/**
 * Create a new valuation service instance.
 * No dependencies required - this is a pure calculation service.
 */
export function createValuationService(customRehabTable?: Record<ArvTier, RehabEstimate[]>): ValuationService {
  return new PropertyValuationService(customRehabTable)
}
