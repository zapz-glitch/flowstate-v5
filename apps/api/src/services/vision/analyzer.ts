/**
 * Vision Analyzer Service
 *
 * Uses OpenRouter LLM to analyze property photos
 * and determine property condition and quality.
 *
 * OpenRouter provides access to multiple models via single API:
 * - google/gemini-2.5-flash (default, fast and cheap)
 * - anthropic/claude-3.5-sonnet (high quality)
 * - openai/gpt-4o (alternative)
 */

import type { LLMProvider, LLMProviderType, UsageMetrics } from '../llm'
import { createLLMProvider } from '../llm'
import type {
  PropertyConditionAnalysis,
  CompVsSubjectAnalysis,
  ConditionRating,
  ComparisonResult,
  VisionAnalysisResponse,
} from './types'
import { PROMPTS } from './prompts'

// Re-export LLM types as vision types for backwards compatibility
export type VisionProviderType = LLMProviderType
export type VisionProviderConfig = { provider: LLMProviderType; apiKey: string; model?: string }

// Re-export prompts for backwards compatibility
export { PROMPTS } from './prompts'

// Prompt constants for direct access
export const CONDITION_ANALYSIS_PROMPT = PROMPTS.CONDITION_ANALYSIS
export const COMPARISON_ANALYSIS_PROMPT = PROMPTS.COMPARISON_ANALYSIS

// ─── Extended Response with Usage ────────────────────────────────────────────

export type VisionAnalysisWithUsage =
  | { success: true; data: PropertyConditionAnalysis; usage?: UsageMetrics; latencyMs?: number }
  | { success: false; error: string; code?: string; usage?: UsageMetrics; latencyMs?: number }

// ─── Vision Analyzer Class ────────────────────────────────────────────────────

export class VisionAnalyzer {
  private provider: LLMProvider

  constructor(provider: LLMProvider) {
    this.provider = provider
  }

  /**
   * Get the current provider name
   */
  getProviderName(): LLMProviderType {
    return this.provider.name
  }

  /**
   * Get the current model
   */
  getModel(): string {
    return this.provider.model
  }

  /**
   * Analyze property condition from photos
   */
  async analyzeCondition(
    photoUrls: string[],
    propertyContext?: {
      address?: string
      squareFeet?: number
      yearBuilt?: number
    }
  ): Promise<VisionAnalysisWithUsage> {
    if (!photoUrls.length) {
      return {
        success: false,
        error: 'No photos provided for analysis',
        code: 'NO_PHOTOS',
      }
    }

    try {
      // Build prompt with context
      let prompt = ''
      if (propertyContext) {
        prompt = 'Property context:\n'
        if (propertyContext.address) prompt += `Address: ${propertyContext.address}\n`
        if (propertyContext.squareFeet) prompt += `Square Feet: ${propertyContext.squareFeet}\n`
        if (propertyContext.yearBuilt) prompt += `Year Built: ${propertyContext.yearBuilt}\n`
        prompt += '\n'
      }
      prompt += PROMPTS.CONDITION_ANALYSIS

      // Call provider using new execute() method
      const result = await this.provider.execute({
        prompt,
        images: photoUrls.slice(0, 10).map((url) => ({ url })),
      })

      if (!result.success || !result.data?.content) {
        return {
          success: false,
          error: result.error?.message || 'Analysis failed',
          code: result.error?.code || 'ANALYSIS_FAILED',
        }
      }

      // Parse response
      const analysis = this.parseConditionResponse(result.data.content)

      return {
        success: true,
        data: analysis,
        usage: result.usage,
        latencyMs: result.timing?.durationMs,
      }
    } catch (error) {
      console.error('Vision analysis failed:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Analysis failed',
        code: 'ANALYSIS_FAILED',
      }
    }
  }

  /**
   * Compare comp property to subject property
   */
  async compareProperties(
    compPhotoUrls: string[],
    subjectPhotoUrls: string[],
    compId: string,
    subjectId: string
  ): Promise<{ analysis: CompVsSubjectAnalysis | null; usage?: UsageMetrics; latencyMs?: number }> {
    if (!compPhotoUrls.length || !subjectPhotoUrls.length) {
      return { analysis: null }
    }

    try {
      // Build prompt with labels
      const compCount = Math.min(compPhotoUrls.length, 5)
      const subjectCount = Math.min(subjectPhotoUrls.length, 5)

      const prompt = `=== COMPARABLE PROPERTY PHOTOS ===
(The following ${compCount} images are the COMP property)

=== SUBJECT PROPERTY PHOTOS ===
(The following ${subjectCount} images are the SUBJECT property)

${PROMPTS.COMPARISON_ANALYSIS}`

      // Combine images: comp images first, then subject images
      const images = [
        ...compPhotoUrls.slice(0, 5).map((url) => ({ url })),
        ...subjectPhotoUrls.slice(0, 5).map((url) => ({ url })),
      ]

      // Call provider using new execute() method
      const result = await this.provider.execute({
        prompt,
        images,
      })

      if (!result.success || !result.data?.content) {
        return {
          analysis: null,
          usage: result.usage,
          latencyMs: result.timing?.durationMs,
        }
      }

      // Parse response
      const comparison = this.parseComparisonResponse(result.data.content, compId, subjectId)

      return {
        analysis: comparison,
        usage: result.usage,
        latencyMs: result.timing?.durationMs,
      }
    } catch (error) {
      console.error('Property comparison failed:', error)
      return { analysis: null }
    }
  }

  /**
   * Parse condition analysis response
   */
  private parseConditionResponse(response: string): PropertyConditionAnalysis {
    // Try to extract JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      throw new Error('No JSON found in response')
    }

    const parsed = JSON.parse(jsonMatch[0])

    // Validate and normalize
    return {
      overallCondition: this.normalizeCondition(parsed.overallCondition),
      confidence: Math.min(100, Math.max(0, parsed.confidence || 50)),
      exterior: {
        condition: this.normalizeCondition(parsed.exterior?.condition),
        notes: Array.isArray(parsed.exterior?.notes) ? parsed.exterior.notes : [],
      },
      interior: parsed.interior
        ? {
            condition: this.normalizeCondition(parsed.interior.condition),
            notes: Array.isArray(parsed.interior.notes) ? parsed.interior.notes : [],
          }
        : undefined,
      features: {
        roofCondition: this.normalizeConditionOrNull(parsed.features?.roofCondition),
        landscaping: this.normalizeConditionOrNull(parsed.features?.landscaping),
        driveway: this.normalizeConditionOrNull(parsed.features?.driveway),
        windows: this.normalizeConditionOrNull(parsed.features?.windows),
        siding: this.normalizeConditionOrNull(parsed.features?.siding),
        poolCondition: this.normalizeConditionOrNull(parsed.features?.poolCondition),
      },
      estimatedRehabNeeds: this.normalizeRehabNeeds(parsed.estimatedRehabNeeds),
      summary: parsed.summary || 'Unable to determine condition from photos',
    }
  }

  /**
   * Parse comparison response
   */
  private parseComparisonResponse(
    response: string,
    compId: string,
    subjectId: string
  ): CompVsSubjectAnalysis {
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      throw new Error('No JSON found in response')
    }

    const parsed = JSON.parse(jsonMatch[0])

    return {
      compId,
      subjectId,
      comparison: this.normalizeComparison(parsed.comparison),
      confidence: Math.min(100, Math.max(0, parsed.confidence || 50)),
      details: {
        exteriorComparison: this.normalizeComparison(parsed.details?.exteriorComparison),
        interiorComparison: parsed.details?.interiorComparison
          ? this.normalizeComparison(parsed.details.interiorComparison)
          : undefined,
        conditionComparison: this.normalizeComparison(parsed.details?.conditionComparison),
        updatesComparison: this.normalizeComparison(parsed.details?.updatesComparison),
      },
      qualityAdjustmentFactor: Math.min(1, Math.max(-1, parsed.qualityAdjustmentFactor || 0)),
      reasoning: parsed.reasoning || 'Unable to determine comparison',
    }
  }

  private normalizeCondition(value: string | undefined): ConditionRating {
    const normalized = value?.toLowerCase()
    if (
      normalized === 'excellent' ||
      normalized === 'good' ||
      normalized === 'fair' ||
      normalized === 'poor'
    ) {
      return normalized
    }
    return 'unknown'
  }

  private normalizeConditionOrNull(value: string | undefined | null): ConditionRating | undefined {
    if (!value || value === 'null') return undefined
    return this.normalizeCondition(value)
  }

  private normalizeComparison(value: string | undefined): ComparisonResult {
    const normalized = value?.toLowerCase()
    if (normalized === 'better' || normalized === 'similar' || normalized === 'worse') {
      return normalized
    }
    return 'unknown'
  }

  private normalizeRehabNeeds(
    value: string | undefined
  ): PropertyConditionAnalysis['estimatedRehabNeeds'] {
    const normalized = value?.toLowerCase()
    if (
      normalized === 'none' ||
      normalized === 'cosmetic' ||
      normalized === 'moderate' ||
      normalized === 'significant' ||
      normalized === 'full_renovation'
    ) {
      return normalized
    }
    return 'moderate'
  }
}

// ─── Factory Functions ────────────────────────────────────────────────────────

/**
 * Create a vision analyzer with an LLM provider
 */
export function createVisionAnalyzer(provider: LLMProvider): VisionAnalyzer {
  return new VisionAnalyzer(provider)
}

/**
 * Create a vision analyzer from environment variables
 * Uses OpenRouter as the single LLM provider
 */
export function createVisionAnalyzerFromEnv(env: {
  OPENROUTER_API_KEY?: string
  OPENROUTER_MODEL?: string
}): VisionAnalyzer | null {
  if (!env.OPENROUTER_API_KEY) {
    return null
  }

  const provider = createLLMProvider({
    provider: 'openrouter',
    apiKey: env.OPENROUTER_API_KEY,
    model: env.OPENROUTER_MODEL || 'google/gemini-2.5-flash',
  })

  return new VisionAnalyzer(provider)
}

// Re-export provider interface
export type { LLMProvider as VisionProvider }
