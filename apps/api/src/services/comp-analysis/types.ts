/**
 * LLM Comp Analysis Types
 *
 * Types for AI-powered comparable analysis that enriches
 * rule-based comp selection with reasoning and quality scores.
 */

export interface CompAnalysisOptions {
  /** Include property photos in analysis (default: false) */
  includePhotos?: boolean
  /** Max tokens for LLM response (default: 2048) */
  maxTokens?: number
  /** Temperature for LLM (default: 0.3 — low for structured output) */
  temperature?: number
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
  /** Comp IDs selected by LLM for ARV calculation (best 3-5 comps) */
  selectedForArv: string[]
  /** Overall market analysis summary */
  summary: string
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
