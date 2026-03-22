/**
 * Shared Valuation Types
 *
 * Single source of truth for valuation types used by both
 * server (apps/api) and client (apps/dashboard).
 */

// ─── ARV Tiers ─────────────────────────────────────────────────────────────────

export type ArvTier = string

export interface TierRangeDefinition {
  key: string
  label: string
  minValue: number | null
  maxValue: number | null
}

export const DEFAULT_TIER_RANGES: TierRangeDefinition[] = [
  { key: 'under501k', label: 'Under $501K', minValue: null, maxValue: 501000 },
  { key: '501kTo999k', label: '$501K – $999K', minValue: 501000, maxValue: 1000000 },
  { key: '1mTo3m', label: '$1M – $3M', minValue: 1000000, maxValue: 3000000 },
  { key: 'over3m', label: 'Over $3M', minValue: 3000000, maxValue: null },
]

// ─── Rehab Levels ──────────────────────────────────────────────────────────────

export const REHAB_LEVELS = [
  'Lipstick',
  'Light Cosmetic',
  'Full Cosmetic',
  'Heavy Rehab',
  'Down to Stud',
] as const

export type RehabLevel = (typeof REHAB_LEVELS)[number]

export interface RehabEstimate {
  perSqft: number
  minProfit: number
}

export type RehabTable = Record<string, RehabEstimate[]>

// ─── Major Items ───────────────────────────────────────────────────────────────

export const MAJOR_ITEMS = [
  { id: 'roof', name: 'Roof', defaultCost: 10000, ageThreshold: 20 },
  { id: 'hvac', name: 'HVAC', defaultCost: 8000, ageThreshold: 15 },
  { id: 'water_heater', name: 'Water Heater', defaultCost: 2500, ageThreshold: 10 },
  { id: 'electric_panel', name: 'Electric Panel', defaultCost: 3500, ageThreshold: 30 },
  { id: 'replumb', name: 'Re-Plumb', defaultCost: 8000, ageThreshold: 40 },
  { id: 'rewire', name: 'Re-Wire', defaultCost: 8000, ageThreshold: 40 },
  { id: 'sinkhole', name: 'Sinkhole', defaultCost: 15000, ageThreshold: null },
  { id: 'foundation', name: 'Foundation', defaultCost: 12000, ageThreshold: null },
  { id: 'septic', name: 'Septic Repair', defaultCost: 5000, ageThreshold: 25 },
  { id: 'new_septic', name: 'New Septic', defaultCost: 15000, ageThreshold: null },
  { id: 'pool_redone', name: 'Pool Redone', defaultCost: 15000, ageThreshold: null },
  { id: 'pool_plaster', name: 'Pool Plaster', defaultCost: 5000, ageThreshold: 10 },
  { id: 'termite', name: 'Termite', defaultCost: 3000, ageThreshold: null },
  { id: 'mold', name: 'Mold', defaultCost: 5000, ageThreshold: null },
  { id: 'asbestos', name: 'Asbestos', defaultCost: 10000, ageThreshold: null },
  { id: 'vinyl', name: 'Replace Vinyl', defaultCost: 5000, ageThreshold: 20 },
  { id: 'well_pump', name: 'Well Pump', defaultCost: 4000, ageThreshold: 15 },
] as const

export type MajorItemId = (typeof MAJOR_ITEMS)[number]['id']

export interface MajorItem {
  id: MajorItemId
  enabled: boolean
  cost: number
}

// ─── Valuation Parameters ──────────────────────────────────────────────────────

export interface ValuationParams {
  /** After Repair Value */
  arv: number
  /** Subject property square footage */
  subjectSqft: number
  /** Average comp square footage (defaults to subjectSqft) */
  compAvgSqft?: number
  /** Rehab level index */
  rehabLevelIndex?: number
  /** Major items with costs */
  majorItems?: MajorItem[]
  /** Addition play (extra budget for improvements) */
  additionPlay?: number
  /** Closing costs percentage (default: 8%) */
  closingCostsPercent?: number
  /** Carrying costs percentage (default: 2%) */
  carryingCostsPercent?: number
  /** Wholesale fee amount (default: $10,000) */
  wholesaleFee?: number
}

// ─── Valuation Result ──────────────────────────────────────────────────────────

export interface ValuationResult {
  // ARV Info
  arv: number
  arvTier: ArvTier
  pricePerSqft: number

  // Rehab Costs
  rehabLevel: RehabLevel
  rehabPerSqft: number
  baseRehabCost: number
  majorItemsCost: number
  additionPlay: number
  totalRehabCost: number

  // Closing & Carrying
  closingCostsPercent: number
  closingCosts: number
  carryingCostsPercent: number
  carryingCosts: number

  // Buy Price
  buyPrice: number
  buyPricePercent: number

  // Wholesale
  wholesaleFee: number
  wholesalePrice: number
  wholesalePricePercent: number

  // Profit & ROI
  projectedProfit: number
  projectedROI: number
  totalInvestment: number

  // Breakdown for UI
  breakdown: {
    label: string
    amount: number
    percent?: number
  }[]
}

// ─── Rehab Level Estimate ──────────────────────────────────────────────────────

export interface RehabLevelEstimate {
  index: number
  name: string
  perSqft: number
  estimatedCost: number
  buyPrice: number
  wholesalePrice: number
  projectedProfit: number
  projectedROI: number
  isSelected: boolean
}
