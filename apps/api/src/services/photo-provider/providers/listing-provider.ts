/**
 * Listing-site Photo Provider
 *
 * Implements PhotoProvider for listing sites scraped via Firecrawl
 * (Redfin, Realtor.com). Each provider resolves the subject's public
 * listing URL, scrapes it, and extracts property photos from the site's CDN.
 */

import type { Env } from '../../../types'
import type {
  PhotoProvider,
  PropertyIdentifier,
  PropertyPhotos,
  PhotoFetchOptions,
  PhotoFetchResult,
  BulkPhotoFetchResult,
} from '../types'
import {
  ListingPhotoScraper,
  type ListingSiteAdapter,
  LISTING_ADAPTERS,
} from './listing-scraper'

export class ListingPhotoProvider implements PhotoProvider {
  readonly name: string
  private scraper: ListingPhotoScraper | null = null
  private adapter: ListingSiteAdapter
  private env: Env

  constructor(env: Env, adapter: ListingSiteAdapter) {
    this.env = env
    this.adapter = adapter
    this.name = adapter.name
  }

  isAvailable(): boolean {
    return Boolean(this.env.FIRECRAWL_API_KEY)
  }

  private getScraper(): ListingPhotoScraper | null {
    if (!this.isAvailable()) return null
    if (!this.scraper) {
      this.scraper = new ListingPhotoScraper({
        apiKey: this.env.FIRECRAWL_API_KEY as string,
        openrouterApiKey: this.env.OPENROUTER_API_KEY,
        openrouterModel: this.env.OPENROUTER_MODEL,
        cache: this.env.API_CACHE,
      })
    }
    return this.scraper
  }

  async fetchPhotos(
    property: PropertyIdentifier,
    options?: PhotoFetchOptions
  ): Promise<PhotoFetchResult> {
    const scraper = this.getScraper()
    if (!scraper) {
      return {
        success: false,
        propertyId: property.propertyId,
        error: `${this.name} fetcher not available - FIRECRAWL_API_KEY required`,
        code: 'PROVIDER_UNAVAILABLE',
      }
    }

    const result = await scraper.fetchPhotos(property, this.adapter)
    if (!result) {
      return {
        success: false,
        propertyId: property.propertyId,
        error: `No photos found on ${this.name}`,
        code: 'NOT_FOUND',
      }
    }

    const photos: PropertyPhotos = {
      propertyId: property.propertyId,
      photos: result.photos.slice(0, options?.maxPhotos ?? 20),
      source: this.name,
      sourceUrl: result.sourceUrl,
      fetchedAt: new Date().toISOString(),
      metadata: result.floodRisk ? { floodRisk: result.floodRisk } : undefined,
    }
    return { success: true, data: photos }
  }

  async fetchBulkPhotos(
    properties: PropertyIdentifier[],
    options?: PhotoFetchOptions
  ): Promise<BulkPhotoFetchResult> {
    const results = new Map<string, PropertyPhotos>()
    const errors: BulkPhotoFetchResult['errors'] = []

    for (const property of properties) {
      const result = await this.fetchPhotos(property, options)
      if (result.success) {
        results.set(property.propertyId, result.data)
      } else {
        errors.push({
          success: false as const,
          propertyId: property.propertyId,
          error: result.error,
          code: result.code,
        })
      }
    }

    return {
      results,
      errors,
      summary: {
        total: properties.length,
        successful: results.size,
        failed: errors.length,
        totalPhotos: [...results.values()].reduce((n, p) => n + p.photos.length, 0),
      },
    }
  }
}

export function createListingPhotoProvider(env: Env, site: keyof typeof LISTING_ADAPTERS): PhotoProvider {
  return new ListingPhotoProvider(env, LISTING_ADAPTERS[site])
}
