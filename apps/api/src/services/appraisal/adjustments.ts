/**
 * Adjustment Rule Definitions
 *
 * Each adjustment is a self-contained rule definition with its type key,
 * defaults, UI label metadata, and calculation logic.
 *
 * To add a new adjustment:
 *   1. Add the type to AdjustmentType in types.ts
 *   2. Add one object to the ADJUSTMENT_RULES array below
 * That's it — defaults, labels, and calculator lookup all derive from
 * this single array automatically.
 */

import type { NormalizedProperty, NormalizedComparable } from '../property-api/types'
import type { AppraisalAdjustment, AdjustmentResult, AdjustmentLabel, AdjustmentType } from './types'

// ─── Rule Definition Interface ───────────────────────────────────────────────

export interface AdjustmentRuleDefinition {
  /** Must match a value in AdjustmentType union */
  type: AdjustmentType
  /** Default configuration when no preset is specified */
  defaults: {
    enabled: boolean
    amount: number
    percent?: number
  }
  /** UI metadata for rendering in dashboard */
  label: AdjustmentLabel
  /** The calculation function — determines the price adjustment for a comparable */
  calculate: (
    subject: NormalizedProperty,
    comp: NormalizedComparable,
    adjustment: AppraisalAdjustment
  ) => AdjustmentResult
}

// ─── Adjustment Rules ────────────────────────────────────────────────────────

export const ADJUSTMENT_RULES: AdjustmentRuleDefinition[] = [
  {
    type: 'old_comp_discount',
    defaults: { enabled: true, amount: 0, percent: 15 },
    label: {
      label: 'Old Comp Discount',
      description: 'Discount percentage for older sales',
      isPercentage: true,
    },
    calculate(_subject, comp, adjustment) {
      if (!comp.saleDate || !comp.salePrice) {
        return { type: 'old_comp_discount', applied: false, amount: 0, reason: 'No sale data' }
      }

      const saleDate = new Date(comp.saleDate)
      const today = new Date()
      const daysDiff = Math.floor((today.getTime() - saleDate.getTime()) / (1000 * 60 * 60 * 24))

      // Only apply discount for sales older than 90 days
      if (daysDiff <= 90) {
        return { type: 'old_comp_discount', applied: false, amount: 0, reason: 'Sale within 90 days' }
      }

      const monthsOld = daysDiff / 30
      const percent = adjustment.percent || 15
      const discountPercent = Math.min(percent, (percent * monthsOld) / 12)
      const discountAmount = Math.round(comp.salePrice * (discountPercent / 100))

      return {
        type: 'old_comp_discount',
        applied: true,
        amount: -discountAmount,
        reason: `${discountPercent.toFixed(1)}% discount for ${Math.round(monthsOld)} months old`,
      }
    },
  },

  {
    type: 'bedroom',
    defaults: { enabled: true, amount: 15000 },
    label: {
      label: 'Bedroom Adjustment',
      description: 'Dollar adjustment per bedroom difference',
    },
    calculate(subject, comp, adjustment) {
      if (subject.bedrooms == null || comp.bedrooms == null) {
        return { type: 'bedroom', applied: false, amount: 0, reason: 'Bedroom data not available' }
      }

      const diff = subject.bedrooms - comp.bedrooms
      if (diff === 0) {
        return { type: 'bedroom', applied: false, amount: 0, reason: 'Same bedroom count' }
      }

      const amount = diff * adjustment.amount
      return {
        type: 'bedroom',
        applied: true,
        amount,
        reason: `${diff > 0 ? '+' : ''}${diff} bedrooms × $${adjustment.amount.toLocaleString()}`,
      }
    },
  },

  {
    type: 'bathroom',
    defaults: { enabled: true, amount: 10000 },
    label: {
      label: 'Bathroom Adjustment',
      description: 'Dollar adjustment per bathroom difference',
    },
    calculate(subject, comp, adjustment) {
      if (subject.bathrooms == null || comp.bathrooms == null) {
        return { type: 'bathroom', applied: false, amount: 0, reason: 'Bathroom data not available' }
      }

      const diff = subject.bathrooms - comp.bathrooms
      if (diff === 0) {
        return { type: 'bathroom', applied: false, amount: 0, reason: 'Same bathroom count' }
      }

      const amount = diff * adjustment.amount
      return {
        type: 'bathroom',
        applied: true,
        amount,
        reason: `${diff > 0 ? '+' : ''}${diff} bathrooms × $${adjustment.amount.toLocaleString()}`,
      }
    },
  },

  {
    type: 'pool',
    defaults: { enabled: false, amount: 10000 },
    label: {
      label: 'Pool Adjustment',
      description: 'Add value if subject has a pool',
    },
    calculate(subject, _comp, adjustment) {
      const hasPool = subject.features?.poolType && subject.features.poolType.length > 0
      if (!hasPool) {
        return { type: 'pool', applied: false, amount: 0, reason: 'Subject has no pool' }
      }

      return {
        type: 'pool',
        applied: true,
        amount: adjustment.amount,
        reason: `Subject has pool (+$${adjustment.amount.toLocaleString()})`,
      }
    },
  },

  {
    type: 'garage',
    defaults: { enabled: false, amount: 10000 },
    label: {
      label: 'Garage Adjustment',
      description: 'Add value if subject has a garage',
    },
    calculate(subject, _comp, adjustment) {
      const hasGarage =
        (subject.features?.garageType && subject.features.garageType.length > 0) ||
        (subject.features?.garageSquareFeet && subject.features.garageSquareFeet > 0)

      if (!hasGarage) {
        return { type: 'garage', applied: false, amount: 0, reason: 'Subject has no garage' }
      }

      return {
        type: 'garage',
        applied: true,
        amount: adjustment.amount,
        reason: `Subject has garage (+$${adjustment.amount.toLocaleString()})`,
      }
    },
  },

  {
    type: 'carport',
    defaults: { enabled: false, amount: 5000 },
    label: {
      label: 'Carport Adjustment',
      description: 'Add value if subject has a carport',
    },
    calculate(subject, _comp, adjustment) {
      const hasCarport = subject.features?.carportType != null

      if (!hasCarport) {
        return { type: 'carport', applied: false, amount: 0, reason: 'Subject has no carport' }
      }

      return {
        type: 'carport',
        applied: true,
        amount: adjustment.amount,
        reason: `Subject has carport (+$${adjustment.amount.toLocaleString()})`,
      }
    },
  },
]
