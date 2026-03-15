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
  neighbourhoodKey,
  CACHE_TTL,
  type CacheService,
} from '../cache';
import { createNeighbourhoodService, type NeighbourhoodData } from '../neighbourhood';
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
  PropertyApiConfig,
  NormalizedProperty,
  NormalizedComparable,
  NormalizedFloodZone,
  // PropertyBundle types
  PropertyBundle,
  PropertyBundleParams,
  PropertyBundleResponse,
  EnrichmentData,
  EnrichmentOptions,
  PermitsEnrichment,
  WeatherRisk,
} from './types';

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
    this._stats.logCall('property-search');
    return provider.searchProperty(params);
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
    const enrichOpts: EnrichmentOptions = params.enrichment ?? {
      permits: true,
      floodZone: true,
    };

    // Build address strings for providers that need them (e.g. ATTOM permits)
    const address1 = property.address || params.streetAddress || ''
    const address2 = [property.city || params.city, property.state || params.state, property.zipCode || params.zipCode].filter(Boolean).join(', ')

    const [compsResult, permitsResult, floodResult, neighbourhoodResult] = await Promise.all([
      // Get comparables
      this.getComparables({
        propertyId: property.id,
        radiusMiles: compParams.radiusMiles ?? 1,
        maxComps: compParams.maxComps ?? 10,
        monthsBack: compParams.monthsBack ?? 12,
        sqftVariance: compParams.sqftVariance,
        subjectSqft: property.squareFeet ?? undefined,
        subjectPropertyType: property.propertyType ?? undefined,
      }),
      // Get permits (if enabled) — pass address for ATTOM
      enrichOpts.permits !== false
        ? this.getBuildingPermits(property.id, { address1, address2 })
        : Promise.resolve(null),
      // Get flood zone (if enabled and coordinates exist)
      enrichOpts.floodZone !== false && property.latitude && property.longitude
        ? this.getFloodZone(property.latitude, property.longitude)
        : Promise.resolve(null),
      // Get neighbourhood data (community, schools, POI)
      enrichOpts.neighbourhood !== false && property.latitude && property.longitude
        ? this.fetchNeighbourhood(property.latitude, property.longitude, address1)
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
      permitsResult.success &&
      permitsResult.data.permits.length > 0
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
    const weatherRisk: WeatherRisk | null = enrichOpts.weatherRisk
      ? this.estimateWeatherRisk(property.state)
      : null;

    const enrichment: EnrichmentData = {
      permits,
      floodZone,
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
          maxComps: compParams.maxComps ?? 10,
          monthsBack: compParams.monthsBack ?? 12,
        },
        enrichmentOptions: enrichOpts,
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
              return {
                ...comp,
                subdivision: result.data.subdivision ?? null,
                construction: result.data.construction,
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

  /**
   * Fetch neighbourhood data (community, schools, POI) with caching
   */
  private async fetchNeighbourhood(
    latitude: number,
    longitude: number,
    address?: string,
  ): Promise<NeighbourhoodData | null> {
    // Check cache first
    const cacheKey = neighbourhoodKey(latitude, longitude);
    if (!this._skipCache) {
      const cached = await this.cache.get<NeighbourhoodData>(cacheKey);
      if (cached) {
        console.log('PropertyAPI: Cache HIT for neighbourhood', { latitude, longitude });
        return cached;
      }
    }

    console.log('PropertyAPI: Fetching neighbourhood data', { latitude, longitude });

    try {
      const apiKey = this.env.ATTOM_API_KEY ?? '';
      if (!apiKey) {
        console.log('PropertyAPI: No ATTOM API key for neighbourhood data');
        return null;
      }

      const service = createNeighbourhoodService(apiKey);
      const result = await service.getNeighbourhoodData(latitude, longitude, address);

      // Cache the result
      await this.cache.set(cacheKey, result, { ttl: CACHE_TTL.NEIGHBOURHOOD });

      return result;
    } catch (error) {
      console.log('PropertyAPI: Neighbourhood fetch failed:', error instanceof Error ? error.message : error);
      return null;
    }
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
