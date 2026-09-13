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
      status: 'not_verified',
      reason: 'Subdivision data not available — rule not verified',
    }
  }

  const passed = subdivisionsMatch(subjectSub, compSub)
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
      status: 'not_verified',
      reason: 'Subject sqft not available — rule not verified',
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
      status: 'not_verified',
      reason: 'Year built not available — rule not verified',
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
      status: 'not_verified',
      reason: 'Distance not available — rule not verified',
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

function evaluatePropertyType(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  _filter: AppraisalFilter
): FilterResult {
  const subjectType = normalizePropertyType(subject.propertyType)
  const compType = normalizePropertyType(comp.propertyType)

  if (!subjectType || !compType) {
    return {
      type: 'property_type',
      passed: true,
      status: 'not_verified',
      reason: 'Property type data not available — rule not verified',
    }
  }

  const passed = subjectType === compType
  return {
    type: 'property_type',
    passed,
    status: passed ? 'passed' : 'failed',
    reason: passed ? undefined : `Property type mismatch: "${compType}" vs subject "${subjectType}"`,
    actualValue: compType,
    threshold: subjectType,
  }
}

function evaluateLotSizeDiff(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  filter: AppraisalFilter
): FilterResult {
  const subjectLotSqft =
    subject.lotSizeSquareFeet ??
    (subject.lotSizeAcres != null ? Math.round(subject.lotSizeAcres * 43560) : null)
  const compLotSqft =
    comp.lotSizeSquareFeet ??
    (comp.lotSizeAcres != null ? Math.round(comp.lotSizeAcres * 43560) : null)

  if (subjectLotSqft == null || compLotSqft == null) {
    return {
      type: 'lot_size_diff',
      passed: true,
      status: 'not_verified',
      reason: 'Lot size data not available — rule not verified',
    }
  }

  const diff = Math.abs(compLotSqft - subjectLotSqft)
  const passed = diff <= filter.value
  return {
    type: 'lot_size_diff',
    passed,
    status: passed ? 'passed' : 'failed',
    reason: passed ? undefined : `Lot size difference too large: ${diff} sqft (max: ${filter.value})`,
    actualValue: diff,
    threshold: filter.value,
  }
}

function evaluateRoadBarrier(
  _subject: NormalizedProperty,
  comp: NormalizedComparable,
  _filter: AppraisalFilter
): FilterResult {
  // Requires geospatial road-network data. When the provider supplies
  // crossesMajorRoad the rule is enforced; otherwise honestly not verified.
  if (comp.crossesMajorRoad == null) {
    return {
      type: 'road_barrier',
      passed: true,
      status: 'not_verified',
      reason: 'Road-barrier geospatial data unavailable — rule not verified',
    }
  }

  const passed = comp.crossesMajorRoad === false
  return {
    type: 'road_barrier',
    passed,
    status: passed ? 'passed' : 'failed',
    reason: passed ? undefined : 'Comparable is across a major road from subject',
    actualValue: comp.crossesMajorRoad ? 'crosses' : 'same_side',
    threshold: 'same_side',
  }
}

function evaluateBuildingStyleMatch(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  _filter: AppraisalFilter
): FilterResult {
  const subjectStyle = subject.construction?.buildingStyle?.toLowerCase().trim()
  const compStyle = comp.construction?.buildingStyle?.toLowerCase().trim()

  if (!subjectStyle || !compStyle) {
    return {
      type: 'building_style_match',
      passed: true,
      status: 'not_verified',
      reason: 'Building style data not available',
    }
  }

  const passed = subjectStyle === compStyle
  return {
    type: 'building_style_match',
    passed,
    status: passed ? 'passed' : 'failed',
    reason: passed ? undefined : `Style mismatch: "${compStyle}" vs subject "${subjectStyle}"`,
    actualValue: compStyle,
    threshold: subjectStyle,
  }
}

/** Foundation match — slab ≠ pier/beam ≠ basement changes rehab scope */
function evaluateFoundationMatch(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  _filter: AppraisalFilter
): FilterResult {
  const normalize = (v?: string | null) =>
    v?.toLowerCase().replace(/[^a-z]/g, '')
  const subjectFoundation = normalize(subject.construction?.foundationType)
  const compFoundation = normalize(comp.construction?.foundationType)

  if (!subjectFoundation || !compFoundation) {
    return {
      type: 'foundation_match',
      passed: true,
      status: 'not_verified',
      reason: 'Foundation type data not available — rule not verified',
    }
  }

  const passed = subjectFoundation === compFoundation
  return {
    type: 'foundation_match',
    passed,
    status: passed ? 'passed' : 'failed',
    reason: passed ? undefined : `Foundation mismatch: "${comp.construction?.foundationType}" vs subject "${subject.construction?.foundationType}"`,
    actualValue: comp.construction?.foundationType,
    threshold: subject.construction?.foundationType,
  }
}

/**
 * Pure neighborhood match: name OR code equality is sufficient evidence.
 * Returns null when no comparable field pair exists (not verifiable).
 * Used both by the neighborhood_match filter and by the fallback ladder's
 * neighborhood tier — the tier works off raw geography even when the
 * soft filter is disabled in the user's preset.
 */
export function neighborhoodsMatch(
  subject: Pick<NormalizedProperty, 'neighborhoodName' | 'neighborhoodCode'>,
  comp: Pick<NormalizedComparable, 'neighborhoodName' | 'neighborhoodCode'>
): boolean | null {
  const normalize = (v?: string | null) => v?.toLowerCase().trim().replace(/\s+/g, ' ') || null
  const subjectName = normalize(subject.neighborhoodName)
  const compName = normalize(comp.neighborhoodName)
  const subjectCode = normalize(subject.neighborhoodCode)
  const compCode = normalize(comp.neighborhoodCode)

  if ((!subjectName || !compName) && (!subjectCode || !compCode)) return null
  return (subjectName != null && subjectName === compName) ||
    (subjectCode != null && subjectCode === compCode)
}

function evaluateNeighborhoodMatch(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  _filter: AppraisalFilter
): FilterResult {
  const normalize = (v?: string | null) => v?.toLowerCase().trim().replace(/\s+/g, ' ') || null
  const subjectName = normalize(subject.neighborhoodName)
  const compName = normalize(comp.neighborhoodName)
  const subjectCode = normalize(subject.neighborhoodCode)
  const compCode = normalize(comp.neighborhoodCode)
  const matched = neighborhoodsMatch(subject, comp)

  if (matched === null) {
    return {
      type: 'neighborhood_match',
      passed: true,
      status: 'not_verified',
      reason: 'Neighborhood data not available — rule not verified',
    }
  }

  // Match on name OR code — either is sufficient evidence
  const nameMatch = subjectName != null && compName != null && subjectName === compName
  const codeMatch = subjectCode != null && compCode != null && subjectCode === compCode
  const via = nameMatch && codeMatch ? 'name+code' : nameMatch ? 'name' : 'code'
  return {
    type: 'neighborhood_match',
    passed: matched,
    status: matched ? 'passed' : 'failed',
    reason: matched
      ? (nameMatch && !codeMatch ? undefined : `Neighborhood matched via ${via}`)
      : `Neighborhood mismatch: "${compName ?? compCode}" vs subject "${subjectName ?? subjectCode}"`,
    actualValue: compName ?? compCode ?? undefined,
    threshold: subjectName ?? subjectCode ?? undefined,
  }
}

/**
 * Construction material match — construction type (frame/masonry) and
 * exterior wall material (brick/wood siding/stucco). Compares every field
 * present on both sides; a mismatch on any compared field fails.
 */
function evaluateConstructionMaterialMatch(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  _filter: AppraisalFilter
): FilterResult {
  const normalize = (v?: string | null) => v?.toLowerCase().replace(/[^a-z]/g, '') || null
  const pairs: Array<[string | null, string | null, string]> = [
    [normalize(subject.construction?.type), normalize(comp.construction?.type), 'construction type'],
    [normalize(subject.construction?.exteriorWalls), normalize(comp.construction?.exteriorWalls), 'exterior walls'],
  ]

  const compared = pairs.filter(([s, c]) => s && c)
  if (compared.length === 0) {
    return {
      type: 'construction_material_match',
      passed: true,
      status: 'not_verified',
      reason: 'Construction material data not available — rule not verified',
    }
  }

  const mismatched = compared.find(([s, c]) => s !== c)
  const passed = !mismatched
  return {
    type: 'construction_material_match',
    passed,
    status: passed ? 'passed' : 'failed',
    reason: passed
      ? undefined
      : `Construction mismatch: ${mismatched![2]} "${comp.construction?.exteriorWalls ?? comp.construction?.type}" vs subject "${subject.construction?.exteriorWalls ?? subject.construction?.type}"`,
    actualValue: comp.construction?.exteriorWalls ?? comp.construction?.type,
    threshold: subject.construction?.exteriorWalls ?? subject.construction?.type,
  }
}

/** Pool match — pool presence must match the subject */
function evaluatePoolMatch(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  _filter: AppraisalFilter
): FilterResult {
  if (subject.features?.poolType == null || comp.features?.poolType == null) {
    return {
      type: 'pool_match',
      passed: true,
      status: 'not_verified',
      reason: 'Pool data not available — rule not verified',
    }
  }

  const subjectHas = hasPool(subject)
  const compHas = hasPool(comp)
  const passed = subjectHas === compHas
  return {
    type: 'pool_match',
    passed,
    status: passed ? 'passed' : 'failed',
    reason: passed
      ? undefined
      : `Pool mismatch: comp ${compHas ? 'has' : 'has no'} pool vs subject ${subjectHas ? 'has' : 'has no'} pool`,
    actualValue: compHas ? 'pool' : 'none',
    threshold: subjectHas ? 'pool' : 'none',
  }
}

/** Garage/carport match — covered parking presence must match the subject */
function evaluateGarageMatch(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  _filter: AppraisalFilter
): FilterResult {
  const compHasParkingData =
    comp.features != null &&
    (comp.features.garageType != null ||
      comp.features.garageSquareFeet != null ||
      comp.features.carportType != null)
  const subjectHasParkingData =
    subject.features != null &&
    (subject.features.garageType != null ||
      subject.features.garageSquareFeet != null ||
      subject.features.carportType != null ||
      subject.features.carportSpaces != null)

  if (!subjectHasParkingData || !compHasParkingData) {
    return {
      type: 'garage_match',
      passed: true,
      status: 'not_verified',
      reason: 'Garage/carport data not available — rule not verified',
    }
  }

  // Covered parking = garage OR carport on either side
  const subjectHas = hasGarage(subject) || hasCarport(subject)
  const compHas = hasGarage(comp) || hasCarport(comp)
  const passed = subjectHas === compHas
  return {
    type: 'garage_match',
    passed,
    status: passed ? 'passed' : 'failed',
    reason: passed
      ? undefined
      : `Garage/carport mismatch: comp ${compHas ? 'has' : 'has no'} covered parking vs subject ${subjectHas ? 'has' : 'has none'}`,
    actualValue: compHas ? 'covered_parking' : 'none',
    threshold: subjectHas ? 'covered_parking' : 'none',
  }
}

/** Stories match — story count (soft priority: ranks, never disqualifies) */
function evaluateStoriesMatch(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  _filter: AppraisalFilter
): FilterResult {
  const subjectStories = subject.stories ?? null
  const compStories = comp.stories ?? null

  if (subjectStories == null || compStories == null) {
    return {
      type: 'stories_match',
      passed: true,
      status: 'not_verified',
      reason: 'Story count not available — rule not verified',
    }
  }

  // Half-story tolerance: 1.5-story comps are compatible with both 1 and 2
  const passed = Math.abs(subjectStories - compStories) <= 0.5
  return {
    type: 'stories_match',
    passed,
    status: passed ? 'passed' : 'failed',
    reason: passed ? undefined : `Stories mismatch: comp ${compStories} vs subject ${subjectStories}`,
    actualValue: compStories,
    threshold: subjectStories,
  }
}

/** Roof material match — roof cover material (soft priority) */
function evaluateRoofMaterialMatch(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  _filter: AppraisalFilter
): FilterResult {
  const normalize = (v?: string | null) => v?.toLowerCase().replace(/[^a-z]/g, '') || null
  const subjectRoof = normalize(subject.construction?.roofCover ?? subject.construction?.roofType)
  const compRoof = normalize(comp.construction?.roofCover ?? comp.construction?.roofType)

  if (!subjectRoof || !compRoof) {
    return {
      type: 'roof_material_match',
      passed: true,
      status: 'not_verified',
      reason: 'Roof material data not available — rule not verified',
    }
  }

  const passed = subjectRoof === compRoof
  return {
    type: 'roof_material_match',
    passed,
    status: passed ? 'passed' : 'failed',
    reason: passed
      ? undefined
      : `Roof material mismatch: "${comp.construction?.roofCover ?? comp.construction?.roofType}" vs subject "${subject.construction?.roofCover ?? subject.construction?.roofType}"`,
    actualValue: comp.construction?.roofCover ?? comp.construction?.roofType,
    threshold: subject.construction?.roofCover ?? subject.construction?.roofType,
  }
}

// Assessor condition tiers, best → worst. Unknown labels get no tier.
const CONDITION_TIERS: Record<string, number> = {
  excellent: 7,
  verygood: 6,
  good: 5,
  average: 4,
  fair: 3,
  poor: 2,
  verypoor: 1,
}

function conditionTier(v?: string | null): number | null {
  if (!v) return null
  return CONDITION_TIERS[v.toLowerCase().replace(/[^a-z]/g, '')] ?? null
}

/**
 * Assessor condition match — the comp cannot be in a worse assessor
 * condition tier than the subject (a distressed comp never anchors ARV).
 * Replaces the LLM/Firecrawl condition classification with provider data.
 */
function evaluateConditionMatch(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  _filter: AppraisalFilter
): FilterResult {
  const subjectTier = conditionTier(subject.buildingCondition)
  const compTier = conditionTier(comp.buildingCondition)

  if (subjectTier == null || compTier == null) {
    return {
      type: 'condition_match',
      passed: true,
      status: 'not_verified',
      reason: 'Assessor condition data not available — rule not verified',
    }
  }

  const passed = compTier >= subjectTier
  return {
    type: 'condition_match',
    passed,
    status: passed ? 'passed' : 'failed',
    reason: passed
      ? undefined
      : `Condition mismatch: comp "${comp.buildingCondition}" below subject "${subject.buildingCondition}"`,
    actualValue: comp.buildingCondition ?? undefined,
    threshold: subject.buildingCondition ?? undefined,
  }
}

const FILTER_EVALUATORS: Record<
  FilterType,
  (subject: NormalizedProperty, comp: NormalizedComparable, filter: AppraisalFilter) => FilterResult
> = {
  subdivision_match: evaluateSubdivisionMatch,
  neighborhood_match: evaluateNeighborhoodMatch,
  building_style_match: evaluateBuildingStyleMatch,
  foundation_match: evaluateFoundationMatch,
  construction_material_match: evaluateConstructionMaterialMatch,
  pool_match: evaluatePoolMatch,
  garage_match: evaluateGarageMatch,
  stories_match: evaluateStoriesMatch,
  roof_material_match: evaluateRoofMaterialMatch,
  condition_match: evaluateConditionMatch,
  sale_age: evaluateSaleAge,
  sqft_diff: evaluateSqftDiff,
  year_built_diff: evaluateYearBuiltDiff,
  distance: evaluateDistance,
  property_type: evaluatePropertyType,
  lot_size_diff: evaluateLotSizeDiff,
  road_barrier: evaluateRoadBarrier,
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

  // Only apply if the sale is older than the configured threshold —
  // the adjustment's thresholdDays field (default 90) carries it.
  const thresholdDays = adjustment.thresholdDays ?? 90
  if (daysDiff <= thresholdDays) {
    return { type: 'old_comp_discount', applied: false, amount: 0, reason: `Sale within ${thresholdDays} days` }
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

function hasPool(p: { features?: { poolType?: string } | undefined }): boolean {
  return !!p.features?.poolType && p.features.poolType.length > 0
}

function hasGarage(p: { features?: { garageType?: string; garageSquareFeet?: number } | undefined }): boolean {
  return (
    (!!p.features?.garageType && p.features.garageType.length > 0) ||
    (!!p.features?.garageSquareFeet && p.features.garageSquareFeet > 0)
  )
}

function hasCarport(p: { features?: { carportType?: string; carportSpaces?: number } | undefined }): boolean {
  return (
    (!!p.features?.carportType && p.features.carportType.length > 0) ||
    (!!p.features?.carportSpaces && p.features.carportSpaces > 0)
  )
}

function calculatePoolAdjustment(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  adjustment: AppraisalAdjustment
): AdjustmentResult {
  const subjectHas = hasPool(subject)
  const compHas = hasPool(comp)
  const diff = (subjectHas ? 1 : 0) - (compHas ? 1 : 0)

  if (diff === 0) {
    return {
      type: 'pool',
      applied: false,
      amount: 0,
      reason: subjectHas && compHas ? 'Both have pool' : 'Neither has pool data/match',
    }
  }

  return {
    type: 'pool',
    applied: true,
    amount: diff * adjustment.amount,
    reason: diff > 0
      ? `Subject has pool, comp does not (+$${adjustment.amount.toLocaleString()})`
      : `Comp has pool, subject does not (-$${adjustment.amount.toLocaleString()})`,
  }
}

function calculateGarageAdjustment(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  adjustment: AppraisalAdjustment
): AdjustmentResult {
  const subjectHas = hasGarage(subject)
  const compHas = hasGarage(comp)
  const diff = (subjectHas ? 1 : 0) - (compHas ? 1 : 0)

  if (diff === 0) {
    return {
      type: 'garage',
      applied: false,
      amount: 0,
      reason: subjectHas && compHas ? 'Both have garage' : 'No garage difference',
    }
  }

  return {
    type: 'garage',
    applied: true,
    amount: diff * adjustment.amount,
    reason: diff > 0
      ? `Subject has garage, comp does not (+$${adjustment.amount.toLocaleString()})`
      : `Comp has garage, subject does not (-$${adjustment.amount.toLocaleString()})`,
  }
}

function calculateCarportAdjustment(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  adjustment: AppraisalAdjustment
): AdjustmentResult {
  const subjectHas = hasCarport(subject)
  const compHas = hasCarport(comp)
  const diff = (subjectHas ? 1 : 0) - (compHas ? 1 : 0)

  if (diff === 0) {
    return {
      type: 'carport',
      applied: false,
      amount: 0,
      reason: comp.features ? 'No carport difference' : 'Comp carport data not available',
    }
  }

  return {
    type: 'carport',
    applied: true,
    amount: diff * adjustment.amount,
    reason: diff > 0
      ? `Subject has carport, comp does not (+$${adjustment.amount.toLocaleString()})`
      : `Comp has carport, subject does not (-$${adjustment.amount.toLocaleString()})`,
  }
}

// ─── Traffic / Commercial Exposure Adjustments ────────────────────────────────

type TrafficKind = 'siding' | 'backing' | 'fronting'

function makeTrafficAdjustment(kind: TrafficKind) {
  const matchValues: Record<TrafficKind, string[]> = {
    siding: ['sides_traffic', 'sides_commercial'],
    backing: ['backs_traffic', 'backs_commercial'],
    fronting: ['fronts_traffic', 'fronts_commercial'],
  }

  const type = `traffic_${kind}` as const

  return function (
    _subject: NormalizedProperty,
    comp: NormalizedComparable,
    adjustment: AppraisalAdjustment
  ): AdjustmentResult {
    // Exposure data is mutually exclusive (one site influence per property),
    // which structurally prevents double counting across the three types.
    if (comp.siteInfluence == null) {
      return {
        type,
        applied: false,
        amount: 0,
        reason: 'Traffic/commercial exposure data unavailable — not verified',
      }
    }

    if (!matchValues[kind].includes(comp.siteInfluence)) {
      return { type, applied: false, amount: 0, reason: `Comp does not ${kind} traffic/commercial` }
    }

    const compValue =
      comp.salePrice ??
      (comp.pricePerSqft != null && comp.squareFeet != null
        ? Math.round(comp.pricePerSqft * comp.squareFeet)
        : 0)
    const threshold = adjustment.valueThreshold ?? 500000

    // Under threshold: flat $ deduction. At/over: percent deduction.
    const deduction =
      compValue < threshold
        ? adjustment.amount
        : Math.round(compValue * ((adjustment.percent ?? 0) / 100))

    return {
      type,
      applied: deduction > 0,
      amount: -deduction,
      reason:
        compValue < threshold
          ? `Comp ${kind} traffic/commercial (-$${deduction.toLocaleString()})`
          : `Comp ${kind} traffic/commercial (-${adjustment.percent}% = -$${deduction.toLocaleString()})`,
    }
  }
}

const calculateTrafficSiding = makeTrafficAdjustment('siding')
const calculateTrafficBacking = makeTrafficAdjustment('backing')
const calculateTrafficFronting = makeTrafficAdjustment('fronting')

function calculateBasementSqft(
  _subject: NormalizedProperty,
  comp: NormalizedComparable,
  adjustment: AppraisalAdjustment
): AdjustmentResult {
  // Basement/guest-house sqft is credited at percent% of normal $/sqft.
  // The deduction removes the over-valued portion of the comp's price.
  if (!comp.basementSquareFeet || comp.basementSquareFeet <= 0) {
    return {
      type: 'basement_sqft',
      applied: false,
      amount: 0,
      reason: 'No basement/guest-house sqft on comp',
    }
  }

  const normalPpsf =
    comp.pricePerSqft ??
    (comp.salePrice && comp.squareFeet ? comp.salePrice / comp.squareFeet : null)

  if (!normalPpsf) {
    return {
      type: 'basement_sqft',
      applied: false,
      amount: 0,
      reason: 'Cannot compute $/sqft for basement credit',
    }
  }

  const discountPct = adjustment.percent ?? 50
  // Basement area is only worth `discountPct`% — deduct the overvalued share
  const deduction = Math.round(comp.basementSquareFeet * normalPpsf * ((100 - discountPct) / 100))

  return {
    type: 'basement_sqft',
    applied: deduction > 0,
    amount: -deduction,
    reason: `${comp.basementSquareFeet} sqft basement credited at ${discountPct}% (-$${deduction.toLocaleString()})`,
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
  carport: calculateCarportAdjustment,
  traffic_siding: calculateTrafficSiding,
  traffic_backing: calculateTrafficBacking,
  traffic_fronting: calculateTrafficFronting,
  basement_sqft: calculateBasementSqft,
}

// ─── Helper Functions ──────────────────────────────────────────────────────────

function normalizeSubdivision(value: string | null | undefined): string | null {
  if (!value) return null
  return value.toLowerCase().trim().replace(/\s+/g, ' ')
}

/**
 * Subdivision base name — strips unit/phase/section/plat designators so
 * "SWEETWATER CREEK", "SWEETWATER CREEK S UT 2E", and "PARKSIDE LAKES PH 01"
 * resolve to their parent development ("sweetwater creek", "parkside lakes").
 */
function subdivisionBase(value: string | null | undefined): string | null {
  let v = normalizeSubdivision(value)
  if (!v) return null
  v = v.replace(/[\/\-_.,]/g, ' ').replace(/\s+/g, ' ').trim()
  v = v
    .replace(
      /(?:\b(?:un|unit|ut|u|ph|phase|sec|sect|section|blk|block|lot|plat|tract|add|addn|addition|part|pt|rep|repl|replat|vlg)\s*\w*|#\s*\w+).*$/i,
      ''
    )
    .trim()
  return v || null
}

/**
 * Two subdivisions match when their base names are equal, or one base is a
 * word-boundary prefix of the other — "sweetwater creek" ⊂ "sweetwater creek
 * south" (same parent development) but "oak" ⊄ "oakwood" (different names).
 */
function subdivisionsMatch(
  subjectSub: string | null | undefined,
  compSub: string | null | undefined
): boolean {
  const a = subdivisionBase(subjectSub)
  const b = subdivisionBase(compSub)
  if (!a || !b) return false
  if (a === b) return true
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a]
  return longer.startsWith(shorter) && longer[shorter.length] === ' '
}

function normalizePropertyType(value: string | null | undefined): string | null {
  if (!value) return null
  const v = value.toLowerCase().trim()
  // Collapse common variants into comparable buckets
  if (/single.?family|sfr|detached/.test(v)) return 'single_family'
  if (/condo|condominium/.test(v)) return 'condo'
  if (/town ?(home|house)|row/.test(v)) return 'townhome'
  if (/multi|duplex|triplex|quad/.test(v)) return 'multi_family'
  if (/manufactured|mobile/.test(v)) return 'manufactured'
  if (/land|lot|vacant/.test(v)) return 'land'
  return v.replace(/\s+/g, '_')
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
    if (!result.status) {
      result.status = result.passed ? 'passed' : 'failed'
    }
    filterResults.push(result)

    // Soft filters (stories, roof material) record the mismatch for
    // ranking/reporting but never disqualify the comp.
    if (!result.passed && result.reason && filter.priority !== 'soft') {
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
