/**
 * Vision Analysis Service Types
 *
 * Types for AI vision-based property photo analysis using OpenRouter.
 * Used to determine comp quality by analyzing property condition.
 */

// ─── Zillow URL Generation ────────────────────────────────────────────────────

export interface ZillowUrlParams {
  address: string
  city: string
  state: string
  zipCode: string
}

export interface ZillowUrl {
  searchUrl: string
  estimatedPropertyUrl: string | null
}

// ─── Property Condition Analysis ──────────────────────────────────────────────

export type ConditionRating = 'excellent' | 'good' | 'fair' | 'poor' | 'unknown'

export interface PropertyConditionAnalysis {
  /** Overall condition rating */
  overallCondition: ConditionRating
  /** Confidence score 0-100 */
  confidence: number

  /** Exterior analysis */
  exterior: {
    condition: ConditionRating
    notes: string[]
  }

  /** Interior analysis (if photos available) */
  interior?: {
    condition: ConditionRating
    notes: string[]
  }

  /** Specific features assessed */
  features: {
    roofCondition?: ConditionRating
    landscaping?: ConditionRating
    driveway?: ConditionRating
    windows?: ConditionRating
    siding?: ConditionRating
    poolCondition?: ConditionRating
  }

  /** Estimated rehab needs based on photos */
  estimatedRehabNeeds: 'none' | 'cosmetic' | 'moderate' | 'significant' | 'full_renovation'

  /** Summary description */
  summary: string
}

// ─── Comp Comparison Analysis ─────────────────────────────────────────────────

export type ComparisonResult = 'better' | 'similar' | 'worse' | 'unknown'

export interface CompVsSubjectAnalysis {
  /** Comparable property ID */
  compId: string
  /** Subject property ID */
  subjectId: string

  /** Overall comparison result */
  comparison: ComparisonResult
  /** Confidence score 0-100 */
  confidence: number

  /** Detailed comparison */
  details: {
    exteriorComparison: ComparisonResult
    interiorComparison?: ComparisonResult
    conditionComparison: ComparisonResult
    updatesComparison: ComparisonResult
  }

  /** Quality adjustment factor (-1 to 1) */
  qualityAdjustmentFactor: number

  /** Reasoning for the comparison */
  reasoning: string
}

// ─── Vision Analysis Request/Response ─────────────────────────────────────────

export interface VisionAnalysisRequest {
  /** Property photo URLs to analyze */
  photoUrls: string[]
  /** Type of analysis to perform */
  analysisType: 'condition' | 'comparison'
  /** Subject property photos (for comparison) */
  subjectPhotoUrls?: string[]
  /** Property context */
  propertyContext?: {
    address: string
    squareFeet?: number
    yearBuilt?: number
    bedrooms?: number
    bathrooms?: number
  }
}

export interface VisionAnalysisResult {
  success: true
  data: PropertyConditionAnalysis
}

export interface VisionAnalysisError {
  success: false
  error: string
  code?: string
}

export type VisionAnalysisResponse = VisionAnalysisResult | VisionAnalysisError

// ─── Comp Quality Score ───────────────────────────────────────────────────────

export interface CompQualityScore {
  compId: string
  /** Overall quality score 0-100 */
  qualityScore: number
  /** Whether this comp should be weighted higher/lower */
  weightAdjustment: number
  /** Analysis details */
  analysis: PropertyConditionAnalysis | null
  /** Comparison to subject */
  comparison: CompVsSubjectAnalysis | null
  /** Source of analysis */
  analysisSource: 'vision' | 'inferred' | 'none'
}

// ─── Photo Fetching ──────────────────────────────────────────────────────────

export interface FetchedPhotos {
  propertyId: string
  zillowUrl: ZillowUrl
  photos: string[]
  streetViewUrl: string | null
  source: 'zillow' | 'streetview' | 'none'
  error?: string
}

// ─── Property Classification ─────────────────────────────────────────────────

/**
 * Property classification type for investment analysis
 * - as_is: Property needs renovation (investor/fixer properties)
 * - after_renovation: Property is renovated/turnkey (retail ready)
 * - transitional: Mix of old and new, could go either way
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
  | 'batch_photo_analysis'  // Batch LLM classification with photos
  | 'data_only'             // Data-based classification (no LLM)
  | 'fallback'              // Fallback when LLM fails
  | 'parse_error_fallback'  // Fallback when LLM response parsing fails

/**
 * Result of photo-based analysis for classification
 */
export interface PhotoAnalysisResult {
  /** Condition score 0-100 (0=very distressed, 100=fully renovated) */
  conditionScore: number
  /** Visual indicators observed */
  indicators: string[]
  /** Renovation level assessment */
  renovationLevel: 'none' | 'cosmetic' | 'partial' | 'full'
}

/**
 * Result of description keyword analysis
 */
export interface DescriptionAnalysisResult {
  /** Keywords found in the description */
  keywordsFound: string[]
  /** Whether investment-related keywords were found */
  investmentIndicators: boolean
  /** Whether retail-ready keywords were found */
  retailReadyIndicators: boolean
  /** Score from -100 (as-is) to +100 (after-renovation) */
  score: number
}

/**
 * Indicators used to determine classification
 */
export interface ClassificationIndicators {
  /** Photo-based condition score (0-100) */
  photoScore?: number
  /** Description keyword score (-100 to +100) */
  descriptionScore?: number
  /** Price ratio vs area average */
  priceRatio?: number
}

/**
 * Full classification result for a property
 */
export interface ClassificationResult {
  /** Final classification */
  classification: PropertyClassification
  /** Confidence in classification (0-100) */
  confidence: number
  /** Method used for classification */
  method: ClassificationMethod
  /** Indicators used for classification */
  indicators: ClassificationIndicators
  /** Photo analysis result (if available) */
  photoAnalysis?: PhotoAnalysisResult
  /** Description analysis result (if available) */
  descriptionAnalysis?: DescriptionAnalysisResult
  /** Human-readable reasoning */
  reasoning: string
}

/**
 * LLM response for property classification
 * This matches the expected JSON structure from the PROPERTY_CLASSIFICATION prompt
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
