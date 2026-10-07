import { subdivisionsMatch } from '@flowstate-api/shared'
import type { CompBadges, CompItem, SubjectData } from './shared-types'
import { compFeatureMatches, featureState, MATCH_TEXT, MISMATCH_TEXT, type FeatureMatch } from './feature-match'

export { MATCH_TEXT, MISMATCH_TEXT }

export const FILTER_TYPE_LABELS: Record<string, string> = {
  // Shown on the comp detail's rule list · the area is called the neighborhood on every comp surface
  subdivision_match: 'Neighborhood Match',
  neighborhood_match: 'Neighborhood',
  building_style_match: 'Building Style',
  foundation_match: 'Foundation Match',
  construction_material_match: 'Construction Material',
  pool_match: 'Pool Match',
  garage_match: 'Garage Match',
  stories_match: 'Stories Match',
  roof_material_match: 'Roof Material',
  condition_match: 'Condition Match',
  property_type: 'Property Type',
  sale_age: 'Sale Age',
  sqft_diff: 'Sqft Difference',
  year_built_diff: 'Year Built Diff',
  distance: 'Distance',
  lot_size_diff: 'Lot Size Diff',
  road_barrier: 'Road Barrier',
}

export const ADJUSTMENT_TYPE_LABELS: Record<string, string> = {
  old_comp_discount: 'Old Comp Discount',
  bedroom: 'Bedroom Adjustment',
  bathroom: 'Bathroom Adjustment',
  pool: 'Pool Adjustment',
  garage: 'Garage Adjustment',
  carport: 'Carport Adjustment',
  traffic_siding: 'Traffic — Siding',
  traffic_backing: 'Traffic — Backing',
  traffic_fronting: 'Traffic — Fronting',
  basement_sqft: 'Basement/Guest Sqft',
  foundation: 'Foundation Mismatch',
}

export function formatFilterType(type: string): string {
  return FILTER_TYPE_LABELS[type] || type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function formatAdjustmentType(type: string): string {
  return ADJUSTMENT_TYPE_LABELS[type] || type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}

export function normalizeSubdivision(sub: string | null | undefined): string {
  if (!sub) return ''
  return sub.toLowerCase().trim().replace(/\s+/g, ' ')
}

export function getCompKey(comp: { address?: string }, index: number): string {
  return comp.address || `comp-${index}`
}

/** Format a number with commas, returning '-' for null/NaN */
export function fmtNumber(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '-'
  return v.toLocaleString()
}

/** Format a date string as "Mar 15, 2024" */
export function formatShortDate(date: string | null | undefined): string {
  if (!date) return '-'
  // A date with no time ("2016-04-14") is a calendar day, not a moment. Read as UTC
  // midnight and shown in the viewer's zone it lands on the day before in the US.
  const calendarDay = /^\d{4}-\d{2}-\d{2}$/.test(date)
  return new Date(date).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', ...(calendarDay ? { timeZone: 'UTC' } : {}),
  })
}

/** Format a numeric delta as "+1,200" or "-300" */
export function fmtDelta(diff: number): string {
  return diff > 0 ? `+${diff.toLocaleString()}` : diff.toLocaleString()
}

/**
 * Delta as plain words — "540 sf larger", "12 yrs older", "same size".
 * Words read direction without a sign to misread against the match color.
 */
export function fmtDeltaWords(diff: number, unit: string, larger = 'larger', smaller = 'smaller'): string {
  const abs = Math.abs(Math.round(diff))
  if (abs === 0) return 'same'
  return `${abs.toLocaleString()} ${unit} ${diff > 0 ? larger : smaller}`
}

/** Sqft match quality color class: green (≤10%), neutral (≤20%), red (>20%) */
export function sqftMatchColor(compSf: number, subSf: number): string {
  const pct = Math.abs(compSf - subSf) / subSf
  if (pct <= 0.10) return MATCH_TEXT
  if (pct <= 0.20) return 'text-foreground-tertiary'
  return MISMATCH_TEXT
}

/** Lot-size match quality color class — deltas in sqft vs lot_size_diff default (±2,500 sf) */
export function lotMatchColor(compAcres: number, subAcres: number): string {
  const diffSf = Math.abs(compAcres - subAcres) * 43560
  if (diffSf <= 2500) return MATCH_TEXT
  if (diffSf <= 5000) return 'text-foreground-tertiary'
  return MISMATCH_TEXT
}

/** Format lot size: sqft for ≤0.5 ac, acres above — "9,540 sf" / "0.62 ac" */
export function formatLotSize(acres: number | null | undefined): string {
  if (acres == null) return '-'
  if (acres <= 0.5) return `${Math.round(acres * 43560).toLocaleString()} sf`
  return `${Number(acres).toFixed(2)} ac`
}

/** Format a lot-size delta in sqft as "+2,310 sf" */
export function fmtLotDelta(compAcres: number, subAcres: number): string {
  const diffSf = Math.round((compAcres - subAcres) * 43560)
  return diffSf > 0 ? `+${diffSf.toLocaleString()} sf` : `${diffSf.toLocaleString()} sf`
}

/** Year-built match quality color class */
export function yearMatchColor(compYr: number, subYr: number): string {
  if (compYr <= 1940 && subYr <= 1940) return MATCH_TEXT
  const diff = Math.abs(compYr - subYr)
  if (diff <= 5) return MATCH_TEXT
  if (diff <= 10) return 'text-foreground-tertiary'
  return MISMATCH_TEXT
}

// ─── Comp verdict vocabulary ────────────────────────────────────────────────
// One place for every word and tone the comp card and the comp dialog share,
// so the preview and the full detail can never disagree. Pure and prop-only:
// these render what the server sent, they never re-derive a verdict.

export type Verdict = 'evidence' | 'support' | 'excluded'

/** Which of the three verdict edges a comp wears. Older reports carry no
 *  bRole, so the edge falls back to the ARV selection itself. */
export function verdictOf(bRole: CompItem['bRole'], isEnabled: boolean): Verdict {
  if (bRole === 'anchor' || bRole === 'driver') return 'evidence'
  if (bRole === 'pool') return 'support'
  if (bRole === 'excluded') return 'excluded'
  return isEnabled ? 'evidence' : 'excluded'
}

/** Left verdict edge · green feeds the ARV, gray supports it, hatched is out */
export const VERDICT_EDGE_CLASS: Record<Verdict, string> = {
  evidence: 'bg-emerald-600 dark:bg-emerald-400',
  support: 'bg-foreground/40',
  excluded: 'verdict-edge-excluded',
}

/** Role word for the photo stamp · null when the server sent no role */
export function roleWord(bRole: CompItem['bRole']): 'ARV' | 'EVIDENCE' | 'SUPPORT' | 'EXCLUDED' | null {
  return bRole === 'anchor' ? 'ARV'
    : bRole === 'driver' ? 'EVIDENCE'
    : bRole === 'pool' ? 'SUPPORT'
    : bRole === 'excluded' ? 'EXCLUDED'
    : null
}

export function roleTitle(bRole: CompItem['bRole']): string | undefined {
  return bRole === 'anchor' ? 'The verified sale the ARV is priced off'
    : bRole === 'driver' ? 'Verified evidence inside the ARV answer'
    : bRole === 'pool' ? 'Evaluated · supports the answer without setting it'
    : bRole === 'excluded' ? 'Excluded from the ARV evidence'
    : undefined
}

/** Photo stamp fill per role · the original card colors */
export const ROLE_STAMP_CLASS: Record<NonNullable<CompItem['bRole']>, string> = {
  anchor: 'bg-amber-500 text-white',
  driver: 'bg-emerald-600 text-white',
  pool: 'bg-neutral-600 text-white',
  excluded: 'bg-neutral-700 text-white/80',
}

/** Photo stamp fill per price class · the original card colors */
export const PRICE_STAMP_CLASS: Record<NonNullable<CompBadges['price']>, string> = {
  renovated: 'bg-emerald-600 text-white',
  median: 'bg-blue-600 text-white',
  as_is: 'bg-orange-500 text-white',
}

/** Zillow page for a comp · the saved listing link, else a Zillow search */
export function zillowHref(comp: Pick<CompItem, 'zillowUrl' | 'address' | 'city' | 'state'>): string | null {
  if (comp.zillowUrl) return comp.zillowUrl
  if (!comp.address) return null
  const q = [comp.address, comp.city, comp.state].filter(Boolean).join(' ')
  return `https://www.zillow.com/homes/${encodeURIComponent(q)}_rb/`
}

/** Where a comp's geography matched the subject · lower sorts first */
export function scopeRank(scope: Pick<ScopeLabel, 'word'>): number {
  return scope.word === 'Block' ? 0 : scope.word === 'Tract' ? 1 : scope.word === 'Tract/Block' ? 2 : scope.word === 'Neighborhood' ? 3 : 4
}

/** Photo condition · missing evidence stays Unverified, never a guess */
export function conditionLabel(c: CompBadges['condition'] | undefined): 'Reno' | 'Dated' | 'Distressed' | 'Unverified' {
  return c === 'reno' ? 'Reno' : c === 'dated' ? 'Dated' : c === 'distressed' ? 'Distressed' : 'Unverified'
}

export function priceClassLabel(p: CompBadges['price'] | undefined): 'Renovated' | 'Median' | 'As-is' | null {
  return p === 'renovated' ? 'Renovated' : p === 'median' ? 'Median' : p === 'as_is' ? 'As-is' : null
}

export function trustLabel(t: CompBadges['trust'] | undefined): 'Verified' | 'Partial' | 'Unverified' | null {
  return t === 'verified' ? 'Verified' : t === 'partial' ? 'Partial' : t === 'unverified' ? 'Unverified' : null
}

export function trustTitle(t: CompBadges['trust'] | undefined): string | undefined {
  return t === 'verified' ? 'Every evidence check passed'
    : t === 'partial' ? 'Partially verified · some checks missing'
    : t === 'unverified' ? 'Unverified · an evidence check failed'
    : undefined
}

/** Filters the run relaxed to admit this comp · safe on older reports */
export function widenedRules(badges: CompBadges | null | undefined): string[] {
  return badges?.widenedOn ?? []
}

export function widenedTitle(widenedOn: readonly string[]): string {
  return `Admitted by widened rules: ${widenedOn.map(formatFilterType).join(', ')}`
}

/** The server's ruling when photo condition and sale price disagree */
export function conflictNote(comp: Pick<CompItem, 'classification' | 'badges'>): string | null {
  if (comp.classification?.method !== 'conflict_arbiter') return null
  const t = comp.classification.type
  const word = priceClassLabel(comp.badges?.price)
    ?? (t === 'after_renovation' ? 'Renovated' : t === 'as_is' ? 'As-is' : 'Median')
  return `Condition and price disagree. Classed ${word}.`
}

// ─── Geographic scope ───────────────────────────────────────────────────────

export type ScopeWord = 'Block' | 'Tract' | 'Neighborhood' | 'Tract/Block' | 'Out =' | 'Out >' | 'Out <' | 'Unverified'
export type ScopeTone = 'match' | 'out' | 'unverified'

export interface ScopeLabel {
  word: ScopeWord
  tone: ScopeTone
  /** Plain-words explanation for the tooltip */
  title: string
  /** The comp's neighborhood name; the census tract when it has no name */
  matchedName: string | null
}

/** "Tract 0404.10" from an 11+ digit GEOID */
export function formatCensusTract(value?: string | null): string | null {
  if (!value) return null
  const tract = value.length >= 6 ? value.slice(-6) : value.padStart(6, '0')
  return `${tract.slice(0, 4)}.${tract.slice(4)}`
}

/** Block-group digit from a 12-digit GEOID */
export function formatBlockGroup(value?: string | null): string | null {
  return value ? value.slice(-1) : null
}

/**
 * The area line on a property card: "Group 4 - Meadow Brook" · block group first,
 * then the neighborhood name. Either half alone is drawn alone; neither gives null.
 */
export function formatAreaLine(blockGroupGeoid?: string | null, name?: string | null): string | null {
  const group = formatBlockGroup(blockGroupGeoid)
  const area = name ? titleCaseWords(name) : null
  if (group && area) return `Block ${group} - ${area}`
  if (group) return `Block ${group}`
  return area
}

export type AreaMatch = 'both' | 'block' | 'neighborhood' | 'none'

const geoName = (value?: string | null) => (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/**
 * How a comp sits against the subject's area: the same census block group, the same
 * neighborhood (name or subdivision), both, or neither. Unknown geography reads as neither.
 */
export function compAreaMatch(
  comp: Pick<CompItem, 'sameBlockGroup' | 'censusBlockGroup' | 'neighborhoodName' | 'subdivision' | 'badges'>,
  subject?: Pick<SubjectData, 'censusBlockGroup' | 'neighborhoodName' | 'subdivision'> | null,
): AreaMatch {
  const block = comp.sameBlockGroup === true
    || comp.badges?.pocketVia === 'block'
    || !!(subject?.censusBlockGroup && comp.censusBlockGroup && subject.censusBlockGroup === comp.censusBlockGroup)
  const compName = geoName(comp.neighborhoodName)
  const subjectName = geoName(subject?.neighborhoodName)
  const neighborhood = comp.badges?.pocketVia === 'name'
    || (!!compName && !!subjectName && compName === subjectName)
    || !!(comp.subdivision && subject?.subdivision && subdivisionsMatch(comp.subdivision, subject.subdivision))
  return block && neighborhood ? 'both' : block ? 'block' : neighborhood ? 'neighborhood' : 'none'
}

/** The plain words for an area match · what the map tag says under the price */
export const AREA_MATCH_WORDS: Record<AreaMatch, string> = {
  both: 'Block + Neighborhood',
  block: 'Block',
  neighborhood: 'Neighborhood',
  none: 'Outside',
}

type ScopeComp = Pick<CompItem, 'badges' | 'subdivision' | 'neighborhoodName' | 'sameBlockGroup' | 'censusTract' | 'censusBlockGroup' | 'geographyUnverified'>

/**
 * The one scope label a comp shows · tightest match wins:
 * Group (census block group) → Tract → Neighborhood. How the match was earned
 * (pocketVia) is read first, because a name-only match keeps the server's
 * price comparison in `pocket`. Unknown geography reads Unverified, which is
 * a different thing from a confirmed "Out".
 */
export function scopeLabel(
  comp: ScopeComp & CompItem,
  subject: SubjectData | null | undefined,
  featureMatches?: FeatureMatch[],
): ScopeLabel {
  const b = comp.badges
  const rawName = comp.neighborhoodName || comp.subdivision || null
  const unverified = (title: string): ScopeLabel => ({
    word: 'Unverified', tone: 'unverified', title,
    matchedName: rawName ? titleCaseWords(rawName) : formatCensusTract(comp.censusTract) ? `Tract ${formatCensusTract(comp.censusTract)}` : null,
  })
  if (!b) return unverified('Geographic scope was not evaluated')

  const tractCode = formatCensusTract(comp.censusTract ?? subject?.censusTract)
  const groupCode = formatBlockGroup(comp.censusBlockGroup ?? subject?.censusBlockGroup)
  const matches = featureMatches ?? compFeatureMatches(comp, subject)
  const sharedName =
    comp.subdivision && subject?.subdivision && subdivisionsMatch(comp.subdivision, subject.subdivision)
      ? comp.subdivision
      : comp.neighborhoodName && featureState(matches, 'neighborhood') === 'match'
        ? comp.neighborhoodName
        : null
  // The comp's own neighborhood name is what the card shows; the census
  // tract number only stands in when the comp has no name on file.
  const ownName = comp.neighborhoodName || comp.subdivision || null
  const name = sharedName ? titleCaseWords(sharedName) : ownName ? titleCaseWords(ownName) : null

  const group = (): ScopeLabel => ({
    word: 'Block', tone: 'match', title: 'Same census block group as the subject',
    matchedName: name ?? (tractCode ? `Tract ${tractCode}${groupCode ? ` Block ${groupCode}` : ''}` : null),
  })
  const tract = (): ScopeLabel => ({
    word: 'Tract', tone: 'match', title: 'Same census tract as the subject',
    matchedName: name ?? (tractCode ? `Tract ${tractCode}` : null),
  })

  if (b.pocketVia === 'block') return group()
  if (b.pocketVia === 'tract') return tract()
  if (b.pocketVia === 'name') {
    return { word: 'Neighborhood', tone: 'match', title: 'Same subdivision or neighborhood name as the subject', matchedName: name }
  }

  if (comp.geographyUnverified) return unverified('Geographic scope could not be verified')

  switch (b.pocket) {
    case 'in':
      // Older reports recorded the match but not how it was earned. It was
      // only ever a census match, so it is never labelled Neighborhood.
      if (comp.sameBlockGroup === true) return group()
      if (comp.censusTract && subject?.censusTract && comp.censusTract === subject.censusTract) return tract()
      return { word: 'Tract/Block', tone: 'match', title: 'Inside the subject census area · match level not recorded', matchedName: name }
    case 'equal':
      return { word: 'Out =', tone: 'out', title: 'Outside the subject area · priced level with it', matchedName: name }
    case 'above':
      return { word: 'Out >', tone: 'out', title: 'Outside the subject area · priced above it', matchedName: name }
    case 'below':
      return { word: 'Out <', tone: 'out', title: 'Outside the subject area · priced below it', matchedName: name }
    default:
      return unverified('Geographic scope could not be verified')
  }
}

export function scopeToneClass(tone: ScopeTone): string {
  return tone === 'match' ? MATCH_TEXT : tone === 'out' ? 'text-foreground-secondary' : 'text-foreground-tertiary'
}

// ─── Address casing ─────────────────────────────────────────────────────────

const DIRECTIONALS = new Set(['N', 'S', 'E', 'W', 'NE', 'NW', 'SE', 'SW'])
const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY',
  'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH',
  'OK', 'OR', 'PA', 'PR', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
])

function caseWord(word: string): string {
  if (/^\d+(st|nd|rd|th)$/i.test(word)) return word.toLowerCase()
  if (/\d/.test(word)) return word.toUpperCase()
  if (DIRECTIONALS.has(word.toUpperCase())) return word.toUpperCase()
  // Already mixed case ("McDonough", "Hunter's") · the source cased it, keep it
  if (word !== word.toUpperCase() && word !== word.toLowerCase()) return word
  // After an apostrophe a name part is capitalized ("O'Neal"), a possessive is not ("Hunter's")
  return word.toLowerCase().replace(/(^|-|'(?=[a-z]{2}))([a-z])/g, (_, lead: string, ch: string) => lead + ch.toUpperCase())
}

/** "SCOTTISH MANOR" → "Scottish Manor" */
export function titleCaseWords(text: string): string {
  return text.trim().split(/\s+/).filter(Boolean).map(caseWord).join(' ')
}

/**
 * "1643 BAGPIPE PL, CONLEY, GA 30288" → "1643 Bagpipe Pl, Conley, GA 30288".
 * Display only · copy buttons, links and selection keys keep the raw string.
 * A two-letter state stays uppercase only where a state belongs (closing a
 * part after the street, or right before the ZIP), so "Cay Ct" and
 * "La Grange" are not read as Connecticut and Louisiana.
 */
export function formatAddressCasing(address: string | null | undefined): string {
  if (!address) return ''
  const parts = address.split(',').map((part) => part.trim()).filter(Boolean)
  return parts
    .map((part, partIndex) => {
      const words = part.split(/\s+/)
      return words
        .map((word, i) => {
          const upper = word.toUpperCase()
          const next = words[i + 1]
          const beforeZip = /^\d{5}(-\d{4})?$/.test(next ?? '')
          const stateSlot = beforeZip || (partIndex > 0 && i === words.length - 1)
          if (stateSlot && US_STATES.has(upper)) return upper
          return caseWord(word)
        })
        .join(' ')
    })
    .join(', ')
}

/** ("CONLEY", "ga") → "Conley, GA" */
export function formatCityState(city: string | null | undefined, state: string | null | undefined): string {
  return [city ? titleCaseWords(city) : null, state ? state.trim().toUpperCase() : null].filter(Boolean).join(', ')
}

// ─── Links and small values ─────────────────────────────────────────────────

/** Google Street View for a comp · one builder for the card and the dialog */
export function streetViewHref(comp: Pick<CompItem, 'latitude' | 'longitude' | 'address' | 'city' | 'state'>): string | null {
  if (comp.latitude != null && comp.longitude != null) {
    return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${comp.latitude},${comp.longitude}`
  }
  if (!comp.address) return null
  const full = [comp.address, comp.city, comp.state].filter(Boolean).join(', ')
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(full)}`
}

/** The subject's Street View link · same destination rule as a comp's, from the subject's location. */
export function subjectStreetViewHref(subject: { latitude?: number | null; longitude?: number | null; address?: string | null }): string | null {
  return streetViewHref({
    latitude: subject.latitude ?? undefined,
    longitude: subject.longitude ?? undefined,
    address: subject.address ?? undefined,
  })
}

/** A filter's measured value or threshold, readable · 0.0748427 → "0.07" */
export function fmtRuleValue(v: unknown): string {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '-'
    const rounded = Number(v.toFixed(2))
    // Years ride through here too ("1925 / 1969") · group only clearly large values
    return Math.abs(rounded) >= 10000 ? rounded.toLocaleString() : String(rounded)
  }
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return String(v).replace(/_/g, ' ')
}
