/**
 * Client-side Recalculation Engine Types
 *
 * Re-exports shared types from @flowstate-api/shared and defines
 * client-specific types for the recalculation UI.
 */

// Re-export shared types
export type {
  FilterType,
  AdjustmentType,
  ArvTier,
  RehabEstimate,
  RehabTable,
  RehabLevelEstimate,
  MajorItemId,
  TierRangeDefinition,
} from '@flowstate-api/shared'

export {
  MAJOR_ITEMS as MAJOR_ITEMS_LIST,
  REHAB_LEVELS,
} from '@flowstate-api/shared'

import type { DealParamsConfig, TierRangeDefinition } from '../client-api'

// ─── Aliases for backward compatibility ──────────────────────────────────────

export type RecalcFilter = {
  type: string
  enabled: boolean
  value: number
}

export type RecalcAdjustment = {
  type: string
  enabled: boolean
  amount: number
  percent?: number
}

// ─── Major Items Setting ─────────────────────────────────────────────────────

export interface MajorItemSetting {
  id: string
  name: string
  enabled: boolean
  cost: number
}

// ─── Comp Evaluation ────────────────────────────────────────────────────────

export interface CompEvaluation {
  isEnabled: boolean
  /** Comp quality score based on soft filter matches (higher = better) */
  compScore: number
  disableReasons: string[]
  filterResults: Array<{
    type: string
    passed: boolean
    reason?: string
    actualValue?: number | string | null
    threshold?: number | string | null
  }>
  adjustmentResults: Array<{
    type: string
    applied: boolean
    amount: number
    reason?: string
  }>
  totalAdjustment: number
  adjustedPrice: number | null
}

// ─── Valuation Result ───────────────────────────────────────────────────────

export interface RecalcValuationResult {
  arv: number
  arvTier: string
  arvPerSqft: number
  buyPrice: number
  buyPricePercent: number
  rehabLevel: string
  rehabPerSqft: number
  baseRehabCost: number
  majorItemsCost: number
  rehabCost: number
  closingCosts: number
  carryingCosts: number
  totalCosts: number
  totalInvestment: number
  projectedProfit: number
  projectedROI: number
  wholesalePrice: number
  rehabLevelEstimates: Array<{
    index: number
    name: string
    perSqft: number
    estimatedCost: number
    buyPrice: number
    wholesalePrice: number
    projectedProfit: number
    projectedROI: number
    isSelected: boolean
  }>
}

// ─── Evaluation Settings (combined user settings) ───────────────────────────

export interface EvaluationSettings {
  filters: RecalcFilter[]
  adjustments: RecalcAdjustment[]
  dealParams: DealParamsConfig
  rehabTable: Record<string, Array<{ perSqft: number; minProfit: number }>>
  tierRanges?: TierRangeDefinition[]
  rehabLevelIndex: number
  majorItems: MajorItemSetting[]
  additionPlay?: number
}

// ─── Recalc Result (full output from recalculateReport) ─────────────────────

export interface RecalcResult {
  /** Updated comp evaluations, keyed by comp index */
  compEvaluations: CompEvaluation[]
  /** New ARV from enabled comps */
  arv: number
  /** Number of enabled comps */
  enabledCount: number
  /** Number of disabled comps */
  disabledCount: number
  /** Avg price per sqft of enabled comps */
  avgPricePerSqft: number | null
  /** Median sale price of enabled comps */
  medianPrice: number | null
  /** Full valuation result */
  valuation: RecalcValuationResult
  /** Whether values differ from original */
  hasChanges: boolean
}
