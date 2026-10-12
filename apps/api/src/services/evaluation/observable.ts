/**
 * Observable-evidence lane — the prototype classification layer.
 *
 * Replaces whole-condition judgments with small, answerable questions:
 *   - SUBJECT (all listing photos + description): S1–S7 — condition, reno
 *     evidence, repair level, interior doc quality, description agreement,
 *     asking-price position, price/condition agreement.
 *   - COMP (cover photo + description + closed sale price): C1–C7 — price
 *     position vs the supplied pocket boundaries, description condition,
 *     cover-photo evidence, credible reno claim, price/condition
 *     agreement, unexplained premium flag, final market tier.
 *
 * Decisions (gpt-6-luna) classifies evidence only — it never selects comps
 * or sets ARV (rule 9/10). Price boundaries are computed in code over the
 * matched-comp set and passed in; the model never does boundary math.
 * Sonnet appraises downstream. See the question spec pasted with the task.
 */

import { decisionsRun, isDecisionsAvailable } from '../decisions'
import { RENOVATION_LEVEL_DEFINITIONS, renovationTierInstructions, renovationTierProbabilities } from '../vision/renovation'
import { decisionsExteriorMatch, type CoverImage } from './exterior-match'
import { fetchImagesAsBase64, fetchImageAsBase64 } from '../llm/image-utils'
import type { Env } from '../../types'

export type PriceTier = 'ABOVE_MEDIAN' | 'MEDIAN' | 'BELOW_MEDIAN' | 'UNVERIFIED'

export interface PocketBenchmark {
  scope: 'block_group' | 'neighborhood' | 'tract' | 'pool'
  /** Comp ids that make up the matched set. */
  compIds: string[]
  n: number
  medianPrice: number | null
  medianPpsf: number | null
  p25Ppsf: number | null
  p75Ppsf: number | null
  /** False when the matched set is too thin to trust — the appraiser sees
   *  the flag, not a silently weak benchmark. */
  reliable: boolean
}

interface BenchmarkComp {
  id: string
  salePrice?: number | null
  squareFeet?: number | null
  pricePerSqft?: number | null
  sameBlockGroup?: boolean | null
  neighborhoodName?: string | null
  censusTract?: string | null
  isEnabled?: boolean | null
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]!
}
const pctile = (xs: number[], p: number): number | null => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.max(0, Math.min(s.length - 1, Math.floor(p * (s.length - 1))))]!
}

/** Matched-market benchmark — the price distribution Decisions classifies
 *  against. Block group first (physically similar), then neighborhood,
 *  then tract, then the whole priced pool with reliable=false. */
export function computePocketBenchmark(
  subject: { censusBlockGroup?: string | null; neighborhoodName?: string | null; censusTract?: string | null },
  comps: BenchmarkComp[],
): PocketBenchmark | null {
  const priced = (c: BenchmarkComp) =>
    (c.pricePerSqft ?? (c.salePrice != null && c.squareFeet ? c.salePrice / c.squareFeet : null))
  const active = comps.filter((c) => c.isEnabled !== false && priced(c) != null && (c.salePrice ?? 0) > 0)
  if (active.length === 0) return null

  const tiers: Array<{ scope: PocketBenchmark['scope']; set: BenchmarkComp[] }> = [
    { scope: 'block_group', set: active.filter((c) => c.sameBlockGroup) },
    { scope: 'neighborhood', set: subject.neighborhoodName ? active.filter((c) => c.neighborhoodName === subject.neighborhoodName) : [] },
    { scope: 'tract', set: subject.censusTract ? active.filter((c) => c.censusTract === subject.censusTract) : [] },
    { scope: 'pool', set: active },
  ]
  // First scope with ≥3 members wins; pool is the always-true fallback.
  const tier = tiers.find((t) => t.set.length >= 3) ?? tiers[tiers.length - 1]!
  const set = tier.set
  const ppsfs = set.map((c) => priced(c)!).filter((v) => v > 0)
  const prices = set.map((c) => c.salePrice!).filter((v) => v > 0)
  return {
    scope: tier.scope,
    compIds: set.map((c) => c.id),
    n: set.length,
    medianPrice: median(prices),
    medianPpsf: median(ppsfs),
    p25Ppsf: pctile(ppsfs, 0.25),
    p75Ppsf: pctile(ppsfs, 0.75),
    reliable: set.length >= 3 && tier.scope !== 'pool',
  }
}

export function positionFor(ppsf: number | null, bench: PocketBenchmark): { tier: PriceTier; vsMedianPct: number | null } {
  if (ppsf == null || bench.medianPpsf == null || bench.medianPpsf <= 0) return { tier: 'UNVERIFIED', vsMedianPct: null }
  const vs = ppsf / bench.medianPpsf
  // p75/p25 are the supplied boundaries — 'at median' is the middle half.
  if (bench.p75Ppsf != null && ppsf > bench.p75Ppsf) return { tier: 'ABOVE_MEDIAN', vsMedianPct: vs }
  if (bench.p25Ppsf != null && ppsf < bench.p25Ppsf) return { tier: 'BELOW_MEDIAN', vsMedianPct: vs }
  return { tier: 'MEDIAN', vsMedianPct: vs }
}

// ─── Question banks (verbatim spec) ─────────────────────────────────────

/** Doctrine injected into every Decisions call's context — the model reads
 *  this before judging each comp so it knows what it's looking at.
 *  Exclusion reasons FIRST, inclusion reasons SECOND: the lane's job is to
 *  disprove comps before it proves them. */
export const DECISIONS_DOCTRINE = `EXCLUSION RULES — disqualify first:
- Outside the block group with no neighborhood or trade-area match — exclude.
- Square footage outside the subject's band, or materially different year built — exclude.
- Stale sale, or an uncorroborated price (no AVM support, nominal/data_error flags) — exclude.
- Fits the rules but priced far below the pocket — an investor sale; real data, not ARV-grade evidence.
- Condition that cannot represent the subject's finished state — not ARV evidence.

CONDITION DOCTRINE:
- DATED = move-in ready but older house by year built, especially when no notable cosmetic or big-ticket renovations appear in the description.
- RENOVATED = cosmetics AND big-ticket items replaced, especially when the description emphasizes new condition or renovation status.
- DISTRESSED = "fixer upper", "TLC", "sweat equity", "bring your vision", "as-is", or similar keywords — a full renovation is required.
- MAINTAINED = lived-in and serviceable with some updated big-ticket items; not retail-renovated.

INCLUSION RULES — only after exclusions pass:
- Geography: same block group > same neighborhood > same subdivision > pocket median fallback.
- Physical similarity to the subject (style, stories, garage layout, curb appeal) — judged from street view, never condition.
- ARV-fitness ladder: newly renovated / flipper-complete = highest score; move-in ready or lived-in with updated big-ticket items ≈ 70-80s; investor sale / fixer / TLC / "bring your vision" = lowest score for ARV use.
- The goal is maximizing after-repair value within the rules — the strongest honest valuation makes the strongest honest offer to the seller.`

const COND_CHOICES = {
  RENOVATED: 'clearly renovated or substantially updated for retail resale',
  MAINTAINED: 'well-kept, dated finishes but nothing visibly broken',
  DATED: 'original or tired finishes throughout — needs updating',
  DISTRESSED: 'visible damage, deferred maintenance, or heavy wear',
  UNVERIFIED: 'evidence does not support a condition call',
}
// Condition answered in the product's own renovation-tier vocabulary —
// the same REHAB_LEVELS criteria the Evaluation Settings expose, so the
// model picks a tier against the user's reference text, not adjectives.
const TIER_COND_CHOICES = {
  ...Object.fromEntries(
    RENOVATION_LEVEL_DEFINITIONS.map((d) => [d.name.toUpperCase().replace(/ /g, '_'), d.criteria])),
  UNVERIFIED: 'evidence does not support a tier call',
}
const TIER_CHOICES = {
  ABOVE_MEDIAN: 'priced above the supplied pocket median band',
  MEDIAN: 'priced at or near the supplied pocket median band',
  BELOW_MEDIAN: 'priced significantly below the supplied pocket median band',
  UNVERIFIED: 'evidence cannot support a tier call',
}

const SUBJECT_QUESTIONS = {
  s1_overall_condition: {
    type: 'choice' as const, criteria: COND_CHOICES,
    instructions: "Based on all available property photos and the listing description, which condition best describes the SUBJECT? DATED = move-in ready but older house by year built, especially when no notable cosmetic or big-ticket renovations appear in the description. RENOVATED = cosmetics AND big-ticket items replaced, especially when the description emphasizes new condition or renovation status. DISTRESSED = fixer upper, TLC, sweat equity, bring your vision, as-is, or similar keywords — a full renovation is required. MAINTAINED = lived-in and serviceable with some updated big-ticket items; not retail-renovated.",
  },
  s2_reno_evidence: {
    type: 'noul' as const,
    instructions: 'Do the photographs provide clear evidence of meaningful improvements to major living areas, such as kitchens, bathrooms, flooring, and interior finishes, rather than simple cleaning, staging, or minor cosmetic changes?',
  },
  s3_repair_level: {
    type: 'choice' as const,
    criteria: {
      MINIMAL: 'little or no visible work needed',
      COSMETIC: 'paint/floor/fixture-level work',
      SIGNIFICANT: 'kitchen/bath/system-level work',
      MAJOR_REHAB: 'gut or near-gut scope',
      UNVERIFIED: 'evidence cannot support a level',
    },
    instructions: 'What level of visible or explicitly described work does the property need to reach a typical renovated retail condition?',
  },
  s4_interior_quality: {
    type: 'choice' as const,
    criteria: {
      WELL_DOCUMENTED: 'interior condition is well covered by the photos',
      PARTIAL: 'some interior rooms covered',
      EXTERIOR_ONLY: 'photos cover only exterior/street views',
      UNVERIFIED: 'cannot tell what the photos cover',
    },
    instructions: "How much of the property's interior condition can the supplied photographs actually establish?",
  },
  s5_desc_agreement: {
    type: 'choice' as const,
    criteria: { SUPPORTS: 'description supports the photo condition', CONTRADICTS: 'description contradicts the photos', INSUFFICIENT: 'description too thin to verify' },
    instructions: 'Does the listing description support, contradict, or fail to verify the condition visible in the photographs?',
  },
  s6_ask_price_support: {
    type: 'choice' as const,
    criteria: { SUPPORTS: 'evidence supports the code-assigned asking-price position', CONTRADICTS: 'evidence contradicts it', INSUFFICIENT: 'evidence too thin to judge' },
    instructions: "The asking price's market tier is already code-assigned from the supplied percentile boundaries — do not locate the price yourself. Does the photographic and descriptive evidence support that asking-price position? This measures evidence support only — it does not establish market value or ARV.",
  },
  s7_price_condition: {
    type: 'choice' as const,
    criteria: { SUPPORTS: 'condition supports the asking-price position', PRICE_APPEARS_HIGH: 'asking appears high for the observed condition', PRICE_APPEARS_LOW: 'asking appears low for the observed condition', INSUFFICIENT: 'cannot tell' },
    instructions: "Does the SUBJECT's observed condition reasonably support its asking-price position relative to similar neighborhood properties?",
  },
  s8_lot_premium: {
    type: 'choice' as const,
    criteria: { WATERFRONT: 'waterfront or water-adjacent lot', OVERSIZED_LOT: 'notably larger lot than neighbors', CORNER_CULDESAC: 'corner or cul-de-sac premium lot', POOL: 'pool visible on property', NONE: 'no premium lot features evident', UNVERIFIED: 'imagery insufficient to tell' },
    instructions: 'From the aerial/satellite images, does the SUBJECT sit on a premium lot? THE SUBJECT LOT IS AT THE CENTER OF EACH AERIAL FRAME — the close-up tile (second image) frames the parcel itself; judge that parcel, not the neighborhood. Check each label: (1) WATERFRONT — water (bay, canal, lake, pond) touching or adjacent to the center lot boundary; (2) CORNER/CUL-DE-SAC — the center lot sits on a street corner or at a dead-end bulb; (3) OVERSIZED — the center parcel is clearly larger than its neighbors; (4) POOL visible on the center lot. Answer WATERFRONT whenever water borders the center parcel — do not answer NONE while a water body touches the lot.',
  },
  // Per-attribute probabilities — same decomposition as the comp c8p lane.
  s8p_waterfront: { type: 'noul' as const, instructions: 'Probability the SUBJECT parcel has a water premium — lakefront, riverfront, canal, bay, or a water body touching/adjacent to the parcel boundary. THE SUBJECT LOT IS AT THE CENTER OF EACH AERIAL FRAME. ~0 when no water touches the center parcel.' },
  s8p_culdesac_corner: { type: 'noul' as const, instructions: 'Probability the SUBJECT sits on a cul-de-sac bulb or a corner lot — the parcel faces onto a circular dead-end bulb or fronts two intersecting streets. ~0 for a mid-block interior lot.' },
  s8p_oversized: { type: 'noul' as const, instructions: 'Probability the SUBJECT parcel is notably larger than its immediate neighbors — a lot-size premium versus the surrounding block. ~0 for a typical parcel.' },
  s8p_pool: { type: 'noul' as const, instructions: 'Probability the SUBJECT parcel has a pool — visible pool geometry in the aerial or photos. ~0 when none evident.' },
  s9_site_exposure: {
    type: 'choice' as const,
    criteria: { FRONTING: 'fronts a busy road, arterial, or commercial', SIDING: 'sides a busy road, arterial, or commercial', BACKING: 'backs a busy road, commercial, freeway, or rail', NEUTRAL: 'typical interior residential setting', UNVERIFIED: 'imagery insufficient to tell' },
    instructions: 'From the aerial/satellite image, does the SUBJECT have adverse site exposure? THE SUBJECT LOT IS AT THE CENTER OF EACH AERIAL FRAME — the close-up frames the parcel itself. Scan every edge of the center parcel for exposure cues: a large flat-roof commercial/industrial building, warehouse, big-box store, parking lot, multi-lane arterial or highway, or rail line touching or immediately adjacent to the parcel boundary. Any of those = exposure, NEVER NEUTRAL. Pick the SIDE: fronting = on the street side the home faces, backing = on the rear edge opposite the street, siding = on a side edge. NEUTRAL only when all edges border homes, yards, or woods. Interior residential lots between commercial strips still count when a commercial rooftop or lot touches the boundary.',
  },
  // Edge-wise decomposition — the model answers the easy question (what is
  // ON each frame edge) and code maps edges to front/back/side using the
  // computed street orientation. One choice question cannot decompose the
  // two judgments reliably.
  s9e_north: { type: 'noul' as const, instructions: 'On the NORTH edge of the aerial frames (top of image), does anything NON-RESIDENTIAL touch or immediately border the CENTER parcel: a large flat-roof commercial/industrial building, warehouse, retail store, parking lot, multi-lane arterial/highway, rail line, or industrial yard? Score high only when such a feature clearly touches the center parcel north boundary; 0 when the north edge borders only homes, yards, woods, or a quiet residential street.' },
  s9e_east: { type: 'noul' as const, instructions: 'On the EAST edge of the aerial frames (right of image), does anything NON-RESIDENTIAL touch or immediately border the CENTER parcel: a large flat-roof commercial/industrial building, warehouse, retail store, parking lot, multi-lane arterial/highway, rail line, or industrial yard? Score high only when such a feature clearly touches the center parcel east boundary; 0 when the east edge borders only homes, yards, woods, or a quiet residential street.' },
  s9e_south: { type: 'noul' as const, instructions: 'On the SOUTH edge of the aerial frames (bottom of image), does anything NON-RESIDENTIAL touch or immediately border the CENTER parcel: a large flat-roof commercial/industrial building, warehouse, retail store, parking lot, multi-lane arterial/highway, rail line, or industrial yard? Score high only when such a feature clearly touches the center parcel south boundary; 0 when the south edge borders only homes, yards, woods, or a quiet residential street.' },
  s9e_west: { type: 'noul' as const, instructions: 'On the WEST edge of the aerial frames (left of image), does anything NON-RESIDENTIAL touch or immediately border the CENTER parcel: a large flat-roof commercial/industrial building, warehouse, retail store, parking lot, multi-lane arterial/highway, rail line, or industrial yard? Score high only when such a feature clearly touches the center parcel west boundary; 0 when the west edge borders only homes, yards, woods, or a quiet residential street.' },
}

const COMP_QUESTIONS = {
  c1_price_support: {
    type: 'choice' as const,
    criteria: { SUPPORTS: 'evidence supports the code-assigned price position', CONTRADICTS: 'evidence contradicts it', INSUFFICIENT: 'evidence too thin to judge' },
    instructions: "The COMP's price tier is already code-assigned from the supplied percentile boundaries — do not locate the price yourself. Does the limited visual and descriptive evidence support this market position?",
  },
  c2_desc_condition: {
    type: 'choice' as const, criteria: COND_CHOICES,
    instructions: 'What property condition does the listing description support? Do not infer renovation from the sale price. DATED = older house by year built with no notable cosmetic or big-ticket renovation claims in the description. RENOVATED = description claims cosmetics and big-ticket items replaced, or emphasizes new condition / renovation status. DISTRESSED = fixer upper, TLC, sweat equity, bring your vision, as-is keywords — a full renovation is required. MAINTAINED = lived-in with some updates, serviceable but not retail-renovated.',
  },
  c3_cover_evidence: {
    type: 'choice' as const,
    criteria: { SUPERIOR: 'visibly superior exterior condition/curb appeal', TYPICAL: 'typical exterior condition', INFERIOR: 'visibly worse exterior condition', UNVERIFIED: 'no usable cover photo' },
    instructions: 'What condition does the cover photograph visibly support? Judge only visible exterior features. Do not infer interior renovation from curb appeal.',
  },
  c4_reno_claim: {
    type: 'noul' as const,
    instructions: 'Does the listing description explicitly provide credible evidence of substantial renovation or value-added improvements, rather than generic phrases such as "beautiful," "well-maintained," or "move-in ready"?',
  },
  c5_price_condition: {
    type: 'choice' as const,
    criteria: { SUPPORTS: 'evidence supports the price position', CONFLICTS: 'evidence conflicts with the price position', INSUFFICIENT: 'cannot tell' },
    instructions: "Does the photographic and descriptive evidence reasonably support the COMP's price position relative to physically similar neighborhood sales?",
  },
  c6_unexplained_premium: {
    type: 'noul' as const,
    instructions: 'EXTREME-VARIANCE CHECK ONLY: is this COMP priced at an outsized level versus the supplied price distribution — the kind of far-outlier sale (e.g. a $1M+ sale inside a ~$300k pocket) that looks like bad data or a non-market transaction rather than a plausible retail sale? A renovated or well-conditioned comp selling modestly above the pocket median is EXPLAINED by its renovation and is NOT unexplained — score near 0 for it. Score high only for extreme variance no evidence could plausibly cover.',
  },
  c7_final_tier: {
    type: 'choice' as const, criteria: TIER_CHOICES,
    instructions: 'Using the supplied price distribution as the primary evidence, assign the COMP to its market price tier. Consider property condition, physical differences, and evidence conflicts. Do not change a verified price-position fact merely because the property appears renovated or dated. Preserve disagreements between price position and condition evidence for the final appraiser.',
  },
  c8_premium_attributes: {
    type: 'choice' as const,
    criteria: { WATERFRONT: 'waterfront or water-adjacent', LARGE_LOT: 'notably larger lot than neighbors', CORNER_CULDESAC: 'corner or cul-de-sac lot', VIEW: 'view premium (golf, water, skyline)', POOL: 'pool present', NONE: 'no premium attribute evident', UNVERIFIED: 'evidence insufficient' },
    instructions: "Do the satellite aerials or the supplied lot data indicate a premium lot attribute that could explain a price premium? THE COMP LOT IS AT THE CENTER OF EACH AERIAL FRAME — the close-up tile frames the parcel itself; judge that parcel. Check each label: WATERFRONT — water (bay, canal, lake, pond) touching or adjacent to the center lot boundary; CORNER_CULDESAC — corner lot or cul-de-sac bulb position; LARGE_LOT — clearly larger parcel than neighbors; POOL — visible pool; VIEW — golf/water/skyline view. Pick the strongest single attribute; NONE only when none is evident — do not answer NONE while a water body touches the center lot.",
  },
  // Per-attribute lot-premium probabilities — the seat reads the odds, not
  // just c8's winning label. Appraiser priors: waterfront/lake/river adjacency
  // carries the largest lot premium; cul-de-sac position is a modest premium
  // (privacy, low traffic, often larger pie-shaped lots); corner lots are
  // mixed-to-slightly-positive in residential appraisals (more frontage but
  // also more exposure and setback loss — the model weighs what it sees).
  c8p_waterfront: {
    type: 'noul' as const,
    instructions: 'Probability that the COMP parcel has a water premium — lakefront, riverfront, canal, bay, or a water body touching/adjacent to the parcel boundary. THE COMP LOT IS AT THE CENTER OF EACH AERIAL FRAME. Score ~0 when no water touches the center parcel; a distant water body in frame is not waterfront.',
  },
  c8p_culdesac_corner: {
    type: 'noul' as const,
    instructions: 'Probability that the COMP sits on a cul-de-sac bulb or a corner lot. Cul-de-sac: parcel faces onto the circular dead-end bulb of a street. Corner: parcel fronts two intersecting streets. Judge the aerial/street-view evidence; ~0 for a mid-block interior lot.',
  },
  c8p_large_lot: {
    type: 'noul' as const,
    instructions: 'Probability that the COMP parcel is notably larger than its immediate neighbors — a lot-size premium versus the surrounding block, not merely an average lot. ~0 for a typical parcel.',
  },
  c8p_view: {
    type: 'noul' as const,
    instructions: 'Probability that the COMP carries a view premium — golf course, water, skyline, or open-space frontage visible from the parcel. ~0 for a standard residential outlook.',
  },
  c8p_pool: {
    type: 'noul' as const,
    instructions: 'Probability that the COMP parcel has a pool — visible pool geometry in the aerial or street view, or a pool noted in the description/property data. ~0 when none evident.',
  },
  // Site predicates — yes/no facts from the aerial (owner doctrine:
  // environmental facts are predicates, not probabilities). Each answers
  // one binary question about the CENTER parcel in the aerial frames.
  sp_backs_busy_road: {
    type: 'noul' as const,
    instructions: 'YES or NO: does the CENTER parcel in the aerial BACK onto a busy road, arterial, highway, or rail line — its REAR edge (opposite the street side) touches one?',
  },
  sp_fronts_busy_road: {
    type: 'noul' as const,
    instructions: 'YES or NO: does the CENTER parcel in the aerial FRONT onto a busy road or arterial — its STREET side faces one?',
  },
  sp_sides_busy_road: {
    type: 'noul' as const,
    instructions: 'YES or NO: does the CENTER parcel in the aerial SIDE onto a busy road or arterial — a SIDE edge (not the street frontage, not the rear) borders one?',
  },
  sp_commercial: {
    type: 'noul' as const,
    instructions: 'YES or NO: is the CENTER parcel in the aerial exposed to commercial use — a commercial/industrial building, warehouse, big-box store, or parking lot touching or immediately adjacent to it?',
  },
  sp_corner_lot: {
    type: 'noul' as const,
    instructions: 'YES or NO: does the CENTER parcel in the aerial sit on a corner — fronting two intersecting streets?',
  },
  sp_culdesac: {
    type: 'noul' as const,
    instructions: 'YES or NO: does the CENTER parcel in the aerial face onto a cul-de-sac bulb — the circular dead-end of a street?',
  },
  sp_infill_lot: {
    type: 'noul' as const,
    instructions: 'YES or NO: is the CENTER parcel an interior infill lot — mid-block inside the pocket, surrounded by the same housing stock, not on an edge/corner/cul-de-sac?',
  },
  sp_waterfront: {
    type: 'noul' as const,
    instructions: 'YES or NO: does a water body (bay, canal, lake, pond, river) touch or border the CENTER parcel boundary in the aerial? A distant water body in frame is not waterfront.',
  },
  sp_lakefront: {
    type: 'noul' as const,
    instructions: 'YES or NO: does a LAKE or POND touch or border the CENTER parcel boundary in the aerial?',
  },
  sp_riverfront: {
    type: 'noul' as const,
    instructions: 'YES or NO: does a RIVER or CANAL touch or border the CENTER parcel boundary in the aerial?',
  },
  c9_site_exposure: {
    type: 'choice' as const,
    criteria: { FRONTING: 'fronts a busy road, arterial, or commercial', SIDING: 'sides a busy road, arterial, or commercial', BACKING: 'backs a busy road, commercial, freeway, or rail', NEUTRAL: 'typical interior residential setting', UNVERIFIED: 'imagery insufficient or unavailable' },
    instructions: 'When a satellite image is supplied, does the COMP have adverse site exposure? THE COMP LOT IS AT THE CENTER OF EACH AERIAL FRAME — the close-up frames the parcel itself. Scan every edge of the center parcel for exposure cues: a large flat-roof commercial/industrial building, warehouse, big-box store, parking lot, multi-lane arterial or highway, or rail line touching or immediately adjacent to the parcel boundary. Any of those = exposure, NEVER NEUTRAL. Pick the SIDE: fronting = on the street side, backing = rear edge opposite the street, siding = side edge. NEUTRAL only when all edges border homes, yards, or woods. UNVERIFIED only when no satellite image is present; do not infer exposure from price or description alone.',
  },
  c10_physical_match: {
    type: 'noul' as const,
    instructions: 'Two street-view images are supplied: the FIRST is the COMP, the SECOND is the SUBJECT. Score the probability that the COMP is a physical match to the subject — architectural style, stories, garage layout, curb appeal. Judge physical similarity ONLY, never condition — street view cannot verify condition. Score low when the styles clearly differ.',
  },
  c11_arv_fitness: {
    type: 'noul' as const,
    instructions: 'Score the probability that this COMP represents a finished, renovated, or move-in-ready version of the subject property — an ARV-grade sale. Highest scores: newly renovated or flipper-complete listings (description emphasizes new this, new that). Around 70-80: move-in ready, lived-in condition with updated big-ticket items. Lowest scores: investor sales or listings needing full renovation — fixer upper, TLC, sweat equity, bring your vision, as-is keywords.',
  },
  c12_development_vintage: {
    type: 'choice' as const,
    criteria: {
      NEWER: "the development around the COMP clearly reads as a newer, more modern subdivision than the one around the SUBJECT",
      SIMILAR: 'the developments around both read as the same era of housing stock',
      OLDER: "the development around the COMP clearly reads as an older, more dated subdivision than the one around the SUBJECT",
      UNVERIFIED: 'aerials missing or the neighborhoods cannot be compared',
    },
    instructions: 'Compare the two satellite aerials: the COMP aerial is earlier in the image set, the SUBJECT aerial is the LAST image. Judge the NEIGHBORHOOD around each centered parcel — housing-stock era, lot and street pattern, tract development vs infill — not the individual houses. A comp sitting in a visibly newer subdivision is different housing stock than the subject even when the houses look alike. Answer NEWER only when the surrounding development is clearly a different (newer) era; SIMILAR when the neighborhoods read as the same vintage; UNVERIFIED when either aerial is missing or unreadable.',
  },
  c13_condition_tier: {
    type: 'choice' as const,
    criteria: TIER_COND_CHOICES,
    instructions: renovationTierInstructions('comp'),
  },
}

// Each question reads exactly one kind of evidence, and each kind travels
// in its own model call: listing photos + description (condition), satellite
// aerials (site), street views (physical match). The calls never share
// images, so an aerial cannot colour a condition answer or the reverse.
type AnyQuestion = (typeof SUBJECT_QUESTIONS)[keyof typeof SUBJECT_QUESTIONS] | (typeof COMP_QUESTIONS)[keyof typeof COMP_QUESTIONS]
const questionsWhere = <Q extends Record<string, AnyQuestion>>(all: Q, keep: (name: string) => boolean): Record<string, AnyQuestion> =>
  Object.fromEntries(Object.entries(all).filter(([name]) => keep(name)))

const isSubjectSatellite = (name: string) => name.startsWith('s8_') || name.startsWith('s9')
const SUBJECT_SATELLITE_QUESTIONS = questionsWhere(SUBJECT_QUESTIONS, isSubjectSatellite)
const SUBJECT_CONDITION_QUESTIONS = questionsWhere(SUBJECT_QUESTIONS, (name) => !isSubjectSatellite(name))

const COMP_SATELLITE_NAMES = ['c8_premium_attributes', 'c9_site_exposure', 'c12_development_vintage']
const COMP_STREET_NAMES = ['c10_physical_match']
// c8p_* premium-probability reads judge the aerial — they ride the
// satellite call (spec step 5), not the listing-condition call.
const isCompSatellite = (name: string) => COMP_SATELLITE_NAMES.includes(name) || name.startsWith('c8p_') || name.startsWith('sp_')
const COMP_SATELLITE_QUESTIONS = questionsWhere(COMP_QUESTIONS, isCompSatellite)
const COMP_STREET_QUESTIONS = questionsWhere(COMP_QUESTIONS, (name) => COMP_STREET_NAMES.includes(name))
const COMP_CONDITION_QUESTIONS = questionsWhere(
  COMP_QUESTIONS,
  (name) => !isCompSatellite(name) && !COMP_STREET_NAMES.includes(name),
)

// ─── Deterministic match profile (code, not model) ──────────────────────

const normalizeGeoName = (value?: string | null) =>
  value?.toLowerCase().replace(/[^a-z0-9]/g, '') || null

const normToken = (v?: string | null) => (v?.toLowerCase().trim() ?? null) || null
const eqToken = (a?: string | null, b?: string | null): boolean | null => {
  const na = normToken(a), nb = normToken(b)
  if (!na || !nb) return null // no data — not a match and not a miss
  return na === nb || na.includes(nb) || nb.includes(na)
}
const deltaPct = (a?: number | null, b?: number | null): number | null =>
  typeof a === 'number' && typeof b === 'number' && b > 0 ? (a - b) / b : null
const delta = (a?: number | null, b?: number | null): number | null =>
  typeof a === 'number' && typeof b === 'number' ? a - b : null

export interface MatchLike {
  squareFeet?: number | null
  yearBuilt?: number | null
  lotSizeAcres?: number | null
  bedrooms?: number | null
  bathrooms?: number | null
  stories?: number | null
  foundationType?: string | null
  constructionType?: string | null
  exteriorWalls?: string | null
  roofType?: string | null
  censusTract?: string | null
  neighborhoodName?: string | null
  subdivision?: string | null
  sameBlockGroup?: boolean | null
}

export interface CompMatchProfile {
  /** Two-dimension geo answer — a comp can be BG+neighborhood matched at
   *  once. Deepest tier wins the ordering. */
  blockGroupMatch: boolean
  neighborhoodMatch: boolean
  subdivisionMatch: boolean
  tractMatch: boolean
  geoTier: 'BLOCK_GROUP' | 'NEIGHBORHOOD' | 'SUBDIVISION' | 'TRACT' | 'OFF_POCKET'
  /** Physical variance vs the subject — signed deltas/% deltas, null when
   *  the data point is missing on either side. */
  sqftDeltaPct: number | null
  yearBuiltDelta: number | null
  lotDeltaPct: number | null
  bedsDelta: number | null
  bathsDelta: number | null
  storiesMatch: boolean | null
  foundationMatch: boolean | null
  constructionMatch: boolean | null
  exteriorWallsMatch: boolean | null
  roofTypeMatch: boolean | null
}

/** Code-computed comp-vs-subject match sheet — instant, deterministic.
 *  Geo hierarchy: block group > neighborhood > subdivision > tract; a comp
 *  may satisfy several at once (BG inside neighborhood), so the booleans
 *  are independent and geoTier names the deepest satisfied tier. */
export function compMatchProfile(subject: MatchLike, comp: MatchLike): CompMatchProfile {
  const blockGroupMatch = comp.sameBlockGroup === true
  const subjectNeighborhood = normalizeGeoName(subject.neighborhoodName)
  const neighborhoodMatch = subjectNeighborhood != null
    && normalizeGeoName(comp.neighborhoodName) === subjectNeighborhood
  const subdivisionMatch = subject.subdivision != null
    && comp.subdivision != null
    && normalizeGeoName(comp.subdivision) === normalizeGeoName(subject.subdivision)
  const tractMatch = !!subject.censusTract && comp.censusTract === subject.censusTract
  const geoTier: CompMatchProfile['geoTier'] = blockGroupMatch ? 'BLOCK_GROUP'
    : neighborhoodMatch ? 'NEIGHBORHOOD'
    : subdivisionMatch ? 'SUBDIVISION'
    : tractMatch ? 'TRACT'
    : 'OFF_POCKET'
  return {
    blockGroupMatch, neighborhoodMatch, subdivisionMatch, tractMatch, geoTier,
    sqftDeltaPct: deltaPct(comp.squareFeet, subject.squareFeet),
    yearBuiltDelta: delta(comp.yearBuilt, subject.yearBuilt),
    lotDeltaPct: deltaPct(comp.lotSizeAcres, subject.lotSizeAcres),
    bedsDelta: delta(comp.bedrooms, subject.bedrooms),
    bathsDelta: delta(comp.bathrooms, subject.bathrooms),
    storiesMatch: eqToken(comp.stories != null ? String(comp.stories) : null, subject.stories != null ? String(subject.stories) : null),
    foundationMatch: eqToken(comp.foundationType, subject.foundationType),
    constructionMatch: eqToken(comp.constructionType, subject.constructionType),
    exteriorWallsMatch: eqToken(comp.exteriorWalls, subject.exteriorWalls),
    roofTypeMatch: eqToken(comp.roofType, subject.roofType),
  }
}

// ─── Answer shapes ───────────────────────────────────────────────────────

export interface SubjectObservables {
  overallCondition: string | null
  renoEvidenceP: number | null
  repairLevel: string | null
  interiorDocQuality: string | null
  descAgreement: string | null
  /** Code-assigned asking-price tier (p25/p75 boundaries) — not a model call. */
  askPricePosition: string | null
  /** Whether the evidence supports that code-assigned position. */
  askPriceSupport: string | null
  priceConditionAgreement: string | null
  /** Premium lot attribute from satellite + photos (waterfront/pool/corner etc.). */
  lotPremium: string | null
  /** Per-attribute lot-premium odds — P(waterfront) / P(corner-cul-de-sac)
   *  / P(oversized) / P(pool). */
  lotPremiumProbabilities: Record<string, number> | null
  /** Adverse site exposure from satellite (arterial/commercial/freeway). */
  siteExposure: string | null
  /** Edge-wise exposure probabilities + computed street orientation —
   *  the audit trail behind siteExposure when the edge lane fires. */
  siteEdges?: {
    north: number | null
    east: number | null
    south: number | null
    west: number | null
    streetEdge: string | null
    streetBearingDeg: number | null
  }
  /** Scope of work the subject needs, in the product's rehab-tier
   *  vocabulary (LIPSTICK … FULL_GUT) — the subject renovation
   *  assessment's verdict (see applySubjectTierVerdict). */
  renovationTier: string | null
  /** Probability per renovation tier behind `renovationTier` */
  renovationTierProbabilities?: Record<string, number> | null
  /** The subject's saved cover photo — the first listing photo that loads,
   *  used as the reference image for every comp's exterior match. */
  coverPhotoUrl?: string | null
  confidence: Record<string, number>
  photosRead: number
  photosTotal: number
  /** Which tiles/photos actually made it into the call (audit trail). */
  imagesRead: string[]
  model: string
  durationMs: number
}

export interface CompObservables {
  /** Code-assigned price tier (p25/p75 boundaries) — not a model call. */
  pricePosition: string | null
  /** Whether the limited visual+descriptive evidence supports it. */
  priceSupport: string | null
  codePosition: PriceTier
  descCondition: string | null
  coverPhotoEvidence: string | null
  renoClaimP: number | null
  priceConditionAgreement: string | null
  unexplainedPremiumP: number | null
  finalTier: string | null
  /** Non-condition premium driver (waterfront/lot/pool/view) — explains c6 flags. */
  premiumAttributes: string | null
  /** Per-attribute probabilities for premiumAttributes — P(waterfront),
   *  P(corner/cul-de-sac), P(large lot), P(view), P(pool) — the seat reads
   *  the odds, not just the winning label. */
  premiumProbabilities?: Record<string, number> | null
  /** Adverse site exposure from satellite (arterial/commercial/freeway). */
  siteExposure: string | null
  /** Development-era comparison from both aerials — NEWER means the comp
   *  sits in a visibly newer subdivision than the subject (different
   *  housing stock, not apples-to-apples). */
  developmentVintage: string | null
  /** Comp condition in the product's rehab-tier vocabulary — the model
   *  picked against the Evaluation Settings criteria (photo+description). */
  conditionTier: string | null
  /** Probability per renovation tier behind `conditionTier` */
  conditionTierProbabilities?: Record<string, number> | null
  /** P(comp is a physical match to the subject) — street view lane. */
  physicalMatchP: number | null
  /** P(the comp's exterior matches the subject's) — listing cover photo vs
   *  listing cover photo. Null when either photo is missing. */
  exteriorMatchP?: number | null
  /** Site predicates — yes/no satellite reads (probability ≥0.5 = yes):
   *  backsBusyRoad / frontsBusyRoad / sidesBusyRoad / commercial /
   *  cornerLot / culdesac / infillLot / waterfront / lakefront / riverfront. */
  sitePredicates?: Record<string, number | null> | null
  /** P(the comp's cover photo shows the front of the house) */
  coverIsFrontP?: number | null
  /** P(the subject's cover photo shows the front of the house) */
  subjectCoverIsFrontP?: number | null
  /** P(comp is a finished/renovated/move-in-ready version of the subject) —
   *  ARV-fitness ladder: flipper-complete highest, maintained ~70-80s,
   *  fixer/investor lowest. */
  arvFitnessP: number | null
  confidence: Record<string, number>
  /** Which tiles/photos actually made it into the call (audit trail). */
  imagesRead: string[]
  model: string
  durationMs: number
}

type DecisionsAnswers = Record<string, { probability?: number; choice?: string | boolean | null; score?: number; confidence?: number; probabilities?: Record<string, number> }>
const choiceOf = (a: DecisionsAnswers, k: string): string | null =>
  typeof a[k]?.choice === 'string' ? (a[k]!.choice as string) : null
const probOf = (a: DecisionsAnswers, k: string): number | null =>
  typeof a[k]?.probability === 'number' ? a[k]!.probability! : null
const choiceProbs = (a: DecisionsAnswers, k: string): Record<string, number> | null =>
  a[k]?.probabilities && Object.keys(a[k]!.probabilities!).length ? a[k]!.probabilities! : null
/** Probability per renovation tier behind a tier choice answer. */
const tierProbsOf = (a: DecisionsAnswers, k: string): Record<string, number> | null =>
  renovationTierProbabilities(a[k]?.probabilities)
const confs = (a: DecisionsAnswers): Record<string, number> =>
  Object.fromEntries(Object.entries(a).filter(([, v]) => typeof v?.confidence === 'number').map(([k, v]) => [k, v.confidence!]))

/**
 * One subject tier per evaluation. The renovation assessment asks the tier
 * question once and prices the rehab from it, so that verdict is also the
 * tier the appraiser is told — this lane does not ask it a second time.
 */
export function applySubjectTierVerdict(
  observables: SubjectObservables,
  assessment: { renovationLevelIndex: number | null; tierProbabilities?: Record<string, number> | null },
): void {
  const tier = assessment.renovationLevelIndex === null ? null : RENOVATION_LEVEL_DEFINITIONS[assessment.renovationLevelIndex]
  observables.renovationTier = tier ? tier.name.toUpperCase().replace(/ /g, '_') : null
  observables.renovationTierProbabilities = tier ? assessment.tierProbabilities ?? null : null
}

// ─── Subject call — every listing photo (100% coverage), chunked past the
//     API's 128-image cap; empty sets fall back to the cover photo. ───────

const DECISIONS_IMG_CAP = 128

/** Fetch a 640x640 image tile as base64; null on non-image/error. */
async function fetchTile(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) return null
  const mime = res.headers.get('content-type') ?? 'image/png'
  if (!mime.startsWith('image/')) return null
  const buf = new Uint8Array(await res.arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192))
  return { base64: btoa(bin), content_type: mime }
}

/** Satellite tile for the subject — feeds s8 lot-premium and s9 site-
 *  exposure. Provider chain: Google staticmap hybrid (needs the Maps
 *  Static API enabled on the key — it is NOT enabled on the current
 *  project, so this 403s today) → Esri World Imagery (sharpest fallback
 *  aerial) → USGS imagery+topo hybrid (aerial + road/place labels,
 *  US-only, no key). Null when coords/fetch miss. Exported — evaluation
 *  shares one subject wide-aerial fetch across every comp c12 call. */
export async function fetchSatelliteTile(env: Env, subject: Record<string, unknown>, half = 300) {
  const lat = subject.latitude ?? subject.lat, lng = subject.longitude ?? subject.lng
  if (typeof lat !== 'number' || typeof lng !== 'number') return null
  const key = env.GOOGLE_MAPS_KEY
  if (key) {
    // 640px at zoom 17 spans ~600m (the wide frame); zoom 19 spans ~150m
    // (the close-up, parcel centered). One fixed zoom made both frames identical.
    const zoom = half >= 200 ? 17 : 19
    const g = await fetchTile(`https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=${zoom}&size=640x640&maptype=hybrid&key=${key}`).catch(() => null)
    if (g) return g
  }
  // Web-Mercator bbox ≈ zoom 17 (~600m across at 640px).
  // x = lng·(πR_earth)/180 needs the half-extent constant; y needs
  // R_earth itself: y = R_earth·ln(tan(π/4 + φ/2)).
  const R = 20037508.34
  const x = (lng as number) * R / 180
  const y = (R / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat as number) * Math.PI / 360))
  // Default half-width ~300m (~600m across) — wide enough that a
  // waterfront boundary (bay/canal/lake edge) is visible in frame, not
  // just the street block. The close-up pass uses ~90m so the subject
  // parcel itself fills the frame.
  const bbox = `${Math.round(x - half)},${Math.round(y - half)},${Math.round(x + half)},${Math.round(y + half)}`
  const esri = await fetchTile(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${bbox}&bboxSR=3857&imageSR=3857&size=640,640&format=jpg&f=image`).catch(() => null)
  if (esri) return esri
  return fetchTile(`https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/export?bbox=${bbox}&bboxSR=3857&imageSR=3857&size=640,640&format=jpg&f=image`).catch(() => null)
}

/** Which frame edge the subject's fronting street sits on — deterministic
 *  orientation for the exposure questions. Nominatim resolves the street's
 *  geometry near the parcel; the bearing of its nearest point maps to a
 *  frame edge (top=N … left=W). The model then only judges WHAT is on each
 *  edge, never which edge is the street. */
export type FrameEdge = 'north' | 'east' | 'south' | 'west'
export interface StreetOrientation { streetEdge: FrameEdge; bearingDeg: number; streetName: string | null }

export async function fetchStreetOrientation(subject: Record<string, unknown>, env?: { OSM_ENABLED?: string }): Promise<StreetOrientation | null> {
  if (env?.OSM_ENABLED === 'false') return null
  const lat = subject.latitude ?? subject.lat, lng = subject.longitude ?? subject.lng
  if (typeof lat !== 'number' || typeof lng !== 'number') return null
  const addr = String(subject.address ?? '')
  const m = /^\d+\s+(.+?)(?:,|$)/.exec(addr)
  if (!m) return null
  const street = m[1]!.replace(/\s+(NW|NE|SW|SE|N|S|E|W)$/i, ' $1').trim()
  // Structured fields win; the address string is the fallback when the
  // provider only carries a street line.
  const city = (subject.city as string | undefined)
    ?? /,\s*([^,]+?),\s*[A-Z]{2}/.exec(addr)?.[1]
  const state = (subject.state as string | undefined)
    ?? /,\s*([A-Z]{2})(?:\s|\d|,|$)/.exec(addr)?.[1]
  const u = new URL('https://nominatim.openstreetmap.org/search')
  u.searchParams.set('street', street)
  if (city) u.searchParams.set('city', city.trim())
  if (state) u.searchParams.set('state', state.trim())
  u.searchParams.set('format', 'json')
  u.searchParams.set('polygon_geojson', '1')
  // Bound the search to ~±5km around the parcel — a same-named street in
  // another city can't leak an orientation.
  const vb = 0.05
  u.searchParams.set('viewbox', `${(lng as number) - vb},${(lat as number) + vb},${(lng as number) + vb},${(lat as number) - vb}`)
  u.searchParams.set('bounded', '1')
  const res = await fetch(u, { headers: { 'User-Agent': 'flowstate-eval/1.0' }, signal: AbortSignal.timeout(10000) }).catch(() => null)
  if (!res?.ok) return null
  const hits = await res.json().catch(() => null) as Array<{ geojson?: { type: string; coordinates: unknown } }> | null
  const lines: Array<Array<[number, number]>> = []
  for (const h of hits ?? []) {
    const g = h.geojson
    if (g?.type === 'LineString') lines.push(g.coordinates as [number, number][])
    else if (g?.type === 'MultiLineString') for (const l of g.coordinates as [number, number][][]) lines.push(l)
  }
  if (!lines.length) return null
  // Nearest point on each SEGMENT, not just vertices — a long segment
  // spanning the parcel has its closest approach between endpoints.
  const mx = Math.cos((lat as number) * Math.PI / 180) * 111320
  const my = 110540
  let best = { d: Infinity, b: 0 }
  for (const line of lines) {
    for (let i = 0; i + 1 < line.length; i++) {
      const ax = (line[i]![0] - (lng as number)) * mx, ay = (line[i]![1] - (lat as number)) * my
      const bx = (line[i + 1]![0] - (lng as number)) * mx, by = (line[i + 1]![1] - (lat as number)) * my
      const dx = bx - ax, dy = by - ay
      const len2 = dx * dx + dy * dy
      const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0
      const px = ax + t * dx, py = ay + t * dy
      const d = Math.hypot(px, py)
      if (d < best.d) best = { d, b: (Math.atan2(px, py) * 180 / Math.PI + 360) % 360 }
    }
  }
  const edge: FrameEdge = best.b >= 315 || best.b < 45 ? 'north' : best.b < 135 ? 'east' : best.b < 225 ? 'south' : 'west'
  return { streetEdge: edge, bearingDeg: Math.round(best.b), streetName: street }
}

/** Edge exposure answers + street orientation → FRONTING/SIDING/BACKING.
 *  The exposure edge opposite the street = backing; on the street edge =
 *  fronting; the two adjacent edges = siding. Returns null when no edge
 *  fires hard enough or orientation is unknown — the choice answer is
 *  then the fallback. */
export function deriveExposure(
  edges: Record<FrameEdge, number>,
  orientation: StreetOrientation | null,
): { exposure: 'FRONTING' | 'SIDING' | 'BACKING'; edge: FrameEdge; prob: number } | null {
  if (!orientation) return null
  const entries = Object.entries(edges) as Array<[FrameEdge, number]>
  const [topEdge, topP] = entries.sort((a, b) => b[1] - a[1])[0]!
  const second = entries[1]![1]
  if (topP < 0.15 || topP < second * 1.5) return null
  const order: FrameEdge[] = ['north', 'east', 'south', 'west']
  const dist = Math.abs(order.indexOf(topEdge) - order.indexOf(orientation.streetEdge))
  const side = dist === 0 ? 'FRONTING' : dist === 2 ? 'BACKING' : 'SIDING'
  return { exposure: side, edge: topEdge, prob: topP }
}

/** Curb-level Street View image for the physical-similarity lane — subject
 *  fetched once per eval by the caller; comps fetched per call. Returns null
 *  when Street View Static is unavailable or the coverage is missing. */
export async function fetchStreetViewTile(env: Env, loc: { latitude?: number | null; longitude?: number | null }) {
  const key = env.GOOGLE_MAPS_KEY
  const lat = loc.latitude, lng = loc.longitude
  if (env.STREET_VIEW_ENABLED === 'false') return null
  if (!key || typeof lat !== 'number' || typeof lng !== 'number') return null
  // Where there is no coverage the image endpoint still answers 200 with a
  // grey "no imagery" placeholder. The (free) metadata endpoint says whether
  // a real panorama exists — never hand the placeholder to a reader.
  const meta = await fetch(
    `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&key=${key}`,
    { signal: AbortSignal.timeout(10000) },
  )
  if (!meta.ok || ((await meta.json()) as { status?: string }).status !== 'OK') return null
  const url = `https://maps.googleapis.com/maps/api/streetview?size=640x640&location=${lat},${lng}&key=${key}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) return null
  const mime = res.headers.get('content-type') ?? 'image/jpeg'
  if (!mime.startsWith('image/')) return null
  const buf = new Uint8Array(await res.arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192))
  return { base64: btoa(bin), content_type: mime }
}

export async function decisionsSubjectObservables(
  env: Env,
  input: {
    subject: Record<string, unknown>
    /** Satellite tile when available — prepended to the photo set. */
    satelliteImage?: { base64: string; content_type?: string } | null
    photoUrls: string[]
    coverPhotoUrl?: string | null
    description?: string | null
    benchmark: PocketBenchmark | null
    askPrice?: number | null
    askPpsf?: number | null
  },
): Promise<SubjectObservables | null> {
  if (!isDecisionsAvailable(env)) return null
  const started = Date.now()
  const urls = input.photoUrls.length > 0 ? input.photoUrls : (input.coverPhotoUrl ? [input.coverPhotoUrl] : [])
  const [sat, satClose, images, orientation] = await Promise.all([
    fetchSatelliteTile(env, input.subject).catch(() => null),
    fetchSatelliteTile(env, input.subject, 90).catch(() => null),
    fetchImagesAsBase64(urls, { concurrency: 10 }),
    fetchStreetOrientation(input.subject, env).catch(() => null),
  ])
  const satImg = sat ?? input.satelliteImage ?? null
  const photos = urls.map((u) => images.get(u)).filter((i): i is NonNullable<typeof i> => !!i)
  const satelliteImages = [
    ...(satImg ? [{ label: 'satellite aerial (wide ~600m)', content_type: satImg.content_type ?? 'image/png', base64: satImg.base64 }] : []),
    ...(satClose ? [{ label: 'satellite close-up (~180m — subject parcel centered)', content_type: satClose.content_type ?? 'image/png', base64: satClose.base64 }] : []),
  ]
  const askPos = input.askPpsf != null && input.benchmark ? positionFor(input.askPpsf, input.benchmark) : null

  // Condition read — listing photos + description only.
  const conditionState = {
    role: 'SUBJECT property — evaluate ONLY this property.',
    subject: input.subject,
    askingPrice: input.askPrice ?? null,
    askingPpsf: input.askPpsf ?? null,
    codePricePosition: askPos,
    matchedMarket: input.benchmark,
    description: input.description ?? null,
    imageOrder: ['listing photos'],
    doctrine: DECISIONS_DOCTRINE,
    rules: [
      'A price tier is not proof of renovation condition.',
      'Missing interior photographs do not prove that a property is dated.',
      'Marketing claims are evidence, not verified facts.',
      'Record confidence for every answer; confidence is not independent verification.',
    ],
  }
  // Satellite read — the aerials and the parcel's location facts only. No
  // listing photos, no description, no price.
  const satelliteState = {
    role: 'SUBJECT property — site and lot read from satellite imagery. Evaluate ONLY the parcel at the center of each frame.',
    subject: {
      address: input.subject.address ?? null,
      lotSizeAcres: input.subject.lotSizeAcres ?? null,
      latitude: input.subject.latitude ?? null,
      longitude: input.subject.longitude ?? null,
    },
    imageOrder: satelliteImages.map((i) => i.label),
  }

  const merged: DecisionsAnswers = {}
  const absorb = (answers: Record<string, unknown> | undefined) => {
    for (const [k, v] of Object.entries(answers ?? {})) {
      if (!(k in merged) || (typeof (v as { confidence?: number }).confidence === 'number' && ((v as { confidence?: number }).confidence! > ((merged[k] as { confidence?: number })?.confidence ?? 0)))) {
        merged[k] = v as DecisionsAnswers[string]
      }
    }
  }

  const satelliteRead = satelliteImages.length
    ? decisionsRun(env, {
        state: satelliteState,
        questions: SUBJECT_SATELLITE_QUESTIONS,
        images: satelliteImages.map(({ content_type, base64 }) => ({ content_type, base64 })),
      }).catch(() => null)
    : Promise.resolve(null)

  // 100% photo coverage — chunk past the image cap and merge answers
  // (condition questions read every chunk; price/description questions run
  // once on the first chunk's call).
  const chunks: typeof photos[] = []
  for (let i = 0; i < photos.length; i += DECISIONS_IMG_CAP) chunks.push(photos.slice(i, i + DECISIONS_IMG_CAP))
  if (chunks.length === 0) chunks.push([])
  for (let i = 0; i < chunks.length; i++) {
    const questions = i === 0
      ? SUBJECT_CONDITION_QUESTIONS
      : questionsWhere(SUBJECT_CONDITION_QUESTIONS, (k) => !k.startsWith('s6') && !k.startsWith('s5'))
    const res = await decisionsRun(env, {
      state: i === 0 ? conditionState : { ...conditionState, note: `photo chunk ${i + 1}/${chunks.length} — same subject, continue answering` },
      questions,
      images: chunks[i]!.map((im) => ({ content_type: im.mimeType, base64: im.base64 })),
    }).catch(() => null)
    absorb(res?.answers)
  }
  absorb((await satelliteRead)?.answers)
  if (Object.keys(merged).length === 0) return null

  return {
    overallCondition: choiceOf(merged, 's1_overall_condition'),
    renoEvidenceP: probOf(merged, 's2_reno_evidence'),
    repairLevel: choiceOf(merged, 's3_repair_level'),
    interiorDocQuality: choiceOf(merged, 's4_interior_quality'),
    descAgreement: choiceOf(merged, 's5_desc_agreement'),
    askPricePosition: askPos?.tier ?? null,
    askPriceSupport: choiceOf(merged, 's6_ask_price_support'),
    priceConditionAgreement: choiceOf(merged, 's7_price_condition'),
    lotPremium: choiceOf(merged, 's8_lot_premium'),
    lotPremiumProbabilities: {
      WATERFRONT: probOf(merged, 's8p_waterfront') ?? 0,
      CORNER_CULDESAC: probOf(merged, 's8p_culdesac_corner') ?? 0,
      OVERSIZED_LOT: probOf(merged, 's8p_oversized') ?? 0,
      POOL: probOf(merged, 's8p_pool') ?? 0,
    },
    siteExposure: (() => {
      // Edge predicates + code-computed street orientation resolve the side
      // when they fire — the choice answer stays the fallback for the frames
      // where the edges don't commit.
      const derived = deriveExposure(
        {
          north: probOf(merged, 's9e_north') ?? 0,
          east: probOf(merged, 's9e_east') ?? 0,
          south: probOf(merged, 's9e_south') ?? 0,
          west: probOf(merged, 's9e_west') ?? 0,
        },
        orientation,
      )
      return derived?.exposure ?? choiceOf(merged, 's9_site_exposure')
    })(),
    /** Edge-exposure probabilities + street orientation (audit trail). */
    siteEdges: {
      north: probOf(merged, 's9e_north'),
      east: probOf(merged, 's9e_east'),
      south: probOf(merged, 's9e_south'),
      west: probOf(merged, 's9e_west'),
      streetEdge: orientation?.streetEdge ?? null,
      streetBearingDeg: orientation?.bearingDeg ?? null,
    },
    // Set from the renovation assessment by applySubjectTierVerdict.
    renovationTier: null,
    renovationTierProbabilities: null,
    confidence: confs(merged),
    photosRead: photos.length,
    photosTotal: urls.length,
    imagesRead: [...satelliteState.imageOrder, ...(photos.length ? ['listing photos'] : [])],
    model: env.DECISIONS_MODEL || 'gpt-6-luna',
    durationMs: Date.now() - started,
  }
}

// ─── Comp call — cover photo + description + closed price + boundaries ───

export async function decisionsCompObservables(
  env: Env,
  input: {
    comp: Record<string, unknown>
    salePrice?: number | null
    ppsf?: number | null
    description?: string | null
    /** Pre-fetched cover image; falls back to coverPhotoUrl fetch. */
    coverImage?: { base64: string; content_type?: string } | null
    /** Every pre-fetched listing photo (cover first) — the condition read
     *  sees them all; the cover alone feeds the exterior match. */
    listingImages?: Array<{ base64: string; content_type?: string }> | null
    coverPhotoUrl?: string | null
    /** Comp coordinates for the satellite tile feeding c9. */
    latitude?: number | null
    longitude?: number | null
    /** Subject listing cover photo — reference image for the exterior
     *  match, fetched once per eval and shared across every comp call. */
    subjectCoverImage?: CoverImage | null
    /** Subject street-view image — c10 street-comparison mate. Fetched once
     *  per eval, shared across every comp call. */
    subjectStreetViewImage?: { base64: string; content_type?: string } | null
    /** Subject wide satellite aerial for the c12 development-vintage lane —
     *  fetched once per eval and shared across every comp call. */
    subjectSatelliteImage?: { base64: string; content_type?: string } | null
    subjectAddress?: string | null
    /** Subject's geo/physical fields — feeds the code-computed matchProfile. */
    subjectRef?: MatchLike
    benchmark: PocketBenchmark | null
  },
  /** Spec order split — the lane runs { site: false } (condition/cover/
   *  description, spec step 2); the seat runs { condition: false } (satellite
   *  premiums, street-view physical match, exterior match, spec step 5) after
   *  the TypeScript labels exist. Omit to run every phase. */
  phases?: { condition?: boolean; site?: boolean; street?: boolean },
): Promise<CompObservables | null> {
  if (!isDecisionsAvailable(env)) return null
  const wantCondition = phases?.condition !== false
  const wantSite = phases?.site !== false
  if (!wantCondition && !wantSite) return null
  const started = Date.now()
  const pos = input.ppsf != null && input.benchmark ? positionFor(input.ppsf, input.benchmark) : { tier: 'UNVERIFIED' as PriceTier, vsMedianPct: null }
  let img = input.listingImages?.[0] ?? input.coverImage ?? null
  if (!img && input.coverPhotoUrl) {
    const fetched = await fetchImageAsBase64(input.coverPhotoUrl).catch(() => null)
    if (fetched) img = { base64: fetched.base64, content_type: fetched.mimeType }
  }
  const listingImages = input.listingImages?.length ? input.listingImages : img ? [img] : []
  const wantStreet = wantSite && phases?.street !== false
  const [satImg, satCloseImg, streetImg] = wantSite
    ? await Promise.all([
        fetchSatelliteTile(env, { latitude: input.latitude ?? undefined, longitude: input.longitude ?? undefined }).catch(() => null),
        fetchSatelliteTile(env, { latitude: input.latitude ?? undefined, longitude: input.longitude ?? undefined }, 90).catch(() => null),
        wantStreet ? fetchStreetViewTile(env, { latitude: input.latitude, longitude: input.longitude }).catch(() => null) : Promise.resolve(null),
      ])
    : [null, null, null]
  type Labeled = { label: string; content_type?: string; base64: string }
  const listingSet: Labeled[] = listingImages.map((im, i) => ({
    label: i === 0 ? 'comp listing cover photo' : `comp listing photo ${i + 1}`,
    content_type: im.content_type, base64: im.base64,
  }))
  const satelliteSet: Labeled[] = [
    ...(satImg ? [{ label: 'comp satellite aerial (wide ~600m)', content_type: satImg.content_type, base64: satImg.base64 }] : []),
    ...(satCloseImg ? [{ label: 'comp satellite close-up (~180m — comp parcel centered)', content_type: satCloseImg.content_type, base64: satCloseImg.base64 }] : []),
    ...(input.subjectSatelliteImage ? [{ label: 'SUBJECT satellite aerial (wide ~600m — subject parcel centered)', content_type: input.subjectSatelliteImage.content_type, base64: input.subjectSatelliteImage.base64 }] : []),
  ]
  // Street comparison needs both houses; one street view alone compares nothing.
  const streetSet: Labeled[] = streetImg && input.subjectStreetViewImage
    ? [
        { label: 'comp street view', content_type: streetImg.content_type, base64: streetImg.base64 },
        { label: 'SUBJECT street view', content_type: input.subjectStreetViewImage.content_type, base64: input.subjectStreetViewImage.base64 },
      ]
    : []
  const payload = (set: Labeled[]) => set.map(({ content_type, base64 }) => ({ content_type, base64 }))

  // Condition read — listing photos + description + the code-computed
  // price position. No aerials, no street views.
  const conditionState = {
    role: 'COMPARABLE closed sale — evaluate ONLY this property.',
    comp: input.comp,
    closedSalePrice: input.salePrice ?? null,
    pricePerSqft: input.ppsf ?? null,
    codePricePosition: pos,
    matchedMarket: input.benchmark,
    matchProfile: compMatchProfile(input.subjectRef ?? {}, input.comp),
    description: input.description ?? null,
    imageOrder: listingSet.map((i) => i.label),
    doctrine: DECISIONS_DOCTRINE,
    rules: [
      'A price tier is not proof of renovation condition.',
      'A price outlier must be flagged when its premium cannot be explained.',
      'Do not automatically remove a comp because its price and condition disagree.',
      'Preserve disagreements between price position and condition evidence.',
      'Decisions classifies evidence. The appraiser selects comps and determines ARV.',
    ],
  }
  // Satellite read — the aerials and the parcel's lot facts only. No
  // listing photos, no description, no price.
  const satelliteState = {
    role: 'COMPARABLE property — site and lot read from satellite imagery. Evaluate the parcel at the center of the comp frames.',
    comp: {
      address: input.comp.address ?? null,
      lotSizeAcres: input.comp.lotSizeAcres ?? null,
      pool: input.comp.pool ?? null,
    },
    imageOrder: satelliteSet.map((i) => i.label),
  }
  const streetState = {
    role: 'Street-view comparison of a COMPARABLE with the SUBJECT — physical similarity only, never condition.',
    imageOrder: streetSet.map((i) => i.label),
  }

  // Cover photo vs cover photo — its own two-image call.
  const exteriorPromise = wantSite
    ? decisionsExteriorMatch(env, {
        subjectCover: input.subjectCoverImage,
        compCover: img,
        subjectAddress: input.subjectAddress ?? null,
        compAddress: (input.comp.address as string | undefined) ?? null,
      }).catch(() => null)
    : Promise.resolve(null)
  const [conditionRes, satelliteRes, streetRes, exterior] = await Promise.all([
    wantCondition
      ? decisionsRun(env, { state: conditionState, questions: COMP_CONDITION_QUESTIONS, images: payload(listingSet) }).catch(() => null)
      : null,
    wantSite && satelliteSet.length
      ? decisionsRun(env, { state: satelliteState, questions: COMP_SATELLITE_QUESTIONS, images: payload(satelliteSet) }).catch(() => null)
      : null,
    wantSite && streetSet.length
      ? decisionsRun(env, { state: streetState, questions: COMP_STREET_QUESTIONS, images: payload(streetSet) }).catch(() => null)
      : null,
    exteriorPromise,
  ])
  const a = {
    ...(conditionRes?.answers ?? {}),
    ...(satelliteRes?.answers ?? {}),
    ...(streetRes?.answers ?? {}),
  } as DecisionsAnswers
  if (Object.keys(a).length === 0) return null

  return {
    pricePosition: pos.tier,
    priceSupport: choiceOf(a, 'c1_price_support'),
    codePosition: pos.tier,
    descCondition: choiceOf(a, 'c2_desc_condition'),
    coverPhotoEvidence: choiceOf(a, 'c3_cover_evidence'),
    renoClaimP: probOf(a, 'c4_reno_claim'),
    priceConditionAgreement: choiceOf(a, 'c5_price_condition'),
    unexplainedPremiumP: probOf(a, 'c6_unexplained_premium'),
    finalTier: choiceOf(a, 'c7_final_tier'),
    premiumAttributes: choiceOf(a, 'c8_premium_attributes'),
    premiumProbabilities: choiceProbs(a, 'c8_premium_attributes') ?? {
      WATERFRONT: probOf(a, 'c8p_waterfront') ?? 0,
      CORNER_CULDESAC: probOf(a, 'c8p_culdesac_corner') ?? 0,
      LARGE_LOT: probOf(a, 'c8p_large_lot') ?? 0,
      VIEW: probOf(a, 'c8p_view') ?? 0,
      POOL: probOf(a, 'c8p_pool') ?? 0,
    },
    sitePredicates: {
      backsBusyRoad: probOf(a, 'sp_backs_busy_road'),
      frontsBusyRoad: probOf(a, 'sp_fronts_busy_road'),
      sidesBusyRoad: probOf(a, 'sp_sides_busy_road'),
      commercial: probOf(a, 'sp_commercial'),
      cornerLot: probOf(a, 'sp_corner_lot'),
      culdesac: probOf(a, 'sp_culdesac'),
      infillLot: probOf(a, 'sp_infill_lot'),
      waterfront: probOf(a, 'sp_waterfront'),
      lakefront: probOf(a, 'sp_lakefront'),
      riverfront: probOf(a, 'sp_riverfront'),
    },
    siteExposure: choiceOf(a, 'c9_site_exposure'),
    developmentVintage: choiceOf(a, 'c12_development_vintage'),
    conditionTier: choiceOf(a, 'c13_condition_tier'),
    conditionTierProbabilities: tierProbsOf(a, 'c13_condition_tier'),
    physicalMatchP: probOf(a, 'c10_physical_match'),
    exteriorMatchP: exterior?.matchP ?? null,
    coverIsFrontP: exterior?.compCoverIsFrontP ?? null,
    subjectCoverIsFrontP: exterior?.subjectCoverIsFrontP ?? null,
    arvFitnessP: probOf(a, 'c11_arv_fitness'),
    confidence: confs(a),
    imagesRead: [...conditionState.imageOrder, ...satelliteState.imageOrder, ...streetState.imageOrder],
    model: env.DECISIONS_MODEL || 'gpt-6-luna',
    durationMs: Date.now() - started,
  }
}
