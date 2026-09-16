/**
 * Property API Types
 *
 * Normalized types that provide a consistent interface for property data
 * regardless of the underlying data provider (CoreLogic, ATTOM, etc.)
 */

// ─── Provider Types ─────────────────────────────────────────────────────────

export type PropertyProvider = 'corelogic' | 'attom'

// ─── Search Parameters ──────────────────────────────────────────────────────

export interface PropertySearchParams {
  /** Full address string or components */
  address?: string
  streetAddress?: string
  city?: string
  state?: string
  zipCode?: string
}

export interface ComparablesSearchParams {
  providerDefaults?: boolean
  /** Property ID (CLIP for CoreLogic, ATTOM ID for ATTOM) */
  propertyId: string
  /** Search radius in miles (default: 1) */
  radiusMiles?: number
  /** Maximum comparables to return (default: 10) */
  maxComps?: number
  /** Months back to search for sales (default: 12) */
  monthsBack?: number
  /** Bedroom filters */
  minBeds?: number
  maxBeds?: number
  /** Bathroom filters */
  minBaths?: number
  maxBaths?: number
  /** Square footage variance PERCENT for filtering (provider param) */
  sqftVariance?: number
  /**
   * Absolute sqft tolerance (from the sqft_diff appraisal rule). Preferred
   * over sqftVariance — the rule value is absolute sqft, not a percent.
   * Never relaxed by any evaluation tier, so a provider-side bound is a
   * SAFE_PROVIDER_PREFILTER. Sent only when the rule is enabled and
   * subjectSqft is known.
   */
  sqftDiff?: number
  /** Subject sqft (required with sqftVariance/sqftDiff) */
  subjectSqft?: number
  /** Subject property type (used when API doesn't return it) */
  subjectPropertyType?: string
}

// ─── Normalized Property ────────────────────────────────────────────────────

export interface NormalizedProperty {
  /** Provider-specific property ID */
  id: string
  /** Provider name */
  provider: PropertyProvider

  // Address
  address: string
  city: string
  state: string
  zipCode: string
  county?: string

  // Coordinates
  latitude: number | null
  longitude: number | null

  // Property characteristics
  bedrooms: number | null
  bathrooms: number | null
  fullBathrooms?: number | null
  halfBathrooms?: number | null
  squareFeet: number | null
  lotSizeAcres: number | null
  lotSizeSquareFeet?: number | null
  /** Below-grade/basement finished area — valued at a discounted $/sqft */
  basementSquareFeet?: number | null
  yearBuilt: number | null
  effectiveYearBuilt?: number | null
  propertyType: string | null
  stories: number | null

  // Sale information
  lastSalePrice: number | null
  lastSaleDate: string | null
  pricePerSqft?: number | null

  // Tax & Assessment
  assessedValue: number | null
  landAssessedValue?: number | null
  improvementAssessedValue?: number | null
  marketValue: number | null
  taxAmount: number | null
  taxYear?: number | null

  // AVM (Automated Valuation Model)
  /** Estimated property value from AVM */
  avmValue?: number | null
  /** AVM confidence score (0-100) */
  avmConfidence?: number | null

  // HOA
  /** Monthly HOA fee in dollars (if applicable) */
  hoaFee?: number | null

  // Building details
  construction?: {
    type?: string
    qualityCode?: string
    /** Building style (e.g. Colonial, Cape Cod, Bungalow, Ranch) */
    buildingStyle?: string
    /** Story type description (e.g. Split Foyer, Tri Level, 2 Story) */
    storiesType?: string
    roofType?: string
    roofCover?: string
    foundationType?: string
    exteriorWalls?: string
  }
  features?: {
    heating?: string
    cooling?: string
    fireplacesCount?: number
    poolType?: string
    garageType?: string
    garageSquareFeet?: number
    parkingSpaces?: number
    carportType?: string
    carportSpaces?: number
    porchCount?: number
    porchSquareFeet?: number
    patioCount?: number
    patioSquareFeet?: number
  }

  // Ownership
  ownership?: {
    ownerName?: string
    ownerOccupied?: boolean
    ownershipRights?: string
    mailingAddress?: string
  }

  // Transaction details (important for underwriting)
  transaction?: {
    buyerNames?: string[]
    sellerNames?: string[]
    buyerIsCorporate?: boolean
    titleCompany?: string
    isCashPurchase?: boolean
    isShortSale?: boolean
    isForeclosure?: boolean
    isInterfamilyTransfer?: boolean
    saleDocumentType?: string
    ownershipTransferPercent?: number
  }

  // Location details
  subdivision?: string
  zoning?: string
  zoningDescription?: string
  /** Composite parcel ID `fipsCode:universalParcelId` (Cotality v1PropertyId) — required by parcel-level flood-zone/AVM */
  parcelId?: string | null
  /** Formatted assessor parcel number (e.g. "17786-042-0330") */
  apnFormatted?: string | null
  /** Assessor building improvement condition (e.g. "Average", "Good") */
  buildingCondition?: string | null
  /** Construction quality grade (e.g. "Fair", "Good") */
  buildingGrade?: string | null
  /** Assessor improvement value in dollars */
  improvementValue?: number | null
  /** Added-on building area (sqft) — indicates a permitted addition exists on the subject */
  additionSquareFeet?: number | null
  neighborhoodName?: string
  neighborhoodCode?: string
  cbsaCode?: string
  censusTract?: string
  legalDescription?: string

  /** Raw API response for debugging */
  raw?: unknown
}

// ─── Normalized Comparable ──────────────────────────────────────────────────

export interface NormalizedComparable {
  /** Provider-specific property ID */
  id: string
  /** Provider name */
  provider: PropertyProvider

  // Address
  address: string
  city: string
  state: string
  zipCode: string

  // Coordinates
  latitude: number | null
  longitude: number | null

  // Distance from subject
  distanceMiles: number | null

  // Property characteristics
  bedrooms: number | null
  bathrooms: number | null
  squareFeet: number | null
  lotSizeAcres: number | null
  lotSizeSquareFeet?: number | null
  /** Below-grade/basement finished area — valued at a discounted $/sqft */
  basementSquareFeet?: number | null
  yearBuilt: number | null
  propertyType: string | null

  // Sale information
  salePrice: number | null
  saleDate: string | null
  pricePerSqft: number | null

  // Location details (from enrichment)
  subdivision?: string | null
  /** Composite parcel ID `fipsCode:universalParcelId` — present on comparables responses */
  parcelId?: string | null
  neighborhoodName?: string | null
  neighborhoodCode?: string | null

  /** Assessor building improvement condition (e.g. "Average") */
  buildingCondition?: string | null
  /** Construction quality grade */
  buildingGrade?: string | null
  stories?: number | null

  /** True when the comp sits across a major road from the subject (not_verified when unknown) */
  crossesMajorRoad?: boolean
  /** Site/influence quality flag from provider (e.g. traffic influence) */
  siteInfluence?: string | null

  // Building details (from enrichment)
  construction?: {
    type?: string
    qualityCode?: string
    buildingStyle?: string
    storiesType?: string
    roofType?: string
    roofCover?: string
    foundationType?: string
    exteriorWalls?: string
  }

  // Transaction details (from enrichment)
  transaction?: {
    buyerNames?: string[]
    buyerIsCorporate?: boolean
    isCashPurchase?: boolean
    isShortSale?: boolean
    isForeclosure?: boolean
    isInterfamilyTransfer?: boolean
    isInvestorPurchase?: boolean
  }

  // Property characteristics (extended, populated by enrichment)

  // Property features (from enrichment)
  features?: {
    poolType?: string
    garageType?: string
    garageSquareFeet?: number
    carportType?: string
    heating?: string
    cooling?: string
    fireplacesCount?: number
  }

  /** Whether this comp has been enriched with full property details */
  isEnriched?: boolean

  /** Raw API response */
  raw?: unknown
}

// ─── Normalized Permit ──────────────────────────────────────────────────────

export interface NormalizedPermit {
  statusHistory?: { status: string | null; effectiveDate: string | null }[]
  source?: string
  raw?: unknown
  permitId: string
  permitNumber: string | null
  status: string | null
  effectiveDate: string | null
  expirationDate: string | null
  projectType: string | null
  projectCategory: string | null
  classificationTypes: string[]
  description: string | null
  jobValue: number | null
  contractorName: string | null
  areaSquareFeet: number | null
}

// ─── Flood Zone ─────────────────────────────────────────────────────────────

export interface NormalizedFloodZone {
  floodZone: string | null
  floodZoneDescription: string | null
  isInFloodZone: boolean
  isNearFloodZone: boolean
  communityName: string | null
  communityNumber: string | null
  firmMapNumber: string | null
  mapPanel: string | null
  mapDate: string | null
  participationStatus: string | null
  /** FEMA Special Flood Hazard Area determination ('In'/'Out') — parcel-level only */
  specialFloodHazardArea?: string | null
  /** Which resource produced this: parcel-level determination, coordinate spatial lookup, or a First Street signal scraped from the public listing */
  source?: 'parcel' | 'spatial' | 'listing'
}

// ─── Response Types ─────────────────────────────────────────────────────────

export interface PropertySearchResult {
  success: true
  data: NormalizedProperty
}

export interface PropertySearchError {
  success: false
  error: string
  code?: string
}

export type PropertySearchResponse = PropertySearchResult | PropertySearchError

export interface ComparablesResult {
  success: true
  data: {
    subject: { id: string; address?: string }
    comparables: NormalizedComparable[]
    count: number
    /** What the provider actually returned — pool breadth + truncation audit */
    retrieval?: import('./retrieval-policy').ComparablesRetrievalMeta
  }
}

export interface ComparablesError {
  success: false
  error: string
  code?: string
}

export type ComparablesSearchResponse = ComparablesResult | ComparablesError

export interface PermitsResult {
  success: true
  data: {
    propertyId: string
    permits: NormalizedPermit[]
    count: number
  }
}

export interface PermitsError {
  success: false
  error: string
  code?: string
}

export type PermitsResponse = PermitsResult | PermitsError

export interface FloodZoneResult {
  success: true
  data: NormalizedFloodZone
}

export interface FloodZoneError {
  success: false
  error: string
  code?: string
}

export type FloodZoneResponse = FloodZoneResult | FloodZoneError

// ─── AVM (Automated Valuation Model) ────────────────────────────────────────

export interface NormalizedAvm {
  /** Point estimate value */
  value: number | null
  /** Confidence score (0-100 when provided) */
  confidence: number | null
  valueRangeLow: number | null
  valueRangeHigh: number | null
  /** Forecast standard deviation (accuracy measure) */
  fsd: number | null
  /** Model identifier used (e.g. thvMarketingStandard) */
  model: string
  asOfDate: string | null
}

export interface AvmResult {
  success: true
  data: NormalizedAvm
}

export interface AvmError {
  success: false
  error: string
  code?: string
}

export type AvmResponse = AvmResult | AvmError

// ─── Building Detail (/property/{id}/building) ──────────────────────────────

/**
 * Literal-text building attributes from the dedicated building endpoint.
 * Used to supplement property-detail when its coded buildings block is
 * missing condition/style/etc. — provider data, so it outranks Zillow fills.
 */
export interface NormalizedBuildingDetail {
  /** Assessor condition (e.g. 'Average', 'Good') */
  condition: string | null
  buildingStyle: string | null
  foundation: string | null
  constructionType: string | null
  exteriorWalls: string | null
  roofCover: string | null
  stories: number | null
  heating: string | null
  cooling: string | null
  parkingType: string | null
  garageSquareFeet: number | null
  pool: string | null
  yearBuilt: number | null
}

export interface BuildingDetailResult {
  success: true
  data: NormalizedBuildingDetail
}

export interface BuildingDetailError {
  success: false
  error: string
  code?: string
}

export type BuildingDetailResponse = BuildingDetailResult | BuildingDetailError

// ─── Provider Interface ─────────────────────────────────────────────────────

export interface PropertyProviderAdapter {
  /** Provider identifier */
  readonly name: PropertyProvider

  /** Search for property by address */
  searchProperty(params: PropertySearchParams): Promise<PropertySearchResponse>

  /** Get property details by ID */
  getPropertyById(propertyId: string): Promise<PropertySearchResponse>

  /** Get comparable properties */
  getComparables(params: ComparablesSearchParams): Promise<ComparablesSearchResponse>

  /** Get building permits (optional). Address fields enable providers that don't support ID-based lookup. */
  getBuildingPermits?(propertyId: string, address?: { address1: string; address2: string }): Promise<PermitsResponse>

  /** Get flood zone (optional) */
  getFloodZone?(latitude: number, longitude: number): Promise<FloodZoneResponse>

  /** Get parcel-level flood zone by composite parcel ID (fipsCode:universalParcelId) — more accurate than the coordinate spatial lookup */
  getFloodZoneByParcel?(parcelId: string): Promise<FloodZoneResponse>

  /** Get an AVM estimate by composite parcel ID (fipsCode:universalParcelId) */
  getAvm?(parcelId: string, model?: string): Promise<AvmResponse>

  /** Get building detail by composite parcel ID — supplements property-detail when condition/style codes are absent */
  getBuildingDetail?(parcelId: string): Promise<BuildingDetailResponse>
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface PropertyApiConfig {
  provider: PropertyProvider
  /** Cache TTL for property data in seconds */
  propertyCacheTtl?: number
  /** Cache TTL for comparables in seconds */
  comparablesCacheTtl?: number
}

// ─── Weather Risk ──────────────────────────────────────────────────────────────

export interface WeatherRisk {
  /** Overall risk score (0-100) */
  overallScore: number
  /** Risk category */
  riskLevel: 'low' | 'moderate' | 'high' | 'severe'

  /** Individual risk factors */
  factors: {
    /** Hurricane/tropical storm risk */
    hurricane?: {
      score: number
      zone?: string
      historicalFrequency?: number
    }
    /** Tornado risk */
    tornado?: {
      score: number
      zone?: string
    }
    /** Wildfire risk */
    wildfire?: {
      score: number
      zone?: string
    }
    /** Earthquake risk */
    earthquake?: {
      score: number
      zone?: string
    }
    /** Hail risk */
    hail?: {
      score: number
      averageFrequency?: number
    }
    /** Wind risk */
    wind?: {
      score: number
      averageMaxSpeed?: number
    }
  }

  /** Climate data */
  climate?: {
    averageHighTemp?: number
    averageLowTemp?: number
    averageAnnualRainfall?: number
    averageAnnualSnowfall?: number
    heatingDegreeDays?: number
    coolingDegreeDays?: number
  }
}

// ─── Enrichment Data ───────────────────────────────────────────────────────────

export interface PermitsEnrichment {
  items: NormalizedPermit[]
  count: number
  totalJobValue?: number
  recentPermitTypes?: string[]
  /** 'ok' | 'empty' when the call succeeded; 'unavailable' when it errored */
  status?: 'ok' | 'empty' | 'unavailable'
  /** Error detail when status is 'unavailable' */
  error?: string
}

export interface EnrichmentData {
  evidenceLimitations?: string[]
  permits: PermitsEnrichment | null
  floodZone: NormalizedFloodZone | null
  /** Subject AVM estimate (Cotality THV) — parcel-level, subject only */
  avm?: NormalizedAvm | null
  /** OSM-detected location risks (major roads, railroads, commercial) */
  locationRisks?: import('../location-risk').LocationRisk[] | null
  weatherRisk: WeatherRisk | null
  neighbourhood: import('../neighbourhood').NeighbourhoodData | null
}

export interface EnrichmentOptions {
  /** Include building permits (default: false — on-demand via report Permits action) */
  permits?: boolean
  /** Include provider flood zone data (default: false — listing scrape carries the flood signal) */
  floodZone?: boolean
  /** Include weather/natural disaster risk (default: false) */
  weatherRisk?: boolean
  /** Include neighbourhood analysis — community, schools, POI (default: true) */
  neighbourhood?: boolean
}

// ─── Property Bundle ───────────────────────────────────────────────────────────

/**
 * Complete property data bundle - fetched in a single call
 * Contains property + comparables + enrichment data.
 *
 * NOTE: Photos are NOT included here - use PhotoProvider separately.
 * This separation allows using any photo source (Zillow, MLS, Redfin, uploads, etc.)
 */
export interface PropertyBundle {
  /** Subject property from data provider */
  property: NormalizedProperty

  /** Comparable properties from data provider */
  comparables: NormalizedComparable[]

  /** Enrichment data (permits, flood zone, weather risk) */
  enrichment: EnrichmentData

  /** Fetch metadata */
  metadata: {
    fetchedAt: string
    provider: PropertyProvider
    searchParams: PropertySearchParams | { propertyId: string }
    comparablesParams: Omit<ComparablesSearchParams, 'subjectSqft' | 'subjectPropertyType'>
    enrichmentOptions: EnrichmentOptions
    /** Provider retrieval audit — pool breadth, truncation inference, refetches */
    retrieval?: import('./retrieval-policy').ComparablesRetrievalMeta
  }
}

/**
 * Parameters for fetching a complete property bundle
 */
export interface PropertyBundleParams {
  /** Property identification - address string */
  address?: string
  /** Property identification - street address component */
  streetAddress?: string
  /** Property identification - city */
  city?: string
  /** Property identification - state */
  state?: string
  /** Property identification - zip code */
  zipCode?: string
  /** Property identification - provider ID */
  propertyId?: string

  /** Comparable search options */
  comparables?: {
    radiusMiles?: number
    maxComps?: number
    monthsBack?: number
    /** Absolute sqft tolerance from the sqft_diff rule (provider bounds) */
    sqftDiff?: number
    /** Square footage variance PERCENT for filtering (legacy provider param) */
    sqftVariance?: number
  }

  /** Enrichment options */
  enrichment?: EnrichmentOptions

  /** Skip cache and fetch fresh data from APIs */
  skipCache?: boolean
}

export interface PropertyBundleResult {
  success: true
  data: PropertyBundle
}

export interface PropertyBundleError {
  success: false
  error: string
  code?: string
}

export type PropertyBundleResponse = PropertyBundleResult | PropertyBundleError
