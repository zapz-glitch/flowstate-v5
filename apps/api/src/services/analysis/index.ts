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

  // Create a copy to avoid mutating the original
  const merged = { ...property }

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
  /** External API call statistics */
  apiCallStats?: ApiCallStats
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
    desiredProfit: number | null
  }
  rehabLevelIndex: number
  rehabTable: Record<string, Array<{ perSqft: number; minProfit: number }>>
  majorItems?: Array<{ id: string; enabled: boolean; cost: number }>
  additionPlay: number
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
  desiredProfit?: number
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
    lastSale: {
      price: number
      date: string | null
      pricePerSqft: number | null
    } | null
    taxAssessment: number | null
    photos: string[]
    /** Foundation type (e.g., Slab, Crawl Space, Basement) */
    foundationType: string | null
    /** Monthly HOA fee in dollars (if applicable) */
    hoaFee: number | null
    /** Zillow search URL for this property */
    zillowUrl: string | null
    /** Property classification (as_is or after_renovation) */
    classification: ClassificationSummary | null
  }
  valuation: {
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
    buyPrice: number
    buyPricePercent: number
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
  }
  comps: {
    /** Total number of comps returned from API */
    total: number
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
      adjustedPrice: number | null
      photos: string[]
      /** Subdivision name (if available) */
      subdivision: string | null
      /** Foundation type (e.g., Slab, Crawl Space, Basement) */
      foundationType: string | null
      /** Zillow search URL for this property */
      zillowUrl: string | null
      /** Whether this comp is enabled (passed all filters) */
      isEnabled: boolean
      /** Reasons why this comp was disabled (if any) */
      disableReasons: string[]
      /** Property classification (as_is or after_renovation) */
      classification: ClassificationSummary | null
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
  } | null
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
}

/**
 * External API call statistics for a single analysis run
 */
export interface ApiCallStats {
  corelogic: {
    total: number
    endpoints: { endpoint: string; count: number }[]
  }
  firecrawl: {
    total: number
    cached: number
  }
  llm: {
    total: number
    breakdown: { purpose: string; count: number }[]
  }
  totalExternalCalls: number
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
    riskFlags.push(`Flood Zone: ${enrichment.floodZone.floodZone}`)
  }
  if (property.transaction?.isForeclosure) riskFlags.push('Foreclosure')
  if (property.transaction?.isShortSale) riskFlags.push('Short Sale')
  if (property.yearBuilt && property.yearBuilt < 1978) riskFlags.push('Pre-1978 (Lead Paint)')
  if (enrichment.permits?.items.some((p) => p.jobValue && p.jobValue > 50000)) {
    riskFlags.push('Major Permits (>$50K)')
  }

  // Get enabled and disabled comp counts
  const enabledComps = appraisalResult.comparables.filter((c) => c.isEnabled)
  const disabledComps = appraisalResult.comparables.filter((c) => !c.isEnabled)

  // Sort helper: subdivision match first, then by distance
  const bySubdivisionThenDistance = (a: AppraisedComparable, b: AppraisedComparable) => {
    const aSubMatch = a.evaluation.filterResults.find((f) => f.type === 'subdivision_match')?.passed ?? false
    const bSubMatch = b.evaluation.filterResults.find((f) => f.type === 'subdivision_match')?.passed ?? false
    if (aSubMatch && !bSubMatch) return -1
    if (!aSubMatch && bSubMatch) return 1
    return (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999)
  }

  // Build lookup from merged bundle comps (has Zillow-supplemented data like bedrooms)
  const mergedCompLookup = new Map(
    bundle.comparables.map((c) => [c.id, c])
  )

  // Return ALL comps: enabled first (subdivision match → distance), then disabled (same order)
  const allComps = [
    ...enabledComps.sort(bySubdivisionThenDistance),
    ...disabledComps.sort(bySubdivisionThenDistance),
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
      adjustedPrice: comp.adjustedSalePrice,
      photos: compPhotos,
      subdivision: comp.subdivision ?? null,
      foundationType: comp.construction?.foundationType ?? null,
      zillowUrl: generateZillowUrl({
        propertyId: comp.id,
        address: comp.address,
        city: comp.city,
        state: comp.state,
        zipCode: comp.zipCode,
      }),
      isEnabled: comp.isEnabled,
      disableReasons: evaluation?.disableReasons ?? [],
      classification: classificationSummary,
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
      lastSale: property.lastSalePrice
        ? {
            price: property.lastSalePrice,
            date: property.lastSaleDate ?? null,
            pricePerSqft: property.pricePerSqft ?? null,
          }
        : null,
      taxAssessment: property.assessedValue ?? null,
      photos: subjectPhotos,
      foundationType: property.construction?.foundationType ?? null,
      hoaFee: property.hoaFee ?? null,
      zillowUrl: generateZillowUrl({
        propertyId: property.id,
        address: property.address,
        city: property.city,
        state: property.state,
        zipCode: property.zipCode,
      }),
      classification: subjectClassificationSummary,
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
      rehabLevelEstimates: ctx.rehabLevelEstimates ?? [],
    },

    // ═══ COMPARABLE SALES (All comps with enable/disable status) ═══════════════
    comps: {
      total: appraisalResult.comparables.length,
      enabledCount: enabledComps.length,
      disabledCount: disabledComps.length,
      avgPricePerSqft: appraisalResult.avgPricePerSqft,
      medianPrice: appraisalResult.medianSalePrice,
      asIsCompIds: ctx.classificationSummary?.asIsCompIds ?? [],
      afterRenovationCompIds: ctx.classificationSummary?.afterRenovationCompIds ?? [],
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

    // ═══ FLOOD ZONE ═════════════════════════════════════════════════════════
    floodZone: enrichment.floodZone
      ? {
          zone: enrichment.floodZone.floodZone,
          inFloodZone: enrichment.floodZone.isInFloodZone,
          description: enrichment.floodZone.floodZoneDescription,
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
  desiredProfit?: number
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
    desiredProfit,
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
      desiredProfit,
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
