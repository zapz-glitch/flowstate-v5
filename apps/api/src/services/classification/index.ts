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

/**
 * Rich Zillow property data used for enhanced classification.
 * These fields come from the Firecrawl JSON extraction of Zillow listing pages.
 */
export interface ClassificationPropertyData {
  description?: string
  features?: string[]
  /** What's Special highlights from Zillow listing */
  whatsSpecial?: string[]
  /** Flooring types (e.g., "Hardwood", "Carpet", "LVP") */
  flooring?: string[]
  /** Appliances included */
  appliances?: string[]
  /** Exterior features */
  exteriorFeatures?: string[]
  /** Roof type */
  roof?: string
  /** Construction materials */
  construction?: string
  /** Heating system */
  heating?: string
  /** Cooling system */
  cooling?: string
  /** Pool present */
  pool?: boolean
  /** Property type */
  propertyType?: string
}

export interface ClassificationService {
  /**
   * Classify a property using Zillow description, features, and rich structured data.
   * No LLM or photo analysis — keyword-based only.
   */
  classifyProperty(params: ClassificationPropertyData): Promise<ClassificationResult>

  /**
   * Classify using description keywords and/or listing features (no LLM)
   */
  classifyByDescription(description: string, features?: string[]): ClassificationResult
}

// ─── Implementation ───────────────────────────────────────────────────────────

class PropertyClassificationService implements ClassificationService {
  /**
   * Classify a property using Zillow description, features, and rich structured data.
   * Uses keyword analysis only — no LLM, no photos, no price signals.
   *
   * Builds a comprehensive text blob from all available Zillow data:
   * - Description (main listing text)
   * - Features (raw feature strings like "3 bed", "2 bath")
   * - What's Special highlights
   * - Flooring, appliances, exterior features
   * - Construction materials, roof, heating, cooling
   */
  async classifyProperty(params: ClassificationPropertyData): Promise<ClassificationResult> {
    // Build enriched features list from all available Zillow data
    const enrichedFeatures: string[] = [...(params.features ?? [])]

    if (params.whatsSpecial?.length) {
      enrichedFeatures.push(...params.whatsSpecial)
    }
    if (params.flooring?.length) {
      enrichedFeatures.push(`Flooring: ${params.flooring.join(', ')}`)
    }
    if (params.appliances?.length) {
      enrichedFeatures.push(`Appliances: ${params.appliances.join(', ')}`)
    }
    if (params.exteriorFeatures?.length) {
      enrichedFeatures.push(`Exterior: ${params.exteriorFeatures.join(', ')}`)
    }
    if (params.roof) {
      enrichedFeatures.push(`Roof: ${params.roof}`)
    }
    if (params.construction) {
      enrichedFeatures.push(`Construction: ${params.construction}`)
    }
    if (params.heating) {
      enrichedFeatures.push(`Heating: ${params.heating}`)
    }
    if (params.cooling) {
      enrichedFeatures.push(`Cooling: ${params.cooling}`)
    }
    if (params.pool) {
      enrichedFeatures.push('Pool')
    }

    const hasData =
      (params.description && params.description.length > 10) ||
      enrichedFeatures.length > 0

    if (hasData) {
      return this.classifyByDescription(params.description ?? '', enrichedFeatures)
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
