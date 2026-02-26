/**
 * Property Classification Service
 *
 * Classifies properties as either As-Is or After-Renovation
 * based on photos, descriptions, and price analysis.
 *
 * Used to:
 * 1. Label subject and comp properties for investment analysis
 * 2. Select best comps based on classification match
 * 3. Calculate weighted ARV using classification factors
 */

import type { Env } from '../../types'
import type { LLMProvider } from '../llm'
import { createLLMProvider } from '../llm'
import type {
  PropertyClassification,
  ClassificationResult,
  ClassificationLLMResponse,
  PhotoAnalysisResult,
  DescriptionAnalysisResult,
} from '../vision/types'
import { PROMPTS } from '../../prompts'
import { analyzeDescriptionKeywords } from './keywords'

// Re-export types
export type {
  PropertyClassification,
  ClassificationResult,
  ClassificationIndicators,
  PhotoAnalysisResult,
  DescriptionAnalysisResult,
  ClassificationLLMResponse,
} from '../vision/types'

export { analyzeDescriptionKeywords, AS_IS_KEYWORDS, AFTER_RENOVATION_KEYWORDS } from './keywords'

// ─── Service Interface ────────────────────────────────────────────────────────

export interface ClassificationService {
  /**
   * Classify a property using photos and/or description
   */
  classifyProperty(params: {
    photos?: string[]
    description?: string
    salePrice?: number
    areaAvgPricePerSqft?: number
    squareFeet?: number
  }): Promise<ClassificationResult>

  /**
   * Classify using only description keywords (no LLM)
   */
  classifyByDescription(description: string): ClassificationResult

  /**
   * Classify using only price analysis (no LLM)
   */
  classifyByPrice(
    salePrice: number,
    squareFeet: number,
    areaAvgPricePerSqft: number
  ): ClassificationResult

  /**
   * Check if LLM-based classification is available
   */
  isLLMAvailable(): boolean
}

// ─── Implementation ───────────────────────────────────────────────────────────

class PropertyClassificationService implements ClassificationService {
  private provider: LLMProvider | null

  constructor(env: Env) {
    const hasOpenRouterKey = !!env.OPENROUTER_API_KEY
    console.log(`[Classification] Initializing: OPENROUTER_API_KEY=${hasOpenRouterKey ? 'set' : 'not set'}`)

    if (env.OPENROUTER_API_KEY) {
      this.provider = createLLMProvider({
        provider: 'openrouter',
        apiKey: env.OPENROUTER_API_KEY,
        model: env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001',
      })
    } else {
      this.provider = null
    }
  }

  isLLMAvailable(): boolean {
    return this.provider !== null
  }

  /**
   * Classify a property using available data
   * Priority: photos > description > price
   */
  async classifyProperty(params: {
    photos?: string[]
    description?: string
    salePrice?: number
    areaAvgPricePerSqft?: number
    squareFeet?: number
  }): Promise<ClassificationResult> {
    const hasPhotos = params.photos && params.photos.length > 0
    const hasDescription = params.description && params.description.length > 10
    const hasPrice = params.salePrice && params.squareFeet && params.areaAvgPricePerSqft

    // If we have photos and LLM, use vision analysis (most accurate)
    if (hasPhotos && this.provider) {
      try {
        const result = await this.classifyWithVision(
          params.photos!,
          params.description
        )
        return result
      } catch (error) {
        console.error('[Classification] Vision analysis failed, falling back:', error)
      }
    }

    // Fall back to description keywords
    if (hasDescription) {
      const descResult = this.classifyByDescription(params.description!)

      // If description gives clear signal (confidence > 60), use it
      if (descResult.confidence >= 60) {
        return descResult
      }

      // Otherwise, combine with price if available
      if (hasPrice) {
        const priceResult = this.classifyByPrice(
          params.salePrice!,
          params.squareFeet!,
          params.areaAvgPricePerSqft!
        )
        return this.combineResults(descResult, priceResult)
      }

      return descResult
    }

    // Fall back to price analysis
    if (hasPrice) {
      return this.classifyByPrice(
        params.salePrice!,
        params.squareFeet!,
        params.areaAvgPricePerSqft!
      )
    }

    // No data available - default to as_is (conservative)
    return {
      classification: 'as_is',
      confidence: 30,
      method: 'combined',
      indicators: {},
      reasoning: 'Insufficient data for classification - defaulting to as_is',
    }
  }

  /**
   * Classify using vision LLM analysis
   */
  private async classifyWithVision(
    photos: string[],
    description?: string
  ): Promise<ClassificationResult> {
    if (!this.provider) {
      throw new Error('LLM provider not available')
    }

    // Build prompt with description if available
    const basePrompt: string = PROMPTS.PROPERTY_CLASSIFICATION
    const prompt = description
      ? `Property Description:\n${description}\n\n${basePrompt}`
      : basePrompt

    // Call LLM with photos
    const result = await this.provider.execute({
      prompt,
      images: photos.slice(0, 10).map((url) => ({ url })),
    })

    if (!result.success || !result.data?.content) {
      throw new Error(result.error?.message || 'Vision analysis failed')
    }

    // Parse response
    const parsed = this.parseVisionResponse(result.data.content)

    return {
      classification: parsed.classification,
      confidence: parsed.confidence,
      method: description ? 'combined' : 'photo_analysis',
      indicators: {
        photoScore: parsed.photoAnalysis.conditionScore,
        descriptionScore: description
          ? analyzeDescriptionKeywords(description).score
          : undefined,
      },
      photoAnalysis: parsed.photoAnalysis,
      descriptionAnalysis: description
        ? {
            keywordsFound: parsed.descriptionAnalysis.keywords_found,
            investmentIndicators: parsed.descriptionAnalysis.investment_indicators,
            retailReadyIndicators: parsed.descriptionAnalysis.retail_ready_indicators,
            score: analyzeDescriptionKeywords(description).score,
          }
        : undefined,
      reasoning: parsed.reasoning,
    }
  }

  /**
   * Parse LLM vision response
   */
  private parseVisionResponse(response: string): ClassificationLLMResponse {
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      throw new Error('No JSON found in vision response')
    }

    const parsed = JSON.parse(jsonMatch[0])

    return {
      classification: this.normalizeClassification(parsed.classification),
      confidence: Math.min(100, Math.max(0, parsed.confidence || 50)),
      photoAnalysis: {
        conditionScore: Math.min(100, Math.max(0, parsed.photoAnalysis?.conditionScore || 50)),
        indicators: Array.isArray(parsed.photoAnalysis?.indicators)
          ? parsed.photoAnalysis.indicators
          : [],
        renovationLevel: this.normalizeRenovationLevel(parsed.photoAnalysis?.renovationLevel),
      },
      descriptionAnalysis: {
        keywords_found: Array.isArray(parsed.descriptionAnalysis?.keywords_found)
          ? parsed.descriptionAnalysis.keywords_found
          : [],
        investment_indicators: !!parsed.descriptionAnalysis?.investment_indicators,
        retail_ready_indicators: !!parsed.descriptionAnalysis?.retail_ready_indicators,
      },
      reasoning: parsed.reasoning || 'Unable to determine classification',
    }
  }

  /**
   * Classify by description keywords only
   * Defaults to as_is when uncertain
   */
  classifyByDescription(description: string): ClassificationResult {
    const analysis = analyzeDescriptionKeywords(description)

    // Determine classification from score
    let classification: PropertyClassification
    let confidence: number

    if (analysis.score <= -20) {
      classification = 'as_is'
      confidence = Math.min(90, 50 + Math.abs(analysis.score) / 2)
    } else if (analysis.score >= 40) {
      // Higher threshold for after_renovation
      classification = 'after_renovation'
      confidence = Math.min(90, 50 + analysis.score / 2)
    } else {
      // Default to as_is when uncertain
      classification = 'as_is'
      confidence = 45
    }

    // Boost confidence if we have strong indicators
    if (analysis.asIsKeywords.length >= 3 || analysis.afterRenovationKeywords.length >= 3) {
      confidence = Math.min(95, confidence + 15)
    }

    return {
      classification,
      confidence: Math.round(confidence),
      method: 'description_keywords',
      indicators: {
        descriptionScore: analysis.score,
      },
      descriptionAnalysis: {
        keywordsFound: [...analysis.asIsKeywords, ...analysis.afterRenovationKeywords],
        investmentIndicators: analysis.investmentIndicators,
        retailReadyIndicators: analysis.retailReadyIndicators,
        score: analysis.score,
      },
      reasoning: this.buildDescriptionReasoning(analysis),
    }
  }

  /**
   * Classify by price analysis only
   * Defaults to as_is when uncertain
   */
  classifyByPrice(
    salePrice: number,
    squareFeet: number,
    areaAvgPricePerSqft: number
  ): ClassificationResult {
    const pricePerSqft = salePrice / squareFeet
    const ratio = pricePerSqft / areaAvgPricePerSqft

    let classification: PropertyClassification
    let confidence: number

    // Properties selling below average are likely As-Is
    if (ratio <= 0.85) {
      classification = 'as_is'
      confidence = Math.min(80, 50 + (0.85 - ratio) * 100)
    } else if (ratio >= 1.15) {
      // Properties significantly above average are likely After-Renovation
      classification = 'after_renovation'
      confidence = Math.min(75, 50 + (ratio - 1.0) * 50)
    } else {
      // Middle range defaults to as_is (conservative)
      classification = 'as_is'
      confidence = 45
    }

    return {
      classification,
      confidence: Math.round(confidence),
      method: 'price_analysis',
      indicators: {
        priceRatio: Math.round(ratio * 100) / 100,
      },
      reasoning: `Property price per sqft ($${Math.round(pricePerSqft)}) is ${Math.round(ratio * 100)}% of area average ($${Math.round(areaAvgPricePerSqft)}). ${
        ratio <= 0.85
          ? 'Below market pricing suggests As-Is condition.'
          : ratio >= 1.15
            ? 'Premium pricing suggests updated/renovated condition.'
            : 'Mid-range pricing - defaulting to As-Is.'
      }`,
    }
  }

  /**
   * Combine two classification results
   */
  private combineResults(
    primary: ClassificationResult,
    secondary: ClassificationResult
  ): ClassificationResult {
    // Weight primary 70%, secondary 30%
    const primaryWeight = 0.7
    const secondaryWeight = 0.3

    // Calculate weighted confidence
    const combinedConfidence = Math.round(
      primary.confidence * primaryWeight + secondary.confidence * secondaryWeight
    )

    // If both agree, boost confidence
    if (primary.classification === secondary.classification) {
      return {
        ...primary,
        method: 'combined',
        confidence: Math.min(95, combinedConfidence + 10),
        indicators: {
          ...primary.indicators,
          ...secondary.indicators,
        },
        reasoning: `${primary.reasoning} Price analysis confirms: ${secondary.reasoning}`,
      }
    }

    // If they disagree, use primary but lower confidence
    return {
      ...primary,
      method: 'combined',
      confidence: Math.max(30, combinedConfidence - 15),
      indicators: {
        ...primary.indicators,
        ...secondary.indicators,
      },
      reasoning: `${primary.reasoning} Note: price analysis suggests ${secondary.classification}.`,
    }
  }

  /**
   * Build reasoning string from keyword analysis
   */
  private buildDescriptionReasoning(analysis: ReturnType<typeof analyzeDescriptionKeywords>): string {
    const parts: string[] = []

    if (analysis.asIsKeywords.length > 0) {
      parts.push(`Found As-Is indicators: ${analysis.asIsKeywords.slice(0, 3).join(', ')}`)
    }

    if (analysis.afterRenovationKeywords.length > 0) {
      parts.push(`Found renovation indicators: ${analysis.afterRenovationKeywords.slice(0, 3).join(', ')}`)
    }

    if (parts.length === 0) {
      return 'No strong classification keywords found in description.'
    }

    return parts.join('. ') + '.'
  }

  /**
   * Normalize classification value
   * Defaults to as_is for unrecognized values
   */
  private normalizeClassification(value: string | undefined): PropertyClassification {
    const normalized = value?.toLowerCase()
    if (normalized === 'as_is' || normalized === 'after_renovation') {
      return normalized
    }
    // Handle alternate formats
    if (normalized === 'as-is' || normalized === 'asis') {
      return 'as_is'
    }
    if (normalized === 'after-renovation' || normalized === 'afterrenovation' || normalized === 'arv' || normalized === 'renovated') {
      return 'after_renovation'
    }
    // Default to as_is for any unrecognized value (including transitional)
    return 'as_is'
  }

  /**
   * Normalize renovation level
   */
  private normalizeRenovationLevel(value: string | undefined): 'none' | 'cosmetic' | 'partial' | 'full' {
    const normalized = value?.toLowerCase()
    if (normalized === 'none' || normalized === 'cosmetic' || normalized === 'partial' || normalized === 'full') {
      return normalized
    }
    return 'cosmetic'
  }
}

// ─── Factory Function ─────────────────────────────────────────────────────────

/**
 * Create a classification service
 */
export function createClassificationService(env: Env): ClassificationService {
  return new PropertyClassificationService(env)
}
