/**
 * Shared Valuation Calculator
 *
 * Single source of truth for valuation calculations.
 * Used by both server (apps/api) and client (apps/dashboard).
 *
 * Formulas:
 *   baseRehabCost  = (subjectSqft || compAvgSqft) × perSqft
 *   totalRehabCost = baseRehabCost + majorItemsCost + additionPlay
 *   closingCosts   = arv × (closingCostsPercent / 100)
 *   carryingCosts  = arv × (carryingCostsPercent / 100)
 *   buyPrice       = arv - totalRehabCost - closingCosts - carryingCosts - minProfit
 *   totalInvestment= buyPrice + totalRehabCost
 *   projectedProfit= arv - totalInvestment - closingCosts - carryingCosts
 *   projectedROI   = (projectedProfit / totalInvestment) × 100
 */

import type { ValuationParams, ValuationResult, RehabLevelEstimate, RehabTable } from './types'
import { REHAB_LEVELS } from './types'
import { getArvTier, getRehabEstimate, DEFAULT_REHAB_TABLE } from './constants'

export function calculateValuation(
  params: ValuationParams,
  rehabTable: RehabTable = DEFAULT_REHAB_TABLE
): ValuationResult {
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

  const arvTier = getArvTier(arv)
  const rehabEstimate = getRehabEstimate(rehabTable, arv, rehabLevelIndex)
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
  const projectedROI = totalInvestment > 0
    ? Math.round((projectedProfit / totalInvestment) * 1000) / 10
    : 0

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

/**
 * Calculate all rehab level estimates for a given ARV.
 * Returns array with full valuation calculations for each of the 7 rehab levels.
 */
export function calculateAllRehabLevelEstimates(
  params: ValuationParams,
  rehabTable: RehabTable = DEFAULT_REHAB_TABLE,
  selectedRehabLevelIndex: number = 2
): RehabLevelEstimate[] {
  return REHAB_LEVELS.map((name, index) => {
    const valuation = calculateValuation(
      { ...params, rehabLevelIndex: index },
      rehabTable
    )

    return {
      index,
      name,
      perSqft: valuation.rehabPerSqft,
      estimatedCost: valuation.totalRehabCost,
      buyPrice: valuation.buyPrice,
      wholesalePrice: valuation.wholesalePrice,
      projectedProfit: valuation.projectedProfit,
      projectedROI: valuation.projectedROI,
      isSelected: index === selectedRehabLevelIndex,
    }
  })
}
