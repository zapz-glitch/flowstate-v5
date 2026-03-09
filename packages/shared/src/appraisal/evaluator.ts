/**
 * Shared Comparable Evaluator
 *
 * Evaluates a comparable against filters and adjustments.
 * Works with any property/comp shape satisfying PropertyLike/CompLike.
 */

import type {
  PropertyLike,
  CompLike,
  AppraisalFilter,
  AppraisalAdjustment,
  ComparableEvaluation,
} from './types'
import { evaluateFilter } from './filters'
import { calculateAdjustment } from './adjustments'

/**
 * Evaluate a single comparable against filters and adjustments.
 */
export function evaluateComparable(
  subject: PropertyLike,
  comp: CompLike,
  filters: AppraisalFilter[],
  adjustments: AppraisalAdjustment[]
): ComparableEvaluation {
  // Evaluate all enabled filters
  const filterResults = []
  const disableReasons: string[] = []

  for (const filter of filters) {
    if (!filter.enabled) continue

    const result = evaluateFilter(subject, comp, filter)
    filterResults.push(result)

    if (!result.passed && result.reason) {
      disableReasons.push(result.reason)
    }
  }

  const shouldDisable = disableReasons.length > 0

  // Calculate adjustments (even for disabled comps, for reference)
  const adjustmentResults = []
  let totalAdjustment = 0

  for (const adjustment of adjustments) {
    if (!adjustment.enabled) continue

    const result = calculateAdjustment(subject, comp, adjustment)
    adjustmentResults.push(result)

    if (result.applied) {
      totalAdjustment += result.amount
    }
  }

  // Use salePrice, or calculate from pricePerSqft * squareFeet if salePrice is missing
  let originalPrice = comp.salePrice ?? null
  if (originalPrice == null && comp.pricePerSqft != null && comp.squareFeet != null) {
    originalPrice = Math.round(comp.pricePerSqft * comp.squareFeet)
  }
  const adjustedPrice = originalPrice != null ? originalPrice + totalAdjustment : null

  return {
    shouldDisable,
    filterResults,
    disableReasons,
    totalAdjustment,
    adjustmentResults,
    originalPrice,
    adjustedPrice,
  }
}
