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
  | 'year_built_diff'
  | 'distance'
  | 'property_type'
  | 'lot_size_diff'
  | 'road_barrier'

export interface AppraisalFilter {
  type: FilterType
  enabled: boolean
  /** Threshold value for the filter */
  value: number
  /**
   * hard (default): a verified failure disqualifies the comp.
   * soft: failure is recorded for ranking/reporting but never disqualifies —
   * used for "ideally matches" fields like stories and roof material.
   */
  priority?: 'hard' | 'soft'
}

export const DEFAULT_FILTERS: AppraisalFilter[] = [
  // HARD RULES (the fixed deal-breakers):
  //   sale_age ≤180d · same subdivision · ±250 sqft · same property type ·
  //   no major-road crossing · ±10yr build date.
  // Neighborhood is a datapoint only — recorded and displayed, never used
  // for comp selection.
  { type: 'subdivision_match', enabled: true, value: 1 },
  { type: 'neighborhood_match', enabled: true, value: 1, priority: 'soft' },
  // Preferred physical matches (soft) — assessed from provider building
  // data; recorded for confidence/ranking, never disqualify.
  { type: 'building_style_match', enabled: true, value: 1, priority: 'soft' },
  { type: 'foundation_match', enabled: true, value: 1, priority: 'soft' },
  { type: 'construction_material_match', enabled: true, value: 1, priority: 'soft' },
  { type: 'pool_match', enabled: true, value: 1, priority: 'soft' },
  { type: 'garage_match', enabled: true, value: 1, priority: 'soft' },
  { type: 'condition_match', enabled: true, value: 1, priority: 'soft' }, // assessor condition — comp at/above subject tier scores higher
  { type: 'stories_match', enabled: true, value: 1, priority: 'soft' },
  { type: 'roof_material_match', enabled: true, value: 1, priority: 'soft' },
  // Size/recency/geography thresholds (relaxable in expansion tiers)
  { type: 'sale_age', enabled: true, value: 180 }, // 6 months max comp age
  { type: 'sqft_diff', enabled: true, value: 250 }, // ±250 sqft variance
  { type: 'year_built_diff', enabled: true, value: 10 }, // ±10 years
  { type: 'distance', enabled: true, value: 1.0 }, // 1 mile (matches API search)
  { type: 'property_type', enabled: true, value: 1 }, // Same property/build type
  { type: 'lot_size_diff', enabled: true, value: 2500, priority: 'soft' }, // ±2,500 sqft lot — similarity data, not a deal-breaker
  { type: 'road_barrier', enabled: true, value: 1 }, // No crossing major roads (not_verified when no data)
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
  neighborhood_match: {
    label: 'Neighborhood Match',
    shortLabel: 'Neighborhood',
    unit: '',
    description: 'Must be in the same neighborhood — fallback geography when no subdivision exists',
  },
  building_style_match: {
    label: 'Building Style Match',
    shortLabel: 'Style',
    unit: '',
    description: 'Must match subject building style (e.g. Ranch, Colonial)',
  },
  foundation_match: {
    label: 'Foundation Match',
    shortLabel: 'Foundation',
    unit: '',
    description: 'Must match subject foundation type (e.g. Slab, Continuous Footing)',
  },
  construction_material_match: {
    label: 'Construction Material Match',
    shortLabel: 'Construction',
    unit: '',
    description: 'Must match subject construction type and exterior wall material (e.g. Frame/Wood Siding vs Brick)',
  },
  pool_match: {
    label: 'Pool Match',
    shortLabel: 'Pool',
    unit: '',
    description: 'Pool presence must match the subject',
  },
  garage_match: {
    label: 'Garage/Carport Match',
    shortLabel: 'Garage',
    unit: '',
    description: 'Covered parking (garage or carport) presence must match the subject',
  },
  stories_match: {
    label: 'Stories Match',
    shortLabel: 'Stories',
    unit: '',
    description: 'Story count should match the subject (preferred — ranks comps, never disqualifies)',
  },
  roof_material_match: {
    label: 'Roof Material Match',
    shortLabel: 'Roof',
    unit: '',
    description: 'Roof cover material should match the subject (preferred — matters in some markets)',
  },
  condition_match: {
    label: 'Assessor Condition Match',
    shortLabel: 'Condition',
    unit: '',
    description: 'Comp assessor condition must be at or above the subject tier (e.g. comp cannot be worse condition)',
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
  property_type: {
    label: 'Property Type Match',
    shortLabel: 'Prop Type',
    unit: '',
    description: 'Must be the same property/build type as subject',
  },
  lot_size_diff: {
    label: 'Lot Size Difference',
    shortLabel: 'Lot Diff',
    unit: 'sqft',
    description: 'Maximum lot size difference from subject (sqft)',
  },
  road_barrier: {
    label: 'Major Road Barrier',
    shortLabel: 'Road Barrier',
    unit: '',
    description: 'Comp must not be across a major road from subject (not verified when geospatial road data unavailable)',
  },
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
  /** Fixed dollar amount per unit (for traffic: flat deduction below valueThreshold).
   *  For old_comp_discount this carries the age threshold in days. */
  amount: number
  /** Percentage (for old_comp_discount; for traffic: percent deduction at/above valueThreshold) */
  percent?: number
  /** For old_comp_discount: sales older than this many days get the discount (default 90) */
  thresholdDays?: number
  /** For traffic adjustments: comp value boundary switching flat $ → % deduction (default 500000) */
  valueThreshold?: number
}

export const DEFAULT_ADJUSTMENTS: AppraisalAdjustment[] = [
  { type: 'old_comp_discount', enabled: true, amount: 0, percent: 15, thresholdDays: 90 },
  { type: 'bedroom', enabled: true, amount: 15000 },
  { type: 'bathroom', enabled: true, amount: 10000 },
  { type: 'pool', enabled: true, amount: 10000 },
  { type: 'garage', enabled: true, amount: 10000 },
  { type: 'carport', enabled: true, amount: 5000 },
  // Traffic/commercial exposure: flat $ under $500K, % at/over $500K
  { type: 'traffic_siding', enabled: true, amount: 10000, percent: 10, valueThreshold: 500000 },
  { type: 'traffic_backing', enabled: true, amount: 10000, percent: 15, valueThreshold: 500000 },
  { type: 'traffic_fronting', enabled: true, amount: 15000, percent: 20, valueThreshold: 500000 },
  // Basement/guest-house sqft credited at 50% of normal $/sqft
  { type: 'basement_sqft', enabled: true, amount: 0, percent: 50 },
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
    description: 'Discount % applied to sales older than the configured age threshold (days)',
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
  carport: {
    label: 'Carport Adjustment',
    description: 'Add value if subject has a carport and comp does not',
  },
  traffic_siding: {
    label: 'Traffic Siding Adjustment',
    description: 'Deduction when comp sides a busy road/commercial (flat $ under threshold, % over)',
    unavailable: false,
  },
  traffic_backing: {
    label: 'Traffic Backing Adjustment',
    description: 'Deduction when comp backs a busy road/commercial (flat $ under threshold, % over)',
  },
  traffic_fronting: {
    label: 'Traffic Fronting Adjustment',
    description: 'Deduction when comp fronts a busy road/commercial (flat $ under threshold, % over)',
  },
  basement_sqft: {
    label: 'Basement/Guest-House SqFt',
    description: 'Basement or guest-house square footage credited at configured % of normal $/sqft',
    isPercentage: true,
  },
}

// ─── Evaluation Results ────────────────────────────────────────────────────────

export interface FilterResult {
  type: FilterType
  passed: boolean
  /**
   * Verification status of the rule check:
   * - passed/failed: rule was evaluated with available data
   * - not_verified: required data was unavailable — the rule was NOT
   *   checked and did not disqualify the comp
   */
  status?: 'passed' | 'failed' | 'not_verified'
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

/**
 * Expansion policy — governs how comp rules relax when fewer than the
 * required number of valid comps are found. Rules are never silently
 * weakened; each expansion tier is explicitly enabled and recorded.
 *
 * Sale age is NEVER relaxed — comps must be inside the configured max
 * (default 180 days) at every tier; we always want the most recent
 * sales. The sanctioned concession is build-era: year_built_diff widens
 * progressively (±10 → ±12 → ±14 by default) inside each location scope
 * before geography expands — subdivision → widened radius → radius-only.
 */
export interface ExpansionPolicy {
  /** Master switch for all expansion tiers (default: true) */
  enabled?: boolean
  /** Allow widening year_built_diff when the comp pool is thin (default: true) */
  allowYearBuiltExpansion?: boolean
  /**
   * Extra year tolerances tried in order after the configured
   * year_built_diff value (default: [+2, +4] → ±10, ±12, ±14).
   * These are the ONLY sanctioned year-built relaxations.
   */
  yearBuiltExpansionSteps?: number[]
  /** Allow dropping the subdivision constraint within a widened radius (default: true) */
  allowGeographicExpansion?: boolean
  /** Allow dropping the radius constraint entirely (default: true) */
  allowNeighborhoodExpansion?: boolean
  /** Distance multiplier when geography expands (default: 2 = widen to 2× configured radius) */
  geographicDistanceMultiplier?: number
}

export const DEFAULT_EXPANSION_POLICY: Required<ExpansionPolicy> = {
  enabled: true,
  allowYearBuiltExpansion: true,
  yearBuiltExpansionSteps: [2, 4],
  allowGeographicExpansion: true,
  allowNeighborhoodExpansion: true,
  geographicDistanceMultiplier: 2,
}

export interface AppraisalOptions {
  /** Filters to apply (uses defaults if not provided) */
  filters?: AppraisalFilter[]
  /** Adjustments to apply (uses defaults if not provided) */
  adjustments?: AppraisalAdjustment[]
  /** Expansion policy for insufficient-comp scenarios */
  expansion?: ExpansionPolicy
}

// ─── Appraised Comparable ──────────────────────────────────────────────────────

export interface AppraisedComparable extends NormalizedComparable {
  /** Evaluation results */
  evaluation: ComparableEvaluation
  /** Whether this comparable passed the appraisal rules */
  isEnabled: boolean
  /**
   * ARV selection status:
   * - selected: one of the top-3 highest-priced valid comps used for ARV
   * - not_examined: passed rules but never reached — 3 valid comps already
   *   accepted (NOT_EXAMINED_FOR_ARV)
   * - disqualified: failed one or more appraisal rules
   */
  arvStatus?: 'selected' | 'not_examined' | 'disqualified'
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
  /** ARV calculated from selected comps (top-3 highest-priced valid sales) */
  arv: number
  /** Average price per sqft */
  avgPricePerSqft: number | null
  /** Median sale price of enabled comparables */
  medianSalePrice: number | null
  /** IDs of comps selected for ARV (up to 3, highest-priced valid) */
  selectedCompIds?: string[]
  /** True when fewer than 3 valid comps found even after approved expansion */
  insufficientComps?: boolean
  /** Expansion tiers actually applied to reach the comp set */
  expansionApplied?: Array<'year_built' | 'subdivision' | 'geographic'>
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
