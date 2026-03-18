/**
 * Appraisal Rules Types
 *
 * Types for comparable filtering, price adjustments, and appraisal presets.
 * Based on standard real estate appraisal methodology.
 *
 * Constants (DEFAULT_FILTERS, DEFAULT_ADJUSTMENTS, FILTER_LABELS, etc.)
 * are derived from the rule definitions in filters.ts and adjustments.ts.
 * To add a new rule:
 *   1. Add the type to the FilterType/AdjustmentType union below
 *   2. Add one object to the RULES array in filters.ts or adjustments.ts
 * That's it — defaults, labels, evaluator lookup, and filtersToApiParams
 * all update automatically from the rules.
 */

import type { NormalizedProperty, NormalizedComparable } from '../property-api/types'

// ─── Filter Types ──────────────────────────────────────────────────────────────

export type FilterType =
  | 'subdivision_match'
  | 'building_style_match'
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

/** UI metadata for a filter */
export interface FilterLabel {
  label: string
  shortLabel: string
  unit: string
  description: string
}

export interface FilterResult {
  type: FilterType
  passed: boolean
  reason?: string
  /** Actual value that was evaluated */
  actualValue?: number | string
  /** Threshold value */
  threshold?: number | string
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

/** UI metadata for an adjustment */
export interface AdjustmentLabel {
  label: string
  description: string
  isPercentage?: boolean
  unavailable?: boolean
}

export interface AdjustmentResult {
  type: AdjustmentType
  applied: boolean
  amount: number
  reason?: string
}

// ─── Evaluation Results ────────────────────────────────────────────────────────

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

export type ApiFilterParamKey = 'radiusMiles' | 'monthsBack' | 'sqftVariance'

/**
 * Parameters that can be sent to the CoreLogic API for pre-filtering.
 * These reduce API payload before post-fetch filtering is applied.
 */
export interface ApiFilterParams {
  /** Search radius in miles (from distance filter) */
  radiusMiles?: number
  /** Months back to search (from sale_age filter, converted from days) */
  monthsBack?: number
  /** Square footage variance (from sqft_diff filter) */
  sqftVariance?: number
}

// ─── Derived Constants (from Rule Definitions) ──────────────────────────────

// NOTE: These are imported lazily to avoid circular dependency.
// filters.ts and adjustments.ts import types from this file, so we import
// the rule arrays here only for deriving constants (not types).

import { FILTER_RULES } from './filters'
import { ADJUSTMENT_RULES } from './adjustments'

/** Derived from FILTER_RULES — one entry per rule definition */
export const DEFAULT_FILTERS: AppraisalFilter[] = FILTER_RULES.map((r) => ({
  type: r.type as FilterType,
  enabled: r.defaults.enabled,
  value: r.defaults.value,
}))

/** Derived from FILTER_RULES */
export const FILTER_LABELS = Object.fromEntries(
  FILTER_RULES.map((r) => [r.type, r.label])
) as Record<FilterType, FilterLabel>

/** Derived from ADJUSTMENT_RULES — one entry per rule definition */
export const DEFAULT_ADJUSTMENTS: AppraisalAdjustment[] = ADJUSTMENT_RULES.map((r) => ({
  type: r.type as AdjustmentType,
  enabled: r.defaults.enabled,
  amount: r.defaults.amount,
  percent: r.defaults.percent,
}))

/** Derived from ADJUSTMENT_RULES */
export const ADJUSTMENT_LABELS = Object.fromEntries(
  ADJUSTMENT_RULES.map((r) => [r.type, r.label])
) as Record<AdjustmentType, AdjustmentLabel>

/**
 * Convert appraisal filters to API-level filter parameters.
 * Derived from FILTER_RULES — each rule declares its own apiParam mapping.
 */
export function filtersToApiParams(filters: AppraisalFilter[]): ApiFilterParams {
  const params: ApiFilterParams = {}

  for (const filter of filters) {
    if (!filter.enabled) continue

    const rule = FILTER_RULES.find((r) => r.type === filter.type)
    if (!rule?.apiParam) continue

    const value = rule.apiParamConvert ? rule.apiParamConvert(filter.value) : filter.value
    params[rule.apiParam] = value
  }

  return params
}
