/**
 * Property Analysis Route
 *
 * Async endpoint for complete property analysis using Cloudflare Workflows.
 *
 * Analysis Flow (via AnalysisWorkflow):
 * 1. PropertyApi.getPropertyBundle() - fetches property, comps, enrichment
 * 2. AppraisalService.evaluate() - applies filters & adjustments to comps
 * 3. PhotoProvider.fetchPhotoBundle() - fetches photos in parallel (rate-limited)
 * 4. ClassificationService.classifyProperty() - classifies all properties in parallel
 * 5. ValuationService.calculate() - computes weighted ARV and investment metrics
 *
 * Architecture Benefits (vs Queue-based):
 * - True parallel execution with fan-out
 * - Automatic retries with backoff per step
 * - Durable execution (survives restarts)
 * - Step-level caching
 * - 10-15 seconds vs 60-120 seconds
 *
 * Real-time Updates:
 * - WebSocket streaming via /ws/analyze/:jobId
 * - HTTP polling via GET /analyze/jobs/:jobId
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
import { performAnalysis } from '../services/evaluation'
import { generateSseToken } from '../utils/sse-token'
import { drizzle } from 'drizzle-orm/d1'
import { savedReports } from '../db/schema'

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
        maxComps: body.searchOptions?.maxComps ?? 10,
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

    // ─── 3. Evaluate: appraisal + price classification + valuation ───────────
    const evalStart = Date.now()
    const propertyCallStats = propertyApi.getCallStats()

    const { response: analysisResult } = performAnalysis({
      jobId,
      bundle,
      appraisalRules: userSettings.appraisalRules,
      buybox: userSettings.mergedBuybox,
      customRehabTable: userSettings.customRehabTable,
      customTierRanges: userSettings.customTierRanges,
      customMajorItemCosts: userSettings.customMajorItemCosts,
      arvThreshold: userSettings.arvThreshold,
      apiCallStats: {
        corelogic: {
          total: propertyCallStats.total,
          cached: propertyCallStats.cached,
          endpoints: propertyCallStats.endpoints,
        },
        totalExternalCalls: propertyCallStats.total,
      },
    })

    console.log(`[Analyze][Timing] Evaluation: ${Date.now() - evalStart}ms`)

    // ─── 4. Check if async enrichment is requested ─────────────────────────
    const llmEnabled = body.llmAnalysis?.enabled === true
    const marketDataEnabled = body.marketData?.enabled === true
    const hasEnrichment = llmEnabled || marketDataEnabled

    // ─── 5. Save report to DB (background, non-blocking) ────────────────────
    c.executionCtx.waitUntil((async () => {
      try {
        const db = drizzle(c.env.DB)
        await db.insert(savedReports).values({
          userId: auth.userId,
          jobId,
          propertyAddress: analysisResult.subject.address,
          propertyCity: body.city || bundle.property.city || '',
          propertyState: body.state || bundle.property.state || '',
          propertyZip: body.zipCode || bundle.property.zipCode || '',
          fullResponseJson: JSON.stringify(analysisResult),
          arv: analysisResult.valuation.arv,
          asIsValue: analysisResult.valuation.asIsValue ?? null,
          maxAllowableOffer: analysisResult.valuation.buyPrice,
          estimatedRepairs: analysisResult.valuation.rehabCost,
        })
        console.log(`[Analyze] Report saved for job ${jobId}`)
      } catch (error) {
        console.warn(`[Analyze] Failed to save report (non-fatal):`, error instanceof Error ? error.message : error)
      }
    })())

    // ─── 6. Start background enrichment if enabled ───────────────────────────
    let enrichmentInfo: { streamUrl: string; token: string; pending: string[] } | undefined

    if (hasEnrichment) {
      const pending: string[] = []
      if (marketDataEnabled) pending.push('market_data')
      if (llmEnabled) pending.push('llm')

      // Generate SSE auth token
      const sseSecret = c.env.BETTER_AUTH_SECRET || ''
      const token = await generateSseToken(sseSecret, jobId, auth.userId)
      const apiBaseUrl = c.req.url.replace(/\/v1\/analyze.*/, '')
      const streamUrl = `${apiBaseUrl}/sse/analyze/${jobId}`

      enrichmentInfo = { streamUrl, token, pending }

      // Start enrichment inside the DO (persistent execution context — no waitUntil)
      const doId = c.env.ANALYSIS_JOB.idFromName(jobId)
      const stub = c.env.ANALYSIS_JOB.get(doId)
      const startResp = await stub.fetch('http://internal/start', {
        method: 'POST',
        body: JSON.stringify({
          jobId,
          userId: auth.userId,
          pending,
          bundle,
          evalParams: {
            appraisalRules: userSettings.appraisalRules,
            buybox: userSettings.mergedBuybox,
            customRehabTable: userSettings.customRehabTable,
            customTierRanges: userSettings.customTierRanges,
            customMajorItemCosts: userSettings.customMajorItemCosts,
            arvThreshold: userSettings.arvThreshold,
          },
          analysisResult,
          llmOptions: { includePhotos: body.llmAnalysis?.includePhotos },
        }),
      })
      await startResp.text() // consume response
    }

    console.log(`[Analyze][Timing] Total: ${Date.now() - routeStart}ms`)
    console.log(`[Analyze] Job ${jobId} completed (${bundle.comparables.length} comps, enrichment: ${hasEnrichment ? 'pending' : 'none'})`)

    return c.json({
      success: true,
      data: {
        jobId,
        result: analysisResult,
        ...(enrichmentInfo ? { enrichment: enrichmentInfo } : {}),
      },
    })
  } catch (error) {
    console.error('[Analyze] Error:', error)
    const message = error instanceof Error ? error.message : 'Failed to analyze property'
    const isBadDeal = message.startsWith('BAD_DEAL:')
    return c.json(
      { success: false, error: isBadDeal ? message.replace('BAD_DEAL: ', '') : message },
      isBadDeal ? 400 : 500
    )
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
        maxComps: 10,
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
