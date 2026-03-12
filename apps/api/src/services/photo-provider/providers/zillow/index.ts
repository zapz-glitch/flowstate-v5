/**
 * Zillow Photo Provider
 *
 * Implements PhotoProvider interface using Zillow as the photo source.
 *
 * Provider priority:
 * 1. Firecrawl (FIRECRAWL_API_KEY) - Primary provider, scrapes HTML
 * 2. Gemini URL Context (GEMINI_API_KEY) - Fallback (currently blocked by Zillow)
 */

import type { Env } from '../../../../types'
import type {
  PhotoProvider,
  PropertyIdentifier,
  PropertyPhotos,
  PhotoFetchOptions,
  PhotoFetchResult,
  BulkPhotoFetchResult,
  PhotoFetchError,
} from '../../types'
import {
  GeminiZillowFetcher,
  createGeminiZillowFetcher,
  generateZillowUrl as generateZillowUrlFromGemini,
} from './gemini-fetcher'
import {
  FirecrawlZillowFetcher,
  createFirecrawlZillowFetcher,
  generateZillowUrl as generateZillowUrlFromFirecrawl,
} from './firecrawl-fetcher'
import type { ZillowPropertyIdentifier } from './types'

// Re-export types and utilities
export * from './types'
export { GeminiZillowFetcher, createGeminiZillowFetcher } from './gemini-fetcher'
export { FirecrawlZillowFetcher, createFirecrawlZillowFetcher } from './firecrawl-fetcher'

// Re-export generateZillowUrl (use Firecrawl version as primary)
export { generateZillowUrlFromFirecrawl as generateZillowUrl }

// Type alias for the fetcher (supports both)
export type ZillowFetcher = FirecrawlZillowFetcher | GeminiZillowFetcher

/**
 * Check if Zillow fetching is available (for Workers)
 * Requires both Firecrawl (scraping) and OpenRouter (LLM parsing)
 */
export function isZillowFetcherAvailable(env: Env): boolean {
  // Firecrawl + OpenRouter is the primary provider
  if (env.FIRECRAWL_API_KEY && env.OPENROUTER_API_KEY) return true
  // Gemini is disabled - Zillow blocks URL context requests
  // if (env.GEMINI_API_KEY) return true
  return false
}

/**
 * Create a Zillow fetcher from environment (for Workers)
 * Uses Firecrawl for scraping + OpenRouter LLM for parsing
 */
export function createZillowFetcher(env: Env): ZillowFetcher | null {
  // Firecrawl + OpenRouter (scrapes HTML, LLM parses it)
  if (env.FIRECRAWL_API_KEY && env.OPENROUTER_API_KEY) {
    return createFirecrawlZillowFetcher({
      apiKey: env.FIRECRAWL_API_KEY,
      openrouterApiKey: env.OPENROUTER_API_KEY,
      openrouterModel: env.OPENROUTER_MODEL,
      cache: env.API_CACHE,
      cacheTtl: 24 * 60 * 60,
    })
  }

  // Fallback to Gemini (currently blocked by Zillow)
  // if (env.GEMINI_API_KEY) {
  //   return createGeminiZillowFetcher({
  //     apiKey: env.GEMINI_API_KEY,
  //     model: 'gemini-3-flash-preview',
  //     cache: env.API_CACHE,
  //     cacheTtl: 24 * 60 * 60,
  //   })
  // }

  return null
}

// Alias for backwards compatibility
export const createZillowFetcherFromEnv = createZillowFetcher

/**
 * Get the provider name being used
 */
export function getZillowFetcherProvider(env: Env): string | null {
  if (env.FIRECRAWL_API_KEY && env.OPENROUTER_API_KEY) return 'firecrawl+openrouter'
  // if (env.GEMINI_API_KEY) return 'gemini-url-context'
  return null
}

// ─── Photo Provider Implementation ──────────────────────────────────────────

export class ZillowPhotoProvider implements PhotoProvider {
  readonly name = 'zillow'
  private env: Env
  private fetcher: ZillowFetcher | null = null

  constructor(env: Env) {
    this.env = env
  }

  isAvailable(): boolean {
    return isZillowFetcherAvailable(this.env)
  }

  private getFetcher(): ZillowFetcher | null {
    if (!this.fetcher && this.isAvailable()) {
      this.fetcher = createZillowFetcher(this.env)
    }
    return this.fetcher
  }

  private toZillowIdentifier(property: PropertyIdentifier): ZillowPropertyIdentifier {
    return {
      propertyId: property.propertyId,
      address: property.address,
      city: property.city,
      state: property.state,
      zipCode: property.zipCode,
    }
  }

  async fetchPhotos(
    property: PropertyIdentifier,
    options?: PhotoFetchOptions
  ): Promise<PhotoFetchResult> {
    const fetcher = this.getFetcher()
    if (!fetcher) {
      return {
        success: false,
        propertyId: property.propertyId,
        error: 'Zillow fetcher not available - FIRECRAWL_API_KEY required',
        code: 'PROVIDER_UNAVAILABLE',
      }
    }

    try {
      const result = await fetcher.fetchListing(this.toZillowIdentifier(property), {
        skipCache: options?.skipCache,
      })

      if (!result.listing) {
        return {
          success: false,
          propertyId: property.propertyId,
          error: result.error || 'No listing found',
          code: 'NOT_FOUND',
        }
      }

      const listing = result.listing
      const maxPhotos = options?.maxPhotos ?? 20

      const photos: PropertyPhotos = {
        propertyId: property.propertyId,
        photos: listing.photos.slice(0, maxPhotos),
        source: 'zillow',
        sourceUrl: listing.zillowUrl,
        description: options?.includeDescription !== false ? listing.description : undefined,
        status: listing.status as PropertyPhotos['status'],
        daysOnMarket: listing.daysOnMarket,
        features: listing.features,
        priceHistory: options?.includePriceHistory !== false ? listing.priceHistory : undefined,
        fetchedAt: new Date().toISOString(),
        // Structured property data from Zillow listing
        bedrooms: listing.bedrooms,
        bathrooms: listing.bathrooms,
        squareFeet: listing.squareFeet,
        yearBuilt: listing.yearBuilt,
        foundationType: listing.foundationType,
        hoaFee: listing.hoaFee,
        lastSaleDate: listing.lastSaleDate,
        lastSalePrice: listing.lastSalePrice,
      }

      return {
        success: true,
        data: photos,
      }
    } catch (error) {
      return {
        success: false,
        propertyId: property.propertyId,
        error: error instanceof Error ? error.message : 'Failed to fetch photos',
        code: 'FETCH_ERROR',
      }
    }
  }

  async fetchBulkPhotos(
    properties: PropertyIdentifier[],
    options?: PhotoFetchOptions
  ): Promise<BulkPhotoFetchResult> {
    const results = new Map<string, PropertyPhotos>()
    const errors: PhotoFetchError[] = []

    // Fetch all in parallel (with concurrency limit for rate limiting)
    const CONCURRENCY = 3
    for (let i = 0; i < properties.length; i += CONCURRENCY) {
      const batch = properties.slice(i, i + CONCURRENCY)
      const batchPromises = batch.map(async (property) => {
        const result = await this.fetchPhotos(property, options)
        if (result.success) {
          results.set(property.propertyId, result.data)
        } else {
          errors.push(result)
        }
      })
      await Promise.all(batchPromises)
    }

    // Calculate total photos
    let totalPhotos = 0
    for (const photos of results.values()) {
      totalPhotos += photos.photos.length
    }

    return {
      results,
      errors,
      summary: {
        total: properties.length,
        successful: results.size,
        failed: errors.length,
        totalPhotos,
      },
    }
  }

  getCallStats(): { firecrawlCalls: number; llmCalls: number; cacheHits: number } {
    const fetcher = this.getFetcher()
    if (fetcher && fetcher instanceof FirecrawlZillowFetcher) {
      return {
        firecrawlCalls: fetcher.firecrawlCallCount,
        llmCalls: fetcher.llmCallCount,
        cacheHits: fetcher.cacheHitCount,
      }
    }
    return { firecrawlCalls: 0, llmCalls: 0, cacheHits: 0 }
  }
}

/**
 * Create a Zillow photo provider
 */
export function createZillowPhotoProvider(env: Env): PhotoProvider {
  return new ZillowPhotoProvider(env)
}
