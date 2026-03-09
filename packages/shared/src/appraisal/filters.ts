/**
 * Shared Filter Evaluators
 *
 * Pure filter evaluation functions that work with any property/comp shape
 * satisfying the PropertyLike/CompLike interfaces.
 */

import type { PropertyLike, CompLike, AppraisalFilter, FilterResult, FilterType } from './types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeSubdivision(value: string | null | undefined): string | null {
  if (!value) return null
  return value.toLowerCase().trim().replace(/\s+/g, ' ')
}

// ─── Filter Evaluator Map ───────────────────────────────────────────────────

type FilterEvaluator = (
  subject: PropertyLike,
  comp: CompLike,
  filter: AppraisalFilter
) => FilterResult

const evaluators: Record<FilterType, FilterEvaluator> = {
  subdivision_match(subject, comp, _filter) {
    const subjectSub = normalizeSubdivision(subject.subdivision)
    const compSub = normalizeSubdivision(comp.subdivision)

    if (!subjectSub || !compSub) {
      return {
        type: 'subdivision_match',
        passed: true,
        reason: 'Subdivision data not available',
      }
    }

    const passed = subjectSub === compSub
    return {
      type: 'subdivision_match',
      passed,
      reason: passed ? undefined : `Subdivision mismatch: "${compSub}" vs subject "${subjectSub}"`,
      actualValue: compSub,
      threshold: subjectSub,
    }
  },

  sale_age(_subject, comp, filter) {
    if (!comp.saleDate) {
      return {
        type: 'sale_age',
        passed: false,
        reason: 'No sale date available',
      }
    }

    const saleDate = new Date(comp.saleDate)
    if (isNaN(saleDate.getTime())) {
      return {
        type: 'sale_age',
        passed: false,
        reason: `Invalid sale date format: "${comp.saleDate}"`,
      }
    }

    const today = new Date()
    const daysDiff = Math.floor((today.getTime() - saleDate.getTime()) / (1000 * 60 * 60 * 24))
    const passed = daysDiff <= filter.value

    return {
      type: 'sale_age',
      passed,
      reason: passed ? undefined : `Sale too old: ${daysDiff} days (max: ${filter.value})`,
      actualValue: daysDiff,
      threshold: filter.value,
    }
  },

  sqft_diff(subject, comp, filter) {
    if (!subject.squareFeet) {
      return {
        type: 'sqft_diff',
        passed: true,
        reason: 'Subject sqft not available',
      }
    }

    if (!comp.squareFeet) {
      return {
        type: 'sqft_diff',
        passed: false,
        reason: 'Comparable sqft not available',
      }
    }

    const diff = Math.abs(comp.squareFeet - subject.squareFeet)
    const passed = diff <= filter.value

    return {
      type: 'sqft_diff',
      passed,
      reason: passed ? undefined : `Sqft difference too large: ${diff} sqft (max: ${filter.value})`,
      actualValue: diff,
      threshold: filter.value,
    }
  },

  property_type(_subject, _comp, _filter) {
    return {
      type: 'property_type',
      passed: true,
      reason: 'Property type filter not evaluated',
    }
  },

  year_built_diff(subject, comp, filter) {
    if (!subject.yearBuilt || !comp.yearBuilt) {
      return {
        type: 'year_built_diff',
        passed: true,
        reason: 'Year built not available',
      }
    }

    const diff = Math.abs(comp.yearBuilt - subject.yearBuilt)
    const passed = diff <= filter.value

    return {
      type: 'year_built_diff',
      passed,
      reason: passed ? undefined : `Year built difference too large: ${diff} years (max: ${filter.value})`,
      actualValue: diff,
      threshold: filter.value,
    }
  },

  distance(_subject, comp, filter) {
    if (comp.distanceMiles == null) {
      return {
        type: 'distance',
        passed: true,
        reason: 'Distance not available',
      }
    }

    const passed = comp.distanceMiles <= filter.value
    return {
      type: 'distance',
      passed,
      reason: passed ? undefined : `Distance too far: ${comp.distanceMiles.toFixed(2)} miles (max: ${filter.value})`,
      actualValue: comp.distanceMiles,
      threshold: filter.value,
    }
  },
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function evaluateFilter(
  subject: PropertyLike,
  comp: CompLike,
  filter: AppraisalFilter
): FilterResult {
  const evaluator = evaluators[filter.type]
  if (!evaluator) {
    return { type: filter.type, passed: true, reason: `Unknown filter type: ${filter.type}` }
  }
  return evaluator(subject, comp, filter)
}
