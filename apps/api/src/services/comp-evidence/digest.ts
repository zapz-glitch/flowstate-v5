/**
 * Clef comp digests — the agent-assist layer that runs at each pipeline
 * stage where the harness itself does work. Three passes, all advisory:
 *
 *   A (comps land)   — sale-record read: prelim band, twin fit on
 *                      size/year/lot, price sanity. Runs beside the
 *                      listing fetch, no listing data yet.
 *   B (post-geocode) — same read + geography: block-group / tract /
 *                      neighborhood fit against the ruleset's geo ladder.
 *   C (post-enrich)  — full read on enriched comps: final band, bracket
 *                      role (smaller/larger twin per §7), anchor strength.
 *
 * Each pass is a text-only Clef call per comp (no images — photos ride the
 * curb-appeal evidence call), lane-fanned like the evidence batch. The
 * Evaluation Agent reads these as margin notes next to the raw fields;
 * it owns the verdict and can overrule every one.
 */

import type { Env } from '../../types'
import type { Question } from '../clef'

export type DigestStage = 'A' | 'B' | 'C'

export interface DigestComp {
  propertyId: string
  address?: string
  salePrice?: number
  saleDate?: string
  squareFeet?: number
  pricePerSqft?: number
  yearBuilt?: number
  lotSizeAcres?: number | null
  lotSizeSquareFeet?: number | null
  distanceMiles?: number | null
  bedrooms?: number | null
  bathrooms?: number | null
  propertyType?: string | null
  stories?: number | null
  construction?: string | null
  subdivision?: string | null
  neighborhoodName?: string | null
  censusTract?: string | null
  censusBlockGroup?: string | null
  sameBlockGroup?: boolean | null
  crossesMajorRoad?: boolean | null
  isEnriched?: boolean | null
  /** Prior-stage digests + listing condition evidence, when present (stage C). */
  priorDigest?: { band?: string | null; twinFit?: string | null } | null
  conditionSummary?: string | null
}

export interface DigestSubject {
  address?: string
  squareFeet?: number | null
  yearBuilt?: number | null
  lotSizeAcres?: number | null
  propertyType?: string | null
  stories?: number | null
  pool?: boolean | null
  censusTract?: string | null
  censusBlockGroup?: string | null
  subdivision?: string | null
  neighborhoodName?: string | null
}

export type CompDigestStages = { A?: CompDigest; B?: CompDigest; C?: CompDigest }

export interface CompDigest {
  band: 'as_is' | 'median' | 'arv' | 'outlier' | null
  twinFit: 'twin' | 'close' | 'moderate' | 'poor' | null
  priceSanity: 'plausible' | 'suspicious' | 'data_error' | null
  geoFit: 'block_group' | 'same_pocket' | 'adjacent' | 'distant' | null
  bracketRole: 'smaller_twin' | 'larger_twin' | 'size_matched' | 'poor_fit' | null
  anchorQuality: 'strong_anchor' | 'supporting' | 'weak' | 'reject' | null
  stage: DigestStage
  probabilities: Record<string, Record<string, number>>
  durationMs: number
}

const BAND_Q: Record<string, Question> = {
  band: {
    type: 'choice',
    instructions:
      'Place this comparable sale in its evidence band — the bucket an ' +
      'appraiser groups it into for ARV work. Price position is king: a ' +
      'distressed sale at top-of-market price is not AS-IS evidence.',
    criteria: {
      as_is: 'Distressed, investment-grade, or fixer price point — what investors pay for ugly houses',
      median: 'Lived-in move-in-ready stock at mid-market price — maintained/updated, no renovation premium',
      arv: 'Clearly renovated sale at top-of-pocket price — forced appreciation evidence',
      outlier: 'Lot sale, intra-family/package transfer, or unexplained price far above the renovated band',
    },
  },
  twin_fit: {
    type: 'choice',
    instructions:
      'How close a physical twin is this comp to the subject? Weigh living ' +
      'area (±250-500sf preferred, ±25% hard cliff), year built (±10yr ' +
      'preferred), lot size, style/stories and bed/bath counts where known. ' +
      'Missing fields count as unknown — never a penalty.',
    criteria: {
      twin: 'Near-identical spec — same style, size within ~250sf, same era',
      close: 'Strong match — within the preferred size/year bands with minor gaps',
      moderate: 'Usable with adjustments — outside preferred bands but same genre',
      poor: 'Wrong genre — extreme size/era/style mismatch vs the subject',
    },
  },
  price_sanity: {
    type: 'choice',
    instructions:
      'Is the recorded sale price plausible for this property at its size? ' +
      'Flag obvious feed errors — stray digits, absurd $/sqft, prices ' +
      'inconsistent with the sale record itself.',
    criteria: {
      plausible: 'Price consistent with size and market',
      suspicious: 'Price high or low for its size — possibly non-arm\'s-length',
      data_error: 'Price almost certainly wrong — typo or feed artifact',
    },
  },
}

const GEO_Q: Record<string, Question> = {
  geo_fit: {
    type: 'choice',
    instructions:
      'Judge this comp\'s geographic evidence tier against the subject. ' +
      'Block-group matches are the strongest evidence; same tract or ' +
      'neighborhood-name shares are the fallback band; adjacent pockets ' +
      'carry a heavier accuracy discount; anything farther is weakest.',
    criteria: {
      block_group: 'Shares the subject\'s census block group — highest-likelihood match',
      same_pocket: 'Same tract/neighborhood/subdivision — similar values and proximity',
      adjacent: 'Adjacent pocket — usable only when the subject\'s pocket is empty',
      distant: 'Outside the pocket — heaviest discount',
    },
  },
}

const BRACKET_Q: Record<string, Question> = {
  bracket_role: {
    type: 'choice',
    instructions:
      'For the ARV bracket (Section 7: at least one comp smaller and one ' +
      'larger than the subject\'s GLA), what role could this comp play in ' +
      'the selected set? Judge size against the subject only.',
    criteria: {
      smaller_twin: 'Smaller than the subject\'s GLA — fills the lower bracket',
      larger_twin: 'Larger than the subject\'s GLA — fills the upper bracket',
      size_matched: 'Within ±10% of the subject\'s GLA — a core comp, not a bracket filler',
      poor_fit: 'Size so far off (>±25%) it should not be used even adjusted',
    },
  },
  anchor_quality: {
    type: 'choice',
    instructions:
      'With the full record — geography, enriched detail, and any prior ' +
      'digests — how strong is this sale as ARV evidence for the subject? ' +
      'A comp can only anchor when its band is arv or top-median AND it is ' +
      'a reasonable twin AND its geography is block_group/same_pocket.',
    criteria: {
      strong_anchor: 'Excellent ARV evidence — twin spec, right band, right pocket',
      supporting: 'Usable supporting evidence — some gaps but same market band',
      weak: 'Marginal — meaningful mismatch on size, geo, or band',
      reject: 'Not ARV evidence — outlier, data error, or wrong market',
    },
  },
}

const STAGE_QUESTIONS: Record<DigestStage, Record<string, Question>> = {
  A: BAND_Q,
  B: { ...BAND_Q, ...GEO_Q },
  C: { ...BAND_Q, ...GEO_Q, ...BRACKET_Q },
}

function choicePick<T extends string>(v: unknown, keys: readonly T[]): { pick: T | null; probabilities: Record<string, number> } {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const probs = (o.probabilities ?? {}) as Record<string, number>
  let pick = typeof o.choice === 'string' ? o.choice : null
  if (!pick || !(keys as readonly string[]).includes(pick)) {
    let best = -1
    pick = null
    for (const k of keys) {
      const p = probs[k]
      if (typeof p === 'number' && p > best) { best = p; pick = k }
    }
  }
  return { pick: pick as T | null, probabilities: probs }
}

export async function assessCompDigest(
  env: Env,
  comp: DigestComp,
  subject: DigestSubject,
  stage: DigestStage,
): Promise<CompDigest | null> {
  if (!env.AI) return null
  const model = env.CLEF_MODEL === 'clef' ? 'clef' : 'clef-flash'
  const started = Date.now()
  const res = (await env.AI.run(`@cf/cloudflare/${model}`, {
    model,
    state: {
      subject: `Stage-${stage} comparable digest — advisory pre-read for the appraisal Evaluation Agent.`,
      appraisalSubject: subject,
      comparable: comp,
    },
    questions: STAGE_QUESTIONS[stage],
  }).catch(() => null)) as { answers?: Record<string, unknown> } | null
  const answers = res?.answers
  if (!answers) return null
  const band = choicePick(answers.band, ['as_is', 'median', 'arv', 'outlier'] as const)
  const twin = choicePick(answers.twin_fit, ['twin', 'close', 'moderate', 'poor'] as const)
  const sanity = choicePick(answers.price_sanity, ['plausible', 'suspicious', 'data_error'] as const)
  const geo = choicePick(answers.geo_fit, ['block_group', 'same_pocket', 'adjacent', 'distant'] as const)
  const bracket = choicePick(answers.bracket_role, ['smaller_twin', 'larger_twin', 'size_matched', 'poor_fit'] as const)
  const anchor = choicePick(answers.anchor_quality, ['strong_anchor', 'supporting', 'weak', 'reject'] as const)
  return {
    band: band.pick,
    twinFit: twin.pick,
    priceSanity: sanity.pick,
    geoFit: geo.pick,
    bracketRole: bracket.pick,
    anchorQuality: anchor.pick,
    stage,
    probabilities: {
      band: band.probabilities,
      twin_fit: twin.probabilities,
      price_sanity: sanity.probabilities,
      geo_fit: geo.probabilities,
      bracket_role: bracket.probabilities,
      anchor_quality: anchor.probabilities,
    },
    durationMs: Date.now() - started,
  }
}

/** Lane-fanned digest batch — same shape as the evidence batch, text-only
 *  calls so per-comp timeout can be tighter. */
export async function startCompDigestBatch(
  env: Env,
  comps: DigestComp[],
  subject: DigestSubject,
  stage: DigestStage,
  opts?: { lanes?: number; perCompTimeoutMs?: number; globalDeadlineMs?: number },
): Promise<Map<string, CompDigest>> {
  const out = new Map<string, CompDigest>()
  const perComp = opts?.perCompTimeoutMs ?? 15_000
  const deadline = opts?.globalDeadlineMs ?? 60_000
  const laneCount = Math.min(opts?.lanes ?? 15, comps.length)
  let next = 0
  const lane = async () => {
    while (next < comps.length) {
      const comp = comps[next++]
      const d = await Promise.race([
        assessCompDigest(env, comp, subject, stage),
        new Promise<null>((r) => setTimeout(() => r(null), perComp)),
      ]).catch(() => null)
      if (d) out.set(comp.propertyId, d)
    }
  }
  await Promise.race([
    Promise.all(Array.from({ length: laneCount }, lane)),
    new Promise((r) => setTimeout(r, deadline)),
  ])
  return out
}
