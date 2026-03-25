/**
 * Firecrawl Zillow Fetcher
 *
 * Uses Firecrawl v2 API to scrape Zillow listings with built-in JSON extraction.
 * Firecrawl's JSON format extracts structured data in a single API call,
 * eliminating the need for a separate LLM parsing step.
 *
 * Flow:
 *   1. Firecrawl v2 scrape with formats: ["html", { type: "json", schema, prompt }]
 *   2. JSON extraction returns structured listing data directly
 *   3. Photos are extracted from HTML via regex (more reliable for URLs)
 *   4. Fallback: OpenRouter LLM parsing if JSON extraction fails
 *
 * Features:
 * - KV caching for scraped responses (24 hour TTL)
 * - Single-call extraction via Firecrawl JSON format
 * - Response normalization and photo URL optimization
 *
 * Requires FIRECRAWL_API_KEY (OPENROUTER_API_KEY optional, for fallback)
 *
 * @see https://docs.firecrawl.dev/advanced-scraping-guide
 */

import type {
  ZillowPropertyIdentifier,
  ZillowListingData,
  CompZillowResult,
  ZillowFetchOptions,
} from './types'
import { createOpenRouterProvider } from '../../../llm'

// ─── Cache Configuration ────────────────────────────────────────────────────

/** Cache key prefix for Firecrawl Zillow responses */
const CACHE_PREFIX = 'zillow-fc:'

/** Default cache TTL in seconds (24 hours) */
const DEFAULT_CACHE_TTL = 24 * 60 * 60

/** Interface for cached Zillow data */
interface CachedZillowData {
  extraction: ZillowExtraction
  cachedAt: string
  zillowUrl: string
}

// ─── Zillow URL Generation ───────────────────────────────────────────────────

export function generateZillowUrl(property: ZillowPropertyIdentifier): string {
  const addressSlug = property.address
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .trim()

  const citySlug = property.city.toLowerCase().replace(/\s+/g, '-')
  const stateSlug = property.state.toLowerCase()

  return `https://www.zillow.com/homes/${addressSlug}-${citySlug}-${stateSlug}-${property.zipCode}_rb/`
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface ZillowExtraction {
  photos: string[]
  description?: string
  price?: number
  pricePerSqft?: number
  status?: 'for_sale' | 'pending' | 'sold' | 'off_market'
  daysOnMarket?: number
  listDate?: string
  features?: string[]
  priceHistory?: Array<{
    date: string
    price: number
    event: string
  }>
  error?: string

  // Property details
  bedrooms?: number
  bathrooms?: number
  squareFeet?: number
  lotSize?: string
  lotSizeAcres?: number
  yearBuilt?: number
  propertyType?: string
  style?: string
  stories?: number

  // Construction & systems
  foundationType?: string
  roof?: string
  construction?: string
  heating?: string
  cooling?: string

  // Parking
  parking?: string
  garageSpaces?: number

  // Financial
  hoaFee?: number
  taxAmount?: number
  estimatedMonthlyPayment?: number

  // Amenities
  appliances?: string[]
  flooring?: string[]
  exteriorFeatures?: string[]
  pool?: boolean
  waterfront?: boolean
  view?: string

  // Location
  neighborhood?: string
  walkScore?: number
  transitScore?: number

  // Agent
  agent?: {
    name?: string
    phone?: string
    brokerage?: string
  }

  // What's Special highlights
  whatsSpecial?: string[]
}

// ─── Feature Parsing Utilities ─────────────────────────────────────────────

/**
 * Parse bedrooms from features array
 * Handles: "3 bed", "3 beds", "3 bedroom", "3 bedrooms", "3bd", "3br"
 */
function parseBedroomsFromFeatures(features: string[]): number | undefined {
  for (const feature of features) {
    const lower = feature.toLowerCase().trim()
    const match = lower.match(/^(\d+)\s*(?:bed|beds|bedroom|bedrooms|bd|br)/)
    if (match) {
      return parseInt(match[1], 10)
    }
  }
  return undefined
}

/**
 * Parse bathrooms from features array
 * Handles: "2 bath", "2.5 bath", "2 baths", "2 bathroom", "2ba"
 */
function parseBathroomsFromFeatures(features: string[]): number | undefined {
  for (const feature of features) {
    const lower = feature.toLowerCase().trim()
    const match = lower.match(/^(\d+(?:\.\d+)?)\s*(?:bath|baths|bathroom|bathrooms|ba)/)
    if (match) {
      return parseFloat(match[1])
    }
  }
  return undefined
}

/**
 * Parse square footage from features array
 * Handles: "1,500 sqft", "1500 sq ft", "1,500 square feet"
 */
function parseSqftFromFeatures(features: string[]): number | undefined {
  for (const feature of features) {
    const lower = feature.toLowerCase().trim()
    const match = lower.match(/^([\d,]+)\s*(?:sqft|sq\s*ft|square\s*feet)/)
    if (match) {
      return parseInt(match[1].replace(/,/g, ''), 10)
    }
  }
  return undefined
}

/**
 * Get most recent sale from price history
 */
function getLastSaleFromHistory(priceHistory?: Array<{ date: string; price: number; event: string }>): {
  lastSaleDate?: string
  lastSalePrice?: number
} {
  if (!priceHistory || priceHistory.length === 0) {
    return {}
  }

  // Look for sold events
  const soldEvents = priceHistory.filter(
    (h) => h.event.toLowerCase().includes('sold') && h.price > 0
  )

  if (soldEvents.length === 0) {
    return {}
  }

  // Sort by date descending (most recent first)
  const sorted = soldEvents.sort((a, b) => {
    const dateA = new Date(a.date).getTime()
    const dateB = new Date(b.date).getTime()
    return dateB - dateA
  })

  const lastSale = sorted[0]
  return {
    lastSaleDate: lastSale.date,
    lastSalePrice: lastSale.price,
  }
}

interface FirecrawlResponse {
  success: boolean
  data?: {
    html?: string
    markdown?: string
    json?: Record<string, unknown> // Firecrawl v2 JSON extraction result
    content?: string
    url?: string // Final URL after redirects
    metadata?: {
      title?: string
      description?: string
      ogImage?: string
      sourceURL?: string
      url?: string
    }
  }
  error?: string
}

/**
 * Check if an extraction is valid and worth caching
 */
function isValidExtraction(extraction: ZillowExtraction): boolean {
  if (extraction.error) return false
  if (!extraction.photos || extraction.photos.length === 0) return false

  // Check if photos are actual Zillow URLs
  const validPhotos = extraction.photos.filter(
    (p) => p && typeof p === 'string' && p.includes('zillowstatic.com')
  )
  return validPhotos.length > 0
}

// ─── HTML Parsing ────────────────────────────────────────────────────────────

/**
 * Extract Zillow data from HTML content
 */
function parseZillowHtml(html: string): ZillowExtraction {
  const photos: string[] = []
  const features: string[] = []
  let description: string | undefined
  let price: number | undefined
  let status: ZillowExtraction['status'] | undefined

  try {
    // Extract photos from various Zillow image patterns
    // Pattern 1: zillowstatic.com URLs in img tags or data attributes
    const photoPatterns = [
      /https:\/\/photos\.zillowstatic\.com\/fp\/[a-f0-9]+-[a-z_]+\.jpg/gi,
      /https:\/\/photos\.zillowstatic\.com\/[^"'\s]+/gi,
      /https:\/\/[^"'\s]*zillowstatic\.com[^"'\s]*\.(?:jpg|jpeg|png|webp)/gi,
    ]

    // Non-property URL patterns to exclude
    const excludeSubstrings = [
      'z-logo', 'icon', 'avatar', 'logo', 'badge',
      'profile', 'agent', 'broker', 'headshot', 'portrait',
      'map', 'streetview', 'street-view', 'satellite',
      'floorplan', 'floor-plan', 'placeholder',
      '/h_n/', '/h_l/', '/h_g/', '/isr', '/mgn/',
      'profilephotos', 'thumb', 'thumbnail',
    ]

    const seenPhotos = new Set<string>()
    for (const pattern of photoPatterns) {
      const matches = html.match(pattern) || []
      for (const match of matches) {
        const lower = match.toLowerCase()
        // Skip non-property images
        if (excludeSubstrings.some((s) => lower.includes(s))) continue
        // Must be from photos.zillowstatic.com with /fp/ or /p_X/ paths
        if (!lower.includes('photos.zillowstatic.com')) continue
        if (!lower.includes('/fp/') && !/\/p_[a-z]\//.test(lower)) continue

        // Normalize to full resolution
        const normalized = match
          .replace(/\/p_[a-z]\//, '/p_f/')
          .replace(/\?.*$/, '')

        if (!seenPhotos.has(normalized)) {
          seenPhotos.add(normalized)
          photos.push(normalized)
        }
      }
    }

    // Extract description from meta tags or content
    const descPatterns = [
      /<meta[^>]*name="description"[^>]*content="([^"]+)"/i,
      /<meta[^>]*property="og:description"[^>]*content="([^"]+)"/i,
    ]
    for (const pattern of descPatterns) {
      const match = html.match(pattern)
      if (match?.[1]) {
        description = match[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"')
        break
      }
    }

    // Extract price from various patterns
    const pricePatterns = [
      /\$([0-9,]+)\s*(?:\/mo|per month)?/i,
      /"price":\s*(\d+)/i,
      /data-price="(\d+)"/i,
    ]
    for (const pattern of pricePatterns) {
      const match = html.match(pattern)
      if (match?.[1]) {
        const priceStr = match[1].replace(/,/g, '')
        const parsed = parseInt(priceStr, 10)
        if (parsed > 10000) { // Reasonable property price
          price = parsed
          break
        }
      }
    }

    // Detect listing status
    if (/\bsold\b/i.test(html)) {
      status = 'sold'
    } else if (/\bpending\b/i.test(html)) {
      status = 'pending'
    } else if (/\bfor sale\b/i.test(html)) {
      status = 'for_sale'
    } else if (/\boff market\b/i.test(html)) {
      status = 'off_market'
    }

    // Extract features from common patterns
    const featurePatterns = [
      /(\d+)\s*(?:bed|bedroom|br)/gi,
      /(\d+(?:\.\d+)?)\s*(?:bath|bathroom|ba)/gi,
      /(\d+[,\d]*)\s*(?:sq\s*ft|sqft|square feet)/gi,
    ]
    for (const pattern of featurePatterns) {
      const match = html.match(pattern)
      if (match?.[0]) {
        features.push(match[0])
      }
    }

  } catch (error) {
    console.error('[FirecrawlZillow] HTML parsing error:', error)
    return { photos: [], error: 'Failed to parse HTML' }
  }

  return {
    photos,
    description,
    price,
    status,
    features: features.length > 0 ? features : undefined,
  }
}

// ─── LLM Extraction Prompt ───────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are a real estate data extraction assistant. Extract property listing data from the provided Zillow page content.

Extract all available fields as a flat JSON object:

PROPERTY PHOTOS:
- "photos": Array of property photo URLs from zillowstatic.com only
- EXCLUDE agent photos, logos, icons, maps, floor plans, street view images
- Only include actual property interior/exterior photos

LISTING DATA (all numbers as raw values, no $ or commas):
- "description", "price", "pricePerSqft", "status" (for_sale|pending|sold|off_market)
- "daysOnMarket", "listDate" (YYYY-MM-DD)

PROPERTY DETAILS:
- "bedrooms", "bathrooms" (use decimals for half baths), "squareFeet"
- "lotSize" (with units), "lotSizeAcres", "yearBuilt"
- "propertyType" (single-family|condo|townhouse|multi-family|land|other)
- "style" (architectural), "stories"

CONSTRUCTION & SYSTEMS:
- "foundationType", "roof", "construction", "heating", "cooling"
- "parking", "garageSpaces"

FINANCIAL:
- "hoaFee" (monthly, divide annual by 12), "taxAmount" (annual), "estimatedMonthlyPayment"

FEATURES (from Facts & Features / Home Details sections):
- "features" (flat array of all features), "appliances" (array)
- "flooring" (array), "exteriorFeatures" (array)
- "pool" (boolean), "waterfront" (boolean), "view"

HISTORY & LOCATION:
- "priceHistory" (array of {date, price, event} — especially sold events)
- "neighborhood", "walkScore", "transitScore"

AGENT:
- "agent": {"name", "phone", "brokerage"}

OTHER:
- "whatsSpecial" (array from "What's Special" section)

Return ONLY valid JSON. Use null for missing fields.`

// ─── Firecrawl v2 JSON Extraction Schema ────────────────────────────────────

/** JSON schema for Firecrawl v2 built-in extraction */
const FIRECRAWL_JSON_SCHEMA = {
  type: 'object',
  properties: {
    // Core listing info
    description: { type: 'string', description: 'Full property description text from the listing' },
    price: { type: 'number', description: 'List price as raw number (no $ or commas)' },
    pricePerSqft: { type: 'number', description: 'Price per square foot' },
    status: { type: 'string', enum: ['for_sale', 'pending', 'sold', 'off_market'], description: 'Listing status' },
    daysOnMarket: { type: 'number', description: 'Days on market' },
    listDate: { type: 'string', description: 'Original list date (YYYY-MM-DD)' },

    // Property details
    bedrooms: { type: 'number', description: 'Number of bedrooms' },
    bathrooms: { type: 'number', description: 'Number of bathrooms (use decimals for half baths, e.g. 2.5)' },
    squareFeet: { type: 'number', description: 'Interior living area in square feet' },
    lotSize: { type: 'string', description: 'Lot size with units (e.g. "0.25 acres", "10,890 sqft")' },
    lotSizeAcres: { type: 'number', description: 'Lot size in acres' },
    yearBuilt: { type: 'number', description: 'Year the property was built' },
    propertyType: {
      type: 'string',
      enum: ['single-family', 'condo', 'townhouse', 'multi-family', 'land', 'other'],
      description: 'Property type',
    },
    style: { type: 'string', description: 'Architectural style (e.g. Ranch, Colonial, Contemporary)' },
    stories: { type: 'number', description: 'Number of stories' },

    // Construction & systems
    foundationType: { type: 'string', description: 'Foundation type (e.g. Slab, Crawl Space, Basement, Pier and Beam)' },
    roof: { type: 'string', description: 'Roof type/material (e.g. Composition, Metal, Tile)' },
    construction: { type: 'string', description: 'Construction materials (e.g. Brick, Frame, Stucco)' },
    heating: { type: 'string', description: 'Heating system type' },
    cooling: { type: 'string', description: 'Cooling system type' },

    // Parking
    parking: { type: 'string', description: 'Parking description (e.g. "2-car attached garage")' },
    garageSpaces: { type: 'number', description: 'Number of garage spaces' },

    // Financial
    hoaFee: { type: 'number', description: 'Monthly HOA fee (if annual, divide by 12). null if no HOA' },
    taxAmount: { type: 'number', description: 'Annual property tax amount' },
    estimatedMonthlyPayment: { type: 'number', description: 'Estimated monthly mortgage payment' },

    // Features & amenities
    features: { type: 'array', items: { type: 'string' }, description: 'All property features and amenities as a flat list' },
    appliances: { type: 'array', items: { type: 'string' }, description: 'List of appliances included' },
    flooring: { type: 'array', items: { type: 'string' }, description: 'Flooring types (e.g. Hardwood, Tile, Carpet)' },
    exteriorFeatures: { type: 'array', items: { type: 'string' }, description: 'Exterior features (e.g. Pool, Patio, Fenced Yard)' },
    pool: { type: 'boolean', description: 'Whether property has a pool' },
    waterfront: { type: 'boolean', description: 'Whether property is waterfront' },
    view: { type: 'string', description: 'View description if applicable' },

    // Price history
    priceHistory: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Date of event (YYYY-MM-DD)' },
          price: { type: 'number', description: 'Price at that event' },
          event: { type: 'string', description: 'Event type (e.g. Sold, Listed, Price Change)' },
        },
      },
      description: 'Price history events (most important: sold events with dates and prices)',
    },

    // Neighborhood & location
    neighborhood: { type: 'string', description: 'Neighborhood or subdivision name' },
    walkScore: { type: 'number', description: 'Walk score (0-100)' },
    transitScore: { type: 'number', description: 'Transit score (0-100)' },

    // Agent/broker info
    agent: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Listing agent name' },
        phone: { type: 'string', description: 'Agent phone number' },
        brokerage: { type: 'string', description: 'Brokerage company name' },
      },
      description: 'Listing agent information',
    },

    // What's Special
    whatsSpecial: { type: 'array', items: { type: 'string' }, description: 'Highlights from the "What\'s Special" section' },
  },
}

/** Prompt for Firecrawl v2 JSON extraction */
const FIRECRAWL_JSON_PROMPT = `Extract all property listing information from this Zillow page.
Focus on:
1. Complete property details: price as raw number (no $ or commas), bedrooms, bathrooms (use decimals for half baths), square footage (interior only), lot size, year built
2. Property type and architectural style
3. Construction details: foundation type, roof, construction materials, heating, cooling
4. Parking and garage information
5. Financial: HOA fee (monthly), tax amount, estimated monthly payment
6. All features and amenities as flat lists
7. Price history events with dates and prices (especially sold events)
8. Neighborhood name, walk score, transit score
9. Agent/broker contact information
10. What's Special highlights

For price: extract numeric value only (no $ or commas).
For status: use "for_sale", "pending", "sold", or "off_market".
For lot size: include both string with units and numeric acres value.
Use null for any fields not found on the page.`

// ─── Firecrawl Zillow Fetcher Class ─────────────────────────────────────────

export interface FirecrawlZillowFetcherConfig {
  /** Firecrawl API key for scraping */
  apiKey: string
  /** OpenRouter API key for LLM parsing (fallback if Firecrawl JSON extraction fails) */
  openrouterApiKey?: string
  /** OpenRouter model to use (default: google/gemini-2.0-flash-001) */
  openrouterModel?: string
  /** Optional KV namespace for caching responses */
  cache?: KVNamespace
  /** Cache TTL in seconds (default: 24 hours) */
  cacheTtl?: number
}

export class FirecrawlZillowFetcher {
  private apiKey: string
  private openrouterApiKey?: string
  private openrouterModel: string
  private cache?: KVNamespace
  private cacheTtl: number

  /** Tracks number of Firecrawl API calls (scrapes) */
  firecrawlCallCount = 0
  /** Tracks number of cache hits */
  cacheHitCount = 0
  /** Tracks number of LLM calls (for parsing scraped content — fallback only) */
  llmCallCount = 0

  constructor(config: FirecrawlZillowFetcherConfig) {
    this.apiKey = config.apiKey
    this.openrouterApiKey = config.openrouterApiKey
    this.openrouterModel = config.openrouterModel ?? 'google/gemini-2.0-flash-001'
    this.cache = config.cache
    this.cacheTtl = config.cacheTtl ?? DEFAULT_CACHE_TTL
  }

  /** Reset call counters for a new analysis run */
  resetCallCounters(): void {
    this.firecrawlCallCount = 0
    this.cacheHitCount = 0
    this.llmCallCount = 0
  }

  /**
   * Generate cache key from Zillow URL
   */
  private getCacheKey(zillowUrl: string): string {
    const urlHash = zillowUrl
      .replace('https://www.zillow.com/homes/', '')
      .replace('_rb/', '')
      .replace(/[^a-zA-Z0-9-]/g, '-')
    return `${CACHE_PREFIX}${urlHash}`
  }

  /**
   * Get cached Zillow data if available
   */
  private async getFromCache(zillowUrl: string): Promise<ZillowExtraction | null> {
    if (!this.cache) return null

    try {
      const cacheKey = this.getCacheKey(zillowUrl)
      const cached = await this.cache.get<CachedZillowData>(cacheKey, 'json')

      if (cached && isValidExtraction(cached.extraction)) {
        console.log(`[FirecrawlZillow] Cache hit for: ${zillowUrl}`)
        console.log(`[FirecrawlZillow] Cached data:`, JSON.stringify({
          photosCount: cached.extraction?.photos?.length ?? 0,
          hasDescription: !!cached.extraction?.description,
          price: cached.extraction?.price,
          status: cached.extraction?.status,
          cachedAt: cached.cachedAt,
        }))
        return cached.extraction
      }
    } catch (error) {
      console.warn('[FirecrawlZillow] Cache read error:', error)
    }

    return null
  }

  /**
   * Store Zillow data in cache
   */
  private async saveToCache(zillowUrl: string, extraction: ZillowExtraction): Promise<void> {
    if (!this.cache) return

    try {
      const cacheKey = this.getCacheKey(zillowUrl)
      const cacheData: CachedZillowData = {
        extraction,
        cachedAt: new Date().toISOString(),
        zillowUrl,
      }

      await this.cache.put(cacheKey, JSON.stringify(cacheData), {
        expirationTtl: this.cacheTtl,
      })

      console.log(`[FirecrawlZillow] Cached response for: ${zillowUrl}`)
    } catch (error) {
      console.warn('[FirecrawlZillow] Cache write error:', error)
    }
  }

  /**
   * Fetch content from Zillow using Firecrawl
   * Returns both HTML and markdown for LLM processing
   */
  /**
   * Extract a homedetails URL from Zillow search results page content.
   * When the /homes/..._rb/ URL lands on search results instead of a property page,
   * we can find the actual property URL in the HTML.
   */
  private extractHomedetailsUrl(html: string, markdown: string): string | null {
    // Look for homedetails URLs in the content
    // Format: /homedetails/[address]/[zpid]_zpid/
    const patterns = [
      /https:\/\/www\.zillow\.com\/homedetails\/[^"'\s<>]+_zpid\//gi,
      /\/homedetails\/[^"'\s<>]+_zpid\//gi,
    ]

    for (const pattern of patterns) {
      const content = html + markdown
      const matches = content.match(pattern)
      if (matches && matches.length > 0) {
        // Take the first homedetails URL found (usually the most relevant)
        let url = matches[0]
        if (url.startsWith('/')) {
          url = `https://www.zillow.com${url}`
        }
        return url
      }
    }

    return null
  }

  /**
   * Detect if the content is a PerimeterX captcha/blocked page rather than real content.
   */
  private isBlockedPage(html: string, markdown: string): boolean {
    const combined = html + markdown
    return (
      combined.includes('px-captcha') ||
      combined.includes('PerimeterX') ||
      combined.includes('Press & Hold') ||
      combined.includes('Access to this page has been denied') ||
      (html.length < 5000 && html.includes('_pxAppId'))
    )
  }

  private async fetchWithFirecrawl(url: string, depth = 0, options?: { skipJsonExtraction?: boolean }): Promise<{ html: string; markdown: string; json?: Record<string, unknown> }> {
    this.firecrawlCallCount++

    // Use Firecrawl v2 — JSON extraction for structured data (subject property),
    // HTML-only for comps (faster, we only need photos + description for classification).
    const useJsonExtraction = !options?.skipJsonExtraction
    const formats: unknown[] = ['html']
    if (useJsonExtraction) {
      formats.push({
        type: 'json',
        schema: FIRECRAWL_JSON_SCHEMA,
        prompt: FIRECRAWL_JSON_PROMPT,
      })
    }

    const response = await fetch('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        url,
        formats,
        onlyMainContent: false,
        waitFor: 3000,
        timeout: 30000,
        proxy: 'stealth',
        actions: [
          { type: 'wait', milliseconds: 2000 },
        ],
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Firecrawl API failed: ${response.status} ${errorText}`)
    }

    const data = (await response.json()) as FirecrawlResponse

    if (!data.success) {
      throw new Error(`Firecrawl error: ${data.error || 'Unknown error'}`)
    }

    if (!data.data?.html && !data.data?.json) {
      throw new Error('No content returned from Firecrawl')
    }

    const html = data.data.html || ''
    const markdown = data.data.markdown || ''
    const json = data.data.json
    const finalUrl = data.data.url || data.data.metadata?.url || data.data.metadata?.sourceURL

    console.log(`[FirecrawlZillow] Fetched ${url} → html: ${html.length} chars, json: ${json ? 'yes' : 'no'}, finalUrl: ${finalUrl || 'unknown'}`)

    // Check if we got blocked by PerimeterX despite stealth proxy
    if (this.isBlockedPage(html, markdown)) {
      console.warn(`[FirecrawlZillow] Blocked by anti-bot for: ${url} (even with stealth proxy)`)
      return { html, markdown, json }
    }

    // Detect redirect with empty/small content — re-fetch the final URL directly.
    const contentTooSmall = html.length < 5000 && !json
    const wasRedirected = finalUrl && finalUrl !== url && /\/homedetails\//.test(finalUrl)

    if (contentTooSmall && wasRedirected && depth < 1) {
      const properFullUrl = this.buildFullHomedetailsUrl(finalUrl, url)
      console.log(`[FirecrawlZillow] Redirect produced empty content (${html.length} chars). Re-fetching: ${properFullUrl}`)
      return this.fetchWithFirecrawl(properFullUrl, depth + 1, options)
    }

    // If content is still too small and no photos and no JSON, try extracting a property URL
    const hasPropertyPhotos = /photos\.zillowstatic\.com\/fp\//.test(html)
    if (contentTooSmall && !hasPropertyPhotos && depth < 1) {
      const propertyUrl = this.extractHomedetailsUrl(html, markdown)
      if (propertyUrl) {
        console.log(`[FirecrawlZillow] Found property URL in sparse content: ${propertyUrl}, re-fetching...`)
        return this.fetchWithFirecrawl(propertyUrl, depth + 1, options)
      }
      console.warn(`[FirecrawlZillow] Very little content returned and no property photos for: ${url}`)
    }

    return { html, markdown, json }
  }

  /**
   * Build a full homedetails URL with address slug from a zpid-only URL.
   * Zillow prefers URLs like /homedetails/Address-City-ST-Zip/12345_zpid/
   * over bare /homedetails/12345_zpid/ which may trigger bot detection.
   */
  private buildFullHomedetailsUrl(zpidUrl: string, originalUrl: string): string {
    // Extract zpid from the URL
    const zpidMatch = zpidUrl.match(/\/(\d+_zpid)\/?/)
    if (!zpidMatch) return zpidUrl

    const zpid = zpidMatch[1]

    // Try to build address slug from the original /homes/ URL
    const homesMatch = originalUrl.match(/\/homes\/([^_]+)_rb/)
    if (homesMatch) {
      const addressSlug = homesMatch[1]
        .split('-')
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join('-')
      return `https://www.zillow.com/homedetails/${addressSlug}/${zpid}/`
    }

    return zpidUrl
  }

  /**
   * Parse structured data from Firecrawl v2 JSON extraction result.
   * Photos are extracted from HTML via regex since URL extraction is more reliable that way.
   */
  private parseJsonExtraction(content: { html: string; json: Record<string, unknown> }): ZillowExtraction {
    const j = content.json
    // Extract photos from HTML (more reliable than JSON for photo URLs)
    const htmlPhotos = parseZillowHtml(content.html)

    const agent = j.agent as { name?: string; phone?: string; brokerage?: string } | undefined
    console.log(`[FirecrawlZillow] JSON extracted: price: ${j.price}, status: ${j.status}, beds: ${j.bedrooms}, baths: ${j.bathrooms}, sqft: ${j.squareFeet}, type: ${j.propertyType}, foundation: ${j.foundationType}, hoa: ${j.hoaFee}, tax: ${j.taxAmount}, agent: ${agent?.name ?? 'n/a'}, whatsSpecial: ${(j.whatsSpecial as string[] | undefined)?.length ?? 0}`)

    return {
      photos: htmlPhotos.photos,
      description: j.description as string | undefined,
      price: j.price as number | undefined,
      pricePerSqft: j.pricePerSqft as number | undefined,
      status: j.status as ZillowExtraction['status'],
      features: j.features as string[] | undefined,
      daysOnMarket: j.daysOnMarket as number | undefined,
      listDate: j.listDate as string | undefined,
      bedrooms: j.bedrooms as number | undefined,
      bathrooms: j.bathrooms as number | undefined,
      squareFeet: j.squareFeet as number | undefined,
      lotSize: j.lotSize as string | undefined,
      lotSizeAcres: j.lotSizeAcres as number | undefined,
      yearBuilt: j.yearBuilt as number | undefined,
      propertyType: j.propertyType as string | undefined,
      style: j.style as string | undefined,
      stories: j.stories as number | undefined,
      foundationType: j.foundationType as string | undefined,
      roof: j.roof as string | undefined,
      construction: j.construction as string | undefined,
      heating: j.heating as string | undefined,
      cooling: j.cooling as string | undefined,
      parking: j.parking as string | undefined,
      garageSpaces: j.garageSpaces as number | undefined,
      hoaFee: j.hoaFee as number | undefined,
      taxAmount: j.taxAmount as number | undefined,
      estimatedMonthlyPayment: j.estimatedMonthlyPayment as number | undefined,
      appliances: j.appliances as string[] | undefined,
      flooring: j.flooring as string[] | undefined,
      exteriorFeatures: j.exteriorFeatures as string[] | undefined,
      pool: j.pool as boolean | undefined,
      waterfront: j.waterfront as boolean | undefined,
      view: j.view as string | undefined,
      priceHistory: j.priceHistory as ZillowExtraction['priceHistory'],
      neighborhood: j.neighborhood as string | undefined,
      walkScore: j.walkScore as number | undefined,
      transitScore: j.transitScore as number | undefined,
      agent,
      whatsSpecial: j.whatsSpecial as string[] | undefined,
    }
  }

  /**
   * Parse scraped content using OpenRouter LLM (fallback when JSON extraction fails)
   */
  private async parseWithLLM(content: { html: string; markdown: string }): Promise<ZillowExtraction> {
    const llm = createOpenRouterProvider({
      apiKey: this.openrouterApiKey!,
      model: this.openrouterModel,
      maxTokens: 4096,
    })

    // Use markdown for context (cleaner), but include HTML for photo URL extraction
    // Larger limits to capture Facts & Features, What's Special, Home Details sections
    const combinedContent = `
## Markdown Content:
${content.markdown.slice(0, 60000)}

## HTML (for photo URLs and structured data):
${content.html.slice(0, 80000)}
`

    try {
      console.log('[FirecrawlZillow] Parsing content with LLM...')
      this.llmCallCount++

      const result = await llm.execute({
        prompt: `${EXTRACTION_PROMPT}\n\nContent to analyze:\n${combinedContent}`,
        maxTokens: 4096,
        temperature: 0.1, // Low temperature for consistent extraction
      })

      if (!result.success || !result.data) {
        console.error('[FirecrawlZillow] LLM parsing failed:', result.error)
        return { photos: [], error: `LLM parsing failed: ${result.error?.message ?? 'Unknown error'}` }
      }

      // Parse JSON from LLM response
      const responseText = result.data.content.trim()

      // Try to extract JSON from the response (handle potential markdown code blocks)
      let jsonStr = responseText
      const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim()
      }

      const parsed = JSON.parse(jsonStr) as Record<string, unknown>

      console.log(`[FirecrawlZillow] LLM extracted: ${(parsed.photos as string[] | undefined)?.length ?? 0} photos, price: ${parsed.price}, status: ${parsed.status}, beds: ${parsed.bedrooms}, baths: ${parsed.bathrooms}, foundation: ${parsed.foundationType}, hoa: ${parsed.hoaFee}, whatsSpecial: ${(parsed.whatsSpecial as string[] | undefined)?.length ?? 0}`)

      // Map LLM response — handle both flat and nested (homeDetails) formats
      const hd = parsed.homeDetails as Record<string, unknown> | undefined
      return {
        photos: (parsed.photos as string[]) ?? [],
        description: parsed.description as string | undefined,
        price: parsed.price as number | undefined,
        pricePerSqft: parsed.pricePerSqft as number | undefined,
        status: parsed.status as ZillowExtraction['status'],
        features: parsed.features as string[] | undefined,
        daysOnMarket: parsed.daysOnMarket as number | undefined,
        listDate: parsed.listDate as string | undefined,
        bedrooms: parsed.bedrooms as number | undefined,
        bathrooms: parsed.bathrooms as number | undefined,
        squareFeet: parsed.squareFeet as number | undefined,
        lotSize: (parsed.lotSize ?? hd?.lotSize) as string | undefined,
        lotSizeAcres: parsed.lotSizeAcres as number | undefined,
        yearBuilt: parsed.yearBuilt as number | undefined,
        propertyType: parsed.propertyType as string | undefined,
        style: parsed.style as string | undefined,
        stories: (parsed.stories ?? hd?.stories) as number | undefined,
        foundationType: parsed.foundationType as string | undefined,
        roof: (parsed.roof ?? hd?.roof) as string | undefined,
        construction: (parsed.construction ?? hd?.construction) as string | undefined,
        heating: (parsed.heating ?? hd?.heating) as string | undefined,
        cooling: (parsed.cooling ?? hd?.cooling) as string | undefined,
        parking: (parsed.parking ?? hd?.parking) as string | undefined,
        garageSpaces: parsed.garageSpaces as number | undefined,
        hoaFee: parsed.hoaFee as number | undefined,
        taxAmount: parsed.taxAmount as number | undefined,
        estimatedMonthlyPayment: parsed.estimatedMonthlyPayment as number | undefined,
        appliances: (parsed.appliances ?? hd?.appliances) as string[] | undefined,
        flooring: (parsed.flooring ?? hd?.flooring) as string[] | undefined,
        exteriorFeatures: (parsed.exteriorFeatures ?? hd?.exteriorFeatures) as string[] | undefined,
        pool: (parsed.pool ?? hd?.pool) as boolean | undefined,
        waterfront: (parsed.waterfront ?? hd?.waterfront) as boolean | undefined,
        view: (parsed.view ?? hd?.view) as string | undefined,
        priceHistory: parsed.priceHistory as ZillowExtraction['priceHistory'],
        neighborhood: parsed.neighborhood as string | undefined,
        walkScore: parsed.walkScore as number | undefined,
        transitScore: parsed.transitScore as number | undefined,
        agent: parsed.agent as ZillowExtraction['agent'],
        whatsSpecial: parsed.whatsSpecial as string[] | undefined,
      }
    } catch (error) {
      console.error('[FirecrawlZillow] LLM parsing error:', error)

      // Fallback to regex parsing if LLM fails
      console.log('[FirecrawlZillow] Falling back to regex parsing...')
      return parseZillowHtml(content.html)
    }
  }

  /**
   * Check if a URL is likely a property photo (not agent/logo/icon/person)
   */
  private isPropertyPhoto(url: string): boolean {
    const lowerUrl = url.toLowerCase()

    // Exclude patterns that indicate non-property images (especially human/agent photos)
    const excludePatterns = [
      // Agent/person related
      'avatar',
      'profile',
      'agent',
      'broker',
      'realtor',
      'team',
      'staff',
      'headshot',
      'portrait',
      'person',
      'people',
      'user',
      'member',
      // Branding/UI
      'logo',
      'icon',
      'badge',
      'button',
      'social',
      'z-logo',
      'zillow-logo',
      'trulia',
      'hotpads',
      // Maps/diagrams
      'map',
      'streetview',
      'street-view',
      'satellite',
      'floorplan',
      'floor-plan',
      'blueprint',
      // Placeholders
      'placeholder',
      'coming-soon',
      'comingsoon',
      'default',
      'no-image',
      'noimage',
      // Small images (often profile pics) — dimension indicators
      'thumb',
      'thumbnail',
      '50x50',
      '64x64',
      '80x80',
      '100x100',
      '120x120',
      '150x150',
      // Zillow headshot/profile photo paths
      '/h_n/',
      '/h_l/',
      '/h_g/',
      'profilephotos',
      'profile_photos',
    ]

    for (const pattern of excludePatterns) {
      if (lowerUrl.includes(pattern)) {
        return false
      }
    }

    // Must be from zillowstatic.com
    if (!lowerUrl.includes('zillowstatic.com')) {
      return false
    }

    // Must be from photos.zillowstatic.com (not other subdomains like profilephotos)
    if (!lowerUrl.includes('photos.zillowstatic.com')) {
      return false
    }

    // Property photos use /fp/ or /p_X/ paths
    // Agent photos use different paths like /ISr..., /mgn/...
    const isFullPhoto = lowerUrl.includes('/fp/') || /\/p_[a-z]\//.test(lowerUrl)

    // Additional check: property listing photos have a specific hash pattern
    // e.g. photos.zillowstatic.com/fp/abc123def-p_f.jpg
    // Agent photos often have different patterns like /ISr... or /mgn/
    if (!isFullPhoto) {
      // Check for common non-property paths on zillowstatic
      const nonPropertyPaths = ['/isr', '/mgn/', '/s_v/', '/static/']
      for (const np of nonPropertyPaths) {
        if (lowerUrl.includes(np)) return false
      }
    }

    return isFullPhoto
  }

  /**
   * Normalize photo URLs to high resolution and filter non-property images
   */
  private normalizePhotoUrls(photos: string[]): string[] {
    const normalized: string[] = []
    const seen = new Set<string>()

    for (const photo of photos) {
      if (!photo || typeof photo !== 'string') continue

      // Filter out non-property images
      if (!this.isPropertyPhoto(photo)) {
        continue
      }

      // Normalize to high resolution
      let highRes = photo
        .replace(/\/p_[a-z]\//, '/p_f/')
        .replace(/\?.*$/, '')

      if (!seen.has(highRes)) {
        seen.add(highRes)
        normalized.push(highRes)
      }
    }

    console.log(`[FirecrawlZillow] Filtered ${photos.length} URLs to ${normalized.length} property photos`)
    return normalized
  }

  /**
   * Fetch content and extract structured data.
   * Uses Firecrawl v2 JSON extraction first, falls back to OpenRouter LLM if needed.
   */
  private async fetchAndExtract(zillowUrl: string, options?: { skipJsonExtraction?: boolean }): Promise<ZillowExtraction> {
    const content = await this.fetchWithFirecrawl(zillowUrl, 0, options)

    // When skipJsonExtraction is true (comps), skip LLM fallback entirely.
    // Comps only need photos + basic features — regex parsing is sufficient and fast.
    if (options?.skipJsonExtraction) {
      return parseZillowHtml(content.html)
    }

    // Primary: use Firecrawl v2 JSON extraction result
    if (content.json && typeof content.json === 'object') {
      const extracted = this.parseJsonExtraction({ html: content.html, json: content.json })
      if (isValidExtraction(extracted)) {
        return extracted
      }
      console.warn(`[FirecrawlZillow] JSON extraction returned no valid photos, trying LLM fallback...`)
    } else {
      console.warn(`[FirecrawlZillow] No JSON extraction result from Firecrawl, trying LLM fallback...`)
    }

    // Fallback: use OpenRouter LLM to parse HTML/markdown
    if (this.openrouterApiKey) {
      return this.parseWithLLM(content)
    }

    // Last resort: regex-only parsing
    console.warn(`[FirecrawlZillow] No OpenRouter key available, using regex fallback`)
    return parseZillowHtml(content.html)
  }

  /**
   * Fetch Zillow listing data using Firecrawl
   */
  async fetchListing(
    property: ZillowPropertyIdentifier,
    options?: ZillowFetchOptions
  ): Promise<CompZillowResult> {
    const startTime = Date.now()
    const zillowUrl = generateZillowUrl(property)

    try {
      console.log(`[FirecrawlZillow] Fetching: ${zillowUrl}`)

      let extracted: ZillowExtraction
      let fromCache = false

      const extractOpts = options?.skipJsonExtraction ? { skipJsonExtraction: true } : undefined

      // Check cache first (unless skipCache is true)
      if (!options?.skipCache) {
        const cached = await this.getFromCache(zillowUrl)
        if (cached) {
          extracted = cached
          fromCache = true
          this.cacheHitCount++
        } else {
          extracted = await this.fetchAndExtract(zillowUrl, extractOpts)

          if (isValidExtraction(extracted)) {
            await this.saveToCache(zillowUrl, extracted)
          } else {
            console.warn(`[FirecrawlZillow] Invalid extraction, not caching: ${zillowUrl}`)
          }
        }
      } else {
        extracted = await this.fetchAndExtract(zillowUrl, extractOpts)

        if (isValidExtraction(extracted)) {
          await this.saveToCache(zillowUrl, extracted)
        }
      }

      // Normalize photo URLs
      const photos = this.normalizePhotoUrls(extracted.photos || [])

      console.log(`[FirecrawlZillow] Extracted ${photos.length} photos, price: ${extracted.price}, status: ${extracted.status}${fromCache ? ' (from cache)' : ''}`)

      // Get structured data - prefer LLM-extracted values, fallback to parsing features
      const features = extracted.features ?? []
      const bedrooms = extracted.bedrooms ?? parseBedroomsFromFeatures(features)
      const bathrooms = extracted.bathrooms ?? parseBathroomsFromFeatures(features)
      const squareFeet = extracted.squareFeet ?? parseSqftFromFeatures(features)
      const yearBuilt = extracted.yearBuilt
      const foundationType = extracted.foundationType
      const hoaFee = extracted.hoaFee

      // Get last sale from price history
      const { lastSaleDate, lastSalePrice } = getLastSaleFromHistory(extracted.priceHistory)

      console.log(`[FirecrawlZillow] Structured data: beds=${bedrooms}, baths=${bathrooms}, sqft=${squareFeet}, year=${yearBuilt}, foundation=${foundationType}, hoa=${hoaFee}, lastSale=${lastSaleDate}`)

      const listing: ZillowListingData = {
        zillowUrl,
        photos,
        description: extracted.description,
        price: extracted.price,
        status: extracted.status,
        daysOnMarket: extracted.daysOnMarket,
        features: extracted.features,
        priceHistory: extracted.priceHistory,
        // Structured fields
        bedrooms,
        bathrooms,
        squareFeet,
        yearBuilt,
        foundationType,
        hoaFee,
        lastSaleDate,
        lastSalePrice,
        // Additional structured fields
        pricePerSqft: extracted.pricePerSqft,
        listDate: extracted.listDate,
        lotSize: extracted.lotSize,
        lotSizeAcres: extracted.lotSizeAcres,
        propertyType: extracted.propertyType,
        style: extracted.style,
        stories: extracted.stories,
        roof: extracted.roof,
        construction: extracted.construction,
        heating: extracted.heating,
        cooling: extracted.cooling,
        parking: extracted.parking,
        garageSpaces: extracted.garageSpaces,
        taxAmount: extracted.taxAmount,
        estimatedMonthlyPayment: extracted.estimatedMonthlyPayment,
        appliances: extracted.appliances,
        flooring: extracted.flooring,
        exteriorFeatures: extracted.exteriorFeatures,
        pool: extracted.pool,
        waterfront: extracted.waterfront,
        view: extracted.view,
        neighborhood: extracted.neighborhood,
        walkScore: extracted.walkScore,
        transitScore: extracted.transitScore,
        agent: extracted.agent,
        whatsSpecial: extracted.whatsSpecial,
      }

      return {
        compId: property.propertyId,
        listing,
        fromCache,
        timing: {
          startTime,
          endTime: Date.now(),
          durationMs: Date.now() - startTime,
        },
      }
    } catch (error) {
      console.error('[FirecrawlZillow] Error:', error)
      return {
        compId: property.propertyId,
        error: error instanceof Error ? error.message : 'Unknown error',
        timing: {
          startTime,
          endTime: Date.now(),
          durationMs: Date.now() - startTime,
        },
      }
    }
  }

  /**
   * Compare comp property to subject property using photos
   * Note: Firecrawl doesn't support photo comparison - use vision service instead
   */
  async compareToSubject(
    comp: ZillowPropertyIdentifier,
    _compPhotos: string[],
    _subjectPhotos: string[],
    _subjectId: string
  ): Promise<CompZillowResult> {
    const startTime = Date.now()

    // Firecrawl is for scraping only, not comparison
    return {
      compId: comp.propertyId,
      comparisonToSubject: {
        comparison: 'similar',
        confidence: 50,
        qualityAdjustment: 0,
        reasoning: 'Photo comparison requires vision analysis service',
      },
      timing: {
        startTime,
        endTime: Date.now(),
        durationMs: Date.now() - startTime,
      },
    }
  }
}

// ─── Factory Function ────────────────────────────────────────────────────────

export function createFirecrawlZillowFetcher(
  config: FirecrawlZillowFetcherConfig
): FirecrawlZillowFetcher {
  return new FirecrawlZillowFetcher(config)
}
