/**
 * Photo Provider Types
 *
 * Abstract interface for fetching property photos from any source.
 * Implementations can include Zillow, MLS, Redfin, custom uploads, etc.
 */

// ─── Property Identification ────────────────────────────────────────────────────

export interface PropertyIdentifier {
  /** Provider-specific property ID */
  propertyId: string
  /** Street address */
  address: string
  /** City */
  city: string
  /** State (2-letter code) */
  state: string
  /** ZIP code */
  zipCode: string
}

// ─── Photo Data ─────────────────────────────────────────────────────────────────

export interface PropertyPhotos {
  /** Property identifier */
  propertyId: string
  /** Photo URLs */
  photos: string[]
  /** Source of photos (zillow, mls, redfin, upload, etc.) */
  source: string
  /** Source-specific URL (e.g., Zillow listing URL) */
  sourceUrl?: string
  /** Property description from source */
  description?: string
  /** Property status from source */
  status?: 'for_sale' | 'pending' | 'sold' | 'off_market' | 'unknown'
  /** Days on market */
  daysOnMarket?: number
  /** Property features listed */
  features?: string[]
  /** Price history */
  priceHistory?: Array<{
    date: string
    price: number
    event: string
  }>
  /** When photos were fetched */
  fetchedAt: string
  /** Any additional metadata from source */
  metadata?: Record<string, unknown>
  // ─── Structured Property Data (extracted from source listing) ────────────
  /** Number of bedrooms */
  bedrooms?: number
  /** Number of bathrooms */
  bathrooms?: number
  /** Square footage */
  squareFeet?: number
  /** Year built */
  yearBuilt?: number
  /** Foundation type (e.g., Slab, Crawl Space, Basement) */
  foundationType?: string
  /** Monthly HOA fee in dollars */
  hoaFee?: number
  /** Most recent sale date */
  lastSaleDate?: string
  /** Most recent sale price */
  lastSalePrice?: number
}

// ─── Fetch Options ──────────────────────────────────────────────────────────────

export interface PhotoFetchOptions {
  /** Maximum number of photos to fetch per property */
  maxPhotos?: number
  /** Include property description */
  includeDescription?: boolean
  /** Include price history */
  includePriceHistory?: boolean
  /** Timeout in milliseconds */
  timeout?: number
  /** Skip cache and fetch fresh data (for providers that support caching) */
  skipCache?: boolean
}

// ─── Provider Interface ─────────────────────────────────────────────────────────

export interface PhotoProvider {
  /** Provider name (e.g., 'zillow', 'mls', 'redfin') */
  readonly name: string

  /**
   * Check if provider is available/configured
   */
  isAvailable(): boolean

  /**
   * Fetch photos for a single property
   */
  fetchPhotos(
    property: PropertyIdentifier,
    options?: PhotoFetchOptions
  ): Promise<PhotoFetchResult>

  /**
   * Fetch photos for multiple properties in parallel
   */
  fetchBulkPhotos(
    properties: PropertyIdentifier[],
    options?: PhotoFetchOptions
  ): Promise<BulkPhotoFetchResult>
}

// ─── Response Types ─────────────────────────────────────────────────────────────

export interface PhotoFetchSuccess {
  success: true
  data: PropertyPhotos
}

export interface PhotoFetchError {
  success: false
  propertyId: string
  error: string
  code?: string
}

export type PhotoFetchResult = PhotoFetchSuccess | PhotoFetchError

export interface BulkPhotoFetchResult {
  /** Successfully fetched photos */
  results: Map<string, PropertyPhotos>
  /** Failed fetches */
  errors: PhotoFetchError[]
  /** Summary stats */
  summary: {
    total: number
    successful: number
    failed: number
    totalPhotos: number
  }
}

// ─── Photo Bundle (for analysis) ────────────────────────────────────────────────

/**
 * Photos for subject property and comparables
 * Used in analysis workflows
 */
export interface PhotoBundle {
  /** Subject property photos */
  subject: PropertyPhotos | null
  /** Comparable property photos (keyed by propertyId) */
  comps: Record<string, PropertyPhotos>
  /** Provider used */
  provider: string
  /** When bundle was created */
  fetchedAt: string
}
