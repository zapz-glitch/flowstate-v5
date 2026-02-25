/**
 * Analysis Types
 *
 * Shared types for real-time analysis updates.
 * These mirror the types from the API's durable-objects/types.ts
 */

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

// ─── Step Configuration ───────────────────────────────────────────────────────

export interface StepConfig {
  step: AnalysisStep
  label: string
  description: string
  icon: string
  required: boolean
}

export const STEP_CONFIGS: StepConfig[] = [
  {
    step: 'property_fetch',
    label: 'Fetching Data',
    description: 'Property details, comparables & enrichment',
    icon: '🏠',
    required: true,
  },
  {
    step: 'appraisal_rules',
    label: 'Applying Rules',
    description: 'Filters & price adjustments',
    icon: '📋',
    required: true,
  },
  {
    step: 'photo_fetch',
    label: 'Fetching Photos',
    description: 'Property images for analysis',
    icon: '📷',
    required: false,
  },
  {
    step: 'comp_selection',
    label: 'AI Analysis',
    description: 'Classifying property conditions',
    icon: '🤖',
    required: false,
  },
  {
    step: 'valuation',
    label: 'Calculating ARV',
    description: 'Weighted valuation & metrics',
    icon: '💰',
    required: true,
  },
  {
    step: 'response_build',
    label: 'Finalizing',
    description: 'Building response',
    icon: '✨',
    required: true,
  },
]

export const TOTAL_STEPS = STEP_CONFIGS.length

export function getStepConfig(step: AnalysisStep): StepConfig | undefined {
  return STEP_CONFIGS.find((c) => c.step === step)
}

export function getStepNumber(step: AnalysisStep): number {
  return STEP_CONFIGS.findIndex((c) => c.step === step) + 1
}

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
  progress: number
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

// ─── API Response Types ───────────────────────────────────────────────────────

export interface QueueJobResponse {
  success: true
  data: {
    jobId: string
    status: JobStatus
    streamUrl: string
    pollUrl: string
    estimatedDurationMs?: number
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result?: any
    error?: {
      code: string
      message: string
      step?: AnalysisStep
      retryable: boolean
    }
  }
}

// ─── Hook State ───────────────────────────────────────────────────────────────

export interface AnalysisState {
  jobId: string | null
  status: JobStatus | null
  currentStep: AnalysisStep | null
  steps: StepProgress[]
  messages: StatusMessage[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any | null
  error: string | null
  isConnected: boolean
  totalDurationMs: number | null
}

export const initialAnalysisState: AnalysisState = {
  jobId: null,
  status: null,
  currentStep: null,
  steps: STEP_CONFIGS.map((c) => ({
    step: c.step,
    status: 'pending' as StepStatus,
  })),
  messages: [],
  result: null,
  error: null,
  isConnected: false,
  totalDurationMs: null,
}
