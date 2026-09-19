/**
 * Shared Analysis Service
 *
 * Common functions used by both sync and async analysis endpoints.
 * Ensures consistent behavior between /analyze (sync) and /analyze/async (queue-based).
 */

import type { PropertyBundle } from '../property-api'
import type { NormalizedProperty, NormalizedComparable } from '../property-api/types'
import type { AppraisedComparable, AppraisalResultWithFallback, ClassificationSummaryResult } from '../appraisal'
import type { PhotoBundle, PropertyPhotos } from '../photo-provider'
import type { MajorItem, ValuationService } from '../valuation'
import { REHAB_LEVELS } from '../valuation'
import type { ClassificationResult, PropertyClassification } from '../classification'
import { generateZillowUrl } from '../photo-provider'
import {
  lookupCode,
  BUILDING_STYLE,
  CONSTRUCTION_TYPE,
  FOUNDATION_TYPE,
  ROOF_TYPE,
  ROOF_COVER,
  EXTERIOR_WALLS,
  BUILDING_QUALITY,
} from '../property-api/providers/corelogic-codes'

/** Resolve construction codes to labels (safety net for cached data with raw codes) */
function resolveConstruction(c?: { type?: string; qualityCode?: string; buildingStyle?: string; foundationType?: string; roofType?: string; exteriorWalls?: string; storiesType?: string; roofCover?: string }) {
  if (!c) return { foundationType: null as string | null, buildingStyle: null as string | null, storiesType: null as string | null, constructionType: null as string | null, qualityCode: null as string | null, roofType: null as string | null, roofCover: null as string | null, exteriorWalls: null as string | null }
  return {
    foundationType: lookupCode(FOUNDATION_TYPE, c.foundationType) ?? null,
    buildingStyle: lookupCode(BUILDING_STYLE, c.buildingStyle) ?? null,
    storiesType: c.storiesType ?? null,
    constructionType: lookupCode(CONSTRUCTION_TYPE, c.type) ?? null,
    qualityCode: lookupCode(BUILDING_QUALITY, c.qualityCode) ?? null,
    roofType: lookupCode(ROOF_TYPE, c.roofType) ?? null,
    roofCover: lookupCode(ROOF_COVER, c.roofCover) ?? null,
    exteriorWalls: lookupCode(EXTERIOR_WALLS, c.exteriorWalls) ?? null,
  }
}

// Re-export for convenience
export type { PropertyBundle } from '../property-api'
export type { AppraisedComparable, AppraisalResultWithFallback } from '../appraisal'
export type { PhotoBundle, PropertyPhotos } from '../photo-provider'

// ─── Zillow Data Merge Utility ────────────────────────────────────────────────

/**
 * Tracks which fields were supplemented from Zillow for a property
 */
export interface SupplementedField {
  field: string
  value: string | number
  source: 'zillow'
}

/**
 * Result of merging Zillow data into a property
 */
export interface MergeResult<T> {
  property: T
  supplementedFields: SupplementedField[]
}

/**
 * Merge Zillow listing data into a property to fill missing CoreLogic fields.
 * Zillow data is used as a fallback when CoreLogic data is null/undefined.
 * Returns both the merged property and a list of which fields were supplemented.
 *
 * Fields that can be supplemented from Zillow:
 * - bedrooms
 * - bathrooms
 * - squareFeet
 * - yearBuilt
 * - lastSaleDate / lastSalePrice
 */
export function mergeZillowDataIntoProperty<T extends NormalizedProperty | NormalizedComparable>(
  property: T,
  zillowData: PropertyPhotos | null | undefined
): MergeResult<T> {
  const supplementedFields: SupplementedField[] = []

  if (!zillowData) return { property, supplementedFields }

  // Create a copy to avoid mutating the original — deep-copy the nested
  // objects we may write into so fills don't alias the source bundle.
  const merged = { ...property }
  if (merged.construction) merged.construction = { ...merged.construction }
  if (merged.features) merged.features = { ...merged.features }

  // Merge bedrooms if missing
  if (merged.bedrooms == null && zillowData.bedrooms != null) {
    merged.bedrooms = zillowData.bedrooms
    supplementedFields.push({ field: 'bedrooms', value: zillowData.bedrooms, source: 'zillow' })
    console.log(`[ZillowMerge] Supplemented bedrooms from Zillow: ${zillowData.bedrooms}`)
  }

  // Merge bathrooms if missing
  if (merged.bathrooms == null && zillowData.bathrooms != null) {
    merged.bathrooms = zillowData.bathrooms
    supplementedFields.push({ field: 'bathrooms', value: zillowData.bathrooms, source: 'zillow' })
    console.log(`[ZillowMerge] Supplemented bathrooms from Zillow: ${zillowData.bathrooms}`)
  }

  // Merge squareFeet if missing
  if (merged.squareFeet == null && zillowData.squareFeet != null) {
    merged.squareFeet = zillowData.squareFeet
    supplementedFields.push({ field: 'squareFeet', value: zillowData.squareFeet, source: 'zillow' })
    console.log(`[ZillowMerge] Supplemented squareFeet from Zillow: ${zillowData.squareFeet}`)
  }

  // Merge yearBuilt if missing
  if (merged.yearBuilt == null && zillowData.yearBuilt != null) {
    merged.yearBuilt = zillowData.yearBuilt
    supplementedFields.push({ field: 'yearBuilt', value: zillowData.yearBuilt, source: 'zillow' })
    console.log(`[ZillowMerge] Supplemented yearBuilt from Zillow: ${zillowData.yearBuilt}`)
  }

  // Merge foundationType if missing
  if (merged.construction?.foundationType == null && zillowData.foundationType != null) {
    if (!merged.construction) {
      merged.construction = {}
    }
    merged.construction.foundationType = zillowData.foundationType
    supplementedFields.push({ field: 'foundationType', value: zillowData.foundationType, source: 'zillow' })
    console.log(`[ZillowMerge] Supplemented foundationType from Zillow: ${zillowData.foundationType}`)
  }

  // Merge building style if missing
  if (merged.construction?.buildingStyle == null && zillowData.style != null) {
    if (!merged.construction) merged.construction = {}
    merged.construction.buildingStyle = zillowData.style
    supplementedFields.push({ field: 'buildingStyle', value: zillowData.style, source: 'zillow' })
    console.log(`[ZillowMerge] Supplemented buildingStyle from Zillow: ${zillowData.style}`)
  }

  // Merge stories if missing
  if (merged.stories == null && zillowData.stories != null) {
    merged.stories = zillowData.stories
    supplementedFields.push({ field: 'stories', value: zillowData.stories, source: 'zillow' })
  }
  if (merged.construction?.storiesType == null && zillowData.stories != null) {
    if (!merged.construction) merged.construction = {}
    merged.construction.storiesType = `${zillowData.stories} Story`
    supplementedFields.push({ field: 'storiesType', value: merged.construction.storiesType, source: 'zillow' })
  }

  // Merge roof material if missing
  if (merged.construction?.roofCover == null && merged.construction?.roofType == null && zillowData.roof != null) {
    if (!merged.construction) merged.construction = {}
    merged.construction.roofCover = zillowData.roof
    supplementedFields.push({ field: 'roofCover', value: zillowData.roof, source: 'zillow' })
    console.log(`[ZillowMerge] Supplemented roofCover from Zillow: ${zillowData.roof}`)
  }

  // Merge construction material if missing
  if (merged.construction?.type == null && merged.construction?.exteriorWalls == null && zillowData.construction != null) {
    if (!merged.construction) merged.construction = {}
    merged.construction.type = zillowData.construction
    supplementedFields.push({ field: 'constructionType', value: zillowData.construction, source: 'zillow' })
    console.log(`[ZillowMerge] Supplemented constructionType from Zillow: ${zillowData.construction}`)
  }

  // Merge heating/cooling if missing
  if (merged.features?.heating == null && zillowData.heating != null) {
    if (!merged.features) merged.features = {}
    merged.features.heating = zillowData.heating
    supplementedFields.push({ field: 'heating', value: zillowData.heating, source: 'zillow' })
  }
  if (merged.features?.cooling == null && zillowData.cooling != null) {
    if (!merged.features) merged.features = {}
    merged.features.cooling = zillowData.cooling
    supplementedFields.push({ field: 'cooling', value: zillowData.cooling, source: 'zillow' })
  }

  // Merge covered parking if missing — Zillow "parking" is free text like
  // "2 spaces, Attached Garage" or "Carport"; route to the right slot.
  if (merged.features?.garageType == null && merged.features?.carportType == null && zillowData.parking != null) {
    if (!merged.features) merged.features = {}
    if (/carport/i.test(zillowData.parking)) {
      merged.features.carportType = zillowData.parking
      supplementedFields.push({ field: 'carportType', value: zillowData.parking, source: 'zillow' })
    } else {
      merged.features.garageType = zillowData.parking
      supplementedFields.push({ field: 'garageType', value: zillowData.parking, source: 'zillow' })
    }
  }

  // Merge pool if missing (Zillow exposes presence only — true fills, false/absent stays unverified)
  if (merged.features?.poolType == null && zillowData.pool === true) {
    if (!merged.features) merged.features = {}
    merged.features.poolType = 'Pool'
    supplementedFields.push({ field: 'poolType', value: 'Pool', source: 'zillow' })
  }

  // Merge hoaFee if missing (subject properties only — NormalizedProperty has hoaFee, NormalizedComparable does not)
  if ('lastSaleDate' in merged && 'lastSalePrice' in merged) {
    const subject = merged as NormalizedProperty
    if (subject.hoaFee == null && zillowData.hoaFee != null) {
      subject.hoaFee = zillowData.hoaFee
      supplementedFields.push({ field: 'hoaFee', value: zillowData.hoaFee, source: 'zillow' })
      console.log(`[ZillowMerge] Supplemented hoaFee from Zillow: $${zillowData.hoaFee}/mo`)
    }
  }

  // For comparables, merge sale data if missing
  if ('saleDate' in merged && 'salePrice' in merged) {
    const comp = merged as NormalizedComparable

    // Merge sale date if missing
    if (comp.saleDate == null && zillowData.lastSaleDate != null) {
      comp.saleDate = zillowData.lastSaleDate
      supplementedFields.push({ field: 'saleDate', value: zillowData.lastSaleDate, source: 'zillow' })
      console.log(`[ZillowMerge] Supplemented saleDate from Zillow: ${zillowData.lastSaleDate}`)
    }

    // Merge sale price if missing
    if (comp.salePrice == null && zillowData.lastSalePrice != null) {
      comp.salePrice = zillowData.lastSalePrice
      supplementedFields.push({ field: 'salePrice', value: zillowData.lastSalePrice, source: 'zillow' })
      console.log(`[ZillowMerge] Supplemented salePrice from Zillow: ${zillowData.lastSalePrice}`)

      // Recalculate price per sqft if we have both price and sqft
      if (comp.squareFeet && comp.squareFeet > 0) {
        comp.pricePerSqft = Math.round(comp.salePrice / comp.squareFeet)
      }
    }
  }

  // For subject property, merge last sale data if missing
  if ('lastSaleDate' in merged && 'lastSalePrice' in merged) {
    const subject = merged as NormalizedProperty

    // Merge last sale date if missing
    if (subject.lastSaleDate == null && zillowData.lastSaleDate != null) {
      subject.lastSaleDate = zillowData.lastSaleDate
      supplementedFields.push({ field: 'lastSaleDate', value: zillowData.lastSaleDate, source: 'zillow' })
      console.log(`[ZillowMerge] Supplemented lastSaleDate from Zillow: ${zillowData.lastSaleDate}`)
    }

    // Merge last sale price if missing
    if (subject.lastSalePrice == null && zillowData.lastSalePrice != null) {
      subject.lastSalePrice = zillowData.lastSalePrice
      supplementedFields.push({ field: 'lastSalePrice', value: zillowData.lastSalePrice, source: 'zillow' })
      console.log(`[ZillowMerge] Supplemented lastSalePrice from Zillow: ${zillowData.lastSalePrice}`)

      // Recalculate price per sqft if we have both price and sqft
      if (subject.squareFeet && subject.squareFeet > 0) {
        subject.pricePerSqft = Math.round(subject.lastSalePrice / subject.squareFeet)
      }
    }
  }

  return { property: merged as T, supplementedFields }
}

/**
 * Result of merging Zillow data into the entire bundle
 */
export interface BundleMergeResult {
  bundle: PropertyBundle
  subjectSupplementedFields: SupplementedField[]
  compSupplementedFields: Map<string, SupplementedField[]>
}

/**
 * Merge Zillow data into property bundle
 * Supplements missing CoreLogic data with Zillow listing data
 * Returns the merged bundle and tracks which fields were supplemented
 */
export function mergeZillowDataIntoBundle(
  bundle: PropertyBundle,
  photoBundle: PhotoBundle | null
): BundleMergeResult {
  const compSupplementedFields = new Map<string, SupplementedField[]>()

  if (!photoBundle) {
    return {
      bundle,
      subjectSupplementedFields: [],
      compSupplementedFields,
    }
  }

  // Merge subject property
  const subjectResult = mergeZillowDataIntoProperty(bundle.property, photoBundle.subject)

  // Merge comparables
  const mergedComps = bundle.comparables.map((comp) => {
    const compPhotos = photoBundle.comps[comp.id]
    const result = mergeZillowDataIntoProperty(comp, compPhotos)
    if (result.supplementedFields.length > 0) {
      compSupplementedFields.set(comp.id, result.supplementedFields)
    }
    return result.property
  })

  return {
    bundle: {
      ...bundle,
      property: subjectResult.property,
      comparables: mergedComps,
    },
    subjectSupplementedFields: subjectResult.supplementedFields,
    compSupplementedFields,
  }
}

// ─── Date Formatting ─────────────────────────────────────────────────────────

/**
 * Format date to ISO format (YYYY-MM-DD)
 * Handles both YYYYMMDD and ISO formats
 */
export function formatDate(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null

  // Already in ISO format
  if (dateStr.includes('-')) {
    return dateStr.split('T')[0]
  }

  // Parse YYYYMMDD format
  if (/^\d{8}$/.test(dateStr)) {
    const year = dateStr.substring(0, 4)
    const month = dateStr.substring(4, 6)
    const day = dateStr.substring(6, 8)
    return `${year}-${month}-${day}`
  }

  return dateStr
}

// ─── Response Building ───────────────────────────────────────────────────────

/**
 * Valuation result type (matches output from ValuationService.calculateValuation)
 */
export interface ValuationResult {
  buyPrice: number
  buyPricePercent: number
  pricePerSqft: number
  totalRehabCost: number
  rehabLevel: string
  rehabPerSqft: number
  closingCosts: number
  carryingCosts: number
  totalInvestment: number
  projectedProfit: number
  projectedROI: number
  wholesalePrice: number
  /** Positional proximity deduction applied to buy price (0 when none) */
  locationPenalty?: number
  locationPenaltyPercent?: number
  recommendation?: 'strong-buy' | 'buy' | 'hold' | 'pass' | 'manual-review'
  recommendationReason?: string
}

/**
 * Rehab level estimate with full valuation calculations
 */
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

/**
 * Context required for building analysis response
 */
export interface ResponseContext {
  arvSource: 'appraisal' | 'comp-selection'
  finalArv: number
  zillowUrls?: Map<string, { searchUrl: string; directUrl?: string }>
  photoProvider?: string | null
  analysisId?: string
  /** Subject property classification */
  subjectClassification?: ClassificationResult
  /** Comp classifications by ID */
  compClassifications?: Map<string, ClassificationResult>
  /** Classification summary (as-is vs after-renovation comp groupings and group averages) */
  classificationSummary?: ClassificationSummaryResult
  /** Fields supplemented from Zillow for subject property */
  subjectSupplementedFields?: SupplementedField[]
  /** Fields supplemented from Zillow for each comp (by comp ID) */
  compSupplementedFields?: Map<string, SupplementedField[]>
  /** All rehab level estimates (pre-calculated for each level) */
  rehabLevelEstimates?: RehabLevelEstimate[]
  /** Applied settings snapshot for client-side recalculation initialization */
  appliedSettings?: AppliedSettings
  /** Vision analysis of subject property condition (from photo AI analysis) */
  visionAnalysis?: {
    overallCondition: string
    confidence: number
    estimatedRehabNeeds: string
    summary: string
    exterior?: { condition: string; notes: string[] }
    interior?: { condition: string; notes: string[] }
    features?: Record<string, string | undefined>
  }
  /** Curb-appeal condition check on the subject's listing photos */
  subjectCurbAppeal?: {
    condition: 'renovated' | 'dated' | 'distressed' | 'unknown'
    source: 'vision' | 'price'
    confidence: number | null
    summary: string | null
    photosExamined: number
  } | null
  /** Actual listing URL from the photo provider that delivered (Redfin/Zillow/Realtor) */
  subjectListingUrl?: string | null
  /** Asking price scraped from the subject's listing page */
  subjectListPrice?: number | null
  /** Visual ARV-candidacy check per ARV-selected comp (by comp ID) */
  compCurbAppeal?: Record<string, {
    condition: 'renovated' | 'dated' | 'distressed' | 'unknown'
    source: 'vision' | 'price'
    confidence: number | null
    summary: string | null
    photosExamined: number
  }>
  /** External API call statistics */
  apiCallStats?: ApiCallStats
  /** LLM-selected best matching comp */
  bestMatch?: { compId: string; reasoning: string }
  /** Group B result (as-is market intelligence) */
  groupBResult?: import('../evaluation').GroupBResult | null
  /** Set of Group A comp IDs (for compGroup tagging) */
  groupACompIds?: Set<string>
  /** Set of Group B comp IDs (for compGroup tagging) */
  groupBCompIds?: Set<string>
}

/**
 * Snapshot of settings used during analysis.
 * Included in the response so the client can initialize with the same settings.
 */
export interface AppliedSettings {
  filters: Array<{ type: string; enabled: boolean; value: number }>
  adjustments: Array<{ type: string; enabled: boolean; amount: number; percent?: number }>
  dealParams: {
    closingCostsPercent: number
    carryingCostsPercent: number
    wholesaleFee: number
  }
  rehabLevelIndex: number
  rehabTable: Record<string, Array<{ perSqft: number; minProfit: number }>>
  majorItems?: Array<{ id: string; enabled: boolean; cost: number }>
  additionPlay: number
  /** Resolved ARV threshold percent (includes location overrides) */
  arvThresholdPercent?: number
  /** Resolved as-is threshold percent (includes location overrides) */
  asIsThresholdPercent?: number
}

/**
 * Buybox parameters for valuation
 */
export interface BuyboxParams {
  rehabLevelIndex?: number
  majorItems?: MajorItem[]
  additionPlay?: number
  closingCostsPercent?: number
  carryingCostsPercent?: number
  wholesaleFee?: number
}

/**
 * Classification summary for response
 */
export interface ClassificationSummary {
  type: PropertyClassification
  confidence: number
  reasoning: string
  method?: string
}

/**
 * Analysis response structure (simplified underwriter format)
 */
export interface AnalysisResponse {
  subject: {
    /** CoreLogic CLIP ID */
    id: string
    address: string
    county: string | null
    latitude: number | null
    longitude: number | null
    bedrooms: number | null
    bathrooms: number | null
    /** @deprecated Use bedrooms and bathrooms separately */
    bedsBaths: string
    squareFeet: number | null
    lotSizeAcres: number | null
    yearBuilt: number | null
    propertyType: string | null
    /** Subdivision name (if available) */
    subdivision: string | null
    /** Cotality composite parcel ID (fipsCode:universalParcelId) */
    parcelId: string | null
    /** Formatted assessor parcel number */
    apnFormatted: string | null
    /** Cotality site-location neighborhood name */
    neighborhoodName: string | null
    neighborhoodCode: string | null
    /** Core Based Statistical Area code (metro geography for market analytics) */
    cbsaCode: string | null
    censusTract: string | null
    /** Legal description from site-location (plat/block/lot) */
    legalDescription: string | null
    lastSale: {
      price: number
      date: string | null
      pricePerSqft: number | null
    } | null
    taxAssessment: number | null
    photos: string[]
    /** Foundation type (e.g., Slab, Crawl Space, Basement) */
    foundationType: string | null
    /** Building style (e.g., Colonial, Cape Cod, Bungalow, Ranch) */
    buildingStyle: string | null
    /** Story type description (e.g., Split Foyer, Tri Level, 2 Story) */
    storiesType: string | null
    /** Pool type (e.g., In Ground, Above Ground) */
    pool: string | null
    /** Garage type (e.g., Attached, Detached) */
    garage: string | null
    /** Garage square footage */
    garageSquareFeet: number | null
    /** Carport type */
    carport: string | null
    /** Monthly HOA fee in dollars (if applicable) */
    hoaFee: number | null
    /** Zillow search URL for this property */
    zillowUrl: string | null
    /** Vision-assessed condition/renovation level (or 'NA' when unverifiable) */
    condition: string | null
    /** Curb-appeal condition label (renovated/dated/distressed/unknown) */
    curbAppeal: {
      condition: 'renovated' | 'dated' | 'distressed' | 'unknown'
      source: 'vision' | 'price'
      confidence: number | null
      summary: string | null
      photosExamined: number
    } | null
    /** Direct listing URL from the provider that delivered photos */
    listingUrl: string | null
    /** Asking/list price scraped from the subject's listing (null when off-market or unlisted) */
    listPrice: number | null
    /** Building permit records for the subject */
    permits: {
      /** 'not_requested' = permits are pulled on demand via the report's Permits action */
      status: 'available' | 'empty' | 'unavailable' | 'not_requested'
      /** Error detail when the permit lookup failed (status 'unavailable') */
      error?: string | null
      items: Array<{
        permitId: string
        permitNumber: string | null
        projectType: string | null
        description: string | null
        status: string | null
        effectiveDate: string | null
        jobValue: number | null
      }>
    } | null
    /** Property classification (as_is or after_renovation) */
    classification: ClassificationSummary | null
    /** Assessor building improvement condition (e.g. "Average") — distinct from vision `condition` */
    buildingCondition: string | null
    /** Construction quality grade (e.g. "Fair") */
    buildingGrade: string | null
    /** Assessor improvement value in dollars */
    improvementValue: number | null
    /** Added-on building area (sqft) — non-null indicates a permitted addition */
    additionSquareFeet: number | null
    /** Roof cover material (e.g. Composition Shingle, Tile) */
    roofCover: string | null
    /** Construction type (e.g. Frame, Masonry) */
    constructionType: string | null
    /** Exterior wall material (e.g. Wood Siding, Brick) */
    exteriorWalls: string | null
    /** Roof type (e.g. Gable, Hip) */
    roofType: string | null
    /** Heating type (e.g. Forced Air) */
    heating: string | null
    /** Cooling/air conditioning type */
    cooling: string | null
    /** Fireplace count */
    fireplacesCount: number | null
    /** Cotality THV AVM estimate (subject only, parcel-level, display-only — never enters valuation math) */
    avm: {
      value: number | null
      confidence: number | null
      valueRangeLow: number | null
      valueRangeHigh: number | null
      model: string
      asOfDate: string | null
    } | null
  }
  valuation: {
    displayedArv?: number
    displayedBuyPrice?: number
    displayedWholesalePrice?: number
    displayRounding?: { increment: 500 | 1000; mode: 'half_up' }
    investorAnalysis?: {
      status: string
      methodLabel: string
      sampleCount: number
      eligibleCount: number
      value: number | null
      limitations: string[]
    }
    arv: number
    arvSource: 'appraisal' | 'comp-selection'
    /** Methodology used to calculate ARV */
    arvMethodology: string
    arvPerSqft: number
    /** As-Is value (current market value based on as_is comps) */
    asIsValue: number | null
    /** After-Renovation value (based on after_renovation comps) */
    afterRenovationValue: number | null
    /** Raw spread between As-Is and After-Renovation */
    spread: number | null
    /** Spread analysis with profit calculation */
    spreadAnalysis: {
      asIsToArv: number | null
      potentialProfit: number | null
    } | null
    /** Group B: As-Is market intelligence (display only, does NOT affect valuation) */
    asIsMarketIntel: {
      asIsMarketPrice: number | null
      avgPricePerSqft: number | null
      compCount: number
      compIds: string[]
      thresholdPercent: number
      priceCeiling: number
      noDataReason?: string
    } | null
    /** Asking/list price scraped from the subject's listing (null when off-market) */
    listPrice: number | null
    /** ARV minus list price — negative = ARV below asking (negotiation room), positive = above */
    arvVsListPrice: number | null
    buyPrice: number
    buyPricePercent: number
    /** Positional proximity deduction applied to buy price (0 when none) */
    locationPenalty: number
    locationPenaltyPercent: number
    rehabCost: number
    rehabLevel: string
    rehabPerSqft: number
    /** All rehab level estimates with costs calculated for the current ARV */
    rehabLevelEstimates: Array<{
      index: number
      name: string
      perSqft: number
      estimatedCost: number
      buyPrice: number
      wholesalePrice: number
      projectedProfit: number
      projectedROI: number
      isSelected: boolean
    }>
    closingCosts: number
    carryingCosts: number
    totalCosts: number
    totalInvestment: number
    projectedProfit: number
    projectedROI: number
    wholesalePrice: number
    recommendation?: 'strong-buy' | 'buy' | 'hold' | 'pass' | 'manual-review'
    recommendationReason?: string
    /** Confidence gate on the comps driving the ARV */
    confidence?: 'high' | 'medium' | 'low'
    confidenceReasons?: string[]
    /** True unless HIGH — medium flags for review, low withholds the call */
    requiresHumanReview?: boolean
  }
  comps: {
    /** Total number of comps returned from API */
    total: number
    /** Provider retrieval audit: requested limit, received count, inferred truncation, refetches */
    retrieval: import('../property-api/retrieval-policy').ComparablesRetrievalMeta | null
    /** Number of comps that passed all filters (enabled) */
    enabledCount: number
    /** Number of comps that failed filters (disabled) */
    disabledCount: number
    avgPricePerSqft: number | null
    medianPrice: number | null
    /** IDs of comps classified as As-Is */
    asIsCompIds: string[]
    /** IDs of comps classified as After-Renovation */
    afterRenovationCompIds: string[]
    /** Best match comp selected by LLM or rule-based scoring */
    bestMatch?: { compId: string; reasoning: string }
    items: Array<{
      id: string
      address: string
      latitude: number | null
      longitude: number | null
      salePrice: number | null
      saleDate: string | null
      squareFeet: number | null
      pricePerSqft: number | null
      distanceMiles: number | null
      bedrooms: number | null
      bathrooms: number | null
      /** @deprecated Use bedrooms and bathrooms separately */
      bedsBaths: string
      yearBuilt: number | null
      lotSizeAcres: number | null
      adjustedPrice: number | null
      photos: string[]
      /** Subdivision name (if available) */
      subdivision: string | null
      /** Composite parcel ID (fipsCode:universalParcelId) */
      parcelId: string | null
      /** Cotality site-location neighborhood name */
      neighborhoodName: string | null
      /** Cotality site-location neighborhood code */
      neighborhoodCode: string | null
      /** Assessor building improvement condition */
      buildingCondition: string | null
      /** Construction quality grade */
      buildingGrade: string | null
      stories: number | null
      /** Heating type (e.g. Forced Air) */
      heating: string | null
      /** Cooling/A/C type (e.g. Central) */
      cooling: string | null
      fireplacesCount: number | null
      /** Foundation type (e.g., Slab, Crawl Space, Basement) */
      foundationType: string | null
      /** Building style (e.g., Colonial, Cape Cod, Bungalow, Ranch) */
      buildingStyle: string | null
      /** Story type description (e.g., Split Foyer, Tri Level, 2 Story) */
      storiesType: string | null
      /** Construction type (e.g. Frame, Masonry) */
      constructionType: string | null
      /** Exterior wall material (e.g. Wood Siding, Brick) */
      exteriorWalls: string | null
      /** Roof type (e.g. Gable, Hip) */
      roofType: string | null
      /** Roof cover material (e.g. Composition Shingle, Tile) */
      roofCover: string | null
      /** Visual ARV-candidacy check (photos) for ARV-selected comps */
      curbAppeal?: {
        condition: 'renovated' | 'dated' | 'distressed' | 'unknown'
        /** vision = verified from photos; price = inferred from top-of-market sale */
        source: 'vision' | 'price'
        confidence: number | null
        summary: string | null
        photosExamined: number
      } | null
      /** Pool type */
      pool: string | null
      /** Garage type */
      garage: string | null
      /** Garage square footage */
      garageSquareFeet: number | null
      /** Carport type */
      carport: string | null
      /** Zillow search URL for this property */
      zillowUrl: string | null
      /** Whether this comp is enabled (passed all filters) */
      isEnabled: boolean
      matchPercent?: number | null
      matchRuleCount?: number
      matchRuleTotal?: number
      matchReasons?: string[]
      selectionReason?: string
      priorityRank?: number | null
      rankingDetails?: string[]
      /** Which comp group: 'arv' (Group A, drives valuation), 'as_is' (Group B, market intel), or null */
      compGroup: 'arv' | 'as_is' | null
      /** Reasons why this comp was disabled (if any) */
      disableReasons: string[]
      /** Property classification (as_is or after_renovation) */
      classification: ClassificationSummary | null
      /** Whether this comp is the LLM/rule-selected best match */
      isBestMatch?: boolean
      /** Jev truth score (0–1): reliable evidence of the subject's after-renovation retail value */
      jevArvTruth?: number | null
      /** Jev truth score (0–1): reliable evidence of the subject's as-is investor value */
      jevInvestmentTruth?: number | null
      /** Appraisal rule evaluation details */
      appraisalRules: {
        /** Whether this comp passed all filters */
        passedFilters: boolean
        /** Total adjustment amount applied to price */
        totalAdjustment: number
        /** Filter results - which rules matched/failed */
        filters: Array<{
          type: string
          passed: boolean
          reason?: string
          actualValue?: number | string | null
          threshold?: number | string | null
        }>
        /** Adjustment results - what price adjustments were applied */
        adjustments: Array<{
          type: string
          applied: boolean
          amount: number
          reason?: string
        }>
      } | null
    }>
  }
  riskFlags: string[] | null
  permits: {
    count: number
    totalValue: number | null
    recentTypes: string[]
  } | null
  floodZone: {
    zone: string | null
    inFloodZone: boolean
    description: string | null
    /** FEMA Special Flood Hazard Area determination ('In'/'Out') — parcel-level only */
    specialFloodHazardArea: string | null
    /** FIRM panel number */
    mapPanel: string | null
    /** FIRM panel date (ISO) */
    mapDate: string | null
    communityName: string | null
    /** 'parcel' (fips:universalParcelId determination) or 'spatial' (coordinate lookup) */
    source: string | null
  } | null
  /** Positional proximity risks — drives the proximity deduction */
  locationRisks: Array<{
    type: string
    description: string
    position: 'fronting' | 'backing' | 'siding' | null
    featureName: string | null
  }> | null
  /** Neighbourhood analysis — community, schools, POI */
  neighbourhood: {
    crime: {
      crimeIndex: number | null
      crimeRisk: string | null
      violentCrimeIndex: number | null
      propertyCrimeIndex: number | null
    } | null
    demographics: {
      population: number | null
      populationDensity: number | null
      medianIncome: number | null
      medianAge: number | null
      householdCount: number | null
      medianHomeValue: number | null
    } | null
    climate: {
      avgHighTemp: number | null
      avgLowTemp: number | null
      annualRainfall: number | null
      annualSnowfall: number | null
      comfortIndex: number | null
    } | null
    schools: {
      nearby: Array<{
        name: string
        type: string | null
        gradeRange: string | null
        rating: number | null
        distance: number | null
        latitude: number | null
        longitude: number | null
      }>
      count: number
    } | null
    poi: {
      summary: Record<string, number>
      nearby: Array<{
        name: string
        category: string | null
        distance: number | null
        latitude: number | null
        longitude: number | null
      }>
    } | null
  } | null
  /** Data supplemented from Zillow when CoreLogic data was missing */
  dataSupplemented: {
    /** Whether any data was supplemented from Zillow */
    hasSupplementedData: boolean
    /** Human-readable remarks about what was supplemented */
    remarks: string[]
    /** Fields supplemented for subject property */
    subject: Array<{
      field: string
      value: string | number
      source: 'zillow'
    }>
    /** Fields supplemented for comps (by comp ID) */
    comps: Record<string, Array<{
      field: string
      value: string | number
      source: 'zillow'
    }>>
  }
  meta: {
    analysisId: string
    timestamp: string
    dataProvider: string | null
  }
  /** Settings used during this analysis (for client-side recalculation initialization) */
  appliedSettings?: AppliedSettings
  /** AI vision analysis of subject property condition */
  visionAnalysis?: {
    overallCondition: string
    confidence: number
    estimatedRehabNeeds: string
    summary: string
    exterior?: { condition: string; notes: string[] }
    interior?: { condition: string; notes: string[] }
    features?: Record<string, string | undefined>
  } | null
  /** External API call statistics for this analysis */
  apiCallStats?: ApiCallStats | null
  /**
   * Justified end-to-end evaluation report: ordered pipeline steps,
   * fallbacks used, ARV drivers, rehab derivation, itemized deductions,
   * and final verdict.
   */
  report?: import('../evaluation/types').EvaluationReport
  /** Full computer-vision renovation assessment (subject photos) */
  visionAssessment?: import('../vision/renovation').RenovationAssessment | null
  /** Where the rehab level came from: manual_override | vision | classification | default */
  renovationLevelSource?: 'manual_override' | 'vision' | 'classification' | 'default'
  /** Photo provider that delivered the subject photos (zillow/redfin/realtor) */
  photoProvider?: string
  /** Evaluation engine that produced this response */
  evaluationEngine?: string
  /**
   * Jev read-only classification of this completed outcome. Attached after the
   * pipeline finishes; it never influences comp selection, ARV, or the
   * recommendation.
   */
  jevOutcome?: import('../jev').JevOutcomeClassification | null
}
export interface ApiCallStats {
  corelogic: {
    total: number
    cached: number
    endpoints: { endpoint: string; calls: number; cached: number }[]
  }
  totalExternalCalls: number
}

// ─── Location Risk Detection ─────────────────────────────────────────────────

/** Keywords indicating proximity to busy roads */
const BUSY_ROAD_KEYWORDS = [
  'busy road', 'busy street', 'main road', 'main street frontage',
  'high traffic', 'heavy traffic', 'arterial', 'highway',
  'major intersection', 'busy intersection', 'thoroughfare',
  'road noise', 'traffic noise', 'fronts highway', 'fronts main',
]

/** Keywords indicating commercial adjacency */
const COMMERCIAL_KEYWORDS = [
  'commercial', 'strip mall', 'shopping center', 'shopping plaza',
  'industrial', 'warehouse', 'mixed use', 'mixed-use',
  'commercial zone', 'commercial district', 'business district',
  'retail', 'office building', 'gas station', 'auto repair',
  'adjacent to commercial', 'next to commercial', 'near commercial',
  'backs to commercial', 'commercial property',
]

/** Zoning codes that indicate commercial or mixed-use */
const COMMERCIAL_ZONING_PREFIXES = [
  'c-', 'c1', 'c2', 'c3', 'c4', 'c5',
  'b-', 'b1', 'b2', 'b3',
  'mu', 'm-u', 'mx',
  'i-', 'i1', 'i2',
  'cb', 'cc', 'cn', 'cg',
]

/**
 * Detect location-based risks from property zoning and characteristics.
 * Returns an array of risk flag strings.
 */
function detectLocationRisks(property: NormalizedProperty): string[] {
  const risks: string[] = []
  const zoning = property.zoning?.toLowerCase() ?? ''
  const zoningDesc = property.zoningDescription?.toLowerCase() ?? ''

  // Check zoning for commercial/mixed-use/industrial
  const isCommercialZoning = COMMERCIAL_ZONING_PREFIXES.some(
    (prefix) => zoning.startsWith(prefix) || zoningDesc.includes(prefix)
  )
  if (isCommercialZoning) {
    const label = property.zoningDescription || property.zoning || 'Commercial'
    risks.push(`Zoning: ${label} (commercial/mixed-use area)`)
  }

  // Check zoning description for busy road / commercial keywords
  const combinedText = `${zoningDesc} ${property.zoningDescription ?? ''} ${property.subdivision ?? ''}`.toLowerCase()
  for (const kw of BUSY_ROAD_KEYWORDS) {
    if (combinedText.includes(kw)) {
      risks.push(`Location: Near busy road (${kw})`)
      break
    }
  }
  if (!isCommercialZoning) {
    for (const kw of COMMERCIAL_KEYWORDS) {
      if (combinedText.includes(kw)) {
        risks.push(`Location: Near commercial property (${kw})`)
        break
      }
    }
  }

  return risks
}

/**
 * Build streamlined underwriter-focused response
 * Returns only essential data for investment decisions
 *
 * This is the single source of truth for response format.
 * Used by both sync and async endpoints.
 */
export function buildAnalysisResponse(
  bundle: PropertyBundle,
  appraisalResult: AppraisalResultWithFallback,
  photoBundle: PhotoBundle | null,
  valuation: ValuationResult,
  ctx: ResponseContext
): AnalysisResponse {
  const { property, enrichment } = bundle
  const { arvSource, finalArv } = ctx

  // Get subject photos
  const subjectPhotos = photoBundle?.subject?.photos.slice(0, 5) ?? []

  // Build risk flags for underwriter attention
  const riskFlags: string[] = []
  if (enrichment.floodZone?.isInFloodZone) {
    riskFlags.push(
      enrichment.floodZone.source === 'listing'
        ? `Flood risk (listing): ${enrichment.floodZone.floodZone}`
        : `Flood Zone: ${enrichment.floodZone.floodZone}`
    )
  }
  if (property.transaction?.isForeclosure) riskFlags.push('Foreclosure')
  if (property.transaction?.isShortSale) riskFlags.push('Short Sale')

  if (enrichment.permits?.items.some((p) => p.jobValue && p.jobValue > 50000)) {
    riskFlags.push('Major Permits (>$50K)')
  }

  // Location risks (OSM: major roads, railroads, commercial proximity)
  for (const risk of enrichment.locationRisks ?? []) {
    riskFlags.push(risk.description)
  }

  // Location risk detection — zoning, busy road, commercial adjacency
  const zoningRisks = detectLocationRisks(property)
  riskFlags.push(...zoningRisks)

  // ARV vs asking price — flag when the ARV clears below the seller's ask
  // (negotiation room) or lands above it (seller underpriced).
  if (ctx.subjectListPrice != null && finalArv != null) {
    const delta = finalArv - ctx.subjectListPrice
    riskFlags.push(
      delta < 0
        ? `ARV $${Math.abs(delta).toLocaleString()} below list price`
        : delta > 0
          ? `ARV $${delta.toLocaleString()} above list price`
          : 'ARV at list price'
    )
  }

  // Get enabled and disabled comp counts
  const enabledComps = appraisalResult.comparables.filter((c) => c.isEnabled)
  const disabledComps = appraisalResult.comparables.filter((c) => !c.isEnabled)

  // Sort helper: closest first — distance is the location criterion
  const byDistance = (a: AppraisedComparable, b: AppraisedComparable) =>
    (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999)

  // Build lookup from merged bundle comps (has Zillow-supplemented data like bedrooms)
  const mergedCompLookup = new Map(
    bundle.comparables.map((c) => [c.id, c])
  )

  // Return ALL comps: enabled first (closest → farthest), then disabled (same order)
  const allComps = [
    ...enabledComps.sort(byDistance),
    ...disabledComps.sort(byDistance),
  ].map((comp) => {
    const compPhotos = photoBundle?.comps[comp.id]?.photos.slice(0, 3) ?? []

    // Use merged comp data for fields that may have been supplemented from Zillow
    const merged = mergedCompLookup.get(comp.id)

    // Build appraisal rule details from evaluation
    const evaluation = comp.evaluation
    const appraisalRules = evaluation
      ? {
          passedFilters: !evaluation.shouldDisable,
          totalAdjustment: evaluation.totalAdjustment,
          filters: evaluation.filterResults.map((f) => ({
            type: f.type,
            passed: f.passed,
            status: f.status,
            reason: f.reason,
            actualValue: f.actualValue ?? null,
            threshold: f.threshold ?? null,
          })),
          adjustments: evaluation.adjustmentResults
            .filter((a) => a.applied)
            .map((a) => ({
              type: a.type,
              applied: a.applied,
              amount: a.amount,
              reason: a.reason,
            })),
        }
      : null

    // Get classification for this comp
    const compClassification = ctx.compClassifications?.get(comp.id)
    const classificationSummary: ClassificationSummary | null = compClassification
      ? {
          type: compClassification.classification,
          confidence: compClassification.confidence,
          reasoning: compClassification.reasoning,
          method: compClassification.method,
        }
      : null

    // Prefer merged (Zillow-supplemented) values for fields that CoreLogic may be missing
    const bedrooms = merged?.bedrooms ?? comp.bedrooms ?? null
    const bathrooms = merged?.bathrooms ?? comp.bathrooms ?? null
    const squareFeet = merged?.squareFeet ?? comp.squareFeet
    const yearBuilt = merged?.yearBuilt ?? comp.yearBuilt

    return {
      id: comp.id,
      address: `${comp.address}, ${comp.city}, ${comp.state}`,
      latitude: comp.latitude ?? null,
      longitude: comp.longitude ?? null,
      salePrice: comp.salePrice,
      saleDate: formatDate(comp.saleDate),
      squareFeet,
      pricePerSqft: squareFeet && squareFeet > 0 && (comp.adjustedSalePrice ?? comp.salePrice) != null
        ? Math.round((comp.adjustedSalePrice ?? comp.salePrice)! / squareFeet)
        : comp.pricePerSqft,
      distanceMiles: comp.distanceMiles,
      bedrooms,
      bathrooms,
      bedsBaths: `${bedrooms ?? '-'}/${bathrooms ?? '-'}`,
      yearBuilt,
      lotSizeAcres: comp.lotSizeAcres ?? null,
      adjustedPrice: comp.adjustedSalePrice,
      photos: compPhotos,
      subdivision: comp.subdivision ?? null,
      parcelId: comp.parcelId ?? null,
      neighborhoodName: comp.neighborhoodName ?? null,
      neighborhoodCode: comp.neighborhoodCode ?? null,
      buildingCondition: comp.buildingCondition ?? null,
      buildingGrade: comp.buildingGrade ?? null,
      stories: comp.stories ?? null,
      heating: merged?.features?.heating ?? comp.features?.heating ?? null,
      cooling: merged?.features?.cooling ?? comp.features?.cooling ?? null,
      fireplacesCount: merged?.features?.fireplacesCount ?? comp.features?.fireplacesCount ?? null,
      ...resolveConstruction(comp.construction),
      pool: merged?.features?.poolType ?? null,
      garage: merged?.features?.garageType ?? null,
      garageSquareFeet: merged?.features?.garageSquareFeet ?? null,
      carport: merged?.features?.carportType ?? null,
      zillowUrl: generateZillowUrl({
        propertyId: comp.id,
        address: comp.address,
        city: comp.city,
        state: comp.state,
        zipCode: comp.zipCode,
      }),
      isEnabled: comp.isEnabled,
      compGroup: ctx.groupACompIds?.has(comp.id) ? 'arv' as const
        : ctx.groupBCompIds?.has(comp.id) ? 'as_is' as const
        : null,
      curbAppeal: ctx.compCurbAppeal?.[comp.id] ?? null,
      disableReasons: evaluation?.disableReasons ?? [],
      classification: classificationSummary,
      isBestMatch: ctx.bestMatch?.compId === comp.id,
      jevArvTruth: comp.jevArvTruth ?? null,
      jevInvestmentTruth: comp.jevInvestmentTruth ?? null,
      appraisalRules,
    }
  })

  // Generate analysis ID if not provided
  const analysisId = ctx.analysisId || `analysis_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`

  // Build subject classification summary
  const subjectClassificationSummary: ClassificationSummary | null = ctx.subjectClassification
    ? {
        type: ctx.subjectClassification.classification,
        confidence: ctx.subjectClassification.confidence,
        reasoning: ctx.subjectClassification.reasoning,
        method: ctx.subjectClassification.method,
      }
    : null

  // Build spread analysis from classification summary (if we have both as-is and after-renovation values)
  const asIsValue = ctx.classificationSummary?.asIsValue ?? null
  const afterRenovationValue = ctx.classificationSummary?.afterRenovationValue ?? null
  const spread = ctx.classificationSummary?.spread ?? null
  const spreadAnalysis =
    asIsValue !== null && afterRenovationValue !== null
      ? {
          asIsToArv: afterRenovationValue - asIsValue,
          potentialProfit: afterRenovationValue - asIsValue - valuation.totalRehabCost,
        }
      : null

  const arvMethodology = ctx.classificationSummary?.methodology ?? `avg price/sqft of ${enabledComps.length} comp${enabledComps.length !== 1 ? 's' : ''} × subject sqft`

  return {
    // ═══ SUBJECT PROPERTY ═══════════════════════════════════════════════════
    subject: {
      id: property.id,
      address: `${property.address}, ${property.city}, ${property.state} ${property.zipCode}`,
      county: property.county ?? null,
      latitude: property.latitude ?? null,
      longitude: property.longitude ?? null,
      bedrooms: property.bedrooms ?? null,
      bathrooms: property.bathrooms ?? null,
      bedsBaths: `${property.bedrooms ?? '-'}/${property.bathrooms ?? '-'}`,
      squareFeet: property.squareFeet ?? null,
      lotSizeAcres: property.lotSizeAcres ?? null,
      yearBuilt: property.yearBuilt ?? null,
      propertyType: property.propertyType ?? null,
      subdivision: property.subdivision ?? null,
      parcelId: property.parcelId ?? null,
      apnFormatted: property.apnFormatted ?? null,
      neighborhoodName: property.neighborhoodName ?? null,
      neighborhoodCode: property.neighborhoodCode ?? null,
      cbsaCode: property.cbsaCode ?? null,
      censusTract: property.censusTract ?? null,
      legalDescription: property.legalDescription ?? null,
      lastSale: property.lastSalePrice
        ? {
            price: property.lastSalePrice,
            date: property.lastSaleDate ?? null,
            pricePerSqft: property.pricePerSqft ?? null,
          }
        : null,
      taxAssessment: property.assessedValue ?? null,
      photos: subjectPhotos,
      ...resolveConstruction(property.construction),
      pool: property.features?.poolType ?? null,
      garage: property.features?.garageType ?? null,
      garageSquareFeet: property.features?.garageSquareFeet ?? null,
      carport: property.features?.carportType ?? null,
      heating: property.features?.heating ?? null,
      cooling: property.features?.cooling ?? null,
      fireplacesCount: property.features?.fireplacesCount ?? null,
      hoaFee: property.hoaFee ?? null,
      zillowUrl: generateZillowUrl({
        propertyId: property.id,
        address: property.address,
        city: property.city,
        state: property.state,
        zipCode: property.zipCode,
      }),
      permits: enrichment.permits
        ? {
            status: enrichment.permits.status === 'unavailable'
              ? 'unavailable'
              : enrichment.permits.items.length > 0 ? 'available' : 'empty',
            error: enrichment.permits.error ?? null,
            items: enrichment.permits.items.map((p) => ({
              permitId: p.permitId,
              permitNumber: p.permitNumber ?? null,
              projectType: p.projectType ?? null,
              description: p.description ?? null,
              status: p.status ?? null,
              effectiveDate: p.effectiveDate ?? null,
              jobValue: p.jobValue ?? null,
            })),
          }
        // Permits are pulled on demand (report Permits action) — 'not_requested'
        // tells the UI to offer the pull button rather than an error state.
        : { status: 'not_requested', items: [] },
      condition: ctx.visionAnalysis?.overallCondition ?? null,
      curbAppeal: ctx.subjectCurbAppeal ?? null,
      listingUrl: ctx.subjectListingUrl ?? null,
      listPrice: ctx.subjectListPrice ?? null,
      classification: subjectClassificationSummary,
      buildingCondition: property.buildingCondition ?? null,
      buildingGrade: property.buildingGrade ?? null,
      improvementValue: property.improvementValue ?? null,
      additionSquareFeet: property.additionSquareFeet ?? null,
      avm: enrichment.avm
        ? {
            value: enrichment.avm.value,
            confidence: enrichment.avm.confidence,
            valueRangeLow: enrichment.avm.valueRangeLow,
            valueRangeHigh: enrichment.avm.valueRangeHigh,
            model: enrichment.avm.model,
            asOfDate: enrichment.avm.asOfDate,
          }
        : null,
    },

    // ═══ VALUATION SUMMARY ══════════════════════════════════════════════════
    valuation: {
      arv: finalArv,
      arvSource: arvSource,
      arvMethodology,
      arvPerSqft: valuation.pricePerSqft,
      asIsValue,
      afterRenovationValue,
      spread,
      spreadAnalysis,
      buyPrice: valuation.buyPrice,
      buyPricePercent: valuation.buyPricePercent,
      rehabCost: valuation.totalRehabCost,
      rehabLevel: valuation.rehabLevel,
      rehabPerSqft: valuation.rehabPerSqft,
      closingCosts: valuation.closingCosts,
      carryingCosts: valuation.carryingCosts,
      totalCosts: valuation.closingCosts + valuation.carryingCosts,
      totalInvestment: valuation.totalInvestment,
      projectedProfit: valuation.projectedProfit,
      projectedROI: valuation.projectedROI,
      wholesalePrice: valuation.wholesalePrice,
      // Position-tiered proximity deduction (fronting/backing/siding a busy
      // road/commercial) — deducted from buy price inside calculateValuation
      locationPenalty: valuation.locationPenalty ?? 0,
      locationPenaltyPercent: valuation.locationPenaltyPercent ?? 0,
      recommendation: valuation.recommendation,
      recommendationReason: valuation.recommendationReason,
      rehabLevelEstimates: ctx.rehabLevelEstimates ?? [],
      asIsMarketIntel: ctx.groupBResult ? {
        asIsMarketPrice: ctx.groupBResult.asIsMarketPrice,
        avgPricePerSqft: ctx.groupBResult.avgPricePerSqft,
        compCount: ctx.groupBResult.count,
        compIds: ctx.groupBResult.compIds,
        thresholdPercent: ctx.groupBResult.thresholdPercent,
        priceCeiling: ctx.groupBResult.priceCeiling,
        noDataReason: ctx.groupBResult.noDataReason,
      } : null,
      listPrice: ctx.subjectListPrice ?? null,
      arvVsListPrice:
        ctx.subjectListPrice != null && finalArv != null
          ? finalArv - ctx.subjectListPrice
          : null,
    },

    // ═══ COMPARABLE SALES (All comps with enable/disable status) ═══════════════
    comps: {
      total: appraisalResult.comparables.length,
      // Provider retrieval audit: pool breadth, inferred truncation, refetches
      retrieval: bundle.metadata?.retrieval ?? null,
      enabledCount: enabledComps.length,
      disabledCount: disabledComps.length,
      avgPricePerSqft: appraisalResult.avgPricePerSqft,
      medianPrice: appraisalResult.medianSalePrice,
      asIsCompIds: ctx.classificationSummary?.asIsCompIds ?? [],
      afterRenovationCompIds: ctx.classificationSummary?.afterRenovationCompIds ?? [],
      bestMatch: ctx.bestMatch ?? undefined,
      items: allComps,
    },

    // ═══ RISK FLAGS ═════════════════════════════════════════════════════════
    riskFlags: riskFlags.length > 0 ? riskFlags : null,

    // ═══ PERMITS (if significant) ═══════════════════════════════════════════
    permits: enrichment.permits
      ? {
          count: enrichment.permits.count,
          totalValue: enrichment.permits.totalJobValue ?? null,
          recentTypes: (enrichment.permits.recentPermitTypes ?? []).slice(0, 5),
        }
      : null,

    // ═══ LOCATION RISKS (positional proximity evidence) ═════════════════════
    locationRisks: enrichment.locationRisks?.length
      ? enrichment.locationRisks.map((r) => ({
          type: r.type,
          description: r.description,
          position: r.position ?? null,
          featureName: r.featureName ?? null,
        }))
      : null,

    // ═══ FLOOD ZONE ═════════════════════════════════════════════════════════
    floodZone: enrichment.floodZone
      ? {
          zone: enrichment.floodZone.floodZone,
          inFloodZone: enrichment.floodZone.isInFloodZone,
          description: enrichment.floodZone.floodZoneDescription,
          specialFloodHazardArea: enrichment.floodZone.specialFloodHazardArea ?? null,
          mapPanel: enrichment.floodZone.mapPanel ?? null,
          mapDate: enrichment.floodZone.mapDate ?? null,
          communityName: enrichment.floodZone.communityName ?? null,
          source: enrichment.floodZone.source ?? null,
        }
      : null,

    // ═══ NEIGHBOURHOOD ═══════════════════════════════════════════════════════
    neighbourhood: enrichment.neighbourhood
      ? {
          crime: enrichment.neighbourhood.community?.crime ?? null,
          demographics: enrichment.neighbourhood.community?.demographics ?? null,
          climate: enrichment.neighbourhood.community?.climate ?? null,
          schools: enrichment.neighbourhood.schools
            ? {
                nearby: enrichment.neighbourhood.schools.nearby.map((s) => ({
                  name: s.name,
                  type: s.type,
                  gradeRange: s.gradeRange,
                  rating: s.rating,
                  distance: s.distance,
                  latitude: s.latitude ?? null,
                  longitude: s.longitude ?? null,
                })),
                count: enrichment.neighbourhood.schools.count,
              }
            : null,
          poi: enrichment.neighbourhood.poi
            ? {
                summary: enrichment.neighbourhood.poi.summary,
                nearby: enrichment.neighbourhood.poi.items.slice(0, 15).map((p) => ({
                  name: p.name,
                  category: p.category,
                  distance: p.distance,
                  latitude: p.latitude ?? null,
                  longitude: p.longitude ?? null,
                })),
              }
            : null,
        }
      : null,

    // ═══ DATA SUPPLEMENTED ═══════════════════════════════════════════════════
    dataSupplemented: buildDataSupplementedSection(ctx),

    // ═══ METADATA ═══════════════════════════════════════════════════════════
    meta: {
      analysisId,
      timestamp: new Date().toISOString(),
      dataProvider: property.provider,
    },

    // ═══ APPLIED SETTINGS (for client-side recalculation) ═══════════════════
    appliedSettings: ctx.appliedSettings,

    // ═══ VISION ANALYSIS (AI photo condition assessment) ═══════════════════
    visionAnalysis: ctx.visionAnalysis ?? null,

    // ═══ API CALL STATISTICS ═══════════════════════════════════════════════
    apiCallStats: ctx.apiCallStats ?? null,
  }
}

/**
 * Build the dataSupplemented section with human-readable remarks
 */
function buildDataSupplementedSection(ctx: ResponseContext): AnalysisResponse['dataSupplemented'] {
  const subjectFields = ctx.subjectSupplementedFields ?? []
  const compFieldsMap = ctx.compSupplementedFields ?? new Map()

  // Convert comp fields map to plain object
  const compsObj: Record<string, Array<{ field: string; value: string | number; source: 'zillow' }>> = {}
  for (const [compId, fields] of compFieldsMap) {
    compsObj[compId] = fields
  }

  const hasSupplementedData = subjectFields.length > 0 || compFieldsMap.size > 0

  // Build human-readable remarks
  const remarks: string[] = []

  if (subjectFields.length > 0) {
    const fieldNames = subjectFields.map(f => formatFieldName(f.field)).join(', ')
    remarks.push(`Subject property: ${fieldNames} supplemented from Zillow`)
  }

  if (compFieldsMap.size > 0) {
    const compCount = compFieldsMap.size
    const totalFields = Array.from(compFieldsMap.values()).reduce((sum, fields) => sum + fields.length, 0)
    remarks.push(`${compCount} comparable${compCount > 1 ? 's' : ''}: ${totalFields} field${totalFields > 1 ? 's' : ''} supplemented from Zillow`)
  }

  return {
    hasSupplementedData,
    remarks,
    subject: subjectFields,
    comps: compsObj,
  }
}

/**
 * Format field name for human-readable display
 */
function formatFieldName(field: string): string {
  const fieldLabels: Record<string, string> = {
    bedrooms: 'bedrooms',
    bathrooms: 'bathrooms',
    squareFeet: 'square footage',
    yearBuilt: 'year built',
    saleDate: 'sale date',
    salePrice: 'sale price',
    lastSaleDate: 'last sale date',
    lastSalePrice: 'last sale price',
  }
  return fieldLabels[field] ?? field
}

// ─── Rehab Level Estimates Calculator ─────────────────────────────────────────

/**
 * Parameters for calculating rehab level estimates
 */
export interface RehabEstimatesParams {
  arv: number
  subjectSqft: number
  compAvgSqft?: number
  selectedRehabLevelIndex: number
  majorItems?: MajorItem[]
  additionPlay?: number
  closingCostsPercent?: number
  carryingCostsPercent?: number
  wholesaleFee?: number
}

/**
 * Calculate all rehab level estimates for a given ARV.
 * Returns an array with full valuation calculations for each rehab level.
 *
 * @param valuationService - The valuation service instance
 * @param params - Parameters for calculation
 * @returns Array of rehab level estimates with full valuation for each level
 */
export function calculateAllRehabLevelEstimates(
  valuationService: ValuationService,
  params: RehabEstimatesParams
): RehabLevelEstimate[] {
  const {
    arv,
    subjectSqft,
    compAvgSqft,
    selectedRehabLevelIndex,
    majorItems,
    additionPlay = 0,
    closingCostsPercent = 8,
    carryingCostsPercent = 2,
    wholesaleFee = 10000,
  } = params

  return REHAB_LEVELS.map((name, index) => {
    // Calculate full valuation for this rehab level
    const valuation = valuationService.calculateValuation({
      arv,
      subjectSqft,
      compAvgSqft,
      rehabLevelIndex: index,
      majorItems,
      additionPlay,
      closingCostsPercent,
      carryingCostsPercent,
      wholesaleFee,
    })

    return {
      index,
      name,
      perSqft: valuation.rehabPerSqft,
      estimatedCost: valuation.totalRehabCost,
      buyPrice: valuation.buyPrice,
      wholesalePrice: valuation.wholesalePrice,
      projectedProfit: valuation.projectedProfit,
      projectedROI: valuation.projectedROI,
      isSelected: index === selectedRehabLevelIndex,
    }
  })
}
