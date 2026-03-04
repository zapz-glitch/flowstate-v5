/**
 * Workflow Types
 *
 * Type definitions for the Analysis Workflow system.
 */

import type { AnalysisResponse } from '../services/analysis'
import type { AppraisalFilter, AppraisalAdjustment } from '../services/appraisal'
import type { MajorItem, ArvTier, RehabEstimate } from '../services/valuation'
import type { ClassificationResult } from '../services/classification'
import type { PropertyPhotos } from '../services/photo-provider'

// ─── Workflow Input/Output ────────────────────────────────────────────────────

/**
 * Input parameters for starting an analysis workflow
 */
export interface AnalysisWorkflowParams {
  /** Job ID for tracking */
  jobId: string
  /** User ID for quota tracking */
  userId: string
  /** Property key for DO identification */
  propertyKey: string

  // Property identification (one of these required)
  address?: string
  streetAddress?: string
  city?: string
  state?: string
  zipCode?: string
  propertyId?: string

  // Search options
  searchOptions?: {
    radiusMiles?: number
    maxComps?: number
    monthsBack?: number
  }

  // Enrichment options
  enrichment?: {
    permits?: boolean
    floodZone?: boolean
    weatherRisk?: boolean
  }

  // Photo/Zillow options
  photoAnalysis?: {
    enabled?: boolean
    maxComps?: number
    requireBetterOrEqual?: boolean
  }

  /**
   * Whether to use LLM vision analysis for property classification.
   * When false (default), photos are still fetched for display but classification
   * falls back to keyword/price-only analysis (no LLM calls).
   */
  visionClassification?: boolean

  // Appraisal rules
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
    desiredProfit?: number | null
  }

  // Cache control
  skipCache?: boolean

  /** Optional per-user rehab pricing table override */
  customRehabTable?: Record<ArvTier, RehabEstimate[]>

  /** Optional per-user major item cost overrides: { item_id: cost_in_dollars } */
  customMajorItemCosts?: Record<string, number>
}

/**
 * Result of the analysis workflow
 */
export interface AnalysisWorkflowResult {
  success: boolean
  jobId: string
  result?: AnalysisResponse
  error?: string
  timing: {
    startedAt: string
    completedAt: string
    durationMs: number
    stepTimings: Record<string, number>
  }
}

// ─── Step Data Types ──────────────────────────────────────────────────────────

/**
 * Property data after initial fetch
 */
export interface PropertyFetchResult {
  propertyId: string
  property: import('../services/property-api').NormalizedProperty
  comparables: import('../services/property-api').NormalizedComparable[]
  enrichment: import('../services/property-api').EnrichmentData
}

/**
 * Photo and classification data for a single property
 */
export interface PropertyEnrichmentResult {
  propertyId: string
  isSubject: boolean
  photos: PropertyPhotos | null
  classification: ClassificationResult | null
  error?: string
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────

/**
 * Firecrawl rate limit state
 */
export interface FirecrawlRateLimitState {
  /** Current active requests */
  activeRequests: number
  /** Maximum concurrent requests (50 for Firecrawl) */
  maxConcurrent: number
  /** Queue of waiting requests */
  waitingCount: number
  /** Timestamp of last request */
  lastRequestAt: string | null
}

/**
 * Acquire slot result
 */
export interface AcquireSlotResult {
  success: boolean
  slotId?: string
  waitMs?: number
  error?: string
}

/**
 * Release slot request
 */
export interface ReleaseSlotRequest {
  slotId: string
  success: boolean
}

// ─── Progress Tracking ────────────────────────────────────────────────────────

/**
 * Workflow step names
 */
export type WorkflowStep =
  | 'init'
  | 'property_fetch'
  | 'photo_fetch'
  | 'classification'
  | 'appraisal'
  | 'arv_calculation'
  | 'response_build'

/**
 * Step progress update
 */
export interface WorkflowStepProgress {
  step: WorkflowStep
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  message?: string
  progress?: {
    current: number
    total: number
  }
  startedAt?: string
  completedAt?: string
  durationMs?: number
  error?: string
}

/**
 * Overall workflow progress
 */
export interface WorkflowProgress {
  jobId: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  currentStep: WorkflowStep | null
  steps: Record<WorkflowStep, WorkflowStepProgress>
  startedAt: string
  updatedAt: string
  completedAt?: string
  error?: string
}

// ─── Workflow Events ──────────────────────────────────────────────────────────

/**
 * Event types emitted during workflow execution
 */
export type WorkflowEventType =
  | 'workflow_started'
  | 'step_started'
  | 'step_progress'
  | 'step_completed'
  | 'step_failed'
  | 'workflow_completed'
  | 'workflow_failed'

/**
 * Workflow event payload
 */
export interface WorkflowEvent {
  type: WorkflowEventType
  jobId: string
  timestamp: string
  data: WorkflowStepProgress | WorkflowProgress | { error: string }
}
