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

import { createListingPhotoProvider } from './providers/listing-provider'

// ─── Provider Registry ──────────────────────────────────────────────────────────

export type PhotoProviderType = 'zillow' | 'mls' | 'redfin' | 'realtor' | 'manual'

/** Subject-photo fallback order: Zillow → Redfin → Realtor.com → none */
const SUBJECT_FALLBACK_ORDER: PhotoProviderType[] = ['redfin', 'zillow', 'realtor']

/**
 * Comp-photo fallback order: Zillow first (richest listing data), then
 * Redfin and Realtor.com so comps without a Zillow listing still get
 * real listing photos instead of Street View.
 */
const COMP_FALLBACK_ORDER: PhotoProviderType[] = ['zillow', 'redfin', 'realtor']

/** Per-provider attempt cap for comp fetches */
const COMP_ATTEMPT_TIMEOUT_MS = 15000
/** Total budget for one comp across the whole fallback chain */
const COMP_CHAIN_BUDGET_MS = 40000

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

    // Listing-site fallbacks (Redfin, Realtor.com) — Firecrawl-based
    for (const site of ['redfin', 'realtor'] as const) {
      const provider = createListingPhotoProvider(env, site)
      if (provider.isAvailable()) {
        this.providers.set(site, provider)
      }
    }

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
    if (this.providers.size === 0) {
      return {
        success: false,
        propertyId: property.propertyId,
        error: 'No photo provider available',
        code: 'NO_PROVIDER',
      }
    }

    // Fallback chain: configured provider first (if set), then SUBJECT_FALLBACK_ORDER
    const order: PhotoProviderType[] = []
    if (this.config.provider) order.push(this.config.provider)
    for (const name of this.config.fallbacks ?? SUBJECT_FALLBACK_ORDER) {
      if (!order.includes(name)) order.push(name)
    }
    for (const name of this.providers.keys()) {
      if (!order.includes(name)) order.push(name)
    }

    const errors: string[] = []
    for (const name of order) {
      const provider = this.providers.get(name)
      if (!provider?.isAvailable()) continue

      const result = await provider.fetchPhotos(property, options)
      if (result.success && result.data.photos.length > 0) {
        if (errors.length > 0) {
          console.log(`[PhotoService] ${name} succeeded after fallbacks: ${errors.join(' → ')}`)
        }
        return result
      }
      errors.push(`${name}: ${result.success ? 'no photos' : result.error}`)
    }

    return {
      success: false,
      propertyId: property.propertyId,
      error: `All photo providers failed — ${errors.join('; ') || 'none available'}`,
      code: 'NOT_FOUND',
    }
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
    // and comps with full JSON extraction — priceHistory is required for
    // stale-price reconciliation and flip detection downstream.
    const maxComps = options?.maxComps ?? 5
    const compsToFetch = comps.slice(0, maxComps)

    // All fetches in parallel — subject and comps both run the provider
    // fallback chain. Each attempt is timeout-bounded and the whole
    // chain per comp is capped so one hung scrape can't gate the bundle.
    const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
      Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))])

    const failed = (propertyId: string, error: string, code: 'NO_PROVIDER' | 'FETCH_FAILED') =>
      ({ success: false as const, propertyId, error, code })

    const fetchCompWithFallback = async (comp: PropertyIdentifier): Promise<PhotoFetchResult> => {
      const deadline = Date.now() + COMP_CHAIN_BUDGET_MS
      const errors: string[] = []
      for (const name of COMP_FALLBACK_ORDER) {
        const provider = this.providers.get(name)
        if (!provider?.isAvailable()) continue
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        const result = await withTimeout(
          provider.fetchPhotos(comp, { ...options }),
          Math.min(COMP_ATTEMPT_TIMEOUT_MS, remaining),
          failed(comp.propertyId, `${name} attempt timed out`, 'FETCH_FAILED')
        )
        if (result.success && result.data.photos.length > 0) {
          if (errors.length > 0) {
            console.log(`[PhotoService] comp ${comp.propertyId}: ${name} delivered after ${errors.join(' → ')}`)
          }
          return result
        }
        errors.push(`${name}: ${result.success ? 'no photos' : result.error}`)
      }
      return failed(
        comp.propertyId,
        errors.length > 0 ? `All comp providers failed — ${errors.join('; ')}` : 'No photo provider available',
        errors.length > 0 ? 'FETCH_FAILED' : 'NO_PROVIDER'
      )
    }

    const [subjectResult, ...compResults] = await Promise.all([
      withTimeout(this.fetchPhotos(subject, options), 20000, failed(subject.propertyId, 'Subject photo fetch timed out', 'FETCH_FAILED')),
      ...compsToFetch.map((comp) => fetchCompWithFallback(comp)),
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
      // Report the provider that actually delivered (fallback chain aware)
      provider: subjectResult.success ? subjectResult.data.source : (this.getProviderName() ?? 'none'),
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
    case 'redfin':
    case 'realtor': {
      const listingProvider = createListingPhotoProvider(env, type)
      return listingProvider.isAvailable() ? listingProvider : null
    }
    case 'mls':
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
