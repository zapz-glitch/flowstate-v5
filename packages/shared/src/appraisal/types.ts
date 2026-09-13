/**
 * Shared Appraisal Types
 *
 * Generic interfaces that both server (NormalizedProperty/NormalizedComparable)
 * and client (SubjectData/CompItem) can satisfy.
 */

// ─── Filter Types ──────────────────────────────────────────────────────────────

export type FilterType =
  | 'subdivision_match'
  | 'neighborhood_match'
  | 'building_style_match'
  | 'foundation_match'
  | 'construction_material_match'
  | 'pool_match'
  | 'garage_match'
  | 'stories_match'
  | 'roof_material_match'
  | 'condition_match'
  | 'sale_age'
  | 'sqft_diff'
  | 'property_type'
  | 'year_built_diff'
  | 'distance'
  | 'lot_size_diff'
  | 'road_barrier'

/** Whether a filter is required (hard) or preferred (soft) */
export type FilterPriority = 'hard' | 'soft'

export interface AppraisalFilter {
  type: FilterType
  enabled: boolean
  /** Threshold value for the filter */
  value: number
  /**
   * hard (default): a verified failure disqualifies the comp.
   * soft: failure is recorded for ranking/reporting but never disqualifies.
   */
  priority?: 'hard' | 'soft'
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
  | 'traffic_siding'
  | 'traffic_backing'
  | 'traffic_fronting'
  | 'basement_sqft'

export interface AppraisalAdjustment {
  type: AdjustmentType
  enabled: boolean
  /** Fixed dollar amount per unit */
  amount: number
  /** Percentage (for old_comp_discount) */
  percent?: number
  /** For old_comp_discount: sales older than this many days get the discount (default 90) */
  thresholdDays?: number
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
  propertyType?: string | null
  lotSizeSquareFeet?: number | null
  basementSquareFeet?: number | null
  /** Cotality site-location neighborhood name */
  neighborhoodName?: string | null
  /** Story count */
  stories?: number | null
  /** Assessor building improvement condition (e.g. "Average") */
  buildingCondition?: string | null
  construction?: {
    buildingStyle?: string | null
    foundationType?: string | null
    /** Construction type (e.g. Frame, Masonry) */
    type?: string | null
    /** Exterior wall material (e.g. Wood Siding, Brick) */
    exteriorWalls?: string | null
    /** Roof cover material */
    roofCover?: string | null
  } | null
  features?: {
    poolType?: string[] | null
    garageType?: string[] | null
    garageSquareFeet?: number | null
    carportType?: string | null
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
  /** True when the comp sits across a major road from the subject */
  crossesMajorRoad?: boolean
  /** Site/influence quality flag (traffic influence) */
  siteInfluence?: string | null
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
