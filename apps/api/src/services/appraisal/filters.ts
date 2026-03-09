/**
 * Filter Rule Definitions
 *
 * Each filter is a self-contained rule definition with its type key, defaults,
 * UI label metadata, API param mapping, and evaluation logic.
 *
 * To add a new filter:
 *   1. Add the type to FilterType in types.ts
 *   2. Add one object to the FILTER_RULES array below
 * That's it — defaults, labels, evaluator lookup, and filtersToApiParams
 * all derive from this single array automatically.
 */

import type { NormalizedProperty, NormalizedComparable } from '../property-api/types'
import type { AppraisalFilter, FilterResult, FilterLabel, FilterType, ApiFilterParamKey } from './types'

// ─── Rule Definition Interface ───────────────────────────────────────────────

export interface FilterRuleDefinition {
  /** Must match a value in FilterType union */
  type: FilterType
  /** Default configuration when no preset is specified */
  defaults: {
    enabled: boolean
    value: number
  }
  /** UI metadata for rendering in dashboard */
  label: FilterLabel
  /**
   * Which API-level parameter this filter maps to for pre-filtering.
   * Set to null if the filter is only applied post-fetch (e.g., requires enriched data).
   */
  apiParam: ApiFilterParamKey | null
  /**
   * Optional conversion function for the API param value.
   * Example: sale_age converts days to months via Math.ceil(days / 30).
   * If not provided, filter.value is passed through directly.
   */
  apiParamConvert?: (value: number) => number
  /** The evaluation function — determines if a comparable passes this filter */
  evaluate: (
    subject: NormalizedProperty,
    comp: NormalizedComparable,
    filter: AppraisalFilter
  ) => FilterResult
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeSubdivision(value: string | null | undefined): string | null {
  if (!value) return null
  return value.toLowerCase().trim().replace(/\s+/g, ' ')
}

// ─── Filter Rules ────────────────────────────────────────────────────────────

export const FILTER_RULES: FilterRuleDefinition[] = [
  {
    type: 'subdivision_match',
    defaults: { enabled: true, value: 1 },
    label: {
      label: 'Subdivision Match',
      shortLabel: 'Subdivision',
      unit: '',
      description: 'Must be in same subdivision as subject',
    },
    apiParam: null,
    evaluate(subject, comp, _filter) {
      const subjectSub = normalizeSubdivision(subject.subdivision)
      const compSub = normalizeSubdivision(
        comp.subdivision ?? (comp.raw as { subdivision?: string } | undefined)?.subdivision
      )

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
  },

  {
    type: 'sale_age',
    defaults: { enabled: true, value: 180 },
    label: {
      label: 'Sale Age',
      shortLabel: 'Sale Age',
      unit: 'days',
      description: 'Maximum days since comparable sold',
    },
    apiParam: 'monthsBack',
    apiParamConvert: (days: number) => Math.ceil(days / 30),
    evaluate(_subject, comp, filter) {
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
  },

  {
    type: 'sqft_diff',
    defaults: { enabled: true, value: 250 },
    label: {
      label: 'Square Footage Difference',
      shortLabel: 'SqFt Diff',
      unit: 'sqft',
      description: 'Maximum sqft difference from subject',
    },
    apiParam: 'sqftVariance',
    evaluate(subject, comp, filter) {
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
  },

  {
    type: 'year_built_diff',
    defaults: { enabled: true, value: 10 },
    label: {
      label: 'Year Built Difference',
      shortLabel: 'Year Diff',
      unit: 'years',
      description: 'Maximum year built difference from subject',
    },
    apiParam: null,
    evaluate(subject, comp, filter) {
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
  },

  {
    type: 'distance',
    defaults: { enabled: true, value: 0.5 },
    label: {
      label: 'Search Distance',
      shortLabel: 'Distance',
      unit: 'miles',
      description: 'Maximum distance from subject property',
    },
    apiParam: 'radiusMiles',
    evaluate(_subject, comp, filter) {
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
  },
]
