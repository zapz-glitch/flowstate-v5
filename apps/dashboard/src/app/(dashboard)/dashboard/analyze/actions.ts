'use server'

import { getSession } from '@/lib/api'
import { getCloudflareEnv } from '@/lib/cloudflare'

// ─── Logging Utilities ───────────────────────────────────────────────────────

const LOG_PREFIX = '[Dashboard Analyze]'

function log(message: string, data?: unknown) {
  const timestamp = new Date().toISOString()
  if (data) {
    console.log(`${LOG_PREFIX} ${timestamp} ${message}`, data)
  } else {
    console.log(`${LOG_PREFIX} ${timestamp} ${message}`)
  }
}

function logError(message: string, error?: unknown) {
  const timestamp = new Date().toISOString()
  console.error(`${LOG_PREFIX} ${timestamp} ✗ ${message}`, error)
}

function logApiCall(method: string, url: string, status?: number, durationMs?: number) {
  const timestamp = new Date().toISOString()
  if (status !== undefined) {
    const statusEmoji = status >= 200 && status < 300 ? '✓' : '✗'
    console.log(`${LOG_PREFIX} ${timestamp} ← ${method} ${url} ${statusEmoji} ${status} (${durationMs}ms)`)
  } else {
    console.log(`${LOG_PREFIX} ${timestamp} → ${method} ${url}`)
  }
}

// Get API URL - inlined at build time via next.config.js
function getApiUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL!
}

// Get dashboard internal secret for API auth
async function getDashboardSecret(): Promise<string> {
  const env = await getCloudflareEnv()
  return env.DASHBOARD_INTERNAL_SECRET || ''
}

export interface AnalyzeRequest {
  address: string
  photoAnalysis?: {
    enabled?: boolean
    maxComps?: number
    requireBetterOrEqual?: boolean
  }
  searchOptions?: {
    radiusMiles?: number
    maxComps?: number
    monthsBack?: number
  }
  /** Skip cache and fetch fresh data from APIs */
  skipCache?: boolean
  /** Appraisal preset ID to use for filters and adjustments */
  appraisalPresetId?: string
}

export type AnalyzeResult =
  | { success: true; data: AnalyzeData; timing: { durationMs: number } }
  | { success: false; error: string }

// ─── API Response Types (Simplified Underwriter Format) ──────────────────────

export interface AnalyzeData {
  subject?: SubjectData
  valuation?: ValuationData
  comps?: CompsData
  riskFlags?: string[] | null
  permits?: PermitsData | null
  floodZone?: FloodZoneData | null
  meta?: {
    analysisId?: string
    timestamp?: string
    dataProvider?: string
  }
}

/** Property classification (As-Is vs After-Renovation) */
export interface ClassificationSummary {
  type: 'as_is' | 'after_renovation' | 'transitional'
  confidence: number
  reasoning: string
  method?: string
}

export interface SubjectData {
  address?: string
  county?: string | null
  bedrooms?: number | null
  bathrooms?: number | null
  /** @deprecated Use bedrooms and bathrooms separately */
  bedsBaths?: string
  squareFeet?: number | null
  lotSizeAcres?: number | null
  yearBuilt?: number | null
  propertyType?: string | null
  /** Subdivision name (if available) */
  subdivision?: string | null
  lastSale?: {
    price?: number
    date?: string | null
    pricePerSqft?: number | null
  } | null
  taxAssessment?: number | null
  photos?: string[]
  /** Foundation type (e.g., Slab, Crawl Space, Basement) */
  foundationType?: string | null
  /** Property classification (as_is, after_renovation, transitional) */
  classification?: ClassificationSummary | null
}

export interface RehabLevelEstimate {
  index: number
  name: string
  perSqft: number
  estimatedCost: number
  buyPrice: number
  wholesalePrice: number
  projectedProfit: number
  projectedROI: number
  isSelected: boolean
}

export interface ValuationData {
  arv?: number
  arvSource?: string
  arvPerSqft?: number
  buyPrice?: number
  buyPricePercent?: number
  rehabCost?: number
  rehabLevel?: string
  rehabPerSqft?: number
  /** All rehab level estimates with costs calculated for the current ARV */
  rehabLevelEstimates?: RehabLevelEstimate[]
  totalCosts?: number
  totalInvestment?: number
  projectedProfit?: number
  projectedROI?: number
  wholesalePrice?: number
  recommendation?: string
  recommendationReason?: string
}

export interface CompsData {
  count?: number
  avgPricePerSqft?: number | null
  medianPrice?: number | null
  items?: CompItem[]
}

export interface CompItem {
  address?: string
  salePrice?: number | null
  saleDate?: string | null
  squareFeet?: number | null
  pricePerSqft?: number | null
  distanceMiles?: number | null
  bedrooms?: number | null
  bathrooms?: number | null
  /** @deprecated Use bedrooms and bathrooms separately */
  bedsBaths?: string
  yearBuilt?: number | null
  adjustedPrice?: number | null
  qualityScore?: number | null
  condition?: string | null
  isBestComp?: boolean
  photos?: string[]
  /** Subdivision name (if available) */
  subdivision?: string | null
  /** Foundation type (e.g., Slab, Crawl Space, Basement) */
  foundationType?: string | null
  /** Reason this comp was selected/analyzed (LLM reasoning) */
  selectionReason?: string | null
  /** Key features identified by LLM analysis */
  keyFeatures?: string[] | null
  /** Whether this comp is enabled (passed all filters) */
  isEnabled?: boolean
  /** Reasons why this comp was disabled (if any) */
  disableReasons?: string[]
  /** Property classification (as_is, after_renovation, transitional) */
  classification?: ClassificationSummary | null
  /** Weight contribution to ARV calculation (0-1) */
  weightInArv?: number | null
  /** Appraisal rule evaluation details */
  appraisalRules?: {
    /** Whether this comp passed all filters */
    passedFilters: boolean
    /** Total adjustment amount applied to price */
    totalAdjustment: number
    /** Filter results - which rules matched/failed */
    filters: Array<{
      type: string
      passed: boolean
      reason?: string
      actualValue?: number | string | null
      threshold?: number | string | null
    }>
    /** Adjustment results - what price adjustments were applied */
    adjustments: Array<{
      type: string
      applied: boolean
      amount: number
      reason?: string
    }>
  } | null
}

export interface PermitsData {
  count?: number
  totalValue?: number
  recentTypes?: string[]
}

export interface FloodZoneData {
  zone?: string | null
  inFloodZone?: boolean
  description?: string | null
}

// Legacy types for backward compatibility (deprecated)
export type PropertyData = SubjectData
export type ComparablesData = CompsData
export type EnrichmentData = {
  permits?: PermitsData | null
  floodZone?: FloodZoneData | null
}

// ─── Async Analysis Types ─────────────────────────────────────────────────────

export interface QueueAnalysisResult {
  success: boolean
  jobId?: string
  status?: string
  streamUrl?: string
  pollUrl?: string
  propertyKey?: string
  estimatedDurationMs?: number
  error?: string
}

export interface JobStatusResult {
  success: boolean
  data?: {
    jobId: string
    status: string
    currentStep: string | null
    progress: {
      completedSteps: number
      totalSteps: number
      percentComplete: number
    }
    steps: Array<{
      step: string
      status: string
      startedAt?: string
      completedAt?: string
      durationMs?: number
      message?: string
      error?: string
      fromCache?: boolean
    }>
    createdAt: string
    startedAt: string | null
    completedAt: string | null
    totalDurationMs: number | null
    result?: AnalyzeData
    error?: {
      code: string
      message: string
      step?: string
      retryable: boolean
    }
  }
  error?: string
}

/**
 * Queue a property analysis job
 * Returns job ID and URLs for streaming/polling
 *
 * Security flow:
 * 1. Queue the job via /v1/analyze (authenticated with dashboard headers)
 * 2. Request a short-lived signed WS token from /v1/analyze/ws-token
 * 3. Return the token-authenticated WebSocket URL
 */
export async function queueAnalysis(request: AnalyzeRequest): Promise<QueueAnalysisResult> {
  log('queueAnalysis called', { address: request.address, skipCache: request.skipCache })

  const session = await getSession()
  if (!session?.user) {
    logError('User not authenticated')
    return {
      success: false,
      error: 'Not authenticated. Please log in to use this feature.',
    }
  }

  log(`User authenticated: ${session.user.id} (${session.user.email})`)

  const dashboardSecret = await getDashboardSecret()
  if (!dashboardSecret) {
    logError('Dashboard secret not configured')
    return {
      success: false,
      error: 'Dashboard configuration error. Please contact support.',
    }
  }

  try {
    const apiUrl = await getApiUrl()

    // Step 1: Queue the analysis job
    const analyzeUrl = `${apiUrl}/v1/analyze`
    const requestBody = {
      address: request.address,
      photoAnalysis: request.photoAnalysis ?? { enabled: true, maxComps: 10, requireBetterOrEqual: true },
      searchOptions: request.searchOptions ?? {
        radiusMiles: 1,
        maxComps: 10,
        monthsBack: 12,
      },
      skipCache: request.skipCache,
      appraisalPresetId: request.appraisalPresetId,
    }

    logApiCall('POST', analyzeUrl)
    log('Request body', requestBody)

    const startTime = Date.now()
    const response = await fetch(analyzeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Dashboard-User-Id': session.user.id,
        'X-Dashboard-Secret': dashboardSecret,
      },
      body: JSON.stringify(requestBody),
    })

    const durationMs = Date.now() - startTime
    logApiCall('POST', analyzeUrl, response.status, durationMs)

    const result = await response.json() as {
      success?: boolean
      error?: string
      data?: {
        jobId: string
        propertyKey: string
        status: string
        streamUrl: string
        pollUrl: string
        estimatedDurationMs?: number
      }
    }

    if (!response.ok || !result.success) {
      logError('Queue analysis failed', { status: response.status, error: result.error })
      return {
        success: false,
        error: result.error || `API request failed with status ${response.status}`,
      }
    }

    // Use property key from API response (ensures consistency with queue processor)
    const jobId = result.data?.jobId
    const propertyKey = result.data?.propertyKey

    log('Job queued successfully', { jobId, propertyKey, status: result.data?.status })

    if (!jobId || !propertyKey) {
      logError('Missing jobId or propertyKey in response')
      return {
        success: false,
        error: 'No job ID or property key returned from API',
      }
    }

    // Step 2: Request a signed WebSocket token
    const tokenUrl = `${apiUrl}/v1/analyze/ws-token`
    logApiCall('POST', tokenUrl)

    const tokenStartTime = Date.now()
    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Dashboard-User-Id': session.user.id,
        'X-Dashboard-Secret': dashboardSecret,
      },
      body: JSON.stringify({
        jobId,
        propertyKey,
      }),
    })

    const tokenDurationMs = Date.now() - tokenStartTime
    logApiCall('POST', tokenUrl, tokenResponse.status, tokenDurationMs)

    const tokenResult = await tokenResponse.json() as {
      success?: boolean
      error?: string
      data?: {
        token: string
        wsUrl: string
        expiresIn: number
      }
    }

    if (!tokenResponse.ok || !tokenResult.success) {
      // Fall back to polling if token generation fails
      log('WS token generation failed, falling back to polling', { error: tokenResult.error })
      return {
        success: true,
        jobId,
        status: result.data?.status,
        streamUrl: undefined, // No WebSocket, use polling
        pollUrl: result.data?.pollUrl,
        propertyKey,
        estimatedDurationMs: result.data?.estimatedDurationMs,
      }
    }

    log('WS token obtained successfully', { wsUrl: tokenResult.data?.wsUrl, expiresIn: tokenResult.data?.expiresIn })

    return {
      success: true,
      jobId,
      status: result.data?.status,
      streamUrl: tokenResult.data?.wsUrl,
      pollUrl: result.data?.pollUrl,
      propertyKey,
      estimatedDurationMs: result.data?.estimatedDurationMs,
    }
  } catch (error) {
    logError('queueAnalysis exception', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to queue analysis',
    }
  }
}

/**
 * Get job status via polling
 */
export async function getJobStatus(jobId: string, propertyKey: string): Promise<JobStatusResult> {
  const session = await getSession()
  if (!session?.user) {
    logError('getJobStatus: User not authenticated')
    return {
      success: false,
      error: 'Not authenticated',
    }
  }

  const dashboardSecret = await getDashboardSecret()
  if (!dashboardSecret) {
    logError('getJobStatus: Dashboard secret not configured')
    return {
      success: false,
      error: 'Dashboard configuration error',
    }
  }

  try {
    const apiUrl = await getApiUrl()
    const url = new URL(`${apiUrl}/v1/analyze/jobs/${jobId}`)
    url.searchParams.set('propertyKey', propertyKey)

    logApiCall('GET', url.toString())
    const startTime = Date.now()

    const response = await fetch(url.toString(), {
      headers: {
        'X-Dashboard-User-Id': session.user.id,
        'X-Dashboard-Secret': dashboardSecret,
      },
    })

    const durationMs = Date.now() - startTime
    logApiCall('GET', url.toString(), response.status, durationMs)

    const result = await response.json() as { success?: boolean; error?: string; data?: JobStatusResult['data'] }

    if (!response.ok) {
      logError('getJobStatus failed', { status: response.status, error: result.error })
      return {
        success: false,
        error: result.error || `Failed to get job status`,
      }
    }

    log('Job status retrieved', {
      jobId,
      status: result.data?.status,
      currentStep: result.data?.currentStep,
      progress: result.data?.progress?.percentComplete,
    })

    return { success: true, data: result.data } as JobStatusResult
  } catch (error) {
    logError('getJobStatus exception', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get job status',
    }
  }
}

// ─── Appraisal Presets ─────────────────────────────────────────────────────────

export interface AppraisalPresetSummary {
  id: string
  name: string
  isDefault: boolean
}

export async function getAppraisalPresets(): Promise<AppraisalPresetSummary[]> {
  const session = await getSession()
  if (!session?.user) {
    return []
  }

  try {
    const apiUrl = getApiUrl()
    const response = await fetch(`${apiUrl}/appraisal-presets`, {
      headers: {
        Cookie: '', // Server-side fetch needs cookie forwarding
      },
      credentials: 'include',
    })

    if (!response.ok) {
      return []
    }

    const result = (await response.json()) as {
      presets: Array<{ id: string; name: string; isDefault: boolean }>
    }
    return result.presets.map((p) => ({
      id: p.id,
      name: p.name,
      isDefault: p.isDefault,
    }))
  } catch {
    return []
  }
}

