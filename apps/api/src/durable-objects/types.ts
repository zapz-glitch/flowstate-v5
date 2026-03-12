/**
 * Durable Object Types
 *
 * Types for the real-time analysis queue system using Cloudflare Durable Objects.
 */

import type {
  AppraisalFilter,
  AppraisalAdjustment,
} from '../services/appraisal/types'
import type { MajorItem } from '../services/valuation/types'

// ─── Analyze Request Type ─────────────────────────────────────────────────────

export interface AnalyzeRequest {
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

  // Photo analysis options (deprecated - use zillowContext instead)
  photoAnalysis?: {
    enabled?: boolean
    provider?: 'zillow' | 'mls' | 'redfin'
    maxComps?: number
    requireBetterOrEqual?: boolean
  }

  // Zillow context options (photos, descriptions for classification)
  zillowContext?: {
    enabled?: boolean
    maxComps?: number
    skipCache?: boolean
  }

  skipCache?: boolean
}

// ─── Analysis Response Type (placeholder - full response from analyze route) ──

export interface AnalysisResponse {
  // The full response type would be complex, using a simplified placeholder
  // The actual response is built in analyze.ts
  [key: string]: unknown
}

// ─── Job Status Types ─────────────────────────────────────────────────────────

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'

export type AnalysisStep =
  | 'property_fetch'
  | 'appraisal_rules'
  | 'photo_fetch'
  | 'comp_selection'
  | 'valuation'
  | 'response_build'

export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'

// ─── Step Progress ────────────────────────────────────────────────────────────

export interface StepProgress {
  step: AnalysisStep
  status: StepStatus
  startedAt?: string
  completedAt?: string
  durationMs?: number
  message?: string
  error?: string
  fromCache?: boolean
}

// ─── Analysis Job State ───────────────────────────────────────────────────────

export interface AnalysisJobState {
  jobId: string
  userId: string
  apiKeyId: string
  propertyKey: string

  // Request data
  request: AnalyzeRequest

  // Status
  status: JobStatus
  currentStep: AnalysisStep | null
  steps: StepProgress[]

  // Timing
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  totalDurationMs: number | null

  // Results
  result: AnalysisResponse | null
  error: JobError | null

  // Progressive step data (accumulated for late-connecting clients)
  stepData: Record<string, unknown> | null

  // Cache info
  cacheHits: string[]
  cacheMisses: string[]
}

export interface JobError {
  code: string
  message: string
  step?: AnalysisStep
  retryable: boolean
}

// ─── Step Configuration ───────────────────────────────────────────────────────

export interface StepConfig {
  step: AnalysisStep
  label: string
  description: string
  required: boolean
  maxRetries: number
  backoffMs: number
  exponentialBackoff: boolean
}

export const STEP_CONFIGS: StepConfig[] = [
  {
    step: 'property_fetch',
    label: 'Fetching Data',
    description: 'Property details, comparables & enrichment',
    required: true,
    maxRetries: 3,
    backoffMs: 1000,
    exponentialBackoff: true,
  },
  {
    step: 'appraisal_rules',
    label: 'Applying Rules',
    description: 'Filters & price adjustments',
    required: true,
    maxRetries: 1,
    backoffMs: 0,
    exponentialBackoff: false,
  },
  {
    step: 'photo_fetch',
    label: 'Fetching Photos',
    description: 'Property images for analysis',
    required: false,
    maxRetries: 2,
    backoffMs: 2000,
    exponentialBackoff: true,
  },
  {
    step: 'comp_selection',
    label: 'AI Analysis',
    description: 'Classifying property conditions',
    required: false,
    maxRetries: 2,
    backoffMs: 1000,
    exponentialBackoff: false,
  },
  {
    step: 'valuation',
    label: 'Calculating ARV',
    description: 'Weighted valuation & metrics',
    required: true,
    maxRetries: 1,
    backoffMs: 0,
    exponentialBackoff: false,
  },
  {
    step: 'response_build',
    label: 'Finalizing',
    description: 'Building response',
    required: true,
    maxRetries: 1,
    backoffMs: 0,
    exponentialBackoff: false,
  },
]

export const TOTAL_STEPS = STEP_CONFIGS.length

export function getStepConfig(step: AnalysisStep): StepConfig {
  const config = STEP_CONFIGS.find((c) => c.step === step)
  if (!config) {
    throw new Error(`Unknown step: ${step}`)
  }
  return config
}

export function getStepNumber(step: AnalysisStep): number {
  return STEP_CONFIGS.findIndex((c) => c.step === step) + 1
}

// ─── Real-Time Status Messages ────────────────────────────────────────────────

export type StatusMessageType =
  | 'job_created'
  | 'job_started'
  | 'step_started'
  | 'step_progress'
  | 'step_completed'
  | 'step_failed'
  | 'step_skipped'
  | 'job_completed'
  | 'job_failed'
  | 'cache_hit'
  | 'result_ready'
  | 'step_data'

export interface StatusMessage {
  type: StatusMessageType
  jobId: string
  timestamp: string
  data: StatusMessageData
}

export type StatusMessageData =
  | JobCreatedData
  | JobStartedData
  | StepStartedData
  | StepProgressData
  | StepCompletedData
  | StepFailedData
  | StepSkippedData
  | JobCompletedData
  | JobFailedData
  | CacheHitData
  | ResultReadyData
  | StepDataData

export interface JobCreatedData {
  propertyKey: string
  totalSteps: number
}

export interface JobStartedData {
  message: string
}

export interface StepStartedData {
  step: AnalysisStep
  stepNumber: number
  totalSteps: number
  label: string
  message: string
}

export interface StepProgressData {
  step: AnalysisStep
  progress: number // 0-100
  message: string
}

export interface StepCompletedData {
  step: AnalysisStep
  stepNumber: number
  totalSteps: number
  durationMs: number
  fromCache: boolean
  message: string
}

export interface StepFailedData {
  step: AnalysisStep
  stepNumber: number
  totalSteps: number
  error: string
  retryable: boolean
}

export interface StepSkippedData {
  step: AnalysisStep
  stepNumber: number
  totalSteps: number
  reason: string
}

export interface JobCompletedData {
  totalDurationMs: number
  cacheHits: number
  cacheMisses: number
  stepsCompleted: number
  stepsSkipped: number
}

export interface JobFailedData {
  error: string
  code: string
  step?: AnalysisStep
  retryable: boolean
}

export interface CacheHitData {
  component: string
  message: string
}

export interface ResultReadyData {
  result: AnalysisResponse
}

export interface StepDataData {
  step: AnalysisStep
  data: Record<string, unknown>
}

// ─── Rate Limit Coordinator Types ─────────────────────────────────────────────

export interface KeyState {
  index: number
  isAvailable: boolean
  lastUsedAt: string | null
  todayUsage: number
  cooldownUntil: string | null
}

export interface DailyUsage {
  date: string // YYYY-MM-DD
  count: number
}

export interface RateLimitState {
  keys: KeyState[]
  dailyUsage: Record<number, DailyUsage> // keyIndex -> usage
}

export interface AcquireKeyResult {
  success: boolean
  keyIndex: number | null
  error?: string
  waitMs?: number
}

export interface ReleaseKeyResult {
  success: boolean
}

// ─── API Response Types ───────────────────────────────────────────────────────

export interface QueueJobResponse {
  success: true
  data: {
    jobId: string
    propertyKey: string
    status: JobStatus
    streamUrl: string
    pollUrl: string
    estimatedDurationMs?: number
    /** Pre-fetched property data for immediate rendering */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    propertyBundle?: Record<string, any>
  }
}

export interface JobStatusResponse {
  success: true
  data: {
    jobId: string
    status: JobStatus
    currentStep: AnalysisStep | null
    progress: {
      completedSteps: number
      totalSteps: number
      percentComplete: number
    }
    steps: StepProgress[]
    createdAt: string
    startedAt: string | null
    completedAt: string | null
    totalDurationMs: number | null
    result?: AnalysisResponse
    error?: JobError
  }
}

// ─── DO Internal Request Types ────────────────────────────────────────────────

export interface InitJobRequest {
  jobId: string
  userId: string
  apiKeyId: string
  propertyKey: string
  request: AnalyzeRequest
}

export interface UpdateStepRequest {
  step: AnalysisStep
  status: StepStatus
  message?: string
  error?: string
  fromCache?: boolean
}

export interface SetResultRequest {
  result: AnalysisResponse
}

export interface SetErrorRequest {
  error: JobError
}
