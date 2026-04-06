/**
 * LLM Comp Analysis Types
 *
 * Types for AI-powered comparable analysis.
 * The LLM is the primary comp selection authority — it receives all property data,
 * user settings, and market context to make the selection decision.
 */

import type { PropertyBundle } from '../property-api/types'
import type { AppraisalFilter, AppraisalAdjustment } from '../appraisal'
import type { RehabTable, TierRangeDefinition } from '@flowstate-api/shared/valuation'
import type { MarketContext } from '../market-context'

export interface CompAnalysisOptions {
  /** Include property photos in analysis (default: false) */
  includePhotos?: boolean
  /** Max tokens for LLM response (default: 4096) */
  maxTokens?: number
  /** Temperature for LLM (default: 0.2 — low for structured output) */
  temperature?: number
  /** Enable reasoning/thinking mode */
  reasoning?: boolean
}

export interface CompRanking {
  compId: string
  /** Quality score 0-100 */
  score: number
  /** 1-3 sentence reasoning for this comp's relevance */
  reasoning: string
  /** Notable features identified by LLM */
  keyFeatures: string[]
  /** Property condition (only with photo analysis) */
  condition?: string
  /** Confidence in the ranking */
  confidenceLevel: 'high' | 'medium' | 'low'
}

export interface CompAnalysisResult {
  /** Per-comp rankings with reasoning */
  rankings: CompRanking[]
  /** Comp IDs selected by LLM for ARV calculation */
  selectedForArv: string[]
  /** Comp IDs classified as as-is market comps */
  asIsComps?: string[]
  /** Overall market analysis summary */
  summary: string
  /** AI's estimated ARV (for cross-validation with calculated ARV) */
  arvEstimate?: number
  /** Overall confidence in the selection */
  confidenceLevel?: 'high' | 'medium' | 'low'
  /** AI reasoning/thinking content (when reasoning mode is enabled) */
  reasoning?: string
  /** Model used for analysis */
  model: string
  /** Time taken for LLM call */
  latencyMs: number
  /** Token usage and cost */
  tokenUsage?: {
    prompt: number
    completion: number
    estimatedCostUsd: number
  }
}

/** Evaluation data passed to the LLM for context */
export interface CompEvalContext {
  compId: string
  isEnabled: boolean
  compGroup: 'arv' | 'as_is' | null
  filterResults: Array<{
    type: string
    passed: boolean
    reason?: string
  }>
  adjustmentResults: Array<{
    type: string
    applied: boolean
    amount: number
  }>
  adjustedPrice: number | null
}

/** Rich context for AI comp selection — includes all available data */
export interface CompAnalysisContext {
  /** Full property bundle (subject + comps + enrichment data) */
  bundle: PropertyBundle
  /** Deterministic evaluation results (advisory, not final) */
  evalContexts: CompEvalContext[]
  /** Analysis result from deterministic pipeline (for reference data) */
  analysisResult: Record<string, unknown>
  /** User's appraisal filter preferences */
  filters: AppraisalFilter[]
  /** User's adjustment preferences */
  adjustments: AppraisalAdjustment[]
  /** User's deal parameters */
  dealParams: {
    closingCostsPercent: number
    carryingCostsPercent: number
    wholesaleFee: number
  }
  /** Selected rehab level index (0-4) */
  rehabLevelIndex: number
  /** Custom rehab table (if user has one) */
  rehabTable?: RehabTable
  /** Custom tier ranges */
  tierRanges?: TierRangeDefinition[]
  /** ARV threshold percent (top X% by price) */
  arvThresholdPercent: number
  /** As-is threshold percent (comps below X% of ARV) */
  asIsThresholdPercent: number
  /** Location risk flags from OSM analysis */
  riskFlags?: string[]
  /** Market context from web search (if available) */
  marketContext?: MarketContext | null
}
