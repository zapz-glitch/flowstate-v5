/**
 * Comp-vs-subject feature matching for visual verification.
 *
 * Every comparable card shows green/red/neutral indicators for whether each
 * property feature matches the subject. 'unknown' means either side lacks
 * the data — never rendered as a failure.
 *
 * Match semantics mirror the API evaluator's rules (canonical subdivision
 * matcher, foundation families, condition tiers, ±250sqft / ±10yr / ±2500sf
 * lot defaults).
 */

import { subdivisionsMatch, foundationFamily } from '@flowstate-api/shared'
import type { CompItem, PhysicalCharacteristic, PhysicalCharacteristicValue, SubjectData } from './shared-types'

export type MatchState = 'match' | 'mismatch' | 'unknown'

export type FeatureKey =
  | 'subdivision'
  | 'neighborhood'
  | 'foundation'
  | 'style'
  | 'stories'
  | 'construction'
  | 'roof'
  | 'condition'
  | 'pool'
  | 'garage'
  | 'hvac'
  | 'fireplaces'
  | 'beds'
  | 'baths'
  | 'sqft'
  | 'year'
  | 'lot'

export interface FeatureMatch {
  key: FeatureKey
  label: string
  state: MatchState
  /** Short detail for tooltips, e.g. "Pier vs Slab" */
  detail?: string
}

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  subdivision: 'Subdivision',
  neighborhood: 'Neighborhood',
  foundation: 'Foundation',
  style: 'Style',
  stories: 'Stories',
  construction: 'Construction',
  roof: 'Roof',
  condition: 'Assessor Cond.',
  pool: 'Pool',
  garage: 'Garage/Carport',
  hvac: 'Heat/AC',
  fireplaces: 'Fireplaces',
  beds: 'Bedrooms',
  baths: 'Bathrooms',
  sqft: 'Sq Ft',
  year: 'Year Built',
  lot: 'Lot Size',
}

const norm = (v?: string | null) => v?.toLowerCase().replace(/[^a-z0-9]/g, '') || null

/** Assessor condition tiers — comp must be at/above subject (mirrors API). */
const CONDITION_TIERS: Record<string, number> = {
  excellent: 7, verygood: 6, good: 5, average: 4, fair: 3, poor: 2, verypoor: 1,
}
const conditionTier = (v?: string | null) => (v ? CONDITION_TIERS[v.toLowerCase().replace(/[^a-z]/g, '')] ?? null : null)

function verified<T extends PhysicalCharacteristicValue>(field?: PhysicalCharacteristic<T>): T | null {
  return field?.status === 'verified' ? field.value : null
}

function eq(a: string | number | boolean | null | undefined, b: string | number | boolean | null | undefined): MatchState {
  const x = typeof a === 'string' ? norm(a) : a
  const y = typeof b === 'string' ? norm(b) : b
  if (x == null || y == null) return 'unknown'
  return x === y ? 'match' : 'mismatch'
}

/**
 * Compare every displayable feature of a comp against the subject.
 * Returns entries for ALL features — 'unknown' for missing data so callers
 * can render a neutral indicator rather than hiding the row.
 */
export function compFeatureMatches(comp: CompItem, subject: SubjectData | null | undefined): FeatureMatch[] {
  if (!subject) return []

  const out: FeatureMatch[] = []
  const push = (key: FeatureKey, state: MatchState, detail?: string) =>
    out.push({ key, label: FEATURE_LABELS[key], state, detail })

  // Geography
  push('subdivision',
    subject.subdivision && comp.subdivision
      ? (subdivisionsMatch(subject.subdivision, comp.subdivision) ? 'match' : 'mismatch')
      : 'unknown',
    comp.subdivision ?? undefined)

  const nbNameMatch = norm(comp.neighborhoodName) && norm(subject.neighborhoodName)
    ? norm(comp.neighborhoodName) === norm(subject.neighborhoodName)
    : null
  const nbCodeMatch = comp.neighborhoodCode != null && subject.neighborhoodCode != null
    ? comp.neighborhoodCode === subject.neighborhoodCode
    : null
  push('neighborhood',
    nbNameMatch == null && nbCodeMatch == null ? 'unknown' : (nbNameMatch || nbCodeMatch) ? 'match' : 'mismatch',
    comp.neighborhoodName ?? comp.neighborhoodCode ?? undefined)

  // Physical structure — only resolver-verified values can match or mismatch.
  const subjectPhysical = subject.physicalCharacteristics
  const compPhysical = comp.physicalCharacteristics
  {
    const subjectFoundation = verified(subjectPhysical?.foundation)
    const compFoundation = verified(compPhysical?.foundation)
    const sf = foundationFamily(subjectFoundation)
    const cf = foundationFamily(compFoundation)
    push('foundation',
      !sf || !cf ? 'unknown' : sf === 'other' || cf === 'other'
        ? (norm(subjectFoundation) === norm(compFoundation) ? 'match' : 'unknown')
        : sf === cf ? 'match' : 'mismatch',
      compFoundation ?? undefined)
  }
  push('style',
    eq(verified(compPhysical?.style), verified(subjectPhysical?.style)),
    verified(compPhysical?.style) ?? undefined)

  {
    const ss = verified(subjectPhysical?.stories)
    const cs = verified(compPhysical?.stories)
    push('stories',
      ss == null || cs == null ? 'unknown' : Math.abs(cs - ss) <= 0.5 ? 'match' : 'mismatch',
      cs != null ? String(cs) : undefined)
  }

  {
    const structure = verified(compPhysical?.constructionType)
    const subjectStructure = verified(subjectPhysical?.constructionType)
    const exterior = verified(compPhysical?.exterior)
    const subjectExterior = verified(subjectPhysical?.exterior)
    const states = [eq(structure, subjectStructure), eq(exterior, subjectExterior)]
      .filter((state) => state !== 'unknown')
    push('construction',
      states.length === 0 ? 'unknown' : states.every((state) => state === 'match') ? 'match' : 'mismatch',
      [structure, exterior].filter(Boolean).join(' / ') || undefined)
  }

  push('roof',
    eq(verified(compPhysical?.roof), verified(subjectPhysical?.roof)),
    verified(compPhysical?.roof) ?? undefined)

  {
    const st = conditionTier(subject.buildingCondition)
    const ct = conditionTier(comp.buildingCondition)
    push('condition',
      st == null || ct == null ? 'unknown' : ct >= st ? 'match' : 'mismatch',
      comp.buildingCondition ?? undefined)
  }

  // Amenities
  const compPool = verified(compPhysical?.pool)
  const subjectPool = verified(subjectPhysical?.pool)
  push('pool', eq(compPool, subjectPool), compPool == null ? undefined : compPool ? 'Yes' : 'No')
  const compGarage = verified(compPhysical?.garage)
  const subjectGarage = verified(subjectPhysical?.garage)
  push('garage', eq(compGarage, subjectGarage), compGarage ?? undefined)

  {
    const pairs: MatchState[] = [eq(comp.heating, subject.heating), eq(comp.cooling, subject.cooling)]
      .filter((s) => s !== 'unknown')
    push('hvac',
      pairs.length === 0 ? 'unknown' : pairs.every((s) => s === 'match') ? 'match' : 'mismatch',
      [comp.heating, comp.cooling].filter(Boolean).join(' / ') || undefined)
  }

  push('fireplaces', eq(comp.fireplacesCount, subject.fireplacesCount),
    comp.fireplacesCount != null ? String(comp.fireplacesCount) : undefined)
  push('beds', eq(comp.bedrooms, subject.bedrooms), comp.bedrooms != null ? String(comp.bedrooms) : undefined)
  push('baths', eq(comp.bathrooms, subject.bathrooms), comp.bathrooms != null ? String(comp.bathrooms) : undefined)

  // Size / age / lot — same thresholds as the appraisal rules
  if (subject.squareFeet != null && comp.squareFeet != null) {
    // Sub-1,000sf subject: any comp ≤1,000sf qualifies (absolute ceiling).
    push('sqft', subject.squareFeet < 1000 ? (comp.squareFeet <= 1000 ? 'match' : 'mismatch')
      : Math.abs(comp.squareFeet - subject.squareFeet) <= 250 ? 'match' : 'mismatch',
      `${comp.squareFeet.toLocaleString()} vs ${subject.squareFeet.toLocaleString()} sf`)
  } else {
    push('sqft', 'unknown')
  }

  if (subject.yearBuilt != null && comp.yearBuilt != null) {
    push('year', Math.abs(comp.yearBuilt - subject.yearBuilt) <= 10 ? 'match' : 'mismatch',
      `${comp.yearBuilt} vs ${subject.yearBuilt}`)
  } else {
    push('year', 'unknown')
  }

  if (subject.lotSizeAcres != null && comp.lotSizeAcres != null) {
    push('lot', Math.abs(comp.lotSizeAcres - subject.lotSizeAcres) * 43560 <= 2500 ? 'match' : 'mismatch',
      undefined)
  } else {
    push('lot', 'unknown')
  }

  return out
}

/** Lookup helper for components that need a single feature's state. */
export function featureState(matches: FeatureMatch[], key: FeatureKey): MatchState {
  return matches.find((m) => m.key === key)?.state ?? 'unknown'
}

/** Tailwind class for a match-state value/label */
export function matchTextClass(state: MatchState): string {
  return state === 'match' ? 'text-emerald-500' : state === 'mismatch' ? 'text-red-400' : ''
}

/** Tailwind class for a match-state dot */
export function matchDotClass(state: MatchState): string {
  return state === 'match'
    ? 'bg-emerald-500'
    : state === 'mismatch'
      ? 'bg-red-400'
      : 'bg-muted-foreground/30'
}
