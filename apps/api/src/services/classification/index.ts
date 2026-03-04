/**
 * Property Classification Service
 *
 * Classifies properties as either As-Is or After-Renovation
 * based on Zillow text description and facts/features keywords.
 *
 * Classification sources (in order of priority):
 * 1. Appraisal filters (handled externally by AppraisalService)
 * 2. Zillow text description — keyword analysis
 * 3. Facts & features — construction/property condition details
 */

import type {
  PropertyClassification,
  ClassificationResult,
  PhotoAnalysisResult,
  DescriptionAnalysisResult,
} from '../vision/types'
import { analyzeDescriptionKeywords } from './keywords'

// Re-export types
export type {
  PropertyClassification,
  ClassificationResult,
  ClassificationIndicators,
  PhotoAnalysisResult,
  DescriptionAnalysisResult,
} from '../vision/types'

export { analyzeDescriptionKeywords, AS_IS_KEYWORDS, AFTER_RENOVATION_KEYWORDS } from './keywords'

// ─── Service Interface ────────────────────────────────────────────────────────

export interface ClassificationService {
  /**
   * Classify a property using Zillow description and/or facts & features.
   * No LLM or photo analysis — keyword-based only.
   */
  classifyProperty(params: {
    description?: string
    features?: string[]
  }): Promise<ClassificationResult>

  /**
   * Classify using description keywords and/or listing features (no LLM)
   */
  classifyByDescription(description: string, features?: string[]): ClassificationResult
}

// ─── Implementation ───────────────────────────────────────────────────────────

class PropertyClassificationService implements ClassificationService {
  /**
   * Classify a property using Zillow description and/or facts & features.
   * Uses keyword analysis only — no LLM, no photos, no price signals.
   */
  async classifyProperty(params: {
    description?: string
    features?: string[]
  }): Promise<ClassificationResult> {
    const hasDescription =
      (params.description && params.description.length > 10) ||
      (params.features && params.features.length > 0)

    if (hasDescription) {
      return this.classifyByDescription(params.description ?? '', params.features)
    }

    // No data available - default to as_is (conservative)
    return {
      classification: 'as_is',
      confidence: 30,
      method: 'description_keywords',
      indicators: {},
      reasoning: 'Insufficient description data for classification - defaulting to as_is',
    }
  }

  /**
   * Classify by description keywords and facts/features (no LLM)
   * Defaults to as_is when uncertain
   */
  classifyByDescription(description: string, features?: string[]): ClassificationResult {
    const analysis = analyzeDescriptionKeywords(description, features)

    let classification: PropertyClassification
    let confidence: number

    if (analysis.signal === 'as_is') {
      classification = 'as_is'
      confidence = analysis.confidence === 'high' ? 85 : analysis.confidence === 'medium' ? 65 : 50
    } else if (analysis.signal === 'after_renovation') {
      classification = 'after_renovation'
      confidence = analysis.confidence === 'high' ? 85 : analysis.confidence === 'medium' ? 65 : 50
    } else {
      // neutral — conservative default
      classification = 'as_is'
      confidence = 40
    }

    return {
      classification,
      confidence,
      method: 'description_keywords',
      indicators: {},
      descriptionAnalysis: {
        keywordsFound: [...analysis.strongMatches, ...analysis.supportingMatches],
        investmentIndicators: analysis.investmentIndicators,
        retailReadyIndicators: analysis.retailReadyIndicators,
        score: analysis.signal === 'as_is' ? -1 : analysis.signal === 'after_renovation' ? 1 : 0,
      },
      reasoning: analysis.summary,
    }
  }

}

// ─── Factory Function ─────────────────────────────────────────────────────────

/**
 * Create a classification service (no dependencies required — keyword analysis only)
 */
export function createClassificationService(): ClassificationService {
  return new PropertyClassificationService()
}
