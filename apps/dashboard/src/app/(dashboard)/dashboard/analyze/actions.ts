'use server'

import { getSession } from '@/lib/api'
import { getCloudflareEnv } from '@/lib/cloudflare'

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
  /** Property classification (as_is, after_renovation, transitional) */
  classification?: ClassificationSummary | null
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
  const session = await getSession()
  if (!session?.user) {
    return {
      success: false,
      error: 'Not authenticated. Please log in to use this feature.',
    }
  }

  const dashboardSecret = await getDashboardSecret()
  if (!dashboardSecret) {
    return {
      success: false,
      error: 'Dashboard configuration error. Please contact support.',
    }
  }

  try {
    const apiUrl = await getApiUrl()

    // Step 1: Queue the analysis job
    const response = await fetch(`${apiUrl}/v1/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Dashboard-User-Id': session.user.id,
        'X-Dashboard-Secret': dashboardSecret,
      },
      body: JSON.stringify({
        address: request.address,
        photoAnalysis: request.photoAnalysis ?? { enabled: true, maxComps: 10, requireBetterOrEqual: true },
        searchOptions: request.searchOptions ?? {
          radiusMiles: 1,
          maxComps: 10,
          monthsBack: 12,
        },
        skipCache: request.skipCache,
      }),
    })

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
      return {
        success: false,
        error: result.error || `API request failed with status ${response.status}`,
      }
    }

    // Use property key from API response (ensures consistency with queue processor)
    const jobId = result.data?.jobId
    const propertyKey = result.data?.propertyKey

    if (!jobId || !propertyKey) {
      return {
        success: false,
        error: 'No job ID or property key returned from API',
      }
    }

    // Step 2: Request a signed WebSocket token
    const tokenResponse = await fetch(`${apiUrl}/v1/analyze/ws-token`, {
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
      console.warn('[queueAnalysis] Failed to get WS token, falling back to polling:', tokenResult.error)
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
    return {
      success: false,
      error: 'Not authenticated',
    }
  }

  const dashboardSecret = await getDashboardSecret()
  if (!dashboardSecret) {
    return {
      success: false,
      error: 'Dashboard configuration error',
    }
  }

  try {
    const apiUrl = await getApiUrl()
    const url = new URL(`${apiUrl}/v1/analyze/jobs/${jobId}`)
    url.searchParams.set('propertyKey', propertyKey)

    const response = await fetch(url.toString(), {
      headers: {
        'X-Dashboard-User-Id': session.user.id,
        'X-Dashboard-Secret': dashboardSecret,
      },
    })

    const result = await response.json() as { success?: boolean; error?: string; data?: JobStatusResult['data'] }

    if (!response.ok) {
      return {
        success: false,
        error: result.error || `Failed to get job status`,
      }
    }

    return { success: true, data: result.data } as JobStatusResult
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get job status',
    }
  }
}

