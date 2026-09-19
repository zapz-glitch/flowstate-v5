/**
 * Shared Filter Evaluators
 *
 * Pure filter evaluation functions that work with any property/comp shape
 * satisfying the PropertyLike/CompLike interfaces.
 */

import type { PropertyLike, CompLike, AppraisalFilter, FilterResult, FilterType } from './types'
import { foundationFamily } from './adjustments'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeSubdivision(value: string | null | undefined): string | null {
  if (!value) return null
  return value.toLowerCase().trim().replace(/\s+/g, ' ')
}

/**
 * Subdivision base name — strips ALL plat/legal designator tokens (unit,
 * block, phase, lot, plat, NCB, SUB, etc.) and bare numeric identifiers so
 * differently-recorded parcels of the same community resolve to the shared
 * meaningful name:
 *   "HIGHLAND HILLS SUB UN 17 NCB 1" → "highland hills"
 *   "HIGHLAND HILLS BL 10854 UN 15"  → "highland hills"
 */
const SUBDIVISION_DESIGNATORS = new Set([
  'un', 'unit', 'ut', 'u',
  'ph', 'phase',
  'sec', 'sect', 'section',
  'blk', 'block', 'bl',
  'lot', 'plat', 'tract',
  'add', 'addn', 'addition',
  'part', 'pt',
  'rep', 'repl', 'replat',
  'vlg',
  'sub', 'subdiv', 'subdivision',
  'ncb', 'nb',
  'the', 'of',
])

export function subdivisionBase(value: string | null | undefined): string | null {
  let v = normalizeSubdivision(value)
  if (!v) return null
  v = v.replace(/[\/\-_.,#]/g, ' ').replace(/\s+/g, ' ').trim()
  const tokens = v
    .split(' ')
    .filter((t) => !SUBDIVISION_DESIGNATORS.has(t) && !/^\d+[a-z]?$/.test(t))
  v = tokens.join(' ').trim()
  return v || null
}

/**
 * Equal base names, or one base a word-boundary prefix of the other —
 * "sweetwater creek" ⊂ "sweetwater creek south" but "oak" ⊄ "oakwood".
 */
export function subdivisionsMatch(
  subjectSub: string | null | undefined,
  compSub: string | null | undefined
): boolean {
  const a = subdivisionBase(subjectSub)
  const b = subdivisionBase(compSub)
  if (!a || !b) return false
  if (a === b) return true
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a]
  return longer.startsWith(shorter) && longer[shorter.length] === ' '
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

    const passed = subdivisionsMatch(subjectSub, compSub)
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

    const subjectFam = foundationFamily(subject.construction?.foundationType)
    const compFam = foundationFamily(comp.construction?.foundationType)

    const passed =
      subjectFoundation === compFoundation ||
      subjectFam === compFam ||
      subjectFam === 'other' ||
      compFam === 'other'

    return {
      type: 'foundation_match',
      passed,
      reason: passed
        ? subjectFoundation !== compFoundation && subjectFam === compFam
          ? `Foundation family match: "${comp.construction?.foundationType}" vs subject "${subject.construction?.foundationType}"`
          : subjectFam === 'other' || compFam === 'other'
            ? 'Foundation types differ but could not be classified — not verified'
            : undefined
        : `Foundation mismatch: "${comp.construction?.foundationType}" (${compFam}) vs subject "${subject.construction?.foundationType}" (${subjectFam})`,
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

    // Absolute sqft difference — matches the API evaluator semantics
    // (filter.value is a sqft threshold, e.g. ±250).
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

  neighborhood_match(subject, comp, _filter) {
    const norm = (v?: string | null) => v?.toLowerCase().trim().replace(/\s+/g, ' ') || null
    const s = norm(subject.neighborhoodName)
    const c = norm(comp.neighborhoodName)
    if (!s || !c) {
      return { type: 'neighborhood_match', passed: true, reason: 'Neighborhood data not available' }
    }
    const passed = s === c
    return {
      type: 'neighborhood_match',
      passed,
      reason: passed ? undefined : `Neighborhood mismatch: "${c}" vs subject "${s}"`,
      actualValue: c,
      threshold: s,
    }
  },

  construction_material_match(subject, comp, _filter) {
    const norm = (v?: string | null) => v?.toLowerCase().replace(/[^a-z]/g, '') || null
    const pairs = [
      [norm(subject.construction?.type), norm(comp.construction?.type)],
      [norm(subject.construction?.exteriorWalls), norm(comp.construction?.exteriorWalls)],
    ].filter(([s, c]) => s && c)
    if (pairs.length === 0) {
      return { type: 'construction_material_match', passed: true, reason: 'Construction material data not available' }
    }
    const passed = pairs.every(([s, c]) => s === c)
    return {
      type: 'construction_material_match',
      passed,
      reason: passed ? undefined : 'Construction material/type mismatch with subject',
      actualValue: comp.construction?.exteriorWalls ?? comp.construction?.type,
      threshold: subject.construction?.exteriorWalls ?? subject.construction?.type,
    }
  },

  pool_match(subject, comp, _filter) {
    const sHas = (subject.features?.poolType?.length ?? 0) > 0
    const cHas = (comp.features?.poolType?.length ?? 0) > 0
    if (subject.features?.poolType == null || comp.features?.poolType == null) {
      return { type: 'pool_match', passed: true, reason: 'Pool data not available' }
    }
    const passed = sHas === cHas
    return {
      type: 'pool_match',
      passed,
      reason: passed ? undefined : `Pool mismatch: comp ${cHas ? 'has' : 'has no'} pool`,
      actualValue: cHas ? 'pool' : 'none',
      threshold: sHas ? 'pool' : 'none',
    }
  },

  garage_match(subject, comp, _filter) {
    const covered = (p: PropertyLike) =>
      ((p.features?.garageType?.length ?? 0) > 0) ||
      ((p.features?.garageSquareFeet ?? 0) > 0) ||
      ((p.features?.carportType?.length ?? 0) > 0)
    const hasData = (p: PropertyLike) =>
      p.features != null && (p.features.garageType != null || p.features.garageSquareFeet != null || p.features.carportType != null)
    if (!hasData(subject) || !hasData(comp)) {
      return { type: 'garage_match', passed: true, reason: 'Garage/carport data not available' }
    }
    const sHas = covered(subject)
    const cHas = covered(comp)
    const passed = sHas === cHas
    return {
      type: 'garage_match',
      passed,
      reason: passed ? undefined : `Covered-parking mismatch: comp ${cHas ? 'has' : 'has none'}`,
      actualValue: cHas ? 'covered_parking' : 'none',
      threshold: sHas ? 'covered_parking' : 'none',
    }
  },

  stories_match(subject, comp, _filter) {
    if (subject.stories == null || comp.stories == null) {
      return { type: 'stories_match', passed: true, reason: 'Story count not available' }
    }
    // Half-story tolerance: 1.5-story comps are compatible with both 1 and 2
    const passed = Math.abs(subject.stories - comp.stories) <= 0.5
    return {
      type: 'stories_match',
      passed,
      reason: passed ? undefined : `Stories mismatch: ${comp.stories} vs subject ${subject.stories}`,
      actualValue: comp.stories,
      threshold: subject.stories,
    }
  },

  roof_material_match(subject, comp, _filter) {
    const norm = (v?: string | null) => v?.toLowerCase().replace(/[^a-z]/g, '') || null
    const s = norm(subject.construction?.roofCover)
    const c = norm(comp.construction?.roofCover)
    if (!s || !c) {
      return { type: 'roof_material_match', passed: true, reason: 'Roof material data not available' }
    }
    const passed = s === c
    return {
      type: 'roof_material_match',
      passed,
      reason: passed ? undefined : `Roof material mismatch: "${comp.construction?.roofCover}" vs subject "${subject.construction?.roofCover}"`,
      actualValue: comp.construction?.roofCover,
      threshold: subject.construction?.roofCover,
    }
  },

  condition_match(subject, comp, _filter) {
    const tiers: Record<string, number> = {
      excellent: 7, verygood: 6, good: 5, average: 4, fair: 3, poor: 2, verypoor: 1,
    }
    const tier = (v?: string | null) => (v ? tiers[v.toLowerCase().replace(/[^a-z]/g, '')] ?? null : null)
    const s = tier(subject.buildingCondition)
    const c = tier(comp.buildingCondition)
    if (s == null || c == null) {
      return { type: 'condition_match', passed: true, reason: 'Assessor condition data not available' }
    }
    const passed = c >= s
    return {
      type: 'condition_match',
      passed,
      reason: passed ? undefined : `Condition mismatch: comp "${comp.buildingCondition}" below subject "${subject.buildingCondition}"`,
      actualValue: comp.buildingCondition,
      threshold: subject.buildingCondition,
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
