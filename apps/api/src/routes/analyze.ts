/**
 * Property Analysis Route
 *
 * Synchronous endpoint: CoreLogic fetch → evaluation → JSON response.
 * Optional async enrichment via Durable Objects (Market Data + LLM).
 *
 * Flow:
 * 1. Load user settings (appraisal rules, deal params, rehab config)
 * 2. Fetch property bundle from CoreLogic (property + comps + enrichment)
 * 3. performAnalysis() — Group A comp selection, ARV, Group B as-is intel
 * 4. Return JSON immediately
 * 5. (Optional) Start DO-based enrichment: Zillow scraping + LLM analysis via SSE
 */

import { Hono } from 'hono'
import type { Env } from '../types'
import type { AuthContext } from '../middleware/auth'
import {
  REHAB_LEVELS,
  MAJOR_ITEMS,
  type MajorItem,
} from '../services/valuation'
import { loadUserAnalysisSettings } from '../services/user-settings'
import { createPropertyApi } from '../services/property-api'
import { DEFAULT_FILTERS } from '../services/appraisal'
import { filtersToApiParams } from '../services/appraisal/types'
import { createPhotoService } from '../services/photo-provider'
import type { PropertyIdentifier } from '../services/photo-provider'
import { generateSseToken } from '../utils/sse-token'
import {
  lookupCode,
  BUILDING_STYLE,
  CONSTRUCTION_TYPE,
  FOUNDATION_TYPE,
  ROOF_TYPE,
  ROOF_COVER,
  EXTERIOR_WALLS,
  BUILDING_QUALITY,
  HEATING_TYPE,
  COOLING_TYPE,
  POOL_TYPE,
  GARAGE_TYPE,
} from '../services/property-api/providers/corelogic-codes'

/** Resolve any raw CoreLogic codes to labels in construction/features (handles cached data) */
function resolvePropertyCodes(construction?: Record<string, unknown>, features?: Record<string, unknown>) {
  const c = construction ? {
    ...construction,
    type: lookupCode(CONSTRUCTION_TYPE, construction.type as string) ?? construction.type,
    qualityCode: lookupCode(BUILDING_QUALITY, construction.qualityCode as string) ?? construction.qualityCode,
    buildingStyle: lookupCode(BUILDING_STYLE, construction.buildingStyle as string) ?? construction.buildingStyle,
    foundationType: lookupCode(FOUNDATION_TYPE, construction.foundationType as string) ?? construction.foundationType,
    roofType: lookupCode(ROOF_TYPE, construction.roofType as string) ?? construction.roofType,
    roofCover: lookupCode(ROOF_COVER, construction.roofCover as string) ?? construction.roofCover,
    exteriorWalls: lookupCode(EXTERIOR_WALLS, construction.exteriorWalls as string) ?? construction.exteriorWalls,
  } : undefined
  const f = features ? {
    ...features,
    heating: lookupCode(HEATING_TYPE, features.heating as string) ?? features.heating,
    cooling: lookupCode(COOLING_TYPE, features.cooling as string) ?? features.cooling,
    poolType: lookupCode(POOL_TYPE, features.poolType as string) ?? features.poolType,
    garageType: lookupCode(GARAGE_TYPE, features.garageType as string) ?? features.garageType,
  } : undefined
  return { construction: c, features: f }
}
import { AnalysisError } from '../utils/analysis-error'

type Variables = { auth: AuthContext }

const analyze = new Hono<{ Bindings: Env; Variables: Variables }>()

// ─── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Generate a unique job ID
 */
function generateJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`
}

// ─── Request Types ─────────────────────────────────────────────────────────────

interface AnalyzeRequest {
  // Property identification (one of these required)
  address?: string
  streetAddress?: string
  city?: string
  state?: string
  zipCode?: string
  propertyId?: string

  // Comparable search options
  searchOptions?: {
    radiusMiles?: number
    maxComps?: number
    monthsBack?: number
  }

  // Buybox parameters
  buybox?: {
    rehabLevelIndex?: number
    majorItems?: MajorItem[]
    additionPlay?: number
    closingCostsPercent?: number
    carryingCostsPercent?: number
    wholesaleFee?: number
  }

  // Enrichment options
  enrichment?: {
    permits?: boolean
    floodZone?: boolean
    weatherRisk?: boolean
  }

  /** Skip cache and fetch fresh data from APIs */
  skipCache?: boolean

  /** Override ARV comp threshold for this request (top % of comps by sale price) */
  arvThresholdPercent?: number

  /** Override as-is threshold (% of ARV below which comps are classified as-is) — default 70 */
  asIsThresholdPercent?: number

  /** Override appraisal rules for this request */
  appraisalOverrides?: {
    filters?: Array<{ type: string; enabled: boolean; value: number }>
    adjustments?: Array<{ type: string; enabled: boolean; amount: number; percent?: number }>
  }

  /** Market data enrichment: scrape public listing data via Firecrawl */
  marketData?: {
    enabled?: boolean
  }

  /** LLM-based comp analysis options */
  llmAnalysis?: {
    enabled?: boolean
    includePhotos?: boolean
  }
}

// ─── Main Endpoint ─────────────────────────────────────────────────────────────

/**
 * POST /analyze
 *
 * Start a property analysis using Cloudflare Workflows.
 * Returns immediately with job ID and URLs for status/streaming.
 *
 * Processing is handled by AnalysisWorkflow with parallel execution.
 * Results can be retrieved via:
 * - WebSocket: /ws/analyze/:jobId (real-time updates)
 * - Polling: GET /analyze/jobs/:jobId
 */
analyze.post('/', async (c) => {
  try {
    const routeStart = Date.now()
    const body = await c.req.json<AnalyzeRequest>()
    const auth = c.get('auth')

    // Validate input
    if (!body.address && !body.streetAddress && !body.propertyId) {
      return c.json(
        { success: false, error: 'address, streetAddress, or propertyId is required' },
        400
      )
    }

    const jobId = generateJobId()

    // ─── 1. Load user settings ───────────────────────────────────────────────
    const settingsStart = Date.now()
    const userSettings = await loadUserAnalysisSettings(c.env.DB, {
      userId: auth.userId,
      address: { city: body.city, state: body.state, zipCode: body.zipCode },
      buyboxOverrides: body.buybox,
    }, c.env.API_CACHE)
    console.log(`[Analyze][Timing] User settings: ${Date.now() - settingsStart}ms`)

    // ─── 2. Fetch property bundle from CoreLogic ─────────────────────────────
    const bundleFetchStart = Date.now()
    const propertyApi = createPropertyApi(c.env)
    propertyApi.resetCallStats()
    const filters = userSettings.appraisalRules?.filters ?? DEFAULT_FILTERS
    const apiFilterParams = filtersToApiParams(filters)

    const bundleResult = await propertyApi.getPropertyBundle({
      address: body.address,
      streetAddress: body.streetAddress,
      city: body.city,
      state: body.state,
      zipCode: body.zipCode,
      propertyId: body.propertyId,
      comparables: {
        radiusMiles: body.searchOptions?.radiusMiles ?? apiFilterParams.radiusMiles ?? 1,
        maxComps: body.searchOptions?.maxComps ?? 15,
        monthsBack: body.searchOptions?.monthsBack ?? apiFilterParams.monthsBack ?? 12,
        sqftVariance: apiFilterParams.sqftVariance,
      },
      enrichment: {
        permits: body.enrichment?.permits ?? true,
        floodZone: body.enrichment?.floodZone ?? true,
        weatherRisk: body.enrichment?.weatherRisk ?? false,
        neighbourhood: false,
      },
      skipCache: body.skipCache,
    })

    console.log(`[Analyze][Timing] CoreLogic fetch: ${Date.now() - bundleFetchStart}ms`)

    if (!bundleResult.success) {
      return c.json(
        { success: false, error: bundleResult.error || 'Failed to fetch property data' },
        400
      )
    }

    const bundle = bundleResult.data

    // ─── 3. Build partial result from raw CoreLogic data ───────────────────
    // Return subject + comps immediately so the dashboard can display them
    // while evaluation + enrichment run in the background (DO)
    const propertyCallStats = propertyApi.getCallStats()
    const { property, comparables } = bundle

    // Apply appraisal rule overrides from request (playground inline editing)
    let appraisalRules = userSettings.appraisalRules
    if (body.appraisalOverrides) {
      const overrideFilters = body.appraisalOverrides.filters?.map((f) => ({
        type: f.type as import('../services/appraisal').FilterType,
        enabled: f.enabled,
        value: f.value,
      }))
      const overrideAdjustments = body.appraisalOverrides.adjustments?.map((a) => ({
        type: a.type as import('../services/appraisal').AdjustmentType,
        enabled: a.enabled,
        amount: a.amount,
        percent: a.percent,
      }))
      appraisalRules = {
        filters: overrideFilters ?? appraisalRules?.filters ?? [],
        adjustments: overrideAdjustments ?? appraisalRules?.adjustments ?? [],
      }
    }

    const arvThreshold = body.arvThresholdPercent
      ? { percent: body.arvThresholdPercent }
      : userSettings.arvThreshold

    const evalParams = {
      appraisalRules,
      buybox: userSettings.mergedBuybox,
      customRehabTable: userSettings.customRehabTable,
      customTierRanges: userSettings.customTierRanges,
      customMajorItemCosts: userSettings.customMajorItemCosts,
      arvThreshold,
      asIsThresholdPercent: body.asIsThresholdPercent ?? userSettings.asIsThresholdPercent,
      apiCallStats: {
        corelogic: {
          total: propertyCallStats.total,
          cached: propertyCallStats.cached,
          endpoints: propertyCallStats.endpoints,
        },
        totalExternalCalls: propertyCallStats.total,
      },
    }

    // Build raw partial result — just property data, no evaluation
    const partialResult = {
      subject: {
        id: property.id,
        address: property.address,
        city: property.city,
        state: property.state,
        zipCode: property.zipCode,
        latitude: property.latitude,
        longitude: property.longitude,
        squareFeet: property.squareFeet,
        bedrooms: property.bedrooms,
        bathrooms: property.bathrooms,
        yearBuilt: property.yearBuilt,
        lotSizeAcres: property.lotSizeAcres,
        propertyType: property.propertyType,
        stories: property.stories,
        lastSalePrice: property.lastSalePrice,
        lastSaleDate: property.lastSaleDate,
        assessedValue: property.assessedValue,
        marketValue: property.marketValue,
        subdivision: property.subdivision,
        ...resolvePropertyCodes(property.construction as Record<string, unknown>, property.features as Record<string, unknown>),
        zoning: property.zoning,
      },
      comps: {
        items: comparables.map((comp) => ({
          id: comp.id,
          address: comp.address,
          city: comp.city,
          state: comp.state,
          zipCode: comp.zipCode,
          latitude: comp.latitude,
          longitude: comp.longitude,
          salePrice: comp.salePrice,
          saleDate: comp.saleDate,
          squareFeet: comp.squareFeet,
          bedrooms: comp.bedrooms,
          bathrooms: comp.bathrooms,
          yearBuilt: comp.yearBuilt,
          lotSizeAcres: comp.lotSizeAcres,
          propertyType: comp.propertyType,
          distanceMiles: comp.distanceMiles,
          subdivision: comp.subdivision,
          ...resolvePropertyCodes(comp.construction as Record<string, unknown>),
          pricePerSqft: comp.squareFeet && comp.salePrice ? Math.round(comp.salePrice / comp.squareFeet) : null,
          isEnabled: false,
        })),
        totalCount: comparables.length,
        enabledCount: 0,
        disabledCount: comparables.length,
      },
    }

    // ─── 4. Start background processing: evaluation + enrichment in DO ────
    const pending: string[] = ['evaluation', 'market_data']
    if (c.env.OPENROUTER_API_KEY) pending.push('llm')

    const sseSecret = c.env.BETTER_AUTH_SECRET || ''
    const token = await generateSseToken(sseSecret, jobId, auth.userId)
    const apiBaseUrl = c.req.url.replace(/\/v1\/analyze.*/, '')
    const streamUrl = `${apiBaseUrl}/sse/analyze/${jobId}`

    const doId = c.env.ANALYSIS_JOB.idFromName(jobId)
    const stub = c.env.ANALYSIS_JOB.get(doId)
    const startResp = await stub.fetch('http://internal/start', {
      method: 'POST',
      body: JSON.stringify({
        jobId,
        userId: auth.userId,
        pending,
        bundle,
        evalParams,
        analysisResult: partialResult,
        llmOptions: { includePhotos: body.llmAnalysis?.includePhotos },
      }),
    })
    await startResp.text()

    console.log(`[Analyze][Timing] Total: ${Date.now() - routeStart}ms`)
    console.log(`[Analyze] Job ${jobId} — ${comparables.length} comps, processing in DO (${pending.join(', ')})`)

    return c.json({
      success: true,
      data: {
        jobId,
        partialResult,
        enrichment: { streamUrl, token, pending },
      },
    })
  } catch (error) {
    console.error('[Analyze] Error:', error)

    if (error instanceof AnalysisError) {
      return c.json(
        {
          success: false,
          error: error.message.replace('BAD_DEAL: ', ''),
          ...(error.code ? { code: error.code } : {}),
          ...(error.suggestedFilters ? { suggestedFilters: error.suggestedFilters } : {}),
          ...(error.suggestedArvThreshold ? { suggestedArvThreshold: error.suggestedArvThreshold } : {}),
        },
        400,
      )
    }

    const message = error instanceof Error ? error.message : 'Failed to analyze property'
    return c.json({ success: false, error: message }, 500)
  }
})

/**
 * GET /analyze/defaults
 *
 * Get default values for appraisal rules and buybox parameters
 */
analyze.get('/defaults', async (c) => {
  return c.json({
    success: true,
    data: {
      searchOptions: {
        radiusMiles: 1,
        maxComps: 15,
        monthsBack: 12,
      },
      buybox: {
        rehabLevelIndex: 2,
        closingCostsPercent: 8,
        carryingCostsPercent: 2,
        wholesaleFee: 10000,
      },
      enrichment: {
        permits: true,
        floodZone: true,
        weatherRisk: false,
      },
      rehabLevels: REHAB_LEVELS.map((name, index) => ({ index, name })),
      majorItems: MAJOR_ITEMS,
    },
  })
})

// ─── Lazy Photo Loading ───────────────────────────────────────────────────────

/**
 * POST /analyze/comp-photos
 *
 * Fetch photos + descriptions for comps on demand.
 * Used when a user enables a previously-disabled comp that didn't have photos fetched.
 * Limited to 5 comps per request.
 */
analyze.post('/comp-photos', async (c) => {
  try {
    const auth = c.get('auth')
    const body = await c.req.json<{
      comps: Array<{
        propertyId: string
        address: string
        city?: string
        state?: string
        zipCode?: string
      }>
    }>()

    if (!body.comps || !Array.isArray(body.comps) || body.comps.length === 0) {
      return c.json({ success: false, error: 'comps array is required' }, 400)
    }

    if (body.comps.length > 5) {
      return c.json({ success: false, error: 'Maximum 5 comps per request' }, 400)
    }

    const photoService = createPhotoService(c.env)
    if (!photoService.isAvailable()) {
      return c.json({ success: false, error: 'Photo provider not available' }, 503)
    }

    const properties: PropertyIdentifier[] = body.comps.map((comp) => ({
      propertyId: comp.propertyId,
      address: comp.address,
      city: comp.city ?? '',
      state: comp.state ?? '',
      zipCode: comp.zipCode ?? '',
    }))

    const bulkResult = await photoService.fetchBulkPhotos(properties)

    const data: Record<string, {
      photos: string[]
      description?: string
      features?: string[]
      sourceUrl?: string
    }> = {}

    for (const [propertyId, photos] of bulkResult.results) {
      data[propertyId] = {
        photos: photos.photos,
        description: photos.description,
        features: photos.features,
        sourceUrl: photos.sourceUrl,
      }
    }

    console.log(`[Analyze] Lazy photo fetch for user ${auth.userId}: ${bulkResult.results.size}/${body.comps.length} successful`)

    return c.json({
      success: true,
      data,
      summary: bulkResult.summary,
    })
  } catch (error) {
    console.error('[Analyze Comp Photos] Error:', error)
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch comp photos',
      },
      500
    )
  }
})

export default analyze
