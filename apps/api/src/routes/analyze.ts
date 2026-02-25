/**
 * Property Analysis Route
 *
 * Async endpoint for complete property analysis using Cloudflare Workflows.
 *
 * Analysis Flow (via AnalysisWorkflow):
 * 1. PropertyApi.getPropertyBundle() - fetches property, comps, enrichment
 * 2. AppraisalService.evaluate() - applies filters & adjustments to comps
 * 3. PhotoProvider.fetchPhotoBundle() - fetches photos in parallel (rate-limited)
 * 4. BatchClassificationService.classifyBatch() - classifies ALL properties in 1-2 LLM calls
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
  DEFAULT_FILTERS,
  DEFAULT_ADJUSTMENTS,
  type AppraisalFilter,
  type AppraisalAdjustment,
} from '../services/appraisal'
import {
  REHAB_LEVELS,
  MAJOR_ITEMS,
  type MajorItem,
} from '../services/valuation'
import type { QueueJobResponse, JobStatusResponse } from '../durable-objects/types'
import type { AnalysisWorkflowParams } from '../workflows/types'
import { generateWsToken } from '../utils/ws-token'

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

  // Appraisal rules preset
  appraisalRules?: {
    filters?: AppraisalFilter[]
    adjustments?: AppraisalAdjustment[]
  }

  // Buybox parameters
  buybox?: {
    rehabLevelIndex?: number
    majorItems?: MajorItem[]
    additionPlay?: number
    closingCostsPercent?: number
    carryingCostsPercent?: number
    wholesaleFee?: number
    desiredProfit?: number
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

    // Start the workflow
    const workflowParams: AnalysisWorkflowParams = {
      jobId,
      userId: auth.userId,
      propertyKey,
      address: body.address,
      streetAddress: body.streetAddress,
      city: body.city,
      state: body.state,
      zipCode: body.zipCode,
      propertyId: body.propertyId,
      searchOptions: body.searchOptions,
      enrichment: body.enrichment,
      photoAnalysis: body.photoAnalysis ?? body.zillowContext,
      appraisalRules: body.appraisalRules,
      buybox: body.buybox,
      skipCache: body.skipCache,
    }

    const workflow = await c.env.ANALYSIS_WORKFLOW.create({
      id: jobId,
      params: workflowParams,
    })

    console.log(`[Analyze] Job ${jobId} started via Workflow (instance: ${workflow.id})`)

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
        estimatedDurationMs: body.photoAnalysis?.enabled !== false ? 15000 : 8000,
      },
    }

    return c.json(response, 202)
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
 * POST /analyze/ws-token
 *
 * Generate a short-lived signed token for WebSocket authentication.
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
analyze.post('/ws-token', async (c) => {
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
      console.error('[WS Token] DASHBOARD_INTERNAL_SECRET not configured')
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

    // Build WebSocket URL
    const baseUrl = new URL(c.req.url)
    const wsProtocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${wsProtocol}//${baseUrl.host}/ws/analyze/${body.jobId}?token=${encodeURIComponent(token)}`

    console.log(`[WS Token] Generated WS URL: ${wsUrl}`)

    return c.json({
      success: true,
      data: {
        token,
        wsUrl,
        expiresIn: 300, // 5 minutes in seconds
      },
    })
  } catch (error) {
    console.error('[WS Token] Error:', error)
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
      appraisalRules: {
        filters: DEFAULT_FILTERS,
        adjustments: DEFAULT_ADJUSTMENTS,
      },
      buybox: {
        rehabLevelIndex: 2,
        closingCostsPercent: 10,
        carryingCostsPercent: 5,
        wholesaleFee: 10000,
      },
      enrichment: {
        permits: true,
        floodZone: true,
        weatherRisk: false,
      },
      photoAnalysis: {
        enabled: true, // Now enabled by default since workflows are fast
        maxComps: 10,
        requireBetterOrEqual: true,
      },
      zillowContext: {
        enabled: true,
        skipCache: false,
        maxComps: 10,
      },
      rehabLevels: REHAB_LEVELS.map((name, index) => ({ index, name })),
      majorItems: MAJOR_ITEMS,
    },
  })
})

export default analyze
