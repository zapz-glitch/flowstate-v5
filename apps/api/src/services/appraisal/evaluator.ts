/**
 * Appraisal Rule Evaluator
 *
 * Evaluates comparables against filters and calculates adjustments.
 * Filter and adjustment logic is defined in filters.ts and adjustments.ts.
 * This module builds lookup maps from those rule definitions and provides
 * the evaluateComparable / evaluateComparables entry points.
 */

import type { NormalizedProperty, NormalizedComparable } from '../property-api/types'
import type {
  AppraisalFilter,
  AppraisalAdjustment,
  FilterResult,
  AdjustmentResult,
  ComparableEvaluation,
} from './types'
import { FILTER_RULES } from './filters'
import { ADJUSTMENT_RULES } from './adjustments'

// ─── Lookup Maps (built once at module load) ─────────────────────────────────

const filterEvaluatorMap = new Map(
  FILTER_RULES.map((r) => [r.type, r.evaluate])
)

const adjustmentCalculatorMap = new Map(
  ADJUSTMENT_RULES.map((r) => [r.type, r.calculate])
)

// ─── Main Evaluator ────────────────────────────────────────────────────────────

/**
 * Evaluate a comparable against filters and adjustments
 */
export function evaluateComparable(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  filters: AppraisalFilter[],
  adjustments: AppraisalAdjustment[]
): ComparableEvaluation {
  // Evaluate all enabled filters
  const filterResults: FilterResult[] = []
  const disableReasons: string[] = []

  for (const filter of filters) {
    if (!filter.enabled) continue

    const evaluator = filterEvaluatorMap.get(filter.type)
    if (!evaluator) continue

    const result = evaluator(subject, comp, filter)
    filterResults.push(result)

    if (!result.passed && result.reason) {
      disableReasons.push(result.reason)
    }
  }

  const shouldDisable = disableReasons.length > 0

  // Calculate adjustments (even for disabled comps, for reference)
  const adjustmentResults: AdjustmentResult[] = []
  let totalAdjustment = 0

  for (const adjustment of adjustments) {
    if (!adjustment.enabled) continue

    const calculator = adjustmentCalculatorMap.get(adjustment.type)
    if (!calculator) continue

    const result = calculator(subject, comp, adjustment)
    adjustmentResults.push(result)

    if (result.applied) {
      totalAdjustment += result.amount
    }
  }

  // Use salePrice, or calculate from pricePerSqft * squareFeet if salePrice is missing
  // (CoreLogic API sometimes returns pricePerSqft without salePrice)
  let originalPrice = comp.salePrice
  if (originalPrice == null && comp.pricePerSqft != null && comp.squareFeet != null) {
    originalPrice = Math.round(comp.pricePerSqft * comp.squareFeet)
  }
  const adjustedPrice = originalPrice != null ? originalPrice + totalAdjustment : null

  return {
    comparableId: comp.id,
    shouldDisable,
    filterResults,
    disableReasons,
    totalAdjustment,
    adjustmentResults,
    originalPrice,
    adjustedPrice,
  }
}

/**
 * Evaluate all comparables and return evaluations
 */
export function evaluateComparables(
  subject: NormalizedProperty,
  comparables: NormalizedComparable[],
  filters: AppraisalFilter[],
  adjustments: AppraisalAdjustment[]
): Map<string, ComparableEvaluation> {
  const evaluations = new Map<string, ComparableEvaluation>()

  for (const comp of comparables) {
    const evaluation = evaluateComparable(subject, comp, filters, adjustments)
    evaluations.set(comp.id, evaluation)
  }

  return evaluations
}
