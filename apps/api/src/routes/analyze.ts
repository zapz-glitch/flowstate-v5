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
import type { QueueJobResponse, JobStatusResponse } from '../durable-objects/types'
import type { AnalysisWorkflowParams } from '../workflows/types'
import { generateWsToken } from '../utils/ws-token'
import { loadUserAnalysisSettings } from '../services/user-settings'
import { createPropertyApi } from '../services/property-api'
import { DEFAULT_FILTERS } from '../services/appraisal'
import { filtersToApiParams } from '../services/appraisal/types'
import { generateZillowUrl, createPhotoService } from '../services/photo-provider'
import type { PropertyIdentifier } from '../services/photo-provider'

type Variables = { auth: AuthContext }

const analyze = new Hono<{ Bindings: Env; Variables: Variables }>()

// ─── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Generate a unique job ID
 */
function generateJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`
}

/**
 * Normalize property key for DO identification
 */
function normalizePropertyKey(request: AnalyzeRequest): string {
  if (request.propertyId) {
    return `pid:${request.propertyId}`
  }

  // Create a hash of the address components
  const addressParts = [
    request.address || request.streetAddress || '',
    request.city || '',
    request.state || '',
    request.zipCode || '',
  ]
    .map((s) => s.toLowerCase().trim())
    .join('|')

  // Use a simple hash for the key
  let hash = 0
  for (let i = 0; i < addressParts.length; i++) {
    const char = addressParts.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // Convert to 32bit integer
  }
  return `addr:${Math.abs(hash).toString(36)}`
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

  // Photo analysis options
  photoAnalysis?: {
    /** Enable photo fetching and AI vision analysis */
    enabled?: boolean
    /** Photo provider to use (auto-detected if not specified) */
    provider?: 'zillow' | 'mls' | 'redfin'
    /** Max comps to fetch photos for (default: 10) */
    maxComps?: number
    /** Require comps to be better than or equal to subject (default: true) */
    requireBetterOrEqual?: boolean
  }

  /**
   * Zillow URL Context options (via Gemini URL Context tool)
   *
   * When enabled, fetches property data from Zillow using Gemini's URL context
   * capability. This provides photos, description, price history, and features.
   *
   * Note: This uses Gemini for web page understanding, NOT for vision analysis.
   * Vision analysis (photo comparison) uses OpenRouter.
   */
  zillowContext?: {
    /** Enable Zillow URL context fetching via Gemini */
    enabled?: boolean
    /** Skip cache and fetch fresh data from Gemini */
    skipCache?: boolean
    /** Max comps to fetch Zillow data for (default: 10) */
    maxComps?: number
  }

  /** Skip cache and fetch fresh data from APIs */
  skipCache?: boolean

  /** Enable AI vision analysis of subject property photos (runs in background after results) */
  visionClassification?: boolean
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

    // Generate job ID and property key
    const jobId = generateJobId()
    const propertyKey = normalizePropertyKey(body)

    // Get or create the AnalysisJob DO
    const doId = c.env.ANALYSIS_JOB.idFromName(`${auth.userId}:${propertyKey}`)
    const jobDO = c.env.ANALYSIS_JOB.get(doId)

    const doInitStart = Date.now()
    // Initialize job state in DO
    const initResponse = await jobDO.fetch(
      new Request('http://internal/init', {
        method: 'POST',
        body: JSON.stringify({
          jobId,
          userId: auth.userId,
          apiKeyId: auth.apiKeyId,
          propertyKey,
          request: body,
        }),
      })
    )

    if (!initResponse.ok) {
      const error = await initResponse.json() as { error?: string }
      return c.json(
        { success: false, error: error.error || 'Failed to initialize job' },
        500
      )
    }
    // Consume response body to properly dispose RPC result
    await initResponse.text()
    console.log(`[Analyze][Timing] DO init: ${Date.now() - doInitStart}ms`)

    // Load all user settings (appraisal presets, rehab config, deal params, location overrides)
    const settingsStart = Date.now()
    const userSettings = await loadUserAnalysisSettings(c.env.DB, {
      userId: auth.userId,
      address: { city: body.city, state: body.state, zipCode: body.zipCode },
      buyboxOverrides: body.buybox,
    }, c.env.API_CACHE)
    console.log(`[Analyze][Timing] User settings load: ${Date.now() - settingsStart}ms`)

    // ─── Fetch property bundle synchronously ─────────────────────────────────
    const bundleFetchStart = Date.now()
    // This eliminates Cloudflare Workflow Step 1 overhead (~1-2s checkpoint latency)
    // and lets us return property data immediately in the HTTP response.
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

    console.log(`[Analyze][Timing] Property bundle fetch: ${Date.now() - bundleFetchStart}ms`)

    if (!bundleResult.success) {
      return c.json(
        { success: false, error: bundleResult.error || 'Failed to fetch property data' },
        400
      )
    }

    const bundle = bundleResult.data
    const { property, enrichment } = bundle

    // Capture property API call stats before handing off to workflow (separate isolate)
    const propertyCallStats = propertyApi.getCallStats()
    const preloadedApiCallStats = {
      corelogic: {
        total: propertyCallStats.total,
        cached: propertyCallStats.cached,
        endpoints: propertyCallStats.endpoints,
      },
    }

    // Build the rendered step_data shape (same as workflow's broadcastStepData for property_fetch)
    const riskFlags: string[] = []
    if (enrichment.floodZone?.isInFloodZone) riskFlags.push(`Flood Zone: ${enrichment.floodZone.floodZone}`)
    if (property.transaction?.isForeclosure) riskFlags.push('Foreclosure')
    if (property.transaction?.isShortSale) riskFlags.push('Short Sale')
    if (property.yearBuilt && property.yearBuilt < 1978) riskFlags.push('Pre-1978 (Lead Paint)')
    if (enrichment.permits?.items.some((p) => p.jobValue && p.jobValue > 50000)) riskFlags.push('Major Permits (>$50K)')

    const propertyBundleResponse = {
      subject: {
        address: `${property.address}, ${property.city}, ${property.state} ${property.zipCode}`,
        county: property.county ?? null,
        latitude: property.latitude ?? null,
        longitude: property.longitude ?? null,
        bedrooms: property.bedrooms ?? null,
        bathrooms: property.bathrooms ?? null,
        squareFeet: property.squareFeet ?? null,
        lotSizeAcres: property.lotSizeAcres ?? null,
        yearBuilt: property.yearBuilt ?? null,
        propertyType: property.propertyType ?? null,
        subdivision: property.subdivision ?? null,
        lastSale: property.lastSalePrice ? {
          price: property.lastSalePrice,
          date: property.lastSaleDate ?? null,
          pricePerSqft: property.pricePerSqft ?? null,
        } : null,
        taxAssessment: property.assessedValue ?? null,
        foundationType: property.construction?.foundationType ?? null,
        hoaFee: property.hoaFee ?? null,
        zillowUrl: generateZillowUrl({
          propertyId: property.id,
          address: property.address,
          city: property.city,
          state: property.state,
          zipCode: property.zipCode,
        }),
        photos: [],
        classification: null,
      },
      riskFlags: riskFlags.length > 0 ? riskFlags : null,
      floodZone: enrichment.floodZone ? {
        zone: enrichment.floodZone.floodZone,
        inFloodZone: enrichment.floodZone.isInFloodZone,
        description: enrichment.floodZone.floodZoneDescription,
      } : null,
      permits: enrichment.permits ? {
        count: enrichment.permits.count,
        totalValue: enrichment.permits.totalJobValue ?? null,
        recentTypes: (enrichment.permits.recentPermitTypes ?? []).slice(0, 5),
      } : null,
      meta: {
        analysisId: jobId,
        timestamp: new Date().toISOString(),
        dataProvider: property.provider,
      },
    }

    // Broadcast step_data to DO so SSE late-joiners get it
    const stepDataBroadcastStart = Date.now()
    const stepDataResponse = await jobDO.fetch(
      new Request('http://internal/step-data', {
        method: 'POST',
        body: JSON.stringify({
          step: 'property_fetch',
          data: propertyBundleResponse,
        }),
      })
    )
    // Consume response body to properly dispose RPC result
    await stepDataResponse.text()

    console.log(`[Analyze][Timing] Step data broadcast: ${Date.now() - stepDataBroadcastStart}ms`)

    // Start the workflow with preloaded bundle (skips Step 1)
    const workflowCreateStart = Date.now()
    const workflowParams: AnalysisWorkflowParams = {
      jobId,
      userId: auth.userId,
      propertyKey,
      address: body.address,
      streetAddress: body.streetAddress,
      city: body.city || property.city,
      state: body.state || property.state,
      zipCode: body.zipCode || property.zipCode,
      propertyId: body.propertyId,
      searchOptions: body.searchOptions,
      enrichment: body.enrichment,
      photoAnalysis: body.photoAnalysis ?? body.zillowContext,
      appraisalRules: userSettings.appraisalRules,
      buybox: userSettings.mergedBuybox,
      skipCache: body.skipCache,
      customRehabTable: userSettings.customRehabTable,
      customTierRanges: userSettings.customTierRanges,
      customMajorItemCosts: userSettings.customMajorItemCosts,
      preloadedPropertyBundle: bundle,
      preloadedApiCallStats,
      visionClassification: body.visionClassification ?? false, // Off by default — runs in background when enabled
    }

    const workflow = await c.env.ANALYSIS_WORKFLOW.create({
      id: jobId,
      params: workflowParams,
    })

    console.log(`[Analyze][Timing] Workflow create: ${Date.now() - workflowCreateStart}ms`)
    console.log(`[Analyze][Timing] Total route handler: ${Date.now() - routeStart}ms`)
    console.log(`[Analyze] Job ${jobId} started via Workflow (instance: ${workflow.id}, property preloaded)`)

    // Build response URLs
    const baseUrl = new URL(c.req.url).origin
    const response: QueueJobResponse = {
      success: true,
      data: {
        jobId,
        propertyKey,
        status: 'queued',
        streamUrl: `${baseUrl}/v1/analyze/jobs/${jobId}/stream`,
        pollUrl: `${baseUrl}/v1/analyze/jobs/${jobId}`,
        estimatedDurationMs: body.photoAnalysis?.enabled !== false ? 12000 : 6000,
        propertyBundle: propertyBundleResponse,
      },
    }

    return c.json(response, 200)
  } catch (error) {
    console.error('[Analyze] Error starting job:', error)
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start analysis job',
      },
      500
    )
  }
})

/**
 * GET /analyze/jobs/:jobId
 *
 * Get the current status of an analysis job.
 * Returns job state, progress, and result (if completed).
 */
analyze.get('/jobs/:jobId', async (c) => {
  try {
    const jobId = c.req.param('jobId')
    const auth = c.get('auth')

    // Parse job ID to get property key
    // Job IDs contain timestamp and random suffix, we need to find the DO
    // For now, we'll search through possible DOs or require the property key

    // Get all job DOs for this user (this is a simplified approach)
    // In production, you might want to store job ID -> DO name mapping in KV

    // Try to find the job by iterating or use a stored mapping
    // For simplicity, we'll return a not found for now if we can't locate it
    // A better approach would be to store jobId -> propertyKey mapping in KV

    // Check if jobId includes property key hint (could be passed as query param)
    const propertyKey = c.req.query('propertyKey')

    if (!propertyKey) {
      return c.json(
        { success: false, error: 'propertyKey query parameter required to locate job' },
        400
      )
    }

    const doId = c.env.ANALYSIS_JOB.idFromName(`${auth.userId}:${propertyKey}`)
    const jobDO = c.env.ANALYSIS_JOB.get(doId)

    const stateResponse = await jobDO.fetch(new Request('http://internal/state'))

    if (!stateResponse.ok) {
      await stateResponse.text() // Consume body to dispose RPC result
      if (stateResponse.status === 404) {
        return c.json({ success: false, error: 'Job not found' }, 404)
      }
      return c.json({ success: false, error: 'Failed to get job status' }, 500)
    }

    const state = await stateResponse.json() as JobStatusResponse

    // Verify job ID matches
    if (state.data.jobId !== jobId) {
      return c.json({ success: false, error: 'Job not found' }, 404)
    }

    return c.json(state)
  } catch (error) {
    console.error('[Analyze Job Status] Error:', error)
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get job status',
      },
      500
    )
  }
})

/**
 * POST /analyze/stream-token
 *
 * Generate a short-lived signed token for SSE stream authentication.
 * This endpoint requires authentication (via auth middleware).
 *
 * The token is HMAC-SHA256 signed and contains:
 * - userId: The authenticated user's ID
 * - jobId: The job to connect to
 * - propertyKey: The property key for DO lookup
 * - exp: Expiry timestamp (5 minutes from now)
 *
 * Security:
 * - Tokens expire after 5 minutes
 * - Tokens are scoped to specific job and property
 * - Signature prevents tampering
 */
analyze.post('/stream-token', async (c) => {
  try {
    const auth = c.get('auth')
    const body = await c.req.json<{ jobId: string; propertyKey: string }>()

    if (!body.jobId || !body.propertyKey) {
      return c.json(
        { success: false, error: 'jobId and propertyKey are required' },
        400
      )
    }

    const secret = c.env.DASHBOARD_INTERNAL_SECRET
    if (!secret) {
      console.error('[Stream Token] DASHBOARD_INTERNAL_SECRET not configured')
      return c.json(
        { success: false, error: 'Server configuration error' },
        500
      )
    }

    // Generate signed token
    const token = await generateWsToken(
      auth.userId,
      body.jobId,
      body.propertyKey,
      secret
    )

    // Build SSE URL
    const baseUrl = new URL(c.req.url)
    const streamUrl = `${baseUrl.protocol}//${baseUrl.host}/sse/analyze/${body.jobId}?token=${encodeURIComponent(token)}`

    console.log(`[Stream Token] Generated SSE URL: ${streamUrl}`)

    return c.json({
      success: true,
      data: {
        token,
        streamUrl,
        expiresIn: 300, // 5 minutes in seconds
      },
    })
  } catch (error) {
    console.error('[Stream Token] Error:', error)
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to generate token',
      },
      500
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
      photoAnalysis: {
        enabled: true,
        maxComps: 5,
        requireBetterOrEqual: true,
      },
      zillowContext: {
        enabled: true,
        skipCache: false,
        maxComps: 5,
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
