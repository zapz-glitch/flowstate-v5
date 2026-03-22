/**
 * Shared Appraisal Types
 *
 * Generic interfaces that both server (NormalizedProperty/NormalizedComparable)
 * and client (SubjectData/CompItem) can satisfy.
 */

// ─── Filter Types ──────────────────────────────────────────────────────────────

export type FilterType =
  | 'subdivision_match'
  | 'building_style_match'
  | 'sale_age'
  | 'sqft_diff'
  | 'property_type'
  | 'year_built_diff'
  | 'distance'

/** Whether a filter is required (hard) or preferred (soft) */
export type FilterPriority = 'hard' | 'soft'

export interface AppraisalFilter {
  type: FilterType
  enabled: boolean
  /** Threshold value for the filter */
  value: number
}

export interface FilterResult {
  type: FilterType
  passed: boolean
  reason?: string
  actualValue?: number | string | null
  threshold?: number | string | null
}

// ─── Adjustment Types ──────────────────────────────────────────────────────────

export type AdjustmentType =
  | 'old_comp_discount'
  | 'bedroom'
  | 'bathroom'
  | 'pool'
  | 'garage'
  | 'carport'

export interface AppraisalAdjustment {
  type: AdjustmentType
  enabled: boolean
  /** Fixed dollar amount per unit */
  amount: number
  /** Percentage (for old_comp_discount) */
  percent?: number
}

export interface AdjustmentResult {
  type: AdjustmentType
  applied: boolean
  amount: number
  reason?: string
}

// ─── Generic Property/Comp Interfaces ──────────────────────────────────────────

/**
 * Minimal property interface that both NormalizedProperty (server)
 * and SubjectData (client) satisfy.
 */
export interface PropertyLike {
  squareFeet?: number | null
  bedrooms?: number | null
  bathrooms?: number | null
  yearBuilt?: number | null
  subdivision?: string | null
  construction?: {
    buildingStyle?: string | null
  } | null
  features?: {
    poolType?: string[] | null
    garageType?: string[] | null
    garageSquareFeet?: number | null
  } | null
}

/**
 * Minimal comparable interface that both NormalizedComparable (server)
 * and CompItem (client) satisfy.
 */
export interface CompLike extends PropertyLike {
  salePrice?: number | null
  saleDate?: string | null
  pricePerSqft?: number | null
  distanceMiles?: number | null
}

// ─── Evaluation Result ─────────────────────────────────────────────────────────

export interface ComparableEvaluation {
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

// ─── UI Labels ─────────────────────────────────────────────────────────────────

export interface FilterLabel {
  label: string
  shortLabel: string
  unit: string
  description: string
}

export interface AdjustmentLabel {
  label: string
  description: string
  isPercentage?: boolean
  unavailable?: boolean
}
