/**
 * Photo Provider Service
 *
 * Modular photo fetching from any source (Zillow, MLS, Redfin, uploads, etc.)
 *
 * Usage:
 *   import { createPhotoService } from '../services/photo-provider'
 *
 *   // Create provider (auto-detects available provider)
 *   const photoService = createPhotoService(env)
 *
 *   // Or specify provider explicitly
 *   const photoService = createPhotoService(env, { provider: 'zillow' })
 *
 *   // Fetch photos for a property
 *   const result = await photoService.fetchPhotos({
 *     propertyId: '123',
 *     address: '123 Main St',
 *     city: 'Tampa',
 *     state: 'FL',
 *     zipCode: '33601'
 *   })
 *
 *   // Fetch photos for multiple properties
 *   const bulkResult = await photoService.fetchBulkPhotos([...properties])
 */

import type { Env } from '../../types'
import type {
  PhotoProvider,
  PropertyIdentifier,
  PropertyPhotos,
  PhotoFetchOptions,
  PhotoFetchResult,
  BulkPhotoFetchResult,
  PhotoBundle,
} from './types'

// Import Zillow provider
import {
  createZillowPhotoProvider,
  // Re-export Zillow-specific utilities for backwards compatibility
  generateZillowUrl,
  createZillowFetcher,
  createZillowFetcherFromEnv,
  isZillowFetcherAvailable,
  getZillowFetcherProvider,
} from './providers/zillow'

// Re-export types
export type {
  PhotoProvider,
  PropertyIdentifier,
  PropertyPhotos,
  PhotoFetchOptions,
  PhotoFetchResult,
  BulkPhotoFetchResult,
  PhotoBundle,
} from './types'

// Re-export Zillow-specific types and utilities for backwards compatibility
export {
  generateZillowUrl,
  createZillowFetcher,
  createZillowFetcherFromEnv,
  isZillowFetcherAvailable,
  getZillowFetcherProvider,
}
export type {
  ZillowListingData,
  ZillowPropertyIdentifier,
  ZillowFetchOptions,
  CompZillowResult,
  ConditionRating,
  PropertyCondition,
} from './providers/zillow'

// ─── Provider Registry ──────────────────────────────────────────────────────────

export type PhotoProviderType = 'zillow' | 'mls' | 'redfin' | 'manual'

interface PhotoProviderConfig {
  /** Preferred provider (defaults to first available) */
  provider?: PhotoProviderType
  /** Fallback providers in order of preference */
  fallbacks?: PhotoProviderType[]
}

// ─── Multi-Provider Service ─────────────────────────────────────────────────────

/**
 * Photo service that can use multiple providers with fallback
 */
export interface PhotoService {
  /** Get the active provider name */
  getProviderName(): string | null

  /** Check if any provider is available */
  isAvailable(): boolean

  /** Fetch photos for a single property */
  fetchPhotos(
    property: PropertyIdentifier,
    options?: PhotoFetchOptions
  ): Promise<PhotoFetchResult>

  /** Fetch photos for multiple properties */
  fetchBulkPhotos(
    properties: PropertyIdentifier[],
    options?: PhotoFetchOptions
  ): Promise<BulkPhotoFetchResult>

  /**
   * Fetch photos for subject and comparables as a bundle
   * Convenience method for analysis workflows
   */
  fetchPhotoBundle(
    subject: PropertyIdentifier,
    comps: PropertyIdentifier[],
    options?: PhotoFetchOptions & { maxComps?: number }
  ): Promise<PhotoBundle>

  /** Get call statistics for the current session */
  getCallStats(): { firecrawlCalls: number; llmCalls: number; cacheHits: number }
}

class MultiPhotoService implements PhotoService {
  private providers: Map<PhotoProviderType, PhotoProvider> = new Map()
  private activeProvider: PhotoProvider | null = null
  private config: PhotoProviderConfig

  constructor(env: Env, config?: PhotoProviderConfig) {
    this.config = config ?? {}

    // Initialize available providers
    const zillowProvider = createZillowPhotoProvider(env)
    if (zillowProvider.isAvailable()) {
      this.providers.set('zillow', zillowProvider)
    }

    // Add more providers here as they're implemented:
    // const mlsProvider = createMLSPhotoProvider(env)
    // if (mlsProvider.isAvailable()) {
    //   this.providers.set('mls', mlsProvider)
    // }

    // Set active provider based on config or first available
    this.selectActiveProvider()
  }

  private selectActiveProvider(): void {
    // Try configured provider first
    if (this.config.provider) {
      const preferred = this.providers.get(this.config.provider)
      if (preferred?.isAvailable()) {
        this.activeProvider = preferred
        return
      }
    }

    // Try fallbacks
    if (this.config.fallbacks) {
      for (const fallback of this.config.fallbacks) {
        const provider = this.providers.get(fallback)
        if (provider?.isAvailable()) {
          this.activeProvider = provider
          return
        }
      }
    }

    // Use first available
    for (const provider of this.providers.values()) {
      if (provider.isAvailable()) {
        this.activeProvider = provider
        return
      }
    }

    this.activeProvider = null
  }

  getProviderName(): string | null {
    return this.activeProvider?.name ?? null
  }

  isAvailable(): boolean {
    return this.activeProvider !== null && this.activeProvider.isAvailable()
  }

  async fetchPhotos(
    property: PropertyIdentifier,
    options?: PhotoFetchOptions
  ): Promise<PhotoFetchResult> {
    if (!this.activeProvider) {
      return {
        success: false,
        propertyId: property.propertyId,
        error: 'No photo provider available',
        code: 'NO_PROVIDER',
      }
    }

    return this.activeProvider.fetchPhotos(property, options)
  }

  async fetchBulkPhotos(
    properties: PropertyIdentifier[],
    options?: PhotoFetchOptions
  ): Promise<BulkPhotoFetchResult> {
    if (!this.activeProvider) {
      return {
        results: new Map(),
        errors: properties.map((p) => ({
          success: false as const,
          propertyId: p.propertyId,
          error: 'No photo provider available',
          code: 'NO_PROVIDER',
        })),
        summary: {
          total: properties.length,
          successful: 0,
          failed: properties.length,
          totalPhotos: 0,
        },
      }
    }

    return this.activeProvider.fetchBulkPhotos(properties, options)
  }

  async fetchPhotoBundle(
    subject: PropertyIdentifier,
    comps: PropertyIdentifier[],
    options?: PhotoFetchOptions & { maxComps?: number }
  ): Promise<PhotoBundle> {
    // Fetch subject with full JSON extraction (rich structured data),
    // and comps with skipJsonExtraction (HTML-only — faster, gets photos + description for classification)
    const maxComps = options?.maxComps ?? 5
    const compsToFetch = comps.slice(0, maxComps)

    // All fetches in parallel — subject gets full extraction, comps get HTML-only
    const [subjectResult, ...compResults] = await Promise.all([
      this.fetchPhotos(subject, options),
      ...compsToFetch.map((comp) =>
        this.fetchPhotos(comp, { ...options, skipJsonExtraction: true })
      ),
    ])

    const compPhotos: Record<string, PropertyPhotos> = {}
    for (let i = 0; i < compsToFetch.length; i++) {
      const result = compResults[i]
      if (result.success) {
        compPhotos[compsToFetch[i].propertyId] = result.data
      }
    }

    return {
      subject: subjectResult.success ? subjectResult.data : null,
      comps: compPhotos,
      provider: this.getProviderName() ?? 'none',
      fetchedAt: new Date().toISOString(),
    }
  }

  getCallStats(): { firecrawlCalls: number; llmCalls: number; cacheHits: number } {
    const zillow = this.providers.get('zillow')
    if (zillow && 'getCallStats' in zillow && typeof zillow.getCallStats === 'function') {
      return (zillow as { getCallStats: () => { firecrawlCalls: number; llmCalls: number; cacheHits: number } }).getCallStats()
    }
    return { firecrawlCalls: 0, llmCalls: 0, cacheHits: 0 }
  }
}

// ─── Factory Functions ──────────────────────────────────────────────────────────

/**
 * Create a photo service with automatic provider selection
 */
export function createPhotoService(env: Env, config?: PhotoProviderConfig): PhotoService {
  return new MultiPhotoService(env, config)
}

/**
 * Create a specific photo provider
 */
export function createPhotoProvider(env: Env, type: PhotoProviderType): PhotoProvider | null {
  switch (type) {
    case 'zillow':
      const provider = createZillowPhotoProvider(env)
      return provider.isAvailable() ? provider : null
    case 'mls':
    case 'redfin':
    case 'manual':
      // Not yet implemented
      return null
    default:
      return null
  }
}

/**
 * Check if any photo provider is available
 */
export function isPhotoServiceAvailable(env: Env): boolean {
  const service = createPhotoService(env)
  return service.isAvailable()
}
