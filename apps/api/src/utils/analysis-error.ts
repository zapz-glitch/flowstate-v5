/**
 * Typed error for analysis failures with filter suggestions.
 * Used when no comps pass appraisal filters — includes suggested
 * filter values and ARV threshold for the dashboard to offer "Apply & Retry".
 */

import type { AppraisalFilter } from '../services/appraisal'

export class AnalysisError extends Error {
  readonly suggestedFilters?: AppraisalFilter[]
  readonly suggestedArvThreshold?: number

  constructor(
    message: string,
    options?: {
      suggestedFilters?: AppraisalFilter[]
      suggestedArvThreshold?: number
    },
  ) {
    super(`BAD_DEAL: ${message}`)
    this.name = 'AnalysisError'
    this.suggestedFilters = options?.suggestedFilters
    this.suggestedArvThreshold = options?.suggestedArvThreshold
  }
}
