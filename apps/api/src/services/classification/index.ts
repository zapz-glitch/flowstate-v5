/**
 * Property Classification Types
 *
 * Classification is now price-based (top X% by price/sqft = after_renovation).
 * Types are re-exported from vision/types for backward compatibility with
 * appraisal and analysis services that reference ClassificationResult.
 */

export type {
  PropertyClassification,
  ClassificationResult,
  ClassificationIndicators,
  PhotoAnalysisResult,
  DescriptionAnalysisResult,
} from '../vision/types'
