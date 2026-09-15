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
import type { CompItem, SubjectData } from './shared-types'

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

/** "One Story"/"1 Story"/"2 Level" → 1/2. Words and digits both handled. */
const STORY_WORDS: Record<string, number> = {
  one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, bi: 2, tri: 3, split: 1.5,
}
function storyCount(v?: string | number | null): number | null {
  if (v == null) return null
  if (typeof v === 'number') return v
  const n = v.toLowerCase()
  const digit = n.match(/(\d+(?:\.\d+)?)/)?.[1]
  if (digit) return parseFloat(digit)
  for (const [word, num] of Object.entries(STORY_WORDS)) {
    if (new RegExp(`\\b${word}`).test(n)) return num
  }
  return null
}

const hasPool = (p: { pool?: string | null }) => p.pool != null && p.pool !== ''
const hasCovered = (p: { garage?: string | null; garageSquareFeet?: number | null; carport?: string | null }) =>
  (p.garage != null && p.garage !== '') || (p.garageSquareFeet ?? 0) > 0 || (p.carport != null && p.carport !== '')

function eq(a: string | number | null | undefined, b: string | number | null | undefined): MatchState {
  const x = typeof a === 'number' ? a : norm(a as string | null | undefined)
  const y = typeof b === 'number' ? b : norm(b as string | null | undefined)
  if (x == null || y == null) return 'unknown'
  return x === y ? 'match' : 'mismatch'
}

function boolEq(a: boolean, b: boolean, hasDataA: boolean, hasDataB: boolean): MatchState {
  if (!hasDataA || !hasDataB) return 'unknown'
  return a === b ? 'match' : 'mismatch'
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

  // Physical structure
  {
    const sf = foundationFamily(subject.foundationType)
    const cf = foundationFamily(comp.foundationType)
    push('foundation',
      !sf || !cf ? 'unknown' : sf === 'other' || cf === 'other'
        ? (norm(subject.foundationType) === norm(comp.foundationType) ? 'match' : 'unknown')
        : sf === cf ? 'match' : 'mismatch',
      comp.foundationType ?? undefined)
  }
  push('style', eq(comp.buildingStyle, subject.buildingStyle), comp.buildingStyle ?? undefined)

  {
    const ss = storyCount(subject.storiesType)
    const cs = storyCount(comp.stories ?? comp.storiesType)
    push('stories',
      ss == null || cs == null ? 'unknown' : Math.abs(cs - ss) <= 0.5 ? 'match' : 'mismatch',
      comp.storiesType ?? (comp.stories != null ? String(comp.stories) : undefined))
  }

  {
    const pairs: MatchState[] = [
      eq(comp.constructionType, subject.constructionType),
      eq(comp.exteriorWalls, subject.exteriorWalls),
    ].filter((s) => s !== 'unknown')
    push('construction',
      pairs.length === 0 ? 'unknown' : pairs.every((s) => s === 'match') ? 'match' : 'mismatch',
      [comp.constructionType, comp.exteriorWalls].filter(Boolean).join(' / ') || undefined)
  }

  push('roof', eq(comp.roofCover ?? comp.roofType, subject.roofCover ?? subject.roofType), comp.roofCover ?? comp.roofType ?? undefined)

  {
    const st = conditionTier(subject.buildingCondition)
    const ct = conditionTier(comp.buildingCondition)
    push('condition',
      st == null || ct == null ? 'unknown' : ct >= st ? 'match' : 'mismatch',
      comp.buildingCondition ?? undefined)
  }

  // Amenities
  push('pool', boolEq(hasPool(comp), hasPool(subject), comp.pool != null, subject.pool != null),
    comp.pool ? 'Yes' : 'None')
  push('garage', boolEq(hasCovered(comp), hasCovered(subject),
    comp.garage != null || comp.garageSquareFeet != null || comp.carport != null,
    subject.garage != null || subject.garageSquareFeet != null || subject.carport != null),
    [comp.garage, comp.carport].filter(Boolean).join(' + ') || undefined)

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
