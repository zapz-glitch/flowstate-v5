/**
 * Cache Service for API responses
 * Uses Cloudflare KV for persistent caching
 */

import type { Env } from '../../types'

export interface CacheOptions {
  /** TTL in seconds (default: 24 hours) */
  ttl?: number
  /** Cache key prefix */
  prefix?: string
}

export interface CacheService {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T, options?: CacheOptions): Promise<void>
  delete(key: string): Promise<void>
  has(key: string): Promise<boolean>
}

// Default TTLs for different cache types (in seconds)
export const CACHE_TTL = {
  // Property data rarely changes - cache for 7 days
  PROPERTY_DETAILS: 7 * 24 * 60 * 60,
  // Comparables data can be cached for 24 hours
  COMPARABLES: 24 * 60 * 60,
  // Flood zone data rarely changes - cache for 30 days
  FLOOD_ZONE: 30 * 24 * 60 * 60,
  // Permits data - cache for 7 days
  PERMITS: 7 * 24 * 60 * 60,
  // Vision analysis results - cache for 30 days (photos don't change)
  VISION_ANALYSIS: 30 * 24 * 60 * 60,
  // Zillow data - cache for 24 hours (listings can change)
  ZILLOW_DATA: 24 * 60 * 60,
  // OAuth tokens - cache until expiry minus buffer
  OAUTH_TOKEN: 50 * 60, // 50 minutes (tokens last 60 min)
  // Neighbourhood data - cache for 7 days (community/school/POI data rarely changes)
  NEIGHBOURHOOD: 7 * 24 * 60 * 60,
  // User analysis settings - cache for 1 hour (invalidated on mutation)
  USER_SETTINGS: 60 * 60,
} as const

// Cache key prefixes
export const CACHE_PREFIX = {
  PROPERTY: 'prop:',
  COMPARABLES: 'comps:',
  FLOOD: 'flood:',
  PERMITS: 'permits:',
  VISION: 'vision:',
  ZILLOW: 'zillow:',
  OAUTH: 'oauth:',
  NEIGHBOURHOOD: 'nbhd:',
  USER_SETTINGS: 'user-settings:',
} as const

/**
 * Create a cache service instance
 */
export function createCacheService(env: Env): CacheService {
  const kv = env.API_CACHE

  return {
    async get<T>(key: string): Promise<T | null> {
      try {
        const value = await kv.get(key, 'json')
        return value as T | null
      } catch (error) {
        console.error(`Cache get error for key ${key}:`, error)
        return null
      }
    },

    async set<T>(key: string, value: T, options?: CacheOptions): Promise<void> {
      try {
        const ttl = options?.ttl ?? CACHE_TTL.PROPERTY_DETAILS
        await kv.put(key, JSON.stringify(value), {
          expirationTtl: ttl,
        })
      } catch (error) {
        console.error(`Cache set error for key ${key}:`, error)
      }
    },

    async delete(key: string): Promise<void> {
      try {
        await kv.delete(key)
      } catch (error) {
        console.error(`Cache delete error for key ${key}:`, error)
      }
    },

    async has(key: string): Promise<boolean> {
      try {
        const value = await kv.get(key)
        return value !== null
      } catch (error) {
        console.error(`Cache has error for key ${key}:`, error)
        return false
      }
    },
  }
}

/**
 * Generate a cache key for property data
 */
export function propertyKey(clip: string, provider?: string): string {
  return provider
    ? `${CACHE_PREFIX.PROPERTY}${provider}:${clip}`
    : `${CACHE_PREFIX.PROPERTY}${clip}`
}

/**
 * Generate a cache key for comparables
 */
export function comparablesKey(clip: string, radius?: number, months?: number, provider?: string): string {
  const prefix = provider
    ? `${CACHE_PREFIX.COMPARABLES}${provider}:`
    : CACHE_PREFIX.COMPARABLES
  const suffix = radius || months ? `:r${radius || 1}:m${months || 12}` : ''
  return `${prefix}${clip}${suffix}`
}

/**
 * Generate a cache key for flood zone
 */
export function floodZoneKey(clip: string, provider?: string): string {
  return provider
    ? `${CACHE_PREFIX.FLOOD}${provider}:${clip}`
    : `${CACHE_PREFIX.FLOOD}${clip}`
}

/**
 * Generate a cache key for permits
 */
export function permitsKey(clip: string, provider?: string): string {
  return provider
    ? `${CACHE_PREFIX.PERMITS}${provider}:${clip}`
    : `${CACHE_PREFIX.PERMITS}${clip}`
}

/**
 * Generate a cache key for vision analysis
 * Uses address hash since photos are fetched by address
 */
export function visionKey(address: string): string {
  // Simple hash of address for consistent keys
  const hash = address
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 50)
  return `${CACHE_PREFIX.VISION}${hash}`
}

/**
 * Generate a cache key for Zillow data
 */
export function zillowKey(address: string): string {
  const hash = address
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 50)
  return `${CACHE_PREFIX.ZILLOW}${hash}`
}

/**
 * Generate a cache key for OAuth token
 */
export function oauthKey(clientId: string): string {
  return `${CACHE_PREFIX.OAUTH}${clientId}`
}

/**
 * Generate a cache key for neighbourhood data
 * Uses lat/lng rounded to 3 decimal places (~100m precision, neighbourhood-level)
 */
export function neighbourhoodKey(latitude: number, longitude: number): string {
  return `${CACHE_PREFIX.NEIGHBOURHOOD}${latitude.toFixed(3)},${longitude.toFixed(3)}`
}

/**
 * Generate a cache key for user analysis settings.
 * Includes address hash because location overrides make settings location-dependent.
 */
export function userSettingsKey(userId: string, addressHash?: string): string {
  return `${CACHE_PREFIX.USER_SETTINGS}${userId}${addressHash ? ':' + addressHash : ''}`
}
