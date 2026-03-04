/**
 * Firecrawl Zillow Fetcher
 *
 * Uses Firecrawl API to scrape Zillow listings, then OpenRouter LLM to extract
 * structured data (photos, description, price, status).
 *
 * Features:
 * - KV caching for scraped responses (24 hour TTL)
 * - LLM-based parsing for reliable data extraction
 * - Response normalization and photo URL optimization
 *
 * Requires FIRECRAWL_API_KEY and OPENROUTER_API_KEY
 *
 * @see https://docs.firecrawl.dev/
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
  status?: 'for_sale' | 'pending' | 'sold' | 'off_market'
  daysOnMarket?: number
  features?: string[]
  priceHistory?: Array<{
    date: string
    price: number
    event: string
  }>
  error?: string
  // Structured fields (may be extracted directly by LLM)
  bedrooms?: number
  bathrooms?: number
  squareFeet?: number
  yearBuilt?: number
  foundationType?: string
  hoaFee?: number
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
    content?: string
    metadata?: {
      title?: string
      description?: string
      ogImage?: string
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

    const seenPhotos = new Set<string>()
    for (const pattern of photoPatterns) {
      const matches = html.match(pattern) || []
      for (const match of matches) {
        // Skip logos and icons
        if (match.includes('z-logo') || match.includes('icon') || match.includes('avatar')) {
          continue
        }
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

const EXTRACTION_PROMPT = `You are a real estate data extraction assistant. Analyze the provided Zillow property listing content and extract ONLY actual property photos and listing information.

Return JSON in this exact format:
{
  "photos": ["array of PROPERTY photo URLs only"],
  "description": "property description text if available",
  "price": 123456,
  "status": "for_sale | pending | sold | off_market",
  "features": ["array of property features like '3 bed', '2 bath', '1,500 sqft'"],
  "daysOnMarket": 15,
  "bedrooms": 3,
  "bathrooms": 2,
  "squareFeet": 1500,
  "yearBuilt": 1985,
  "foundationType": "Slab",
  "hoaFee": 250,
  "priceHistory": [{"date": "2024-01-15", "price": 350000, "event": "Sold"}]
}

CRITICAL PHOTO EXTRACTION RULES - These photos will be used for property condition assessment:

1. ONLY extract photos that show the ACTUAL PROPERTY being listed:
   - Exterior shots of the house/building
   - Interior rooms (kitchen, bathroom, bedroom, living room, etc.)
   - Backyard, patio, pool, garage
   - Property features (flooring, appliances, fixtures)

2. ABSOLUTELY DO NOT INCLUDE these types of images:
   - **HUMAN PHOTOS** - Any image showing a person (agents, realtors, homeowners, etc.)
   - **HEADSHOTS/PORTRAITS** - Professional photos of people, profile pictures
   - Agent/realtor photos or team photos
   - Brokerage logos or branding images
   - Map images, satellite views, or street view images
   - Floor plan diagrams or blueprints
   - Virtual tour icons, buttons, or UI elements
   - "Coming soon" or placeholder images
   - Stock photos or marketing images with people
   - Social media icons or badges
   - Any URL containing: "avatar", "logo", "icon", "profile", "agent", "broker", "map", "streetview", "team", "staff", "headshot", "portrait"
   - Circular/rounded images (often profile photos)
   - Small images under 200x200 pixels (typically icons or thumbnails)

3. Photo URLs must contain "zillowstatic.com" or "photos.zillowstatic.com"

4. Look for photo URLs in the format: https://photos.zillowstatic.com/fp/[hash]-[size].jpg
   - The [size] suffix like "uncropped_scaled_within_1536_1152.webp" or "p_f.jpg" indicates actual property photos
   - Property photos typically have larger dimensions and landscape/rectangular aspect ratios

5. Extract the FULL URL for each valid property photo

IMPORTANT: When in doubt, EXCLUDE the photo. It is better to have fewer property photos than to include photos of people or agents.

Other extraction rules:
- For price: Extract numeric value only (no $ or commas)
- For status: Look for "for sale", "pending", "sold", or "off market"
- For features: Extract bed/bath count, square footage, lot size, year built as string array
- For bedrooms/bathrooms/squareFeet/yearBuilt: Extract as NUMBERS directly (not strings)
- For foundationType: Extract the foundation type (e.g., "Slab", "Crawl Space", "Basement", "Pier and Beam", "Block", "Piling"). Look in "Facts and Features", "Interior Details", "Building Details", or similar sections
- For hoaFee: Extract the monthly HOA fee as a NUMBER (no $ or commas). Look for "HOA fee", "HOA dues", "HOA" in listing facts. If listed as annual, divide by 12. If no HOA, use null
- For priceHistory: Extract sale/listing events with dates and prices (most important: sold events)

Return ONLY the JSON object, no explanation or markdown code blocks.
If you cannot find a field, use null. Always return valid JSON.`

// ─── Firecrawl Zillow Fetcher Class ─────────────────────────────────────────

export interface FirecrawlZillowFetcherConfig {
  /** Firecrawl API key for scraping */
  apiKey: string
  /** OpenRouter API key for LLM parsing */
  openrouterApiKey: string
  /** OpenRouter model to use (default: google/gemini-2.0-flash-001) */
  openrouterModel?: string
  /** Optional KV namespace for caching responses */
  cache?: KVNamespace
  /** Cache TTL in seconds (default: 24 hours) */
  cacheTtl?: number
}

export class FirecrawlZillowFetcher {
  private apiKey: string
  private openrouterApiKey: string
  private openrouterModel: string
  private cache?: KVNamespace
  private cacheTtl: number

  constructor(config: FirecrawlZillowFetcherConfig) {
    this.apiKey = config.apiKey
    this.openrouterApiKey = config.openrouterApiKey
    this.openrouterModel = config.openrouterModel ?? 'google/gemini-2.0-flash-001'
    this.cache = config.cache
    this.cacheTtl = config.cacheTtl ?? DEFAULT_CACHE_TTL
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
  private async fetchWithFirecrawl(url: string): Promise<{ html: string; markdown: string }> {
    const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        url,
        formats: ['html', 'markdown'],
        onlyMainContent: false,
        waitFor: 2000, // Wait for JS to load
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

    if (!data.data?.html && !data.data?.markdown) {
      throw new Error('No content returned from Firecrawl')
    }

    return {
      html: data.data.html || '',
      markdown: data.data.markdown || '',
    }
  }

  /**
   * Parse scraped content using OpenRouter LLM
   */
  private async parseWithLLM(content: { html: string; markdown: string }): Promise<ZillowExtraction> {
    const llm = createOpenRouterProvider({
      apiKey: this.openrouterApiKey,
      model: this.openrouterModel,
      maxTokens: 4096,
    })

    // Use markdown for context (cleaner), but include HTML for photo URL extraction
    const combinedContent = `
## Markdown Content:
${content.markdown.slice(0, 30000)}

## HTML (for photo URLs):
${content.html.slice(0, 50000)}
`

    try {
      console.log('[FirecrawlZillow] Parsing content with LLM...')

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

      const parsed = JSON.parse(jsonStr) as {
        photos?: string[]
        description?: string
        price?: number
        status?: string
        features?: string[]
        daysOnMarket?: number
        bedrooms?: number
        bathrooms?: number
        squareFeet?: number
        yearBuilt?: number
        foundationType?: string
        hoaFee?: number
        priceHistory?: Array<{ date: string; price: number; event: string }>
      }

      console.log(`[FirecrawlZillow] LLM extracted: ${parsed.photos?.length ?? 0} photos, price: ${parsed.price}, status: ${parsed.status}, beds: ${parsed.bedrooms}, baths: ${parsed.bathrooms}, foundation: ${parsed.foundationType}, hoa: ${parsed.hoaFee}`)

      return {
        photos: parsed.photos ?? [],
        description: parsed.description,
        price: parsed.price,
        status: parsed.status as ZillowExtraction['status'],
        features: parsed.features,
        daysOnMarket: parsed.daysOnMarket,
        bedrooms: parsed.bedrooms,
        bathrooms: parsed.bathrooms,
        squareFeet: parsed.squareFeet,
        yearBuilt: parsed.yearBuilt,
        foundationType: parsed.foundationType,
        hoaFee: parsed.hoaFee,
        priceHistory: parsed.priceHistory,
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
      // Small images (often profile pics)
      'thumb',
      'thumbnail',
      '50x50',
      '64x64',
      '80x80',
      '100x100',
      '120x120',
      '150x150',
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

    // Prefer URLs that look like property photos (fp/ path indicates full photos)
    // These typically have format: photos.zillowstatic.com/fp/[hash]-[size].jpg
    const isFullPhoto = lowerUrl.includes('/fp/') || lowerUrl.includes('/p/')

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

      // Check cache first (unless skipCache is true)
      if (!options?.skipCache) {
        const cached = await this.getFromCache(zillowUrl)
        if (cached) {
          extracted = cached
          fromCache = true
        } else {
          // Fetch content using Firecrawl
          const content = await this.fetchWithFirecrawl(zillowUrl)

          // Parse using LLM (with regex fallback)
          extracted = await this.parseWithLLM(content)

          // Only cache if valid
          if (isValidExtraction(extracted)) {
            await this.saveToCache(zillowUrl, extracted)
          } else {
            console.warn(`[FirecrawlZillow] Invalid extraction, not caching: ${zillowUrl}`)
          }
        }
      } else {
        // Skip cache, fetch fresh
        const content = await this.fetchWithFirecrawl(zillowUrl)
        extracted = await this.parseWithLLM(content)

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
