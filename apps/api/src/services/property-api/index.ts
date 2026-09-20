/**
 * Unified Property API Service
 *
 * Provides a single interface for property data that works with multiple providers.
 * Currently supports CoreLogic with ATTOM planned.
 *
 * Usage:
 *   import { createPropertyApi } from '../services/property-api'
 *
 *   const propertyApi = createPropertyApi(env)
 *
 *   // Search for a property
 *   const result = await propertyApi.searchProperty({ address: '123 Main St, City, ST 12345' })
 *
 *   // Get comparables
 *   const comps = await propertyApi.getComparables({ propertyId: 'abc123', radiusMiles: 1 })
 *
 *   // Switch providers
 *   propertyApi.setProvider('attom')
 */

import type { Env } from '../../types';
import { createCoreLogicProvider } from './providers/corelogic';
import { createAttomProvider } from './providers/attom';
import {
  createCacheService,
  propertyKey,
  comparablesKey,
  floodZoneKey,
  permitsKey,
  CACHE_TTL,
  type CacheService,
} from '../cache';
import { resolveCandidateLimit } from './retrieval-policy';
import type {
  PropertyProvider,
  PropertyProviderAdapter,
  PropertySearchParams,
  PropertySearchResponse,
  ComparablesSearchParams,
  ComparablesSearchResponse,
  ComparablesResult,
  PermitsResponse,
  PermitsResult,
  FloodZoneResponse,
  AvmResponse,
  BuildingDetailResponse,
  PropertyApiConfig,
  NormalizedProperty,
  NormalizedComparable,
  NormalizedFloodZone,
  NormalizedAvm,
  NormalizedBuildingDetail,
  // PropertyBundle types
  PropertyBundle,
  PropertyBundleParams,
  PropertyBundleResponse,
  EnrichmentData,
  EnrichmentOptions,
  PermitsEnrichment,
  WeatherRisk,
} from './types';
import {
  lookupCode,
  BUILDING_STYLE,
  CONSTRUCTION_TYPE,
  FOUNDATION_TYPE,
  ROOF_TYPE,
  ROOF_COVER,
  EXTERIOR_WALLS,
  BUILDING_QUALITY,
} from './providers/corelogic-codes';

/** Resolve raw CoreLogic codes to labels in construction data (handles KV-cached entries) */
function resolveConstructionCodes(c: NonNullable<NormalizedProperty['construction']>): NonNullable<NormalizedProperty['construction']> {
  return {
    ...c,
    type: lookupCode(CONSTRUCTION_TYPE, c.type) ?? c.type,
    qualityCode: lookupCode(BUILDING_QUALITY, c.qualityCode) ?? c.qualityCode,
    buildingStyle: lookupCode(BUILDING_STYLE, c.buildingStyle) ?? c.buildingStyle,
    foundationType: lookupCode(FOUNDATION_TYPE, c.foundationType) ?? c.foundationType,
    roofType: lookupCode(ROOF_TYPE, c.roofType) ?? c.roofType,
    roofCover: lookupCode(ROOF_COVER, c.roofCover) ?? c.roofCover,
    exteriorWalls: lookupCode(EXTERIOR_WALLS, c.exteriorWalls) ?? c.exteriorWalls,
  };
}

// Re-export types for convenience
export type {
  PropertyProvider,
  PropertySearchParams,
  PropertySearchResponse,
  ComparablesSearchParams,
  ComparablesSearchResponse,
  NormalizedProperty,
  NormalizedComparable,
  NormalizedPermit,
  NormalizedFloodZone,
  // PropertyBundle types
  PropertyBundle,
  PropertyBundleParams,
  PropertyBundleResponse,
  EnrichmentData,
  EnrichmentOptions,
  WeatherRisk,
} from './types';

// ─── Call Stats Tracking ────────────────────────────────────────────────────────

export interface PropertyApiCallStats {
  /** Total API calls made (not from cache) */
  total: number
  /** Total cache hits (no API call made) */
  cached: number
  /** Per-endpoint breakdown: calls + cache hits */
  endpoints: { endpoint: string; calls: number; cached: number }[]
}

class CallStatsTracker {
  private _entries: { endpoint: string; type: 'call' | 'cache_hit' }[] = []

  logCall(endpoint: string): void {
    this._entries.push({ endpoint, type: 'call' })
  }

  logCacheHit(endpoint: string): void {
    this._entries.push({ endpoint, type: 'cache_hit' })
  }

  reset(): void {
    this._entries = []
  }

  getStats(): PropertyApiCallStats {
    const endpointMap = new Map<string, { calls: number; cached: number }>()

    for (const entry of this._entries) {
      const existing = endpointMap.get(entry.endpoint) ?? { calls: 0, cached: 0 }
      if (entry.type === 'call') {
        existing.calls++
      } else {
        existing.cached++
      }
      endpointMap.set(entry.endpoint, existing)
    }

    let totalCalls = 0
    let totalCached = 0
    const endpoints: { endpoint: string; calls: number; cached: number }[] = []

    for (const [endpoint, stats] of endpointMap) {
      totalCalls += stats.calls
      totalCached += stats.cached
      endpoints.push({ endpoint, ...stats })
    }

    return { total: totalCalls, cached: totalCached, endpoints }
  }
}

// ─── Configuration ─────────────────────────────────────────────────────────────

const DEFAULT_PROVIDER: PropertyProvider = 'corelogic';

// ─── Unified Service ───────────────────────────────────────────────────────────

export interface PropertyApiService {
  /** Get the current provider name */
  readonly providerName: PropertyProvider;
  /** Get the current configuration */
  readonly config: Readonly<PropertyApiConfig>;

  /** Set the active provider */
  setProvider(provider: PropertyProvider): void;
  /** Update configuration */
  configure(config: Partial<PropertyApiConfig>): void;

  /** Search for a property by address */
  searchProperty(params: PropertySearchParams): Promise<PropertySearchResponse>;
  /** Get property details by ID */
  getPropertyById(propertyId: string): Promise<PropertySearchResponse>;
  /** Get comparable properties */
  getComparables(
    params: ComparablesSearchParams,
  ): Promise<ComparablesSearchResponse>;
  /** Get building permits */
  getBuildingPermits(propertyId: string, address?: { address1: string; address2: string }): Promise<PermitsResponse>;
  /** Get flood zone data */
  getFloodZone(latitude: number, longitude: number): Promise<FloodZoneResponse>;
  /** Get parcel-level flood zone by composite parcel ID (fipsCode:universalParcelId) */
  getFloodZoneByParcel(parcelId: string): Promise<FloodZoneResponse>;
  /** Flood zone for a property: parcel-level when parcelId is present, spatial fallback */
  getFloodZoneForProperty(property: NormalizedProperty): Promise<FloodZoneResponse | null>;
  /** AVM estimate by composite parcel ID (subject properties only) */
  getAvm(parcelId: string, model?: string): Promise<AvmResponse>;
  /** Building detail by composite parcel ID — supplements property-detail when coded fields are absent */
  getBuildingDetail(parcelId: string): Promise<BuildingDetailResponse>;

  /** Search property with fallback to alternate provider on failure */
  searchPropertyWithFallback(
    params: PropertySearchParams,
    fallbackProvider?: PropertyProvider,
  ): Promise<PropertySearchResponse>;
  /** Get comparables with fallback to alternate provider on failure */
  getComparablesWithFallback(
    params: ComparablesSearchParams,
    fallbackProvider?: PropertyProvider,
  ): Promise<ComparablesSearchResponse>;

  /** Get status of provider credentials (for monitoring) */
  getKeyStatus(): {
    configured: boolean;
    hasToken: boolean;
  };

  /**
   * Get complete property bundle in a single call.
   * Fetches property + comparables + enrichment + optional Zillow data.
   * This is the recommended method for analysis workflows.
   */
  getPropertyBundle(
    params: PropertyBundleParams,
  ): Promise<PropertyBundleResponse>;

  /**
   * Enrich comparables with full property details (including subdivision).
   * Fetches property details for each comp in parallel with concurrency control.
   */
  enrichComparables(
    comparables: NormalizedComparable[],
    options?: { concurrency?: number },
  ): Promise<NormalizedComparable[]>;

  /** Get call statistics for the current session (calls + cache hits per endpoint) */
  getCallStats(): PropertyApiCallStats;

  /** Reset call statistics (call at the start of each analysis) */
  resetCallStats(): void;
}

class PropertyApi implements PropertyApiService {
  private providers: Map<PropertyProvider, PropertyProviderAdapter>;
  private currentConfig: PropertyApiConfig;
  private env: Env;
  private cache: CacheService;
  private _skipCache: boolean = false;
  private _stats = new CallStatsTracker();

  constructor(env: Env, initialConfig?: Partial<PropertyApiConfig>) {
    this.env = env;
    this.cache = createCacheService(env);
    // Allow env var to override the default provider
    const envProvider = (env.PROPERTY_PROVIDER as PropertyProvider | undefined);
    const activeProvider = initialConfig?.provider || envProvider || DEFAULT_PROVIDER;

    this.currentConfig = {
      provider: activeProvider,
      propertyCacheTtl: initialConfig?.propertyCacheTtl ?? 86400, // 24 hours
      comparablesCacheTtl: initialConfig?.comparablesCacheTtl ?? 3600, // 1 hour
    };

    // Initialize providers
    this.providers = new Map();
    this.providers.set('corelogic', createCoreLogicProvider(env));
    this.providers.set('attom', createAttomProvider(env));
  }

  private getProvider(): PropertyProviderAdapter {
    const provider = this.providers.get(this.currentConfig.provider);
    if (!provider) {
      throw new Error(
        `Unknown property provider: ${this.currentConfig.provider}`,
      );
    }
    return provider;
  }

  get providerName(): PropertyProvider {
    return this.currentConfig.provider;
  }

  get config(): Readonly<PropertyApiConfig> {
    return { ...this.currentConfig };
  }

  setProvider(provider: PropertyProvider): void {
    if (!this.providers.has(provider)) {
      throw new Error(`Unknown property provider: ${provider}`);
    }
    console.log(
      `PropertyAPI: Switching provider from ${this.currentConfig.provider} to ${provider}`,
    );
    this.currentConfig.provider = provider;
  }

  configure(config: Partial<PropertyApiConfig>): void {
    this.currentConfig = { ...this.currentConfig, ...config };
    console.log('PropertyAPI: Configuration updated', this.currentConfig);
  }

  getCallStats(): PropertyApiCallStats {
    return this._stats.getStats()
  }

  resetCallStats(): void {
    this._stats.reset()
  }

  async searchProperty(
    params: PropertySearchParams,
  ): Promise<PropertySearchResponse> {
    const provider = this.getProvider();
    console.log('PropertyAPI: Searching property', {
      provider: provider.name,
      address: params.address,
    });
    // Address → property resolution is a stable mapping; cache the
    // normalized subject by normalized address so repeat/nearby lookups
    // don't burn a provider call.
    const addrKey = [
      params.address,
      params.streetAddress,
      params.city,
      params.state,
      params.zipCode,
    ]
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .join('|')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    const cacheKey = `prop:search:${provider.name}:${addrKey}`;
    if (!this._skipCache) {
      const cached = await this.cache.get<NormalizedProperty>(cacheKey);
      if (cached) {
        console.log('PropertyAPI: Cache HIT for property search', { address: params.address });
        this._stats.logCacheHit('property-search');
        return { success: true, data: cached };
      }
    }

    this._stats.logCall('property-search');
    const result = await provider.searchProperty(params);
    if (result.success && result.data) {
      await this.cache.set(cacheKey, result.data, { ttl: CACHE_TTL.PROPERTY_DETAILS });
    }
    return result;
  }

  async getPropertyById(propertyId: string): Promise<PropertySearchResponse> {
    const provider = this.getProvider();

    if (!provider.getPropertyById) {
      return {
        success: false,
        error: `${provider.name} does not support property lookup by ID`,
        code: 'NOT_SUPPORTED',
      };
    }

    // Check cache first (unless skipCache is set)
    const cacheKey = propertyKey(propertyId, provider.name);
    if (!this._skipCache) {
      const cached = await this.cache.get<NormalizedProperty>(cacheKey);
      if (cached) {
        console.log('PropertyAPI: Cache HIT for property', { propertyId });
        this._stats.logCacheHit('property-detail');
        return { success: true, data: cached };
      }
    } else {
      console.log('PropertyAPI: Cache SKIPPED for property', { propertyId });
    }

    console.log('PropertyAPI: Cache MISS, fetching property by ID', {
      provider: provider.name,
      propertyId,
    });
    this._stats.logCall('property-detail');
    const result = await provider.getPropertyById(propertyId);

    // Cache successful results
    if (result.success && result.data) {
      await this.cache.set(cacheKey, result.data, {
        ttl: CACHE_TTL.PROPERTY_DETAILS,
      });
    }

    return result;
  }

  async getComparables(
    params: ComparablesSearchParams,
  ): Promise<ComparablesSearchResponse> {
    const provider = this.getProvider();

    // Check cache first (unless skipCache is set)
    const cacheKey = comparablesKey(
      params.propertyId,
      params.radiusMiles,
      params.monthsBack,
      provider.name,
      { ...params },
    );
    if (!this._skipCache) {
      const cached = await this.cache.get<ComparablesResult['data']>(cacheKey);
      if (cached) {
        console.log('PropertyAPI: Cache HIT for comparables', {
          propertyId: params.propertyId,
        });
        this._stats.logCacheHit('comparables');
        return { success: true, data: cached };
      }
    } else {
      console.log('PropertyAPI: Cache SKIPPED for comparables', {
        propertyId: params.propertyId,
      });
    }

    console.log('PropertyAPI: Cache MISS, fetching comparables', {
      provider: provider.name,
      propertyId: params.propertyId,
      radiusMiles: params.radiusMiles,
    });
    this._stats.logCall('comparables');
    const result = await provider.getComparables(params);

    // Cache successful results
    if (result.success && result.data) {
      await this.cache.set(cacheKey, result.data, {
        ttl: CACHE_TTL.COMPARABLES,
      });
    }

    return result;
  }

  async getBuildingPermits(propertyId: string, address?: { address1: string; address2: string }): Promise<PermitsResponse> {
    const provider = this.getProvider();

    if (!provider.getBuildingPermits) {
      return {
        success: false,
        error: `${provider.name} does not support building permits`,
        code: 'NOT_SUPPORTED',
      };
    }

    // Check cache first (unless skipCache is set)
    const cacheKey = permitsKey(propertyId, provider.name);
    if (!this._skipCache) {
      const cached = await this.cache.get<PermitsResult['data']>(cacheKey);
      if (cached) {
        console.log('PropertyAPI: Cache HIT for permits', { propertyId });
        this._stats.logCacheHit('permits');
        return { success: true, data: cached };
      }
    } else {
      console.log('PropertyAPI: Cache SKIPPED for permits', { propertyId });
    }

    console.log('PropertyAPI: Cache MISS, fetching building permits', {
      provider: provider.name,
      propertyId,
    });
    this._stats.logCall('permits');
    const result = await provider.getBuildingPermits(propertyId, address);

    // Cache successful results
    if (result.success && result.data) {
      await this.cache.set(cacheKey, result.data, { ttl: CACHE_TTL.PERMITS });
    }

    return result;
  }

  async getFloodZone(
    latitude: number,
    longitude: number,
  ): Promise<FloodZoneResponse> {
    const provider = this.getProvider();

    if (!provider.getFloodZone) {
      return {
        success: false,
        error: `${provider.name} does not support flood zone lookup`,
        code: 'NOT_SUPPORTED',
      };
    }

    // Use coordinates as cache key (rounded to 5 decimal places for ~1m precision)
    const coordKey = `${latitude.toFixed(5)},${longitude.toFixed(5)}`;
    const cacheKey = floodZoneKey(coordKey, provider.name);
    if (!this._skipCache) {
      const cached = await this.cache.get<NormalizedFloodZone>(cacheKey);
      if (cached) {
        console.log('PropertyAPI: Cache HIT for flood zone', {
          latitude,
          longitude,
        });
        this._stats.logCacheHit('flood-zone');
        return { success: true, data: cached };
      }
    } else {
      console.log('PropertyAPI: Cache SKIPPED for flood zone', {
        latitude,
        longitude,
      });
    }

    console.log('PropertyAPI: Cache MISS, fetching flood zone', {
      provider: provider.name,
      latitude,
      longitude,
    });
    this._stats.logCall('flood-zone');
    const result = await provider.getFloodZone(latitude, longitude);

    // Cache successful results
    if (result.success && result.data) {
      await this.cache.set(cacheKey, result.data, {
        ttl: CACHE_TTL.FLOOD_ZONE,
      });
    }

    return result;
  }

  /**
   * Parcel-level flood determination keyed on `fipsCode:universalParcelId`.
   * More accurate than the coordinate spatial lookup — preferred when the
   * subject property carries a parcelId.
   */
  async getFloodZoneByParcel(parcelId: string): Promise<FloodZoneResponse> {
    const provider = this.getProvider();

    if (!provider.getFloodZoneByParcel) {
      return {
        success: false,
        error: `${provider.name} does not support parcel flood zone lookup`,
        code: 'NOT_SUPPORTED',
      };
    }

    const cacheKey = floodZoneKey(`parcel:${parcelId}`, provider.name);
    if (!this._skipCache) {
      const cached = await this.cache.get<NormalizedFloodZone>(cacheKey);
      if (cached) {
        this._stats.logCacheHit('flood-zone');
        return { success: true, data: cached };
      }
    }

    this._stats.logCall('flood-zone');
    const result = await provider.getFloodZoneByParcel(parcelId);

    if (result.success && result.data) {
      await this.cache.set(cacheKey, result.data, {
        ttl: CACHE_TTL.FLOOD_ZONE,
      });
    }

    return result;
  }

  /**
   * Flood zone for a subject property: parcel-level determination when a
   * parcelId is present, with graceful fallback to the coordinate spatial
   * lookup (and vice versa when parcel data is unavailable).
   */
  async getFloodZoneForProperty(
    property: NormalizedProperty,
  ): Promise<FloodZoneResponse | null> {
    if (property.parcelId) {
      const parcelResult = await this.getFloodZoneByParcel(property.parcelId);
      if (parcelResult.success) return parcelResult;
      console.log('PropertyAPI: Parcel flood zone unavailable, falling back to spatial', {
        parcelId: property.parcelId,
        code: parcelResult.code,
      });
    }

    if (property.latitude && property.longitude) {
      return this.getFloodZone(property.latitude, property.longitude);
    }

    return null;
  }

  /**
   * AVM estimate via Cotality Total Home Value (subject properties only).
   * Requires the composite parcelId; cached per parcel+model.
   */
  async getAvm(parcelId: string, model = 'thvMarketingStandard'): Promise<AvmResponse> {
    const provider = this.getProvider();

    if (!provider.getAvm) {
      return {
        success: false,
        error: `${provider.name} does not support AVM lookup`,
        code: 'NOT_SUPPORTED',
      };
    }

    // Circuit breaker: the THV product is gated per-account. After a few
    // consecutive entitlement/not-found failures we stop paying for a call
    // that can never return data; the flag expires weekly so a newly
    // entitled product self-heals.
    const disabledKey = `avm:disabled:${provider.name}`;
    if (await this.cache.get<number>(disabledKey)) {
      return {
        success: false,
        error: 'AVM product not entitled on this account (breaker open)',
        code: 'AVM_DISABLED',
      };
    }

    const cacheKey = floodZoneKey(`avm:${model}:${parcelId}`, provider.name);
    if (!this._skipCache) {
      const cached = await this.cache.get<NormalizedAvm>(cacheKey);
      if (cached) {
        this._stats.logCacheHit('avm');
        return { success: true, data: cached };
      }
    }

    this._stats.logCall('avm');
    const result = await provider.getAvm(parcelId, model);

    if (result.success && result.data) {
      await this.cache.set(cacheKey, result.data, {
        ttl: CACHE_TTL.FLOOD_ZONE,
      });
      await this.cache.delete(`avm:failcount:${provider.name}`);
    } else if (!result.success && (result.code === 'ENTITLEMENTS_ERROR' || result.code === 'NOT_FOUND')) {
      const cntKey = `avm:failcount:${provider.name}`;
      const n = ((await this.cache.get<number>(cntKey)) ?? 0) + 1;
      await this.cache.set(cntKey, n, { ttl: CACHE_TTL.FLOOD_ZONE });
      if (n >= 3) {
        console.warn(`PropertyAPI: AVM failed ${n} consecutive times (${result.code}) — disabling for 7 days`);
        await this.cache.set(disabledKey, 1, { ttl: CACHE_TTL.PERMITS });
      }
    }

    return result;
  }

  /**
   * Building detail supplement — literal-text condition/style/foundation/
   * HVAC/parking from /property/{id}/building. Cached per parcel; used to
   * fill fields the coded property-detail block doesn't carry.
   */
  async getBuildingDetail(parcelId: string): Promise<BuildingDetailResponse> {
    const provider = this.getProvider();

    if (!provider.getBuildingDetail) {
      return {
        success: false,
        error: `${provider.name} does not support building detail`,
        code: 'NOT_SUPPORTED',
      };
    }

    const cacheKey = floodZoneKey(`building:${parcelId}`, provider.name);
    if (!this._skipCache) {
      const cached = await this.cache.get<NormalizedBuildingDetail>(cacheKey);
      if (cached) {
        this._stats.logCacheHit('building_detail');
        return { success: true, data: cached };
      }
    }

    this._stats.logCall('building_detail');
    const result = await provider.getBuildingDetail(parcelId);

    if (result.success && result.data) {
      await this.cache.set(cacheKey, result.data, {
        ttl: CACHE_TTL.FLOOD_ZONE,
      });
    }

    return result;
  }

  async searchPropertyWithFallback(
    params: PropertySearchParams,
    fallbackProvider?: PropertyProvider,
  ): Promise<PropertySearchResponse> {
    const primaryResult = await this.searchProperty(params);

    if (primaryResult.success) {
      return primaryResult;
    }

    // Try fallback provider if specified
    const fallback =
      fallbackProvider ||
      (this.currentConfig.provider === 'corelogic' ? 'attom' : 'corelogic');
    const fallbackProviderAdapter = this.providers.get(fallback);

    if (!fallbackProviderAdapter) {
      return primaryResult;
    }

    console.log('PropertyAPI: Primary provider failed, trying fallback', {
      primary: this.currentConfig.provider,
      fallback,
      error: primaryResult.error,
    });

    const fallbackResult = await fallbackProviderAdapter.searchProperty(params);

    if (fallbackResult.success) {
      console.log('PropertyAPI: Fallback provider succeeded', { fallback });
    }

    return fallbackResult;
  }

  async getComparablesWithFallback(
    params: ComparablesSearchParams,
    fallbackProvider?: PropertyProvider,
  ): Promise<ComparablesSearchResponse> {
    const primaryResult = await this.getComparables(params);

    if (primaryResult.success) {
      return primaryResult;
    }

    const fallback =
      fallbackProvider ||
      (this.currentConfig.provider === 'corelogic' ? 'attom' : 'corelogic');
    const fallbackProviderAdapter = this.providers.get(fallback);

    if (!fallbackProviderAdapter) {
      return primaryResult;
    }

    console.log(
      'PropertyAPI: Primary provider failed for comparables, trying fallback',
      {
        primary: this.currentConfig.provider,
        fallback,
        error: primaryResult.error,
      },
    );

    return fallbackProviderAdapter.getComparables(params);
  }

  getKeyStatus(): {
    configured: boolean;
    hasToken: boolean;
  } {
    const provider = this.getProvider();
    // CoreLogic provider has this method
    if (
      'getKeyStatus' in provider &&
      typeof provider.getKeyStatus === 'function'
    ) {
      return (
        provider as {
          getKeyStatus: () => ReturnType<PropertyApiService['getKeyStatus']>;
        }
      ).getKeyStatus();
    }
    return { configured: false, hasToken: false };
  }

  /**
   * Get complete property bundle in a single call.
   * Fetches property + comparables + enrichment data.
   *
   * NOTE: Photos are NOT included - use PhotoProvider separately for modularity.
   * This allows using any photo source (Zillow, MLS, Redfin, uploads, etc.)
   */
  async getPropertyBundle(
    params: PropertyBundleParams,
  ): Promise<PropertyBundleResponse> {
    console.log('PropertyAPI: Getting property bundle', {
      address: params.address,
      propertyId: params.propertyId,
      skipCache: params.skipCache,
    });

    // Set skipCache flag for all subsequent calls
    this._skipCache = params.skipCache ?? false;

    // ─── Step 1: Get subject property ──────────────────────────────────────────
    let propertyResult: PropertySearchResponse;
    if (params.propertyId) {
      propertyResult = await this.getPropertyById(params.propertyId);
    } else {
      propertyResult = await this.searchProperty({
        address: params.address,
        streetAddress: params.streetAddress,
        city: params.city,
        state: params.state,
        zipCode: params.zipCode,
      });
    }

    if (!propertyResult.success) {
      return {
        success: false,
        error: propertyResult.error,
        code: propertyResult.code,
      };
    }

    const property = propertyResult.data;

    // ─── Step 2: Parallel fetch - comparables + enrichment ─────────────────────
    const compParams = params.comparables ?? {};
    // Permits + flood-zone provider calls are opt-in: permits moved to the
    // on-demand report action, flood comes from the listing scrape (First
    // Street signal via Redfin/Realtor) — both keep the CoreLogic spend down.
    const enrichOpts: EnrichmentOptions = params.enrichment ?? {
      permits: false,
      floodZone: false,
    };

    // Build address strings for providers that need them (e.g. ATTOM permits)
    const address1 = property.address || params.streetAddress || ''
    const address2 = [property.city || params.city, property.state || params.state, property.zipCode || params.zipCode].filter(Boolean).join(', ')

    const candidateLimit = resolveCandidateLimit(this.env, this.currentConfig.provider, compParams.maxComps)
    const [compsResult, permitsResult, floodResult, neighbourhoodResult, avmResult, buildingDetailResult] = await Promise.all([
      // Get comparables — up to the configured/provider-max candidate limit
      this.getComparables({
        propertyId: property.id,
        radiusMiles: compParams.radiusMiles ?? 1,
        maxComps: candidateLimit,
        monthsBack: compParams.monthsBack ?? 12,
        sqftDiff: compParams.sqftDiff,
        sqftVariance: compParams.sqftVariance,
        subjectSqft: property.squareFeet ?? undefined,
        subjectPropertyType: property.propertyType ?? undefined,
      }),
      // Get permits (if enabled) — pass address for ATTOM
      enrichOpts.permits !== false
        ? this.getBuildingPermits(property.id, { address1, address2 })
        : Promise.resolve(null),
      // Get flood zone (if enabled) — parcel-level when parcelId is known,
      // coordinate spatial lookup as fallback
      enrichOpts.floodZone !== false
        ? this.getFloodZoneForProperty(property)
        : Promise.resolve(null),
      // Neighbourhood enrichment removed — the ATTOM service is dead code
      // (all callers disabled it); the field stays null on the response.
      Promise.resolve(null),
      // Subject AVM (Cotality THV) — parcel-level, subject only; graceful fail
      property.parcelId
        ? this.getAvm(property.parcelId).catch(() => null)
        : Promise.resolve(null),
      // Subject building detail — supplements property-detail when the coded
      // buildings block lacks condition/style (literal-text provider data)
      property.parcelId &&
        (!property.buildingCondition ||
          !property.construction?.buildingStyle ||
          !property.construction?.foundationType)
        ? this.getBuildingDetail(property.parcelId).catch(() => null)
        : Promise.resolve(null),
    ]);

    if (!compsResult.success) {
      return {
        success: false,
        error: compsResult.error || 'Failed to fetch comparables',
        code: compsResult.code,
      };
    }

    // ─── Step 3: Enrich comparables with full property details ─────────────────
    // This fetches subdivision data for each comp (needed for subdivision matching)
    const enrichedComparables = await this.enrichComparables(
      compsResult.data.comparables,
      {
        concurrency: 10,
      },
    );

    // ─── Step 4: Build enrichment data ─────────────────────────────────────────
    let permits: PermitsEnrichment | null = null;
    if (
      permitsResult &&
      permitsResult.success
    ) {
      const permitItems = permitsResult.data.permits;
      permits = {
        items: permitItems,
        count: permitItems.length,
        totalJobValue:
          permitItems.reduce((sum, p) => sum + (p.jobValue || 0), 0) ||
          undefined,
        recentPermitTypes:
          [
            ...new Set(
              permitItems
                .filter((p) => p.projectType)
                .map((p) => p.projectType!),
            ),
          ].slice(0, 5) || undefined,
      };
    }

    const floodZone: NormalizedFloodZone | null =
      floodResult && floodResult.success ? floodResult.data : null;
    const avm: NormalizedAvm | null =
      avmResult && avmResult.success ? avmResult.data : null;
    if (avm) {
      property.avmValue = avm.value;
      property.avmConfidence = avm.confidence;
    }

    // Building detail supplement — fills fields the coded detail block lacks
    const buildingDetail: NormalizedBuildingDetail | null =
      buildingDetailResult && buildingDetailResult.success ? buildingDetailResult.data : null;
    if (buildingDetail) {
      property.buildingCondition ??= buildingDetail.condition;
      property.stories ??= buildingDetail.stories;
      property.yearBuilt ??= buildingDetail.yearBuilt;
      if (property.construction || buildingDetail.buildingStyle || buildingDetail.foundation) {
        property.construction = {
          ...(property.construction ?? {}),
          buildingStyle: property.construction?.buildingStyle ?? buildingDetail.buildingStyle ?? undefined,
          foundationType: property.construction?.foundationType ?? buildingDetail.foundation ?? undefined,
          type: property.construction?.type ?? buildingDetail.constructionType ?? undefined,
          exteriorWalls: property.construction?.exteriorWalls ?? buildingDetail.exteriorWalls ?? undefined,
          roofCover: property.construction?.roofCover ?? buildingDetail.roofCover ?? undefined,
        };
      }
      if (property.features || buildingDetail.heating || buildingDetail.cooling || buildingDetail.parkingType || buildingDetail.pool) {
        property.features = {
          ...(property.features ?? {}),
          heating: property.features?.heating ?? buildingDetail.heating ?? undefined,
          cooling: property.features?.cooling ?? buildingDetail.cooling ?? undefined,
          poolType: property.features?.poolType ?? buildingDetail.pool ?? undefined,
          garageType: property.features?.garageType ??
            (buildingDetail.parkingType && !/carport/i.test(buildingDetail.parkingType)
              ? buildingDetail.parkingType
              : undefined),
          garageSquareFeet: property.features?.garageSquareFeet ?? buildingDetail.garageSquareFeet ?? undefined,
          carportType: property.features?.carportType ??
            (buildingDetail.parkingType && /carport/i.test(buildingDetail.parkingType)
              ? buildingDetail.parkingType
              : undefined),
        };
      }
    }
    const weatherRisk: WeatherRisk | null = enrichOpts.weatherRisk
      ? this.estimateWeatherRisk(property.state)
      : null;

    const enrichment: EnrichmentData = {
      evidenceLimitations: [
        ...(permitsResult && !permitsResult.success ? [`Building permit evidence unavailable (${permitsResult.code ?? 'API_ERROR'}); permit history is unknown`] : []),
        ...(floodResult && !floodResult.success ? [`Flood zone evidence unavailable (${floodResult.code ?? 'API_ERROR'}); flood risk is unknown`] : []),
      ],
      permits,
      floodZone,
      avm,
      weatherRisk,
      neighbourhood: neighbourhoodResult ?? null,
    };

    // ─── Step 5: Build and return PropertyBundle ───────────────────────────────
    const bundle: PropertyBundle = {
      property,
      comparables: enrichedComparables,
      enrichment,
      metadata: {
        fetchedAt: new Date().toISOString(),
        provider: property.provider,
        searchParams: params.propertyId
          ? { propertyId: params.propertyId }
          : {
              address: params.address,
              streetAddress: params.streetAddress,
              city: params.city,
              state: params.state,
              zipCode: params.zipCode,
            },
        comparablesParams: {
          propertyId: property.id,
          radiusMiles: compParams.radiusMiles ?? 1,
          maxComps: candidateLimit,
          monthsBack: compParams.monthsBack ?? 12,
        },
        enrichmentOptions: enrichOpts,
        retrieval: compsResult.data.retrieval,
      },
    };

    console.log('PropertyAPI: Property bundle complete', {
      propertyId: property.id,
      comparablesCount: bundle.comparables.length,
      hasPermits: !!bundle.enrichment.permits,
      hasFloodZone: !!bundle.enrichment.floodZone,
      hasWeatherRisk: !!bundle.enrichment.weatherRisk,
      hasNeighbourhood: !!bundle.enrichment.neighbourhood,
    });

    // Reset skipCache flag after bundle fetch
    this._skipCache = false;

    return {
      success: true,
      data: bundle,
    };
  }

  /**
   * Enrich comparables with full property details (including subdivision).
   * Fetches property details for each comp in parallel with concurrency control.
   */
  async enrichComparables(
    comparables: NormalizedComparable[],
    options?: { concurrency?: number },
  ): Promise<NormalizedComparable[]> {
    const concurrency = options?.concurrency ?? 10;

    console.log(
      `PropertyAPI: Enriching ${comparables.length} comparables with concurrency ${concurrency}`,
    );

    // Process in batches for concurrency control
    const enriched: NormalizedComparable[] = [];

    for (let i = 0; i < comparables.length; i += concurrency) {
      const batch = comparables.slice(i, i + concurrency);

      const batchResults = await Promise.all(
        batch.map(async (comp) => {
          try {
            // getPropertyById respects _skipCache flag and uses provider-scoped cache
            const result = await this.getPropertyById(comp.id);

            if (result.success) {
              // Resolve any raw CoreLogic codes in cached construction data
              const construction = result.data.construction
                ? this.resolveConstructionCodes(result.data.construction)
                : undefined;

              // Supplement with the /building endpoint when the coded
              // detail block lacks condition/style — provider data, so it
              // outranks any Zillow fills applied later.
              let buildingDetail: NormalizedBuildingDetail | null = null;
              const needsBuilding =
                result.data.parcelId &&
                (!result.data.buildingCondition || !construction?.buildingStyle || !construction?.foundationType);
              if (needsBuilding) {
                const bd = await this.getBuildingDetail(result.data.parcelId as string).catch(() => null);
                if (bd?.success) buildingDetail = bd.data;
              }
              if (buildingDetail) {
                result.data.buildingCondition ??= buildingDetail.condition;
                result.data.buildingGrade ??= null;
                result.data.stories ??= buildingDetail.stories;
              }

              const mergedConstruction = construction || buildingDetail
                ? {
                    ...(construction ?? {}),
                    buildingStyle: construction?.buildingStyle ?? buildingDetail?.buildingStyle ?? undefined,
                    foundationType: construction?.foundationType ?? buildingDetail?.foundation ?? undefined,
                    type: construction?.type ?? buildingDetail?.constructionType ?? undefined,
                    exteriorWalls: construction?.exteriorWalls ?? buildingDetail?.exteriorWalls ?? undefined,
                    roofCover: construction?.roofCover ?? buildingDetail?.roofCover ?? undefined,
                  }
                : undefined;

              return {
                ...comp,
                raw: {
                  ...(comp.raw && typeof comp.raw === 'object' ? comp.raw : {}),
                  enrichment: result.data.raw,
                },
                subdivision: result.data.subdivision ?? null,
                neighborhoodName: result.data.neighborhoodName ?? null,
                neighborhoodCode: result.data.neighborhoodCode ?? null,
                buildingCondition: result.data.buildingCondition ?? null,
                buildingGrade: result.data.buildingGrade ?? null,
                stories: result.data.stories ?? null,
                construction: mergedConstruction,
                transaction: result.data.transaction ? {
                  buyerNames: result.data.transaction.buyerNames,
                  buyerIsCorporate: result.data.transaction.buyerIsCorporate,
                } : undefined,
                features: (result.data.features || buildingDetail) ? {
                  poolType: result.data.features?.poolType ?? buildingDetail?.pool ?? undefined,
                  garageType: result.data.features?.garageType ??
                    (buildingDetail?.parkingType
                      ? (/carport/i.test(buildingDetail.parkingType) ? undefined : buildingDetail.parkingType)
                      : undefined),
                  garageSquareFeet: result.data.features?.garageSquareFeet ?? buildingDetail?.garageSquareFeet ?? undefined,
                  carportType: result.data.features?.carportType ??
                    (buildingDetail?.parkingType && /carport/i.test(buildingDetail.parkingType)
                      ? buildingDetail.parkingType
                      : undefined),
                  heating: result.data.features?.heating ?? buildingDetail?.heating ?? undefined,
                  cooling: result.data.features?.cooling ?? buildingDetail?.cooling ?? undefined,
                  fireplacesCount: result.data.features?.fireplacesCount,
                } : undefined,
                isEnriched: true,
              };
            } else {
              // Some comparables don't have detailed property data available - this is normal
              console.log(
                `PropertyAPI: Comp ${comp.id} has no detailed data (${result.error})`,
              );
              return {
                ...comp,
                subdivision: null,
                isEnriched: false,
              };
            }
          } catch (error) {
            console.log(`PropertyAPI: Error enriching comp ${comp.id}:`, error);
            return {
              ...comp,
              subdivision: null,
              isEnriched: false,
            };
          }
        }),
      );

      enriched.push(...batchResults);

      // Small delay between batches to avoid rate limiting
      if (i + concurrency < comparables.length) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    const enrichedCount = enriched.filter((c) => c.isEnriched).length;
    const withSubdivision = enriched.filter((c) => c.subdivision).length;
    console.log(
      `PropertyAPI: Enrichment complete - ${enrichedCount}/${comparables.length} enriched, ${withSubdivision} have subdivision`,
    );

    return enriched;
  }

  /**
   * Resolve raw CoreLogic codes to labels in construction data (handles KV-cached entries).
   */
  private resolveConstructionCodes(c: NonNullable<NormalizedProperty['construction']>): NonNullable<NormalizedProperty['construction']> {
    return resolveConstructionCodes(c);
  }

  /**
   * Estimate weather risk based on state (simplified heuristic)
   */
  private estimateWeatherRisk(state: string): WeatherRisk {
    const hurricaneStates = ['FL', 'TX', 'LA', 'NC', 'SC', 'GA', 'AL', 'MS'];
    const tornadoAlley = ['TX', 'OK', 'KS', 'NE', 'SD', 'IA', 'MO', 'AR', 'LA'];
    const wildfireStates = ['CA', 'OR', 'WA', 'CO', 'AZ', 'NM', 'MT', 'ID'];
    const earthquakeStates = ['CA', 'AK', 'HI', 'WA', 'OR', 'NV', 'UT'];

    const factors: WeatherRisk['factors'] = {};
    let totalScore = 0;
    let factorCount = 0;

    if (hurricaneStates.includes(state)) {
      factors.hurricane = {
        score: state === 'FL' ? 80 : state === 'TX' || state === 'LA' ? 70 : 50,
      };
      totalScore += factors.hurricane.score;
      factorCount++;
    }

    if (tornadoAlley.includes(state)) {
      factors.tornado = {
        score: ['OK', 'KS', 'TX'].includes(state) ? 70 : 50,
      };
      totalScore += factors.tornado.score;
      factorCount++;
    }

    if (wildfireStates.includes(state)) {
      factors.wildfire = {
        score: state === 'CA' ? 75 : 50,
      };
      totalScore += factors.wildfire.score;
      factorCount++;
    }

    if (earthquakeStates.includes(state)) {
      factors.earthquake = {
        score: state === 'CA' ? 70 : state === 'AK' ? 60 : 40,
      };
      totalScore += factors.earthquake.score;
      factorCount++;
    }

    const overallScore =
      factorCount > 0 ? Math.round(totalScore / factorCount) : 20;

    let riskLevel: WeatherRisk['riskLevel'];
    if (overallScore >= 70) riskLevel = 'severe';
    else if (overallScore >= 50) riskLevel = 'high';
    else if (overallScore >= 30) riskLevel = 'moderate';
    else riskLevel = 'low';

    return {
      overallScore,
      riskLevel,
      factors,
    };
  }

}

// ─── Factory Function ──────────────────────────────────────────────────────────

/**
 * Create a new PropertyAPI service instance
 */
export function createPropertyApi(
  env: Env,
  config?: Partial<PropertyApiConfig>,
): PropertyApiService {
  return new PropertyApi(env, config);
}
