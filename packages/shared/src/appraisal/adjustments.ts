/**
 * Shared Adjustment Calculators
 *
 * Pure adjustment calculation functions that work with any property/comp shape
 * satisfying the PropertyLike/CompLike interfaces.
 */

import type { PropertyLike, CompLike, AppraisalAdjustment, AdjustmentResult, AdjustmentType } from './types'

// ─── Adjustment Calculator Map ──────────────────────────────────────────────

type AdjustmentCalculator = (
  subject: PropertyLike,
  comp: CompLike,
  adjustment: AppraisalAdjustment
) => AdjustmentResult

const calculators: Record<AdjustmentType, AdjustmentCalculator> = {
  old_comp_discount(_subject, comp, adjustment) {
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

  bedroom(subject, comp, adjustment) {
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

  bathroom(subject, comp, adjustment) {
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

  pool(subject, _comp, adjustment) {
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

  garage(subject, _comp, adjustment) {
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

  carport(_subject, _comp, _adjustment) {
    return {
      type: 'carport',
      applied: false,
      amount: 0,
      reason: 'Carport adjustment not implemented',
    }
  },
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function calculateAdjustment(
  subject: PropertyLike,
  comp: CompLike,
  adjustment: AppraisalAdjustment
): AdjustmentResult {
  const calculator = calculators[adjustment.type]
  if (!calculator) {
    return { type: adjustment.type, applied: false, amount: 0, reason: `Unknown adjustment type: ${adjustment.type}` }
  }
  return calculator(subject, comp, adjustment)
}
