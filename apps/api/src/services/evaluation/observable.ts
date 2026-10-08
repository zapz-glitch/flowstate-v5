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
    instructions: "Based on all available property photos and the listing description, which condition best describes the SUBJECT?",
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
  s6_ask_price_position: {
    type: 'choice' as const, criteria: TIER_CHOICES,
    instructions: "Compare the SUBJECT's current asking price per square foot with the supplied matched-neighborhood price distribution. Which market price tier does the asking price occupy? This measures asking-price position only — it does not establish market value or ARV.",
  },
  s7_price_condition: {
    type: 'choice' as const,
    criteria: { SUPPORTS: 'condition supports the asking-price position', PRICE_APPEARS_HIGH: 'asking appears high for the observed condition', PRICE_APPEARS_LOW: 'asking appears low for the observed condition', INSUFFICIENT: 'cannot tell' },
    instructions: "Does the SUBJECT's observed condition reasonably support its asking-price position relative to similar neighborhood properties?",
  },
}

const COMP_QUESTIONS = {
  c1_price_position: {
    type: 'choice' as const, criteria: TIER_CHOICES,
    instructions: "Compare the COMP's closed sale price per square foot with the supplied matched-neighborhood price distribution. Which tier does this sale occupy? Use the supplied price boundaries. Do not calculate new boundaries.",
  },
  c2_desc_condition: {
    type: 'choice' as const, criteria: COND_CHOICES,
    instructions: 'What property condition does the listing description support? Do not infer renovation from the sale price.',
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
}

// ─── Answer shapes ───────────────────────────────────────────────────────

export interface SubjectObservables {
  overallCondition: string | null
  renoEvidenceP: number | null
  repairLevel: string | null
  interiorDocQuality: string | null
  descAgreement: string | null
  askPricePosition: string | null
  priceConditionAgreement: string | null
  confidence: Record<string, number>
  photosRead: number
  photosTotal: number
  model: string
  durationMs: number
}

export interface CompObservables {
  pricePosition: string | null
  codePosition: PriceTier
  descCondition: string | null
  coverPhotoEvidence: string | null
  renoClaimP: number | null
  priceConditionAgreement: string | null
  unexplainedPremiumP: number | null
  finalTier: string | null
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

export async function decisionsSubjectObservables(
  env: Env,
  input: {
    subject: Record<string, unknown>
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
  const images = await fetchImagesAsBase64(urls, { concurrency: 10 })
  const imgs = urls.map((u) => images.get(u)).filter((i): i is NonNullable<typeof i> => !!i)
  const askPos = input.askPpsf != null && input.benchmark ? positionFor(input.askPpsf, input.benchmark) : null

  const state = {
    role: 'SUBJECT property — evaluate ONLY this property.',
    subject: input.subject,
    askingPrice: input.askPrice ?? null,
    askingPpsf: input.askPpsf ?? null,
    codePricePosition: askPos,
    matchedMarket: input.benchmark,
    description: input.description ?? null,
    rules: [
      'A price tier is not proof of renovation condition.',
      'Missing interior photographs do not prove that a property is dated.',
      'Marketing claims are evidence, not verified facts.',
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
    askPricePosition: choiceOf(merged, 's6_ask_price_position'),
    priceConditionAgreement: choiceOf(merged, 's7_price_condition'),
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

  const state = {
    role: 'COMPARABLE closed sale — evaluate ONLY this property.',
    comp: input.comp,
    closedSalePrice: input.salePrice ?? null,
    pricePerSqft: input.ppsf ?? null,
    codePricePosition: pos,
    matchedMarket: input.benchmark,
    description: input.description ?? null,
    rules: [
      'A price tier is not proof of renovation condition.',
      'A price outlier must be flagged when its premium cannot be explained.',
      'Do not automatically remove a comp because its price and condition disagree.',
      'Preserve disagreements between price position and condition evidence.',
      'Decisions classifies evidence. The appraiser selects comps and determines ARV.',
    ],
  }
  const res = await decisionsRun(env, {
    state,
    questions: COMP_QUESTIONS,
    images: img ? [{ content_type: img.content_type, base64: img.base64 }] : [],
  }).catch(() => null)
  const a = (res?.answers ?? {}) as DecisionsAnswers
  if (Object.keys(a).length === 0) return null

  return {
    pricePosition: choiceOf(a, 'c1_price_position'),
    codePosition: pos.tier,
    descCondition: choiceOf(a, 'c2_desc_condition'),
    coverPhotoEvidence: choiceOf(a, 'c3_cover_evidence'),
    renoClaimP: probOf(a, 'c4_reno_claim'),
    priceConditionAgreement: choiceOf(a, 'c5_price_condition'),
    unexplainedPremiumP: probOf(a, 'c6_unexplained_premium'),
    finalTier: choiceOf(a, 'c7_final_tier'),
    confidence: confs(a),
    model: env.DECISIONS_MODEL || 'gpt-6-luna',
    durationMs: Date.now() - started,
  }
}
