/**
 * Appraisal Rule Evaluator
 *
 * Evaluates comparables against filters and calculates adjustments.
 */

import type { NormalizedProperty, NormalizedComparable } from '../property-api/types'
import type {
  AppraisalFilter,
  AppraisalAdjustment,
  FilterResult,
  AdjustmentResult,
  ComparableEvaluation,
  FilterType,
  AdjustmentType,
} from './types'

// ─── Filter Evaluators ─────────────────────────────────────────────────────────

function evaluateSubdivisionMatch(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  _filter: AppraisalFilter
): FilterResult {
  const subjectSub = normalizeSubdivision(subject.subdivision)
  // Use enriched subdivision data from comp, fallback to raw data
  const compSub = normalizeSubdivision(
    comp.subdivision ?? (comp.raw as { subdivision?: string } | undefined)?.subdivision
  )

  // Skip if either is missing - graceful fallback per v1 behavior
  if (!subjectSub || !compSub) {
    return {
      type: 'subdivision_match',
      passed: true,
      status: 'not_verified',
      reason: 'Subdivision data not available — rule not verified',
    }
  }

  const passed = subdivisionsMatch(subjectSub, compSub)
  if (!passed) {
    // Census verification overrides the plat-name mismatch — legal
    // subdivision names routinely diverge from the actual market area; a
    // comp in the subject's census block group or tract is geographically
    // verified regardless of its plat.
    const censusVerified =
      comp.sameBlockGroup === true ||
      // Tract rescue needs proximity too — a tract can span multiple
      // market pockets; same-tract at 2mi is not verified geography.
      // Block groups are the pocket-sized unit and rescue on their own.
      (comp.censusTract != null && subject.censusTract != null && comp.censusTract === subject.censusTract &&
        (comp.distanceMiles == null || comp.distanceMiles <= 0.75)) ||
      // Flex exception — under stretch, a plat-name mismatch survives when
      // the pocket is value-equivalent to the subject's.
      (typeof _filter.value === 'number' && _filter.value > 1 && isValueEquivalent(subject, comp))
    if (censusVerified) {
      return {
        type: 'subdivision_match',
        passed: true,
        reason: `Legal subdivision differs ("${compSub}") — census tract/BG match verifies the geography`,
        actualValue: compSub,
        threshold: subjectSub,
      }
    }
  }
  return {
    type: 'subdivision_match',
    passed,
    reason: passed ? undefined : `Subdivision mismatch: "${compSub}" vs subject "${subjectSub}"`,
    actualValue: compSub,
    threshold: subjectSub,
  }
}

// Geo-name normalization — ATTOM writes "Saint Petersburg" where USPS and
// county sources write "St. Petersburg"; a punctuation/abbreviation diff
// is the same scope, not a mismatch. Whole-word substitutions only.
const GEO_EQUIV: Record<string, string> = {
  SAINT: 'ST', STE: 'STE', MOUNT: 'MT', FORT: 'FT',
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
  NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
  HEIGHTS: 'HTS', BEACH: 'BCH',
}
export function geoScopeNorm(v: string): string {
  return v.toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => GEO_EQUIV[w] ?? w)
    .join(' ')
}

/** Hard geo legs for the pocket catch — the name-label forgiveness covers
 *  neighborhood/subdivision ONLY (enclave vs parent naming); city, county,
 *  zip and school district must still literally match. */
export function pocketHardScopesMatch(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
): boolean {
  const pairs: Array<[string | undefined, string | undefined]> = [
    [subject.geoScopes?.city ?? subject.city ?? undefined, comp.geoScopes?.city ?? comp.city ?? undefined],
    [subject.geoScopes?.county ?? subject.county ?? undefined, comp.geoScopes?.county],
    [subject.geoScopes?.zip ?? subject.zipCode ?? undefined, comp.geoScopes?.zip ?? comp.zipCode ?? undefined],
    [subject.geoScopes?.schoolDistrict, comp.geoScopes?.schoolDistrict],
  ]
  return pairs.every(([a, b]) => !a || !b || geoScopeNorm(a) === geoScopeNorm(b))
}

/** Phase-1 scope requirement: every geography scope populated on BOTH
 *  sides must match (county, city, zip, school district, subdivision, N4).
 *  A scope absent on either side is unverifiable — not a mismatch. */
function evaluateGeoScopeMatch(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  filter: AppraisalFilter,
): FilterResult {
  const s = subject.geoScopes
  const c = comp.geoScopes
  const pairs: Array<[string, string | undefined, string | undefined]> = [
    ['subdivision', s?.subdivision ?? subject.subdivision ?? undefined, c?.subdivision ?? comp.subdivision ?? undefined],
    ['neighborhood', s?.n4 ?? subject.neighborhoodName ?? undefined, c?.n4 ?? comp.neighborhoodName ?? undefined],
    ['school district', s?.schoolDistrict, c?.schoolDistrict],
    ['city', s?.city ?? subject.city ?? undefined, c?.city ?? comp.city ?? undefined],
    ['county', s?.county ?? subject.county ?? undefined, c?.county],
    ['zip', s?.zip ?? subject.zipCode ?? undefined, c?.zip ?? comp.zipCode ?? undefined],
  ]
  const populated = pairs.filter(([, a, b]) => a && b)
  if (populated.length === 0) {
    return {
      type: 'geo_scope_match',
      passed: true,
      status: 'not_verified',
      reason: 'No geo-scope data — rule not verified',
    }
  }
  const mismatches = populated.filter(([, a, b]) => geoScopeNorm(a!) !== geoScopeNorm(b!))
  const passed = mismatches.length === 0
  if (!passed && typeof filter.value === 'number' && filter.value > 1 && isValueEquivalent(subject, comp)) {
    return {
      type: 'geo_scope_match',
      passed: true,
      reason: `Scope mismatch (${mismatches.map(([n]) => n).join(', ')}) — value-equivalent pocket under flex`,
      actualValue: `${populated.length - mismatches.length}/${populated.length} scopes match`,
    }
  }
  return {
    type: 'geo_scope_match',
    passed,
    reason: passed ? undefined : `Geo scope mismatch: ${mismatches.map(([n, a, b]) => `${n} "${b}" ≠ "${a}"`).join(', ')}`,
    actualValue: `${populated.length - mismatches.length}/${populated.length} scopes match`,
    threshold: 'all populated scopes',
  }
}

function evaluateSaleAge(
  _subject: NormalizedProperty,
  comp: NormalizedComparable,
  filter: AppraisalFilter
): FilterResult {
  if (!comp.saleDate) {
    return {
      type: 'sale_age',
      passed: false,
      reason: 'No sale date available',
    }
  }

  const saleDate = new Date(comp.saleDate)

  // Check if date is valid
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
}

function evaluateSqftDiff(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  filter: AppraisalFilter
): FilterResult {
  if (!subject.squareFeet) {
    return {
      type: 'sqft_diff',
      passed: true,
      status: 'not_verified',
      reason: 'Subject sqft not available — rule not verified',
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
}

/** Vintage-era window — subjects ≤1945 comp to the whole pre-1970 buyer
 *  class ("everything before 1970 is in play"). */
const VINTAGE_SUBJECT_MAX_YEAR = 1945
const VINTAGE_ERA_COMP_MAX_YEAR = 1969

/** Era classes — same / adjacent / far relative to the subject. Vintage is
 *  the only class spanning asymmetrically (pre-1970 = one buyer class). */
const ERA_NAMES = ['vintage (≤1945)', 'post-war (1946-69)', 'late-20th (1970-89)', '90s-00s (1990-2009)', 'modern (2010+)'] as const
const eraIndex = (yearBuilt: number) =>
  yearBuilt <= 1945 ? 0 : yearBuilt <= 1969 ? 1 : yearBuilt <= 1989 ? 2 : yearBuilt <= 2009 ? 3 : 4

/** The ladder's deepest year tier — a fallback catch, not a primary gate:
 *  the strict band ran first and failed, so era-class rescues what it can.
 *  Same or adjacent era passes flagged; 2+ era gaps fail. */
function evaluateYearBuiltEra(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  _filter: AppraisalFilter
): FilterResult {
  if (!subject.yearBuilt || !comp.yearBuilt) {
    return {
      type: 'year_built_era',
      passed: true,
      status: 'not_verified',
      reason: 'Year built not available — rule not verified',
    }
  }
  const sEra = eraIndex(subject.yearBuilt)
  const cEra = eraIndex(comp.yearBuilt)
  const eraGap = Math.abs(cEra - sEra)
  const passed = eraGap <= 1
  return {
    type: 'year_built_era',
    passed,
    reason: passed
      ? eraGap === 1 ? `Adjacent era: ${ERA_NAMES[cEra]} comp vs ${ERA_NAMES[sEra]} subject — fallback caught` : undefined
      : `Era mismatch: ${ERA_NAMES[cEra]} comp vs ${ERA_NAMES[sEra]} subject`,
    actualValue: eraGap,
    threshold: 'same or adjacent era',
  }
}

function evaluateYearBuiltDiff(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  filter: AppraisalFilter
): FilterResult {
  if (!subject.yearBuilt || !comp.yearBuilt) {
    return {
      type: 'year_built_diff',
      passed: true,
      status: 'not_verified',
      reason: 'Year built not available — rule not verified',
    }
  }

  // Vintage subjects → era window at tier-0: any comp ≤1969 is the same
  // buyer class, whatever the year diff. Year proximity stays a ranking
  // signal via the ladder's tight tiers, never a gate for vintage stock.
  if (subject.yearBuilt <= VINTAGE_SUBJECT_MAX_YEAR) {
    const passed = comp.yearBuilt <= VINTAGE_ERA_COMP_MAX_YEAR
    return {
      type: 'year_built_diff',
      passed,
      reason: passed
        ? undefined
        : `Modern-era comp (${comp.yearBuilt}) vs vintage subject (${subject.yearBuilt}) — era mismatch (vintage window ≤${VINTAGE_ERA_COMP_MAX_YEAR})`,
      actualValue: comp.yearBuilt,
      threshold: VINTAGE_ERA_COMP_MAX_YEAR,
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
}

/**
 * Absolute build-year ceiling — the vintage-subject fallback rule the
 * ladder swaps in for year_built_diff. One-sided: any comp built on or
 * before the cap passes, however much older than the subject it is.
 */
function evaluateYearBuiltCap(
  _subject: NormalizedProperty,
  comp: NormalizedComparable,
  filter: AppraisalFilter
): FilterResult {
  if (!comp.yearBuilt) {
    return {
      type: 'year_built_cap',
      passed: true,
      status: 'not_verified',
      reason: 'Year built not available — rule not verified',
    }
  }

  const passed = comp.yearBuilt <= filter.value
  return {
    type: 'year_built_cap',
    passed,
    reason: passed ? undefined : `Built after vintage cap: ${comp.yearBuilt} (cap: ${filter.value})`,
    actualValue: comp.yearBuilt,
    threshold: filter.value,
  }
}

function evaluateDistance(
  _subject: NormalizedProperty,
  comp: NormalizedComparable,
  filter: AppraisalFilter
): FilterResult {
  if (comp.distanceMiles == null) {
    return {
      type: 'distance',
      passed: true,
      status: 'not_verified',
      reason: 'Distance not available — rule not verified',
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
}

function evaluatePropertyType(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  _filter: AppraisalFilter
): FilterResult {
  const subjectType = normalizePropertyType(subject.propertyType)
  const compType = normalizePropertyType(comp.propertyType)

  if (!subjectType || !compType) {
    return {
      type: 'property_type',
      passed: true,
      status: 'not_verified',
      reason: 'Property type data not available — rule not verified',
    }
  }

  const passed = subjectType === compType
  return {
    type: 'property_type',
    passed,
    status: passed ? 'passed' : 'failed',
    reason: passed ? undefined : `Property type mismatch: "${compType}" vs subject "${subjectType}"`,
    actualValue: compType,
    threshold: subjectType,
  }
}

function evaluateLotSizeDiff(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  filter: AppraisalFilter
): FilterResult {
  const subjectLotSqft =
    subject.lotSizeSquareFeet ??
    (subject.lotSizeAcres != null ? Math.round(subject.lotSizeAcres * 43560) : null)
  const compLotSqft =
    comp.lotSizeSquareFeet ??
    (comp.lotSizeAcres != null ? Math.round(comp.lotSizeAcres * 43560) : null)

  if (subjectLotSqft == null || compLotSqft == null) {
    return {
      type: 'lot_size_diff',
      passed: true,
      status: 'not_verified',
      reason: 'Lot size data not available — rule not verified',
    }
  }

  const diff = Math.abs(compLotSqft - subjectLotSqft)
  const passed = diff <= filter.value
  return {
    type: 'lot_size_diff',
    passed,
    status: passed ? 'passed' : 'failed',
    reason: passed ? undefined : `Lot size difference too large: ${diff} sqft (max: ${filter.value})`,
    actualValue: diff,
    threshold: filter.value,
  }
}

function evaluateRoadBarrier(
  _subject: NormalizedProperty,
  comp: NormalizedComparable,
  _filter: AppraisalFilter
): FilterResult {
  // Requires geospatial road-network data. When the provider supplies
  // crossesMajorRoad the rule is enforced; otherwise honestly not verified.
  if (comp.crossesMajorRoad == null) {
    return {
      type: 'road_barrier',
      passed: true,
      status: 'not_verified',
      reason: 'Road-barrier geospatial data unavailable — rule not verified',
    }
  }

  if (comp.crossesMajorRoad === false) {
    return { type: 'road_barrier', passed: true, actualValue: 'same_side', threshold: 'same_side' }
  }
  // Flex exception — under stretched parameters a crossing comp survives
  // when its pocket is value-equivalent to the subject's (±10% $/sf).
  const flexed = typeof _filter.value === 'number' && _filter.value > 1
  if (flexed && isValueEquivalent(_subject, comp)) {
    return {
      type: 'road_barrier',
      passed: true,
      reason: 'Crosses major road — pocket is value-equivalent to subject (flex)',
      actualValue: 'crosses',
      threshold: 'same_side',
    }
  }
  return {
    type: 'road_barrier',
    passed: false,
    status: 'failed',
    reason: 'Comparable is across a major road from subject',
    actualValue: 'crosses',
    threshold: 'same_side',
  }
}

function evaluateBuildingStyleMatch(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  _filter: AppraisalFilter
): FilterResult {
  const subjectStyle = subject.construction?.buildingStyle?.toLowerCase().trim()
  const compStyle = comp.construction?.buildingStyle?.toLowerCase().trim()

  if (!subjectStyle || !compStyle) {
    return {
      type: 'building_style_match',
      passed: true,
      status: 'not_verified',
      reason: 'Building style data not available',
    }
  }

  const passed = subjectStyle === compStyle
  return {
    type: 'building_style_match',
    passed,
    status: passed ? 'passed' : 'failed',
    reason: passed ? undefined : `Style mismatch: "${compStyle}" vs subject "${subjectStyle}"`,
    actualValue: compStyle,
    threshold: subjectStyle,
  }
}

/**
 * Foundation families — slab vs raised (pier/beam/crawl/wood) vs basement
 * carry real value and rehab differences. 'other' = provider value we
 * cannot classify; 'null' = no data.
 */
function foundationFamily(v?: string | null): 'slab' | 'raised' | 'basement' | 'other' | null {
  const n = v?.toLowerCase().replace(/[^a-z]/g, '') ?? ''
  if (!n || n === 'unknown' || n === 'none') return null
  // Order matters: basement first (covers "Unknown (with basement)"),
  // slab before raised so "Post Tension" doesn't trip the bare "post".
  if (/basement|bsmt|daylight/.test(n)) return 'basement'
  if (/posttension|slab|monolithic|stemwall|floating|continuousfooting|spreadfooting|^concrete$/.test(n)) return 'slab'
  if (/pier|beam|piling|post|wood|raised|crawl|mudsill|pipe|dirte?arth|crossbridged/.test(n)) return 'raised'
  return 'other'
}

/** Foundation match — hard rule on verified family mismatches (slab ≠
 *  pier/beam ≠ basement). Exact-name equality also passes ("Concrete Slab"
 *  vs "Slab"); unclassifiable pairs are not_verified, never a hard fail. */
function evaluateFoundationMatch(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  _filter: AppraisalFilter
): FilterResult {
  const subjectRaw = subject.construction?.foundationType
  const compRaw = comp.construction?.foundationType
  const normalize = (v?: string | null) =>
    v?.toLowerCase().replace(/[^a-z]/g, '')
  const subjectFoundation = normalize(subjectRaw)
  const compFoundation = normalize(compRaw)

  if (!subjectFoundation || !compFoundation) {
    return {
      type: 'foundation_match',
      passed: true,
      status: 'not_verified',
      reason: 'Foundation type data not available — rule not verified',
    }
  }

  const subjectFam = foundationFamily(subjectRaw)
  const compFam = foundationFamily(compRaw)

  const passed =
    subjectFoundation === compFoundation ||
    (subjectFam === compFam) ||
    subjectFam === 'other' ||
    compFam === 'other'

  return {
    type: 'foundation_match',
    passed,
    status: passed ? (subjectFoundation === compFoundation || subjectFam === compFam ? 'passed' : 'not_verified') : 'failed',
    reason: passed
      ? (subjectFoundation !== compFoundation && subjectFam === compFam
          ? `Foundation family match: "${compRaw}" vs subject "${subjectRaw}"`
          : subjectFam === 'other' || compFam === 'other'
            ? 'Foundation types differ but could not be classified — not verified'
            : undefined)
      : `Foundation mismatch: "${compRaw}" (${compFam}) vs subject "${subjectRaw}" (${subjectFam})`,
    actualValue: compRaw,
    threshold: subjectRaw,
  }
}

/**
 * Pure neighborhood match: name OR code equality is sufficient evidence.
 * Returns null when no comparable field pair exists (not verifiable).
 * Used both by the neighborhood_match filter and by the fallback ladder's
 * neighborhood tier — the tier works off raw geography even when the
 * soft filter is disabled in the user's preset.
 */
export function neighborhoodsMatch(
  subject: Pick<NormalizedProperty, 'neighborhoodName' | 'neighborhoodCode'>,
  comp: Pick<NormalizedComparable, 'neighborhoodName' | 'neighborhoodCode'>
): boolean | null {
  const normalize = (v?: string | null) => v?.toLowerCase().trim().replace(/\s+/g, ' ') || null
  const subjectName = normalize(subject.neighborhoodName)
  const compName = normalize(comp.neighborhoodName)
  const subjectCode = normalize(subject.neighborhoodCode)
  const compCode = normalize(comp.neighborhoodCode)

  if ((!subjectName || !compName) && (!subjectCode || !compCode)) return null
  return (subjectName != null && subjectName === compName) ||
    (subjectCode != null && subjectCode === compCode)
}

function evaluateNeighborhoodMatch(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  _filter: AppraisalFilter
): FilterResult {
  const normalize = (v?: string | null) => v?.toLowerCase().trim().replace(/\s+/g, ' ') || null
  const subjectName = normalize(subject.neighborhoodName)
  const compName = normalize(comp.neighborhoodName)
  const subjectCode = normalize(subject.neighborhoodCode)
  const compCode = normalize(comp.neighborhoodCode)
  const matched = neighborhoodsMatch(subject, comp)

  if (matched === null) {
    return {
      type: 'neighborhood_match',
      passed: true,
      status: 'not_verified',
      reason: 'Neighborhood data not available — rule not verified',
    }
  }

  // Match on name OR code — either is sufficient evidence
  const nameMatch = subjectName != null && compName != null && subjectName === compName
  const codeMatch = subjectCode != null && compCode != null && subjectCode === compCode
  const via = nameMatch && codeMatch ? 'name+code' : nameMatch ? 'name' : 'code'
  return {
    type: 'neighborhood_match',
    passed: matched,
    status: matched ? 'passed' : 'failed',
    reason: matched
      ? (nameMatch && !codeMatch ? undefined : `Neighborhood matched via ${via}`)
      : `Neighborhood mismatch: "${compName ?? compCode}" vs subject "${subjectName ?? subjectCode}"`,
    actualValue: compName ?? compCode ?? undefined,
    threshold: subjectName ?? subjectCode ?? undefined,
  }
}

/**
 * Construction material match — construction type (frame/masonry) and
 * exterior wall material (brick/wood siding/stucco). Compares every field
 * present on both sides; a mismatch on any compared field fails.
 */
function evaluateConstructionMaterialMatch(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  _filter: AppraisalFilter
): FilterResult {
  const normalize = (v?: string | null) => v?.toLowerCase().replace(/[^a-z]/g, '') || null
  const pairs: Array<[string | null, string | null, string]> = [
    [normalize(subject.construction?.type), normalize(comp.construction?.type), 'construction type'],
    [normalize(subject.construction?.exteriorWalls), normalize(comp.construction?.exteriorWalls), 'exterior walls'],
  ]

  const compared = pairs.filter(([s, c]) => s && c)
  if (compared.length === 0) {
    return {
      type: 'construction_material_match',
      passed: true,
      status: 'not_verified',
      reason: 'Construction material data not available — rule not verified',
    }
  }

  const mismatched = compared.find(([s, c]) => s !== c)
  const passed = !mismatched
  return {
    type: 'construction_material_match',
    passed,
    status: passed ? 'passed' : 'failed',
    reason: passed
      ? undefined
      : `Construction mismatch: ${mismatched![2]} "${comp.construction?.exteriorWalls ?? comp.construction?.type}" vs subject "${subject.construction?.exteriorWalls ?? subject.construction?.type}"`,
    actualValue: comp.construction?.exteriorWalls ?? comp.construction?.type,
    threshold: subject.construction?.exteriorWalls ?? subject.construction?.type,
  }
}

/** Pool match — pool presence must match the subject */
function evaluatePoolMatch(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  _filter: AppraisalFilter
): FilterResult {
  if (subject.features?.poolType == null || comp.features?.poolType == null) {
    return {
      type: 'pool_match',
      passed: true,
      status: 'not_verified',
      reason: 'Pool data not available — rule not verified',
    }
  }

  const subjectHas = hasPool(subject)
  const compHas = hasPool(comp)
  const passed = subjectHas === compHas
  return {
    type: 'pool_match',
    passed,
    status: passed ? 'passed' : 'failed',
    reason: passed
      ? undefined
      : `Pool mismatch: comp ${compHas ? 'has' : 'has no'} pool vs subject ${subjectHas ? 'has' : 'has no'} pool`,
    actualValue: compHas ? 'pool' : 'none',
    threshold: subjectHas ? 'pool' : 'none',
  }
}

/** Garage/carport match — covered parking presence must match the subject */
function evaluateGarageMatch(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  _filter: AppraisalFilter
): FilterResult {
  const compHasParkingData =
    comp.features != null &&
    (comp.features.garageType != null ||
      comp.features.garageSquareFeet != null ||
      comp.features.carportType != null)
  const subjectHasParkingData =
    subject.features != null &&
    (subject.features.garageType != null ||
      subject.features.garageSquareFeet != null ||
      subject.features.carportType != null ||
      subject.features.carportSpaces != null)

  if (!subjectHasParkingData || !compHasParkingData) {
    return {
      type: 'garage_match',
      passed: true,
      status: 'not_verified',
      reason: 'Garage/carport data not available — rule not verified',
    }
  }

  // Covered parking = garage OR carport on either side
  const subjectHas = hasGarage(subject) || hasCarport(subject)
  const compHas = hasGarage(comp) || hasCarport(comp)
  const passed = subjectHas === compHas
  return {
    type: 'garage_match',
    passed,
    status: passed ? 'passed' : 'failed',
    reason: passed
      ? undefined
      : `Garage/carport mismatch: comp ${compHas ? 'has' : 'has no'} covered parking vs subject ${subjectHas ? 'has' : 'has none'}`,
    actualValue: compHas ? 'covered_parking' : 'none',
    threshold: subjectHas ? 'covered_parking' : 'none',
  }
}

/** Stories match — story count (soft priority: ranks, never disqualifies) */
function evaluateStoriesMatch(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  _filter: AppraisalFilter
): FilterResult {
  const subjectStories = subject.stories ?? null
  const compStories = comp.stories ?? null

  if (subjectStories == null || compStories == null) {
    return {
      type: 'stories_match',
      passed: true,
      status: 'not_verified',
      reason: 'Story count not available — rule not verified',
    }
  }

  // Half-story tolerance: 1.5-story comps are compatible with both 1 and 2
  const passed = Math.abs(subjectStories - compStories) <= 0.5
  return {
    type: 'stories_match',
    passed,
    status: passed ? 'passed' : 'failed',
    reason: passed ? undefined : `Stories mismatch: comp ${compStories} vs subject ${subjectStories}`,
    actualValue: compStories,
    threshold: subjectStories,
  }
}

/** Roof material match — roof cover material (soft priority) */
function evaluateRoofMaterialMatch(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  _filter: AppraisalFilter
): FilterResult {
  const normalize = (v?: string | null) => v?.toLowerCase().replace(/[^a-z]/g, '') || null
  const subjectRoof = normalize(subject.construction?.roofCover ?? subject.construction?.roofType)
  const compRoof = normalize(comp.construction?.roofCover ?? comp.construction?.roofType)

  if (!subjectRoof || !compRoof) {
    return {
      type: 'roof_material_match',
      passed: true,
      status: 'not_verified',
      reason: 'Roof material data not available — rule not verified',
    }
  }

  const passed = subjectRoof === compRoof
  return {
    type: 'roof_material_match',
    passed,
    status: passed ? 'passed' : 'failed',
    reason: passed
      ? undefined
      : `Roof material mismatch: "${comp.construction?.roofCover ?? comp.construction?.roofType}" vs subject "${subject.construction?.roofCover ?? subject.construction?.roofType}"`,
    actualValue: comp.construction?.roofCover ?? comp.construction?.roofType,
    threshold: subject.construction?.roofCover ?? subject.construction?.roofType,
  }
}

const FILTER_EVALUATORS: Partial<Record<
  FilterType,
  (subject: NormalizedProperty, comp: NormalizedComparable, filter: AppraisalFilter) => FilterResult
>> = {
  subdivision_match: evaluateSubdivisionMatch,
  neighborhood_match: evaluateNeighborhoodMatch,
  geo_scope_match: evaluateGeoScopeMatch,
  building_style_match: evaluateBuildingStyleMatch,
  foundation_match: evaluateFoundationMatch,
  construction_material_match: evaluateConstructionMaterialMatch,
  pool_match: evaluatePoolMatch,
  garage_match: evaluateGarageMatch,
  stories_match: evaluateStoriesMatch,
  roof_material_match: evaluateRoofMaterialMatch,
  sale_age: evaluateSaleAge,
  sqft_diff: evaluateSqftDiff,
  year_built_diff: evaluateYearBuiltDiff,
  year_built_cap: evaluateYearBuiltCap,
  year_built_era: evaluateYearBuiltEra,
  distance: evaluateDistance,
  property_type: evaluatePropertyType,
  lot_size_diff: evaluateLotSizeDiff,
  road_barrier: evaluateRoadBarrier,
}

// ─── Adjustment Calculators ────────────────────────────────────────────────────

function calculateOldCompDiscount(
  _subject: NormalizedProperty,
  comp: NormalizedComparable,
  adjustment: AppraisalAdjustment
): AdjustmentResult {
  if (!comp.saleDate || !comp.salePrice) {
    return { type: 'old_comp_discount', applied: false, amount: 0, reason: 'No sale data' }
  }

  const saleDate = new Date(comp.saleDate)
  const today = new Date()
  const daysDiff = Math.floor((today.getTime() - saleDate.getTime()) / (1000 * 60 * 60 * 24))

  // Only apply if the sale is older than the configured threshold —
  // the adjustment's thresholdDays field (default 90) carries it.
  const thresholdDays = adjustment.thresholdDays ?? 90
  if (daysDiff <= thresholdDays) {
    return { type: 'old_comp_discount', applied: false, amount: 0, reason: `Sale within ${thresholdDays} days` }
  }

  const monthsOld = daysDiff / 30
  const percent = adjustment.percent || 15
  // Cap at the max percentage
  const discountPercent = Math.min(percent, (percent * monthsOld) / 12)
  const discountAmount = Math.round(comp.salePrice * (discountPercent / 100))

  return {
    type: 'old_comp_discount',
    applied: true,
    amount: -discountAmount, // Negative for discount
    reason: `${discountPercent.toFixed(1)}% discount for ${Math.round(monthsOld)} months old`,
  }
}

function calculateBedroomAdjustment(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  adjustment: AppraisalAdjustment
): AdjustmentResult {
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
}

function calculateBathroomAdjustment(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  adjustment: AppraisalAdjustment
): AdjustmentResult {
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
}

function hasPool(p: { features?: { poolType?: string } | undefined }): boolean {
  return !!p.features?.poolType && p.features.poolType.length > 0
}

function hasGarage(p: { features?: { garageType?: string; garageSquareFeet?: number } | undefined }): boolean {
  return (
    (!!p.features?.garageType && p.features.garageType.length > 0) ||
    (!!p.features?.garageSquareFeet && p.features.garageSquareFeet > 0)
  )
}

function hasCarport(p: { features?: { carportType?: string; carportSpaces?: number } | undefined }): boolean {
  return (
    (!!p.features?.carportType && p.features.carportType.length > 0) ||
    (!!p.features?.carportSpaces && p.features.carportSpaces > 0)
  )
}

function calculatePoolAdjustment(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  adjustment: AppraisalAdjustment
): AdjustmentResult {
  const subjectHas = hasPool(subject)
  const compHas = hasPool(comp)
  const diff = (subjectHas ? 1 : 0) - (compHas ? 1 : 0)

  if (diff === 0) {
    return {
      type: 'pool',
      applied: false,
      amount: 0,
      reason: subjectHas && compHas ? 'Both have pool' : 'Neither has pool data/match',
    }
  }

  return {
    type: 'pool',
    applied: true,
    amount: diff * adjustment.amount,
    reason: diff > 0
      ? `Subject has pool, comp does not (+$${adjustment.amount.toLocaleString()})`
      : `Comp has pool, subject does not (-$${adjustment.amount.toLocaleString()})`,
  }
}

function calculateGarageAdjustment(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  adjustment: AppraisalAdjustment
): AdjustmentResult {
  const subjectHas = hasGarage(subject)
  const compHas = hasGarage(comp)
  const diff = (subjectHas ? 1 : 0) - (compHas ? 1 : 0)

  if (diff === 0) {
    return {
      type: 'garage',
      applied: false,
      amount: 0,
      reason: subjectHas && compHas ? 'Both have garage' : 'No garage difference',
    }
  }

  return {
    type: 'garage',
    applied: true,
    amount: diff * adjustment.amount,
    reason: diff > 0
      ? `Subject has garage, comp does not (+$${adjustment.amount.toLocaleString()})`
      : `Comp has garage, subject does not (-$${adjustment.amount.toLocaleString()})`,
  }
}

function calculateCarportAdjustment(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  adjustment: AppraisalAdjustment
): AdjustmentResult {
  const subjectHas = hasCarport(subject)
  const compHas = hasCarport(comp)
  const diff = (subjectHas ? 1 : 0) - (compHas ? 1 : 0)

  if (diff === 0) {
    return {
      type: 'carport',
      applied: false,
      amount: 0,
      reason: comp.features ? 'No carport difference' : 'Comp carport data not available',
    }
  }

  return {
    type: 'carport',
    applied: true,
    amount: diff * adjustment.amount,
    reason: diff > 0
      ? `Subject has carport, comp does not (+$${adjustment.amount.toLocaleString()})`
      : `Comp has carport, subject does not (-$${adjustment.amount.toLocaleString()})`,
  }
}

// ─── Traffic / Commercial Exposure Adjustments ────────────────────────────────

type TrafficKind = 'siding' | 'backing' | 'fronting'

function makeTrafficAdjustment(kind: TrafficKind) {
  const matchValues: Record<TrafficKind, string[]> = {
    siding: ['sides_traffic', 'sides_commercial'],
    backing: ['backs_traffic', 'backs_commercial'],
    fronting: ['fronts_traffic', 'fronts_commercial'],
  }

  const type = `traffic_${kind}` as const

  return function (
    _subject: NormalizedProperty,
    comp: NormalizedComparable,
    adjustment: AppraisalAdjustment
  ): AdjustmentResult {
    // Exposure data is mutually exclusive (one site influence per property),
    // which structurally prevents double counting across the three types.
    if (comp.siteInfluence == null) {
      return {
        type,
        applied: false,
        amount: 0,
        reason: 'Traffic/commercial exposure data unavailable — not verified',
      }
    }

    if (!matchValues[kind].includes(comp.siteInfluence)) {
      return { type, applied: false, amount: 0, reason: `Comp does not ${kind} traffic/commercial` }
    }

    const compValue =
      comp.salePrice ??
      (comp.pricePerSqft != null && comp.squareFeet != null
        ? Math.round(comp.pricePerSqft * comp.squareFeet)
        : 0)
    const threshold = adjustment.valueThreshold ?? 500000

    // Under threshold: flat $ deduction. At/over: percent deduction.
    const deduction =
      compValue < threshold
        ? adjustment.amount
        : Math.round(compValue * ((adjustment.percent ?? 0) / 100))

    return {
      type,
      applied: deduction > 0,
      amount: -deduction,
      reason:
        compValue < threshold
          ? `Comp ${kind} traffic/commercial (-$${deduction.toLocaleString()})`
          : `Comp ${kind} traffic/commercial (-${adjustment.percent}% = -$${deduction.toLocaleString()})`,
    }
  }
}

const calculateTrafficSiding = makeTrafficAdjustment('siding')
const calculateTrafficBacking = makeTrafficAdjustment('backing')
const calculateTrafficFronting = makeTrafficAdjustment('fronting')

function calculateBasementSqft(
  _subject: NormalizedProperty,
  comp: NormalizedComparable,
  adjustment: AppraisalAdjustment
): AdjustmentResult {
  // Basement/guest-house sqft is credited at percent% of normal $/sqft.
  // The deduction removes the over-valued portion of the comp's price.
  if (!comp.basementSquareFeet || comp.basementSquareFeet <= 0) {
    return {
      type: 'basement_sqft',
      applied: false,
      amount: 0,
      reason: 'No basement/guest-house sqft on comp',
    }
  }

  const normalPpsf =
    comp.pricePerSqft ??
    (comp.salePrice && comp.squareFeet ? comp.salePrice / comp.squareFeet : null)

  if (!normalPpsf) {
    return {
      type: 'basement_sqft',
      applied: false,
      amount: 0,
      reason: 'Cannot compute $/sqft for basement credit',
    }
  }

  const discountPct = adjustment.percent ?? 50
  // Basement area is only worth `discountPct`% — deduct the overvalued share
  const deduction = Math.round(comp.basementSquareFeet * normalPpsf * ((100 - discountPct) / 100))

  return {
    type: 'basement_sqft',
    applied: deduction > 0,
    amount: -deduction,
    reason: `${comp.basementSquareFeet} sqft basement credited at ${discountPct}% (-$${deduction.toLocaleString()})`,
  }
}

/**
 * Foundation-family mismatch deduction — percent off the comp's sale price
 * when its foundation is a different family than the subject's (e.g. a
 * pier/crawl comp vs a slab subject). Applies to comp value so retained
 * fallback/manual comps still carry the discount when the hard
 * foundation_match filter is off or data was unverifiable.
 */
function calculateFoundationAdjustment(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  adjustment: AppraisalAdjustment
): AdjustmentResult {
  const subjectFam = foundationFamily(subject.construction?.foundationType)
  const compFam = foundationFamily(comp.construction?.foundationType)

  if (!subjectFam || !compFam) {
    return { type: 'foundation', applied: false, amount: 0, reason: 'Foundation data unavailable — not verified' }
  }
  if (subjectFam === 'other' || compFam === 'other') {
    return { type: 'foundation', applied: false, amount: 0, reason: 'Foundation family not classifiable — no deduction' }
  }
  if (subjectFam === compFam) {
    return { type: 'foundation', applied: false, amount: 0, reason: 'Same foundation family' }
  }

  const compValue =
    comp.salePrice ??
    (comp.pricePerSqft != null && comp.squareFeet != null
      ? Math.round(comp.pricePerSqft * comp.squareFeet)
      : null)
  if (!compValue) {
    return { type: 'foundation', applied: false, amount: 0, reason: 'No comp sale price to adjust' }
  }

  const percent = adjustment.percent ?? 10
  const deduction = Math.round(compValue * (percent / 100))

  return {
    type: 'foundation',
    applied: deduction > 0,
    amount: -deduction,
    reason: `Foundation mismatch: comp ${compFam} vs subject ${subjectFam} (-${percent}% = -$${deduction.toLocaleString()})`,
  }
}

const ADJUSTMENT_CALCULATORS: Record<
  AdjustmentType,
  (subject: NormalizedProperty, comp: NormalizedComparable, adjustment: AppraisalAdjustment) => AdjustmentResult
> = {
  old_comp_discount: calculateOldCompDiscount,
  bedroom: calculateBedroomAdjustment,
  bathroom: calculateBathroomAdjustment,
  pool: calculatePoolAdjustment,
  garage: calculateGarageAdjustment,
  carport: calculateCarportAdjustment,
  traffic_siding: calculateTrafficSiding,
  traffic_backing: calculateTrafficBacking,
  traffic_fronting: calculateTrafficFronting,
  basement_sqft: calculateBasementSqft,
  foundation: calculateFoundationAdjustment,
}

// ─── Helper Functions ──────────────────────────────────────────────────────────

function normalizeSubdivision(value: string | null | undefined): string | null {
  if (!value) return null
  return value.toLowerCase().trim().replace(/\s+/g, ' ')
}

/**
 * Subdivision base name — strips ALL plat/legal designator tokens (unit,
 * block, phase, lot, plat, NCB, SUB, etc.) and bare numeric identifiers so
 * differently-recorded parcels of the same community resolve to the shared
 * meaningful name:
 *   "HIGHLAND HILLS SUB UN 17 NCB 1"  → "highland hills"
 *   "HIGHLAND HILLS BL 10854 UN 15"   → "highland hills"
 *   "SWEETWATER CREEK S UT 2E"        → "sweetwater creek s"
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

function subdivisionBase(value: string | null | undefined): string | null {
  let v = normalizeSubdivision(value)
  if (!v) return null
  v = v.replace(/[\/\-_.,#]/g, ' ').replace(/\s+/g, ' ').trim()
  const tokens = v
    .split(' ')
    .filter(
      (t) => !SUBDIVISION_DESIGNATORS.has(t) && !/^\d+[a-z]?$/.test(t)
    )
  v = tokens.join(' ').trim()
  return v || null
}

/**
 * Two subdivisions match when their base names are equal, or one base is a
 * word-boundary prefix of the other — "sweetwater creek" ⊂ "sweetwater creek
 * south" (same parent development) but "oak" ⊄ "oakwood" (different names).
 */
function subdivisionsMatch(
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

function normalizePropertyType(value: string | null | undefined): string | null {
  if (!value) return null
  const v = value.toLowerCase().trim()
  // Collapse common variants into comparable buckets
  if (/single.?family|sfr|detached/.test(v)) return 'single_family'
  if (/condo|condominium/.test(v)) return 'condo'
  if (/town ?(home|house)|row/.test(v)) return 'townhome'
  if (/multi|duplex|triplex|quad/.test(v)) return 'multi_family'
  if (/manufactured|mobile/.test(v)) return 'manufactured'
  if (/land|lot|vacant/.test(v)) return 'land'
  return v.replace(/\s+/g, '_')
}

// ─── Main Evaluator ────────────────────────────────────────────────────────────

/**
 * Evaluate a comparable against filters and adjustments
 */
export function evaluateComparable(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  filters: AppraisalFilter[],
  adjustments: AppraisalAdjustment[]
): ComparableEvaluation {
  // Evaluate all enabled filters
  const filterResults: FilterResult[] = []
  const disableReasons: string[] = []

  // ── Data-quality gates — hard, never stretched by the flex ladder ────────
  // A $1/$100 recorded price is a quit-claim/family/deed transfer, not a
  // market sale — it can never be comparable evidence regardless of rules.
  if (comp.salePrice != null && comp.salePrice < 10_000) {
    disableReasons.push(`Non-market sale — nominal price $${comp.salePrice.toLocaleString()}`)
  }
  // Rural acreage vs a suburban lot is a category mismatch — the ±lot_size
  // tolerance (even flexed) is for same-pocket variance, not acreage.
  // Symmetric: comp 3×+ bigger on acreage, or a rural subject against a
  // comp on a fraction of its land — neither reconciles.
  if (comp.lotSizeAcres != null && subject.lotSizeAcres != null) {
    const [big, small] = comp.lotSizeAcres >= subject.lotSizeAcres
      ? [comp.lotSizeAcres, subject.lotSizeAcres]
      : [subject.lotSizeAcres, comp.lotSizeAcres]
    if (big > 1 && big > small * 3) {
      disableReasons.push(
        `Lot category mismatch (${comp.lotSizeAcres.toFixed(2)} ac vs subject ${subject.lotSizeAcres.toFixed(2)} ac) — not comparable`,
      )
    }
  }

  for (const filter of filters) {
    if (!filter.enabled) continue

    const evaluator = FILTER_EVALUATORS[filter.type]
    if (!evaluator) continue

    const result = evaluator(subject, comp, filter)
    if (!result.status) {
      result.status = result.passed ? 'passed' : 'failed'
    }
    filterResults.push(result)

    // Soft filters (stories, roof material) record the mismatch for
    // ranking/reporting but never disqualify the comp.
    if (!result.passed && result.reason && filter.priority !== 'soft') {
      disableReasons.push(result.reason)
    }
  }

  const shouldDisable = disableReasons.length > 0

  // Calculate adjustments (even for disabled comps, for reference)
  const adjustmentResults: AdjustmentResult[] = []
  let totalAdjustment = 0

  for (const adjustment of adjustments) {
    if (!adjustment.enabled) continue

    const calculator = ADJUSTMENT_CALCULATORS[adjustment.type]
    if (!calculator) continue

    const result = calculator(subject, comp, adjustment)
    adjustmentResults.push(result)

    if (result.applied) {
      totalAdjustment += result.amount
    }
  }

  // Use salePrice, or calculate from pricePerSqft * squareFeet if salePrice is missing
  // (CoreLogic API sometimes returns pricePerSqft without salePrice)
  let originalPrice = comp.salePrice
  if (originalPrice == null && comp.pricePerSqft != null && comp.squareFeet != null) {
    originalPrice = Math.round(comp.pricePerSqft * comp.squareFeet)
    console.log(`[Evaluator] Calculated salePrice from pricePerSqft: ${originalPrice} (${comp.pricePerSqft} * ${comp.squareFeet})`)
  }
  const adjustedPrice = originalPrice != null ? originalPrice + totalAdjustment : null

  return {
    comparableId: comp.id,
    shouldDisable,
    filterResults,
    disableReasons,
    totalAdjustment,
    adjustmentResults,
    originalPrice,
    adjustedPrice,
  }
}

/**
 * Evaluate all comparables and return evaluations
 */
export function evaluateComparables(
  subject: NormalizedProperty,
  comparables: NormalizedComparable[],
  filters: AppraisalFilter[],
  adjustments: AppraisalAdjustment[]
): Map<string, ComparableEvaluation> {
  const evaluations = new Map<string, ComparableEvaluation>()

  for (const comp of comparables) {
    const evaluation = evaluateComparable(subject, comp, filters, adjustments)
    evaluations.set(comp.id, evaluation)
  }

  return evaluations
}

/**
 * Percentage flex on numeric tolerances — sqft, year built, lot size,
 * sale age, distance scale by `factor`; geo/exact-match filters never
 * flex (census/SD/road barriers stay hard). Powers the thin-pool
 * fallback ladder: strict → ×1.15 → ×1.25 → ×1.35 → … until evidence.
 */
const FLEXIBLE_FILTERS = new Set<FilterType>([
  'sale_age',
  'sale_age_expansion',
  'sale_age_expansion_2',
  'sqft_diff',
  'year_built_diff',
  'lot_size_diff',
  'distance',
])

// Geo-adjacent filters carry a flex MARKER (value > 1) rather than a scaled
// threshold — under stretch, a crossing/mismatch survives when the comp's
// pocket is value-equivalent to the subject's (±10% $/sf).
const FLEX_MARKER_FILTERS = new Set<FilterType>([
  'road_barrier',
  'subdivision_match',
  'neighborhood_match',
  'geo_scope_match',
])

export function flexNumericFilters(filters: AppraisalFilter[], factor: number): AppraisalFilter[] {
  if (factor <= 1) return filters
  return filters.map((f) =>
    FLEXIBLE_FILTERS.has(f.type) && typeof f.value === 'number'
      ? { ...f, value: Math.round(f.value * factor * 100) / 100 }
      : FLEX_MARKER_FILTERS.has(f.type)
        ? { ...f, value: factor }
        : f,
  )
}

/** Subject reference $/sqft for value equivalence — scope median first,
 *  then AVM-implied ppsf as the always-available floor. */
export function subjectRefPpsf(subject: NormalizedProperty): number | null {
  const med = subject.ppsfMedians?.SD ?? subject.ppsfMedians?.N4 ?? subject.ppsfMedians?.N3
  if (med != null && med > 0) return med
  if (subject.avmValue != null && subject.squareFeet) return subject.avmValue / subject.squareFeet
  return null
}

function compPpsf(c: { pricePerSqft?: number | null; salePrice?: number | null; squareFeet?: number | null }): number | null {
  return c.pricePerSqft ?? (c.salePrice != null && c.squareFeet ? c.salePrice / c.squareFeet : null)
}

/** ±10% pocket value equivalence — a comp across a boundary counts as the
 *  same market when its price per sqft sits within 10% of the subject's
 *  reference. Only consulted under flex (marker value > 1). */
export function isValueEquivalent(subject: NormalizedProperty, comp: NormalizedComparable): boolean {
  const ref = subjectRefPpsf(subject)
  const ppsf = compPpsf(comp)
  if (ref == null || ppsf == null) return false
  return Math.abs(ppsf - ref) / ref <= 0.10
}
