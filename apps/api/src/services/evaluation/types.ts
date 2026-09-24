/**
 * Evaluation Service Types
 *
 * Types for the hands-off end-to-end evaluation pipeline:
 * auto-derived buybox parameters and the justified evaluation report.
 */

import type { MajorItem, RehabLevel } from '../valuation/types'
import type { PropertyClassification } from '../vision/types'

// ─── Auto-Derivation ──────────────────────────────────────────────────────────

/**
 * A major item that was automatically enabled by derivation rules,
 * with the reason it was added.
 */
export interface DerivedMajorItem extends MajorItem {
  /** Human-readable justification for why this item was deducted */
  reason: string
}

/**
 * Result of auto-deriving buybox parameters from property data and
 * classification signals. Every derived value carries a reason so the
 * final report can justify each deduction.
 */
export interface DerivedBuybox {
  rehabLevelIndex: number
  rehabLevelName: RehabLevel
  /** Why this rehab level was selected */
  rehabReason: string
  /** Where the final rehab level came from */
  rehabLevelSource: 'manual_override' | 'vision' | 'classification' | 'default'
  /** Vision verified the subject renovated — base $/sqft rehab skipped */
  renovatedVerified?: boolean
  majorItems: DerivedMajorItem[]
  /**
   * Full per-item audit trail from the permit-age engine — includes
   * non-triggered and deduplicated items with evidence status.
   */
  majorItemAssessments?: import('./major-items').MajorItemAssessment[]
  additionPlay: number
  closingCostsPercent: number
  carryingCostsPercent: number
  wholesaleFee: number
  /** True when the caller did not supply explicit buybox parameters */
  derived: boolean
  /** Additional derivation notes for the report */
  notes: string[]
}

// ─── Evaluation Report ────────────────────────────────────────────────────────

export interface ReportStep {
  step: string
  label: string
  status: 'completed' | 'skipped' | 'failed' | 'fallback'
  durationMs?: number
  detail?: string
}

export interface ReportArvDriver {
  compId: string
  address: string
  price: number
  /** Normalized weight contribution to the ARV (0-1) */
  weight: number
  classification: PropertyClassification | null
  /** 1 = same class as subject, 2 = transitional, 3 = opposite */
  tier: number
}

export interface ReportDeduction {
  label: string
  amount: number
  reason: string
}

export interface EvaluationReport {
  pipelineVersion: string
  generatedAt: string

  /** Ordered pipeline steps with outcomes and fallback usage */
  steps: ReportStep[]
  /** Flat list of fallbacks that fired during this run */
  fallbacksUsed: string[]

  /** How the subject property was classified and how sure we are */
  subject: {
    classification: PropertyClassification | null
    confidence: number | null
    method: string | null
  }

  /**
   * Computer-vision renovation assessment persisted for audit —
   * the structured evidence behind the renovation level.
   */
  visionAssessment?: {
    status: 'ok' | 'insufficient_photo_evidence' | 'needs_review' | 'unavailable'
    renovationLevel: string | null
    confidence: number | null
    photosExamined: number
    majorObservations: string[]
    evidenceForClassification: string[]
    limitations: string[]
    provider: string | null
    model: string | null
  }

  /** Where the final renovation level came from (manual beats vision) */
  renovationLevelSource?: 'manual_override' | 'vision' | 'classification' | 'default'

  /** ARV justification */
  arv: {
    value: number
    methodology: string
    pricePerSqft: number | null
    /** Comps that drove the valuation, highest weight first */
    drivers: ReportArvDriver[]
    asIsValue: number | null
    afterRenovationValue: number | null
    spread: number | null
    /** Comp pool statistics */
    compPool: {
      total: number
      enabled: number
      /** Comps actually driving ARV — enabled ∩ within 10% of top price, top 3 */
      selected: number
      fallbackUsed: string
      fallbackReason?: string
    }
  }

  /** Rehab justification — full renovation cost ledger */
  rehab: {
    level: RehabLevel | 'Renovated'
    levelIndex: number
    perSqft: number
    baseCost: number
    majorItems: Array<{ name: string; cost: number; reason: string }>
    majorItemsCost: number
    additionPlay: number
    totalCost: number
    derived: boolean
    reason: string
    /** Source of the final level */
    levelSource?: 'manual_override' | 'vision' | 'classification' | 'default'
    /** Renovation ledger: every cost line with source + dedup status */
    ledger?: Array<{
      label: string
      amount: number
      source: 'rehab_tier' | 'major_item_permit' | 'major_item_manual' | 'addition' | 'other'
      reason: string
      deduplicated?: boolean
      evidenceStatus?: string
    }>
  }

  /** Itemized deductions applied between ARV and max buy price */
  deductions: ReportDeduction[]

  /** Final numbers */
  outcome: {
    maxBuyPrice: number
    buyPricePercent: number
    wholesalePrice: number
    projectedProfit: number
    projectedROI: number
    totalInvestment: number
    recommendation: string
    recommendationReason: string
  }

  /** Overall confidence in this evaluation */
  confidence: 'high' | 'medium' | 'low'
  /** Why that confidence level was assigned */
  confidenceReasons: string[]
  /** True unless HIGH — medium flags for review, low withholds the call */
  requiresHumanReview: boolean
  /**
   * Jev evaluation flagged the run for manual review — zero comps passed
   * test 2, so any ARV shown is unexamined reference. Absent/false when
   * the Jev funnel produced ARV comps.
   */
  humanHandoff?: boolean
}
