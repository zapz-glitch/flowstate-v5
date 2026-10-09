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
    instructions: 'From the aerial/satellite image and photographs, does the SUBJECT sit on a premium lot? Satellite imagery counts as evidence — look for waterfront, oversized or corner lots, cul-de-sac position, or a visible pool.',
  },
  s9_site_exposure: {
    type: 'choice' as const,
    criteria: { FRONTING: 'fronts a busy road, arterial, or commercial', SIDING: 'sides a busy road, arterial, or commercial', BACKING: 'backs a busy road, commercial, freeway, or rail', NEUTRAL: 'typical interior residential setting', UNVERIFIED: 'imagery insufficient to tell' },
    instructions: 'From the aerial/satellite image (roads and business labels are overlaid), does the SUBJECT have adverse site exposure? Pick the exposure SIDE: fronting = busy road/commercial on the street side, siding = on a side edge, backing = behind the lot. Interior residential lots are NEUTRAL.',
  },
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
    instructions: 'Is this COMP priced substantially above similar neighborhood sales without visible, descriptive, or property-feature evidence that reasonably explains the premium?',
  },
  c7_final_tier: {
    type: 'choice' as const, criteria: TIER_CHOICES,
    instructions: 'Using the supplied price distribution as the primary evidence, assign the COMP to its market price tier. Consider property condition, physical differences, and evidence conflicts. Do not change a verified price-position fact merely because the property appears renovated or dated. Preserve disagreements between price position and condition evidence for the final appraiser.',
  },
  c8_premium_attributes: {
    type: 'choice' as const,
    criteria: { WATERFRONT: 'waterfront or water-adjacent', LARGE_LOT: 'notably larger lot than neighbors', CORNER_CULDESAC: 'corner or cul-de-sac lot', VIEW: 'view premium (golf, water, skyline)', POOL: 'pool present', NONE: 'no premium attribute evident', UNVERIFIED: 'evidence insufficient' },
    instructions: "Does the description, cover photo, or supplied property data indicate a premium lot attribute that could explain a price premium — waterfront, oversized/corner lot, cul-de-sac, view, or pool? Pick the strongest single attribute; NONE if none is evident. This explains non-condition price premiums.",
  },
  c9_site_exposure: {
    type: 'choice' as const,
    criteria: { FRONTING: 'fronts a busy road, arterial, or commercial', SIDING: 'sides a busy road, arterial, or commercial', BACKING: 'backs a busy road, commercial, freeway, or rail', NEUTRAL: 'typical interior residential setting', UNVERIFIED: 'imagery insufficient or unavailable' },
    instructions: 'When a satellite image is supplied (roads/business labels overlaid), does the COMP have adverse site exposure? Pick the exposure SIDE: fronting = busy road/commercial on the street side, siding = side edge, backing = behind the lot. UNVERIFIED when no satellite image is present; do not infer exposure from price or description alone.',
  },
  c10_physical_match: {
    type: 'noul' as const,
    instructions: 'When street-view images are supplied (the SUBJECT street view comes LAST), score the probability that the COMP is a physical match to the subject — architectural style, stories, garage layout, curb appeal. Judge physical similarity ONLY, never condition — street view cannot verify condition. Score low when images are absent or the styles clearly differ.',
  },
  c11_arv_fitness: {
    type: 'noul' as const,
    instructions: 'Score the probability that this COMP represents a finished, renovated, or move-in-ready version of the subject property — an ARV-grade sale. Highest scores: newly renovated or flipper-complete listings (description emphasizes new this, new that). Around 70-80: move-in ready, lived-in condition with updated big-ticket items. Lowest scores: investor sales or listings needing full renovation — fixer upper, TLC, sweat equity, bring your vision, as-is keywords.',
  },
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
  /** Adverse site exposure from satellite (arterial/commercial/freeway). */
  siteExposure: string | null
  confidence: Record<string, number>
  photosRead: number
  photosTotal: number
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
  /** Adverse site exposure from satellite (arterial/commercial/freeway). */
  siteExposure: string | null
  /** P(comp is a physical match to the subject) — street view lane. */
  physicalMatchP: number | null
  /** P(comp is a finished/renovated/move-in-ready version of the subject) —
   *  ARV-fitness ladder: flipper-complete highest, maintained ~70-80s,
   *  fixer/investor lowest. */
  arvFitnessP: number | null
  confidence: Record<string, number>
  model: string
  durationMs: number
}

type DecisionsAnswers = Record<string, { probability?: number; choice?: string | boolean | null; score?: number; confidence?: number }>
const choiceOf = (a: DecisionsAnswers, k: string): string | null =>
  typeof a[k]?.choice === 'string' ? (a[k]!.choice as string) : null
const probOf = (a: DecisionsAnswers, k: string): number | null =>
  typeof a[k]?.probability === 'number' ? a[k]!.probability! : null
const confs = (a: DecisionsAnswers): Record<string, number> =>
  Object.fromEntries(Object.entries(a).filter(([, v]) => typeof v?.confidence === 'number').map(([k, v]) => [k, v.confidence!]))

// ─── Subject call — every listing photo (100% coverage), chunked past the
//     API's 128-image cap; empty sets fall back to the cover photo. ───────

const DECISIONS_IMG_CAP = 128

/** Satellite tile for the subject — Google Maps Static API, aerial view
 *  feeds the s8 lot-premium question. Null when the key/coords/fetch miss. */
async function fetchSatelliteTile(env: Env, subject: Record<string, unknown>) {
  const key = env.GOOGLE_MAPS_KEY
  const lat = subject.latitude ?? subject.lat, lng = subject.longitude ?? subject.lng
  if (!key || typeof lat !== 'number' || typeof lng !== 'number') return null
  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=18&size=640x640&maptype=hybrid&key=${key}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) return null
  const mime = res.headers.get('content-type') ?? 'image/png'
  if (!mime.startsWith('image/')) return null
  const buf = new Uint8Array(await res.arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192))
  return { base64: btoa(bin), content_type: mime }
}

/** Curb-level Street View image for the physical-similarity lane — subject
 *  fetched once per eval by the caller; comps fetched per call. Returns null
 *  when Street View Static is unavailable or the coverage is missing. */
export async function fetchStreetViewTile(env: Env, loc: { latitude?: number | null; longitude?: number | null }) {
  const key = env.GOOGLE_MAPS_KEY
  const lat = loc.latitude, lng = loc.longitude
  if (!key || typeof lat !== 'number' || typeof lng !== 'number') return null
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
  const [sat, street, images] = await Promise.all([
    fetchSatelliteTile(env, input.subject).catch(() => null),
    fetchStreetViewTile(env, { latitude: input.subject.latitude as number | null ?? null, longitude: input.subject.longitude as number | null ?? null }).catch(() => null),
    fetchImagesAsBase64(urls, { concurrency: 10 }),
  ])
  const satImg = sat ?? input.satelliteImage ?? null
  const imgs = [
    ...(satImg ? [{ mimeType: satImg.content_type ?? 'image/png', base64: satImg.base64 }] : []),
    ...(street ? [{ mimeType: street.content_type ?? 'image/jpeg', base64: street.base64 }] : []),
    ...urls.map((u) => images.get(u)).filter((i): i is NonNullable<typeof i> => !!i),
  ]
  const askPos = input.askPpsf != null && input.benchmark ? positionFor(input.askPpsf, input.benchmark) : null

  const state = {
    role: 'SUBJECT property — evaluate ONLY this property.',
    subject: input.subject,
    askingPrice: input.askPrice ?? null,
    askingPpsf: input.askPpsf ?? null,
    codePricePosition: askPos,
    matchedMarket: input.benchmark,
    description: input.description ?? null,
    imageOrder: [
      ...(satImg ? ['satellite aerial'] : []),
      ...(street ? ['street view (curb-level)'] : []),
      'listing photos',
    ],
    doctrine: DECISIONS_DOCTRINE,
    rules: [
      'A price tier is not proof of renovation condition.',
      'Missing interior photographs do not prove that a property is dated.',
      'Marketing claims are evidence, not verified facts.',
      'Street view judges physical similarity only — never condition.',
      'Record confidence for every answer; confidence is not independent verification.',
    ],
  }

  // 100% coverage — chunk past the image cap and merge answers (condition
  // questions read every chunk; price/description questions run once on
  // the first chunk's call).
  const chunks: typeof imgs[] = []
  for (let i = 0; i < imgs.length; i += DECISIONS_IMG_CAP) chunks.push(imgs.slice(i, i + DECISIONS_IMG_CAP))
  if (chunks.length === 0) chunks.push([])

  const merged: DecisionsAnswers = {}
  for (let i = 0; i < chunks.length; i++) {
    const questions = i === 0
      ? SUBJECT_QUESTIONS
      : Object.fromEntries(Object.entries(SUBJECT_QUESTIONS).filter(([k]) => !k.startsWith('s6') && !k.startsWith('s5')))
    const res = await decisionsRun(env, {
      state: i === 0 ? state : { ...state, note: `photo chunk ${i + 1}/${chunks.length} — same subject, continue answering` },
      questions,
      images: chunks[i]!.map((im) => ({ content_type: im.mimeType, base64: im.base64 })),
    }).catch(() => null)
    for (const [k, v] of Object.entries(res?.answers ?? {})) {
      if (!(k in merged) || (typeof (v as { confidence?: number }).confidence === 'number' && ((v as { confidence?: number }).confidence! > ((merged[k] as { confidence?: number })?.confidence ?? 0)))) {
        merged[k] = v as DecisionsAnswers[string]
      }
    }
  }
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
    siteExposure: choiceOf(merged, 's9_site_exposure'),
    confidence: confs(merged),
    photosRead: imgs.length,
    photosTotal: urls.length,
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
    coverPhotoUrl?: string | null
    /** Comp coordinates for the satellite tile feeding c9. */
    latitude?: number | null
    longitude?: number | null
    /** Subject street-view image for the c10 physical-similarity lane —
     *  fetched once per eval and shared across every comp call. */
    subjectStreetViewImage?: { base64: string; content_type?: string } | null
    benchmark: PocketBenchmark | null
  },
): Promise<CompObservables | null> {
  if (!isDecisionsAvailable(env)) return null
  const started = Date.now()
  const pos = input.ppsf != null && input.benchmark ? positionFor(input.ppsf, input.benchmark) : { tier: 'UNVERIFIED' as PriceTier, vsMedianPct: null }
  let img = input.coverImage ?? null
  if (!img && input.coverPhotoUrl) {
    const fetched = await fetchImageAsBase64(input.coverPhotoUrl).catch(() => null)
    if (fetched) img = { base64: fetched.base64, content_type: fetched.mimeType }
  }
  const [satImg, streetImg] = await Promise.all([
    fetchSatelliteTile(env, { latitude: input.latitude ?? undefined, longitude: input.longitude ?? undefined }).catch(() => null),
    fetchStreetViewTile(env, { latitude: input.latitude, longitude: input.longitude }).catch(() => null),
  ])

  const state = {
    role: 'COMPARABLE closed sale — evaluate ONLY this property.',
    comp: input.comp,
    closedSalePrice: input.salePrice ?? null,
    pricePerSqft: input.ppsf ?? null,
    codePricePosition: pos,
    matchedMarket: input.benchmark,
    description: input.description ?? null,
    imageOrder: [
      ...(img ? ['comp listing cover photo'] : []),
      ...(satImg ? ['comp satellite aerial'] : []),
      ...(streetImg ? ['comp street view'] : []),
      ...(input.subjectStreetViewImage ? ['SUBJECT street view'] : []),
    ],
    doctrine: DECISIONS_DOCTRINE,
    rules: [
      'A price tier is not proof of renovation condition.',
      'A price outlier must be flagged when its premium cannot be explained.',
      'Do not automatically remove a comp because its price and condition disagree.',
      'Preserve disagreements between price position and condition evidence.',
      'Street view judges physical similarity only — never condition.',
      'Decisions classifies evidence. The appraiser selects comps and determines ARV.',
    ],
  }
  const res = await decisionsRun(env, {
    state,
    questions: COMP_QUESTIONS,
    images: [
      ...(img ? [{ content_type: img.content_type, base64: img.base64 }] : []),
      ...(satImg ? [{ content_type: satImg.content_type, base64: satImg.base64 }] : []),
      ...(streetImg ? [{ content_type: streetImg.content_type, base64: streetImg.base64 }] : []),
      ...(input.subjectStreetViewImage ? [{ content_type: input.subjectStreetViewImage.content_type, base64: input.subjectStreetViewImage.base64 }] : []),
    ],
  }).catch(() => null)
  const a = (res?.answers ?? {}) as DecisionsAnswers
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
    siteExposure: choiceOf(a, 'c9_site_exposure'),
    physicalMatchP: probOf(a, 'c10_physical_match'),
    arvFitnessP: probOf(a, 'c11_arv_fitness'),
    confidence: confs(a),
    model: env.DECISIONS_MODEL || 'gpt-6-luna',
    durationMs: Date.now() - started,
  }
}
