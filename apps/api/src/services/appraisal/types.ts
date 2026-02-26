/**
 * Appraisal Rules Types
 *
 * Types for comparable filtering, price adjustments, and appraisal presets.
 * Based on standard real estate appraisal methodology.
 */

import type { NormalizedProperty, NormalizedComparable } from '../property-api/types'

// ─── Filter Types ──────────────────────────────────────────────────────────────

export type FilterType =
  | 'subdivision_match'
  | 'sale_age'
  | 'sqft_diff'
  | 'year_built_diff'
  | 'distance'

export interface AppraisalFilter {
  type: FilterType
  enabled: boolean
  /** Threshold value for the filter */
  value: number
}

export const DEFAULT_FILTERS: AppraisalFilter[] = [
  { type: 'subdivision_match', enabled: true, value: 1 }, // Must match subdivision
  { type: 'sale_age', enabled: true, value: 30 }, // 30 days
  { type: 'sqft_diff', enabled: true, value: 250 }, // 250 sqft variance
  { type: 'year_built_diff', enabled: true, value: 10 }, // 10 years
  { type: 'distance', enabled: true, value: 0.5 }, // 0.5 miles
]

// ─── Filter Labels (for UI) ────────────────────────────────────────────────────

export const FILTER_LABELS: Record<FilterType, {
  label: string
  shortLabel: string
  unit: string
  description: string
}> = {
  subdivision_match: {
    label: 'Subdivision Match',
    shortLabel: 'Subdivision',
    unit: '',
    description: 'Must be in same subdivision as subject',
  },
  sale_age: {
    label: 'Sale Age',
    shortLabel: 'Sale Age',
    unit: 'days',
    description: 'Maximum days since comparable sold',
  },
  sqft_diff: {
    label: 'Square Footage Difference',
    shortLabel: 'SqFt Diff',
    unit: 'sqft',
    description: 'Maximum sqft difference from subject',
  },
  year_built_diff: {
    label: 'Year Built Difference',
    shortLabel: 'Year Diff',
    unit: 'years',
    description: 'Maximum year built difference from subject',
  },
  distance: {
    label: 'Search Distance',
    shortLabel: 'Distance',
    unit: 'miles',
    description: 'Maximum distance from subject property',
  },
}

// ─── Adjustment Types ──────────────────────────────────────────────────────────

export type AdjustmentType =
  | 'old_comp_discount'
  | 'bedroom'
  | 'bathroom'
  | 'pool'
  | 'garage'

export interface AppraisalAdjustment {
  type: AdjustmentType
  enabled: boolean
  /** Fixed dollar amount per unit */
  amount: number
  /** Percentage (for old_comp_discount) */
  percent?: number
}

export const DEFAULT_ADJUSTMENTS: AppraisalAdjustment[] = [
  { type: 'old_comp_discount', enabled: true, amount: 0, percent: 15 },
  { type: 'bedroom', enabled: true, amount: 15000 },
  { type: 'bathroom', enabled: true, amount: 10000 },
  { type: 'pool', enabled: false, amount: 10000 },
  { type: 'garage', enabled: false, amount: 10000 },
]

// ─── Adjustment Labels (for UI) ───────────────────────────────────────────────

export const ADJUSTMENT_LABELS: Record<AdjustmentType, {
  label: string
  description: string
  isPercentage?: boolean
  unavailable?: boolean
}> = {
  old_comp_discount: {
    label: 'Old Comp Discount',
    description: 'Discount percentage for older sales',
    isPercentage: true,
  },
  bedroom: {
    label: 'Bedroom Adjustment',
    description: 'Dollar adjustment per bedroom difference',
  },
  bathroom: {
    label: 'Bathroom Adjustment',
    description: 'Dollar adjustment per bathroom difference',
  },
  pool: {
    label: 'Pool Adjustment',
    description: 'Add value if subject has a pool',
  },
  garage: {
    label: 'Garage Adjustment',
    description: 'Add value if subject has a garage',
  },
}

// ─── Evaluation Results ────────────────────────────────────────────────────────

export interface FilterResult {
  type: FilterType
  passed: boolean
  reason?: string
  /** Actual value that was evaluated */
  actualValue?: number | string
  /** Threshold value */
  threshold?: number | string
}

export interface AdjustmentResult {
  type: AdjustmentType
  applied: boolean
  amount: number
  reason?: string
}

export interface ComparableEvaluation {
  comparableId: string
  /** Whether this comparable should be disabled */
  shouldDisable: boolean
  /** Filter evaluation results */
  filterResults: FilterResult[]
  /** Reasons for disabling (if any) */
  disableReasons: string[]
  /** Total adjustment amount */
  totalAdjustment: number
  /** Individual adjustment results */
  adjustmentResults: AdjustmentResult[]
  /** Original sale price */
  originalPrice: number | null
  /** Adjusted sale price */
  adjustedPrice: number | null
}

// ─── Appraisal Rule Preset ─────────────────────────────────────────────────────

export interface AppraisalRulePreset {
  id: string
  name: string
  description?: string
  isDefault: boolean
  filters: AppraisalFilter[]
  adjustments: AppraisalAdjustment[]
}

// ─── Appraisal Options ─────────────────────────────────────────────────────────

export interface AppraisalOptions {
  /** Filters to apply (uses defaults if not provided) */
  filters?: AppraisalFilter[]
  /** Adjustments to apply (uses defaults if not provided) */
  adjustments?: AppraisalAdjustment[]
}

// ─── Appraised Comparable ──────────────────────────────────────────────────────

export interface AppraisedComparable extends NormalizedComparable {
  /** Evaluation results */
  evaluation: ComparableEvaluation
  /** Whether this comparable is included in ARV calculation */
  isEnabled: boolean
  /** Adjusted price after applying rules */
  adjustedSalePrice: number | null
}

// ─── Appraisal Result ──────────────────────────────────────────────────────────

export interface AppraisalResult {
  /** Subject property */
  subject: NormalizedProperty
  /** All comparables with evaluations */
  comparables: AppraisedComparable[]
  /** Enabled comparables count */
  enabledCount: number
  /** Disabled comparables count */
  disabledCount: number
  /** Applied filters */
  appliedFilters: AppraisalFilter[]
  /** Applied adjustments */
  appliedAdjustments: AppraisalAdjustment[]
  /** ARV calculated from enabled comparables */
  arv: number
  /** Average price per sqft */
  avgPricePerSqft: number | null
  /** Median sale price of enabled comparables */
  medianSalePrice: number | null
}

// ─── Response Types ────────────────────────────────────────────────────────────

export interface AppraisalSuccessResponse {
  success: true
  data: AppraisalResult
}

export interface AppraisalErrorResponse {
  success: false
  error: string
  code?: string
}

export type AppraisalResponse = AppraisalSuccessResponse | AppraisalErrorResponse

// ─── API-Level Filter Params ──────────────────────────────────────────────────

/**
 * Parameters that can be sent to the CoreLogic API for pre-filtering
 * These reduce API payload before post-fetch filtering is applied
 */
export interface ApiFilterParams {
  /** Search radius in miles (from distance filter) */
  radiusMiles?: number
  /** Months back to search (from sale_age filter, converted from days) */
  monthsBack?: number
  /** Square footage variance (from sqft_diff filter) */
  sqftVariance?: number
}

/**
 * Convert appraisal filters to API-level filter parameters
 *
 * API-level filters (reduce API payload):
 * - sale_age → monthsBack (days converted to months)
 * - sqft_diff → sqftVariance
 * - distance → radiusMiles
 *
 * Post-fetch filters (applied after enrichment):
 * - subdivision_match (requires property details)
 * - property_type (strict matching)
 * - year_built_diff (not supported by API)
 */
export function filtersToApiParams(filters: AppraisalFilter[]): ApiFilterParams {
  const params: ApiFilterParams = {}

  for (const filter of filters) {
    if (!filter.enabled) continue

    switch (filter.type) {
      case 'sale_age':
        // Convert days to months (round up to include partial months)
        params.monthsBack = Math.ceil(filter.value / 30)
        break
      case 'sqft_diff':
        // Pass sqftVariance directly
        params.sqftVariance = filter.value
        break
      case 'distance':
        // Pass radiusMiles directly
        params.radiusMiles = filter.value
        break
      // These filters are applied post-fetch:
      // - subdivision_match (requires enrichment)
      // - property_type (needs normalization)
      // - year_built_diff (not API-supported)
    }
  }

  return params
}
