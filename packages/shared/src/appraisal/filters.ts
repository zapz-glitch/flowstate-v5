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

  building_style_match(subject, comp, _filter) {
    const subjectStyle = subject.construction?.buildingStyle?.toLowerCase().trim()
    const compStyle = comp.construction?.buildingStyle?.toLowerCase().trim()

    if (!subjectStyle || !compStyle) {
      return { type: 'building_style_match', passed: true, reason: 'Building style data not available' }
    }

    const passed = subjectStyle === compStyle
    return {
      type: 'building_style_match',
      passed,
      reason: passed ? undefined : `Style mismatch: "${compStyle}" vs subject "${subjectStyle}"`,
      actualValue: compStyle,
      threshold: subjectStyle,
    }
  },

  foundation_match(subject, comp, _filter) {
    const normalize = (v?: string | null) => v?.toLowerCase().replace(/[^a-z]/g, '')
    const subjectFoundation = normalize(subject.construction?.foundationType)
    const compFoundation = normalize(comp.construction?.foundationType)

    if (!subjectFoundation || !compFoundation) {
      return { type: 'foundation_match', passed: true, reason: 'Foundation type data not available' }
    }

    const passed = subjectFoundation === compFoundation
    return {
      type: 'foundation_match',
      passed,
      reason: passed ? undefined : `Foundation mismatch: "${comp.construction?.foundationType}" vs subject "${subject.construction?.foundationType}"`,
      actualValue: comp.construction?.foundationType,
      threshold: subject.construction?.foundationType,
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

    const pctDiff = Math.abs(comp.squareFeet - subject.squareFeet) / subject.squareFeet * 100
    const passed = pctDiff <= filter.value

    return {
      type: 'sqft_diff',
      passed,
      reason: passed ? undefined : `Sqft difference too large: ${Math.round(pctDiff)}% (max: ±${filter.value}%)`,
      actualValue: Math.round(pctDiff),
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

    // Properties built 1940 and older are all treated as equivalent era
    const PRE_WAR_CUTOFF = 1940
    const effectiveSubject = Math.max(subject.yearBuilt, PRE_WAR_CUTOFF)
    const effectiveComp = Math.max(comp.yearBuilt, PRE_WAR_CUTOFF)
    const diff = Math.abs(effectiveComp - effectiveSubject)
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

  lot_size_diff(subject, comp, filter) {
    const subjLot = subject.lotSizeSquareFeet
    const compLot = comp.lotSizeSquareFeet
    if (subjLot == null || compLot == null) {
      return { type: 'lot_size_diff', passed: true, reason: 'Lot size data not available' }
    }
    const diff = Math.abs(compLot - subjLot)
    return {
      type: 'lot_size_diff',
      passed: diff <= filter.value,
      reason: diff <= filter.value ? undefined : `Lot size difference too large: ${diff} sqft (max: ${filter.value})`,
      actualValue: diff,
      threshold: filter.value,
    }
  },

  road_barrier(_subject, comp, _filter) {
    if (comp.crossesMajorRoad == null) {
      return { type: 'road_barrier', passed: true, reason: 'Road-barrier data not available' }
    }
    const passed = comp.crossesMajorRoad === false
    return {
      type: 'road_barrier',
      passed,
      reason: passed ? undefined : 'Comparable is across a major road from subject',
      actualValue: comp.crossesMajorRoad ? 'crosses' : 'same_side',
      threshold: 'same_side',
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
