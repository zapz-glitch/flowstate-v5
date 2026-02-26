/**
 * Appraisal Rule Evaluator
 *
 * Evaluates comparables against filters and calculates adjustments.
 */

import type { NormalizedProperty, NormalizedComparable } from '../property-api/types'
import type {
  AppraisalFilter,
  AppraisalAdjustment,
  FilterResult,
  AdjustmentResult,
  ComparableEvaluation,
  FilterType,
  AdjustmentType,
} from './types'

// ─── Filter Evaluators ─────────────────────────────────────────────────────────

function evaluateSubdivisionMatch(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  _filter: AppraisalFilter
): FilterResult {
  const subjectSub = normalizeSubdivision(subject.subdivision)
  // Use enriched subdivision data from comp, fallback to raw data
  const compSub = normalizeSubdivision(
    comp.subdivision ?? (comp.raw as { subdivision?: string } | undefined)?.subdivision
  )

  // Skip if either is missing - graceful fallback per v1 behavior
  if (!subjectSub || !compSub) {
    return {
      type: 'subdivision_match',
      passed: true,
      reason: 'Subdivision data not available',
    }
  }

  const passed = subjectSub === compSub
  return {
    type: 'subdivision_match',
    passed,
    reason: passed ? undefined : `Subdivision mismatch: "${compSub}" vs subject "${subjectSub}"`,
    actualValue: compSub,
    threshold: subjectSub,
  }
}

function evaluateSaleAge(
  _subject: NormalizedProperty,
  comp: NormalizedComparable,
  filter: AppraisalFilter
): FilterResult {
  if (!comp.saleDate) {
    return {
      type: 'sale_age',
      passed: false,
      reason: 'No sale date available',
    }
  }

  const saleDate = new Date(comp.saleDate)

  // Check if date is valid
  if (isNaN(saleDate.getTime())) {
    return {
      type: 'sale_age',
      passed: false,
      reason: `Invalid sale date format: "${comp.saleDate}"`,
    }
  }

  const today = new Date()
  const daysDiff = Math.floor((today.getTime() - saleDate.getTime()) / (1000 * 60 * 60 * 24))

  const passed = daysDiff <= filter.value
  return {
    type: 'sale_age',
    passed,
    reason: passed ? undefined : `Sale too old: ${daysDiff} days (max: ${filter.value})`,
    actualValue: daysDiff,
    threshold: filter.value,
  }
}

function evaluateSqftDiff(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  filter: AppraisalFilter
): FilterResult {
  if (!subject.squareFeet) {
    return {
      type: 'sqft_diff',
      passed: true,
      reason: 'Subject sqft not available',
    }
  }

  if (!comp.squareFeet) {
    return {
      type: 'sqft_diff',
      passed: false,
      reason: 'Comparable sqft not available',
    }
  }

  const diff = Math.abs(comp.squareFeet - subject.squareFeet)
  const passed = diff <= filter.value

  return {
    type: 'sqft_diff',
    passed,
    reason: passed ? undefined : `Sqft difference too large: ${diff} sqft (max: ${filter.value})`,
    actualValue: diff,
    threshold: filter.value,
  }
}

function evaluateYearBuiltDiff(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  filter: AppraisalFilter
): FilterResult {
  if (!subject.yearBuilt || !comp.yearBuilt) {
    return {
      type: 'year_built_diff',
      passed: true,
      reason: 'Year built not available',
    }
  }

  const diff = Math.abs(comp.yearBuilt - subject.yearBuilt)
  const passed = diff <= filter.value

  return {
    type: 'year_built_diff',
    passed,
    reason: passed ? undefined : `Year built difference too large: ${diff} years (max: ${filter.value})`,
    actualValue: diff,
    threshold: filter.value,
  }
}

function evaluateDistance(
  _subject: NormalizedProperty,
  comp: NormalizedComparable,
  filter: AppraisalFilter
): FilterResult {
  if (comp.distanceMiles == null) {
    return {
      type: 'distance',
      passed: true,
      reason: 'Distance not available',
    }
  }

  const passed = comp.distanceMiles <= filter.value
  return {
    type: 'distance',
    passed,
    reason: passed ? undefined : `Distance too far: ${comp.distanceMiles.toFixed(2)} miles (max: ${filter.value})`,
    actualValue: comp.distanceMiles,
    threshold: filter.value,
  }
}

const FILTER_EVALUATORS: Record<
  FilterType,
  (subject: NormalizedProperty, comp: NormalizedComparable, filter: AppraisalFilter) => FilterResult
> = {
  subdivision_match: evaluateSubdivisionMatch,
  sale_age: evaluateSaleAge,
  sqft_diff: evaluateSqftDiff,
  year_built_diff: evaluateYearBuiltDiff,
  distance: evaluateDistance,
}

// ─── Adjustment Calculators ────────────────────────────────────────────────────

function calculateOldCompDiscount(
  _subject: NormalizedProperty,
  comp: NormalizedComparable,
  adjustment: AppraisalAdjustment
): AdjustmentResult {
  if (!comp.saleDate || !comp.salePrice) {
    return { type: 'old_comp_discount', applied: false, amount: 0, reason: 'No sale data' }
  }

  const saleDate = new Date(comp.saleDate)
  const today = new Date()
  const daysDiff = Math.floor((today.getTime() - saleDate.getTime()) / (1000 * 60 * 60 * 24))

  // Only apply if sale is > 90 days old
  if (daysDiff <= 90) {
    return { type: 'old_comp_discount', applied: false, amount: 0, reason: 'Sale within 90 days' }
  }

  const monthsOld = daysDiff / 30
  const percent = adjustment.percent || 15
  // Cap at the max percentage
  const discountPercent = Math.min(percent, (percent * monthsOld) / 12)
  const discountAmount = Math.round(comp.salePrice * (discountPercent / 100))

  return {
    type: 'old_comp_discount',
    applied: true,
    amount: -discountAmount, // Negative for discount
    reason: `${discountPercent.toFixed(1)}% discount for ${Math.round(monthsOld)} months old`,
  }
}

function calculateBedroomAdjustment(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  adjustment: AppraisalAdjustment
): AdjustmentResult {
  if (subject.bedrooms == null || comp.bedrooms == null) {
    return { type: 'bedroom', applied: false, amount: 0, reason: 'Bedroom data not available' }
  }

  const diff = subject.bedrooms - comp.bedrooms
  if (diff === 0) {
    return { type: 'bedroom', applied: false, amount: 0, reason: 'Same bedroom count' }
  }

  const amount = diff * adjustment.amount
  return {
    type: 'bedroom',
    applied: true,
    amount,
    reason: `${diff > 0 ? '+' : ''}${diff} bedrooms × $${adjustment.amount.toLocaleString()}`,
  }
}

function calculateBathroomAdjustment(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  adjustment: AppraisalAdjustment
): AdjustmentResult {
  if (subject.bathrooms == null || comp.bathrooms == null) {
    return { type: 'bathroom', applied: false, amount: 0, reason: 'Bathroom data not available' }
  }

  const diff = subject.bathrooms - comp.bathrooms
  if (diff === 0) {
    return { type: 'bathroom', applied: false, amount: 0, reason: 'Same bathroom count' }
  }

  const amount = diff * adjustment.amount
  return {
    type: 'bathroom',
    applied: true,
    amount,
    reason: `${diff > 0 ? '+' : ''}${diff} bathrooms × $${adjustment.amount.toLocaleString()}`,
  }
}

function calculatePoolAdjustment(
  subject: NormalizedProperty,
  _comp: NormalizedComparable,
  adjustment: AppraisalAdjustment
): AdjustmentResult {
  const hasPool = subject.features?.poolType && subject.features.poolType.length > 0
  if (!hasPool) {
    return { type: 'pool', applied: false, amount: 0, reason: 'Subject has no pool' }
  }

  return {
    type: 'pool',
    applied: true,
    amount: adjustment.amount,
    reason: `Subject has pool (+$${adjustment.amount.toLocaleString()})`,
  }
}

function calculateGarageAdjustment(
  subject: NormalizedProperty,
  _comp: NormalizedComparable,
  adjustment: AppraisalAdjustment
): AdjustmentResult {
  const hasGarage =
    (subject.features?.garageType && subject.features.garageType.length > 0) ||
    (subject.features?.garageSquareFeet && subject.features.garageSquareFeet > 0)

  if (!hasGarage) {
    return { type: 'garage', applied: false, amount: 0, reason: 'Subject has no garage' }
  }

  return {
    type: 'garage',
    applied: true,
    amount: adjustment.amount,
    reason: `Subject has garage (+$${adjustment.amount.toLocaleString()})`,
  }
}

const ADJUSTMENT_CALCULATORS: Record<
  AdjustmentType,
  (subject: NormalizedProperty, comp: NormalizedComparable, adjustment: AppraisalAdjustment) => AdjustmentResult
> = {
  old_comp_discount: calculateOldCompDiscount,
  bedroom: calculateBedroomAdjustment,
  bathroom: calculateBathroomAdjustment,
  pool: calculatePoolAdjustment,
  garage: calculateGarageAdjustment,
}

// ─── Helper Functions ──────────────────────────────────────────────────────────

function normalizeSubdivision(value: string | null | undefined): string | null {
  if (!value) return null
  return value.toLowerCase().trim().replace(/\s+/g, ' ')
}

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

    const evaluator = FILTER_EVALUATORS[filter.type]
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

    const calculator = ADJUSTMENT_CALCULATORS[adjustment.type]
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
    console.log(`[Evaluator] Calculated salePrice from pricePerSqft: ${originalPrice} (${comp.pricePerSqft} * ${comp.squareFeet})`)
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
