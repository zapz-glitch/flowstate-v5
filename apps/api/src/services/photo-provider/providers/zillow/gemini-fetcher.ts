/**
 * Gemini URL Context - Zillow Fetcher
 *
 * Uses Gemini's URL context tool via Google AI API to extract
 * structured data from Zillow listings. The url_context tool allows
 * Gemini to fetch and understand web pages directly.
 *
 * Features:
 * - KV caching for URL context responses (24 hour TTL)
 * - Automatic cache invalidation
 * - Response normalization and photo URL optimization
 *
 * Requires GEMINI_API_KEY (Google AI API key, not OpenRouter)
 *
 * @see https://ai.google.dev/gemini-api/docs/url-context
 */

import type {
  ZillowPropertyIdentifier,
  ZillowListingData,
  CompZillowResult,
  ZillowFetchOptions,
} from './types'
import { PROMPTS } from '../../../../prompts'

// ─── Cache Configuration ────────────────────────────────────────────────────

/** Cache key prefix for Zillow URL context responses */
const CACHE_PREFIX = 'zillow-ctx:'

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
  parking?: string
  garageSpaces?: number
  // Financial
  hoaFee?: number
  taxAmount?: number
  estimatedMonthlyPayment?: number
  // Features
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
  agent?: { name?: string; phone?: string; brokerage?: string }
  // Other
  whatsSpecial?: string[]
  /** Error message if extraction failed */
  error?: string
}

/**
 * Check if an extraction is valid and worth caching
 * A valid extraction should have photos OR meaningful property data
 */
function isValidExtraction(extraction: ZillowExtraction): boolean {
  // If there's an error field, it's not valid
  if (extraction.error) {
    return false
  }

  // Must have at least one photo
  if (!extraction.photos || extraction.photos.length === 0) {
    return false
  }

  // Check if photos are actual Zillow URLs (not placeholder or error images)
  const validPhotos = extraction.photos.filter(
    (p) => p && typeof p === 'string' && p.includes('zillowstatic.com')
  )
  if (validPhotos.length === 0) {
    return false
  }

  return true
}

interface GeminiResponse {
  candidates?: Array<{
    content: {
      parts: Array<{
        text?: string
      }>
    }
  }>
  error?: {
    message: string
    code: number
  }
}

// ─── Extraction Prompt (from centralized prompts) ────────────────────────────

// Use centralized prompt for Gemini Zillow extraction
const EXTRACTION_PROMPT = PROMPTS.GEMINI_ZILLOW_EXTRACTION

// ─── Gemini URL Context Zillow Fetcher Class ─────────────────────────────────

export interface GeminiZillowFetcherConfig {
  apiKey: string
  model?: string
  /** Optional KV namespace for caching URL context responses */
  cache?: KVNamespace
  /** Cache TTL in seconds (default: 24 hours) */
  cacheTtl?: number
}

export class GeminiZillowFetcher {
  private apiKey: string
  private model: string
  private cache?: KVNamespace
  private cacheTtl: number

  constructor(config: GeminiZillowFetcherConfig) {
    this.apiKey = config.apiKey
    // Use Gemini 3 Flash Preview which supports URL context tool
    this.model = config.model || 'gemini-3-flash-preview'
    this.cache = config.cache
    this.cacheTtl = config.cacheTtl ?? DEFAULT_CACHE_TTL
  }

  /**
   * Generate cache key from Zillow URL
   */
  private getCacheKey(zillowUrl: string): string {
    // Create a simple hash of the URL for the cache key
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

      if (cached) {
        console.log(`[GeminiZillow] Cache hit for: ${zillowUrl}`)
        console.log(`[GeminiZillow] Cached data:`, JSON.stringify({
          photosCount: cached.extraction?.photos?.length ?? 0,
          hasDescription: !!cached.extraction?.description,
          price: cached.extraction?.price,
          status: cached.extraction?.status,
          error: cached.extraction?.error,
          cachedAt: cached.cachedAt,
          firstPhoto: cached.extraction?.photos?.[0]?.substring(0, 80),
        }))
        return cached.extraction
      }
    } catch (error) {
      console.warn('[GeminiZillow] Cache read error:', error)
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

      console.log(`[GeminiZillow] Cached response for: ${zillowUrl}`)
    } catch (error) {
      console.warn('[GeminiZillow] Cache write error:', error)
    }
  }

  /**
   * Fetch and extract data from a Zillow URL using Gemini's URL context tool
   * Uses the Google AI API directly with url_context tool enabled
   */
  private async extractFromUrl(url: string): Promise<ZillowExtraction> {
    // Google AI API endpoint
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`

    const requestBody = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `${EXTRACTION_PROMPT}\n\nExtract property listing data from this Zillow page: ${url}`,
            },
          ],
        },
      ],
      // Enable URL context tool - this allows Gemini to fetch the URL
      tools: [
        {
          url_context: {},
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4096,
      },
    }

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Google AI API failed: ${response.status} ${errorText}`)
    }

    const data = (await response.json()) as GeminiResponse

    if (data.error) {
      throw new Error(`Gemini API error: ${data.error.message}`)
    }

    const content = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!content) {
      throw new Error('No response content from Gemini')
    }

    // Parse the JSON response
    try {
      // Extract JSON from potential markdown code blocks
      let jsonStr = content.trim()
      if (jsonStr.startsWith('```')) {
        jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
      }

      const extracted = JSON.parse(jsonStr) as ZillowExtraction & { error?: string }

      if (extracted.error) {
        console.warn(`[GeminiZillow] Extraction warning: ${extracted.error}`)
      }

      return extracted
    } catch (parseError) {
      console.error('[GeminiZillow] Failed to parse response:', content.substring(0, 500))
      throw new Error(`Failed to parse Gemini response as JSON: ${parseError}`)
    }
  }

  /**
   * Normalize photo URLs to high resolution
   */
  private normalizePhotoUrls(photos: string[]): string[] {
    const normalized: string[] = []
    const seen = new Set<string>()

    for (const photo of photos) {
      // Skip non-Zillow URLs and logos
      if (!photo || typeof photo !== 'string') continue
      if (!photo.includes('zillowstatic.com') || photo.includes('z-logo')) {
        continue
      }

      // Convert to high-res version
      let highRes = photo
        .replace(/\/p_[a-z]\//, '/p_f/')
        .replace(/\?.*$/, '') // Remove query params

      // Dedupe
      if (!seen.has(highRes)) {
        seen.add(highRes)
        normalized.push(highRes)
      }
    }

    return normalized
  }

  /**
   * Fetch Zillow listing data using Gemini URL context
   *
   * @param property - Property identifier with address info
   * @param options - Fetch options (includes skipCache to bypass cache)
   */
  async fetchListing(
    property: ZillowPropertyIdentifier,
    options?: ZillowFetchOptions
  ): Promise<CompZillowResult> {
    const startTime = Date.now()
    const zillowUrl = generateZillowUrl(property)

    try {
      console.log(`[GeminiZillow] Fetching: ${zillowUrl}`)

      let extracted: ZillowExtraction
      let fromCache = false

      // Check cache first (unless skipCache is true)
      if (!options?.skipCache) {
        const cached = await this.getFromCache(zillowUrl)
        if (cached && isValidExtraction(cached)) {
          extracted = cached
          fromCache = true
        } else {
          // Extract data using Gemini's URL context tool
          extracted = await this.extractFromUrl(zillowUrl)
          // Only cache if extraction is valid (has real Zillow photos)
          if (isValidExtraction(extracted)) {
            await this.saveToCache(zillowUrl, extracted)
          } else {
            console.warn(`[GeminiZillow] Invalid extraction, not caching: ${zillowUrl}`)
          }
        }
      } else {
        // Skip cache, fetch fresh
        extracted = await this.extractFromUrl(zillowUrl)
        // Only cache if extraction is valid (has real Zillow photos)
        if (isValidExtraction(extracted)) {
          await this.saveToCache(zillowUrl, extracted)
        } else {
          console.warn(`[GeminiZillow] Invalid extraction, not caching: ${zillowUrl}`)
        }
      }

      // Normalize photo URLs
      const photos = this.normalizePhotoUrls(extracted.photos || [])

      console.log(`[GeminiZillow] Extracted ${photos.length} photos, price: ${extracted.price}, status: ${extracted.status}${fromCache ? ' (from cache)' : ''}`)

      const listing: ZillowListingData = {
        zillowUrl,
        photos,
        description: extracted.description,
        price: extracted.price,
        pricePerSqft: extracted.pricePerSqft,
        status: extracted.status,
        daysOnMarket: extracted.daysOnMarket,
        listDate: extracted.listDate,
        features: extracted.features,
        priceHistory: extracted.priceHistory,
        // Property details
        bedrooms: extracted.bedrooms,
        bathrooms: extracted.bathrooms,
        squareFeet: extracted.squareFeet,
        lotSize: extracted.lotSize,
        lotSizeAcres: extracted.lotSizeAcres,
        yearBuilt: extracted.yearBuilt,
        propertyType: extracted.propertyType,
        style: extracted.style,
        stories: extracted.stories,
        // Construction & systems
        foundationType: extracted.foundationType,
        roof: extracted.roof,
        construction: extracted.construction,
        heating: extracted.heating,
        cooling: extracted.cooling,
        parking: extracted.parking,
        garageSpaces: extracted.garageSpaces,
        // Financial
        hoaFee: extracted.hoaFee,
        taxAmount: extracted.taxAmount,
        estimatedMonthlyPayment: extracted.estimatedMonthlyPayment,
        // Features
        appliances: extracted.appliances,
        flooring: extracted.flooring,
        exteriorFeatures: extracted.exteriorFeatures,
        pool: extracted.pool,
        waterfront: extracted.waterfront,
        view: extracted.view,
        // Location
        neighborhood: extracted.neighborhood,
        walkScore: extracted.walkScore,
        transitScore: extracted.transitScore,
        // Agent & other
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
      console.error('[GeminiZillow] Error:', error)
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
   */
  async compareToSubject(
    comp: ZillowPropertyIdentifier,
    compPhotos: string[],
    subjectPhotos: string[],
    _subjectId: string
  ): Promise<CompZillowResult> {
    const startTime = Date.now()

    if (compPhotos.length === 0 || subjectPhotos.length === 0) {
      return {
        compId: comp.propertyId,
        error: 'Need photos from both comp and subject to compare',
      }
    }

    // TODO: Implement photo comparison using Gemini vision
    return {
      compId: comp.propertyId,
      comparisonToSubject: {
        comparison: 'similar',
        confidence: 50,
        qualityAdjustment: 0,
        reasoning: 'Photo comparison requires additional vision analysis implementation',
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

export function createGeminiZillowFetcher(
  config: GeminiZillowFetcherConfig
): GeminiZillowFetcher {
  return new GeminiZillowFetcher(config)
}
