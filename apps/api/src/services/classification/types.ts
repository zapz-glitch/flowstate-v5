/**
 * Property Classification Types
 *
 * Types for property condition classification used throughout
 * the appraisal, analysis, and evaluation pipelines.
 */

/**
 * Property classification type for investment analysis
 * - as_is: Property needs renovation (investor/fixer properties)
 * - after_renovation: Property is renovated/turnkey (retail ready)
 */
export type PropertyClassification = 'as_is' | 'after_renovation' | 'transitional'

/**
 * Method used to determine classification
 */
export type ClassificationMethod =
  | 'photo_analysis'
  | 'description_keywords'
  | 'price_analysis'
  | 'combined'
  | 'batch_photo_analysis'
  | 'data_only'
  | 'fallback'
  | 'parse_error_fallback'

/**
 * Result of photo-based analysis for classification
 */
export interface PhotoAnalysisResult {
  conditionScore: number
  indicators: string[]
  renovationLevel: 'none' | 'cosmetic' | 'partial' | 'full'
}

/**
 * Result of description keyword analysis
 */
export interface DescriptionAnalysisResult {
  keywordsFound: string[]
  investmentIndicators: boolean
  retailReadyIndicators: boolean
  score: number
}

/**
 * Indicators used to determine classification
 */
export interface ClassificationIndicators {
  photoScore?: number
  descriptionScore?: number
  priceRatio?: number
}

/**
 * Full classification result for a property
 */
export interface ClassificationResult {
  classification: PropertyClassification
  confidence: number
  method: ClassificationMethod
  indicators: ClassificationIndicators
  photoAnalysis?: PhotoAnalysisResult
  descriptionAnalysis?: DescriptionAnalysisResult
  reasoning: string
}

/**
 * LLM response for property classification
 */
export interface ClassificationLLMResponse {
  classification: PropertyClassification
  confidence: number
  photoAnalysis: {
    conditionScore: number
    indicators: string[]
    renovationLevel: 'none' | 'cosmetic' | 'partial' | 'full'
  }
  descriptionAnalysis: {
    keywords_found: string[]
    investment_indicators: boolean
    retail_ready_indicators: boolean
  }
  reasoning: string
}
