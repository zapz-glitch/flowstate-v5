/**
 * Valuation Service Types
 *
 * Types for property valuation, rehab estimation, and investment analysis.
 */

// ─── ARV Tiers ─────────────────────────────────────────────────────────────────

export type ArvTier = 'under501k' | '501kTo999k' | '1mTo3m' | 'over3m'

// ─── Rehab Levels ──────────────────────────────────────────────────────────────

export const REHAB_LEVELS = [
  'Lipstick',
  'Light Cosmetic',
  'Full Cosmetic',
  'Heavy Rehab',
  'Down to Stud',
  'Low Cost Market',
  'High Cost Market',
] as const

export type RehabLevel = (typeof REHAB_LEVELS)[number]

export interface RehabEstimate {
  perSqft: number
  minProfit: number
}

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
  /** Rehab level index (0-6) */
  rehabLevelIndex?: number
  /** Major items with costs */
  majorItems?: MajorItem[]
  /** Addition play (extra budget for improvements) */
  additionPlay?: number
  /** Closing costs percentage (default: 10%) */
  closingCostsPercent?: number
  /** Carrying costs percentage (default: 5%) */
  carryingCostsPercent?: number
  /** Wholesale fee amount (default: $10,000) */
  wholesaleFee?: number
  /** Override minimum profit (uses tier default if not provided) */
  desiredProfit?: number
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
  desiredProfit: number
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

// ─── Full Analysis Result ──────────────────────────────────────────────────────

export interface PropertyAnalysisResult {
  /** Unique analysis ID */
  analysisId: string
  /** Timestamp */
  timestamp: string

  /** Property details */
  property: {
    id: string
    address: string
    city: string
    state: string
    zipCode: string
    bedrooms: number | null
    bathrooms: number | null
    squareFeet: number | null
    yearBuilt: number | null
    propertyType: string | null
    lastSalePrice: number | null
    lastSaleDate: string | null
  }

  /** Flood zone info */
  floodZone?: {
    zone: string | null
    isInFloodZone: boolean
    isNearFloodZone: boolean
  }

  /** Comparables summary */
  comparables: {
    total: number
    enabled: number
    avgSalePrice: number
    medianSalePrice: number
    avgPricePerSqft: number
    list: Array<{
      address: string
      salePrice: number | null
      saleDate: string | null
      squareFeet: number | null
      distanceMiles: number | null
      isEnabled: boolean
      adjustedPrice: number | null
      /** Zillow search URL for this comp */
      zillowUrl?: string
      /** Vision analysis quality score (0-100) */
      qualityScore?: number
      /** Vision analysis comparison result */
      visionComparison?: 'better' | 'similar' | 'worse' | 'unknown'
    }>
  }

  /** Vision analysis summary (if enabled) */
  visionAnalysis?: {
    /** Whether vision analysis was performed */
    enabled: boolean
    /** Number of comps analyzed with vision */
    compsAnalyzed: number
    /** Average quality score of analyzed comps */
    avgQualityScore: number | null
    /** Quality-weighted ARV adjustment */
    qualityWeightedArv: number | null
  }

  /** Valuation results */
  valuation: ValuationResult

  /** Rehab level options */
  rehabOptions: Array<{
    index: number
    name: RehabLevel
    perSqft: number
    estimatedCost: number
    buyPrice: number
    wholesalePrice: number
  }>
}

// ─── Response Types ────────────────────────────────────────────────────────────

export interface ValuationSuccessResponse {
  success: true
  data: ValuationResult
}

export interface ValuationErrorResponse {
  success: false
  error: string
  code?: string
}

export type ValuationResponse = ValuationSuccessResponse | ValuationErrorResponse

export interface AnalysisSuccessResponse {
  success: true
  data: PropertyAnalysisResult
}

export interface AnalysisErrorResponse {
  success: false
  error: string
  code?: string
}

export type AnalysisResponse = AnalysisSuccessResponse | AnalysisErrorResponse
