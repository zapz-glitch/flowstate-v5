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
  /** Square footage variance for filtering */
  sqftVariance?: number
  /** Subject sqft (required with sqftVariance) */
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
}

export interface EnrichmentData {
  evidenceLimitations?: string[]
  permits: PermitsEnrichment | null
  floodZone: NormalizedFloodZone | null
  /** OSM-detected location risks (major roads, railroads, commercial) */
  locationRisks?: import('../location-risk').LocationRisk[] | null
  weatherRisk: WeatherRisk | null
  neighbourhood: import('../neighbourhood').NeighbourhoodData | null
}

export interface EnrichmentOptions {
  /** Include building permits (default: true) */
  permits?: boolean
  /** Include flood zone data (default: true) */
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
    /** Square footage variance for filtering (passed to API) */
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
