/**
 * Clef decision-model client (Workers AI).
 *
 * @cf/cloudflare/clef is a 27B multimodal decision model: it reads a state
 * (text/JSON/images) plus a schema of typed questions and returns a
 * probability for every allowed option. Jev-API-compatible shape, but
 * hosted on Workers AI with a vision encoder — so one schema-bound call
 * classifies a comp's condition from BOTH curb-appeal photos and the
 * listing description (the appraiser-evidence constraint).
 *
 * Pricing: $0.24/M input tokens — comp calls use clef-flash by default
 * (fast 9B variant, ~39ms median) since they run per-comp inside the
 * pipeline; CLEF_MODEL can promote to the 27B model.
 */

import type { Env } from '../../types'
import { decisionsRun } from '../decisions'

// Workers-AI reader names, the legacy OpenRouter lane, or whichever
// reasoning model answered (e.g. 'claude-haiku-5-5' via Anthropic).
export type ClefModel = 'clef' | 'clef-flash' | 'openai/gpt-6-luna' | (string & {})

export interface ClefImage {
  content_type: 'image/png' | 'image/jpeg' | 'image/webp'
  base64: string
}

export type Question =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }

export interface CompConditionInput {
  address: string
  salePrice?: number
  saleDate?: string
  /** Agent-written listing description persisted post-sale */
  description?: string
  /** "What's special" highlights and listed features */
  whatsSpecial?: string[]
  features?: string[]
  yearBuilt?: number
  squareFeet?: number
  /** Embedded curb-appeal/listing photos (max 4, ≤4MiB each) */
  images?: ClefImage[]
  /** Subject context for the anchor-quality question — the agent reads the
   *  answer as a pre-digested hint, never as a verdict. */
  subject?: { squareFeet?: number; address?: string }
}

export type CompTier = 'investor' | 'median' | 'arv'

export interface CompHint {
  priceSanity: 'plausible' | 'suspicious' | 'data_error' | null
  anchorQuality: 'strong_anchor' | 'supporting' | 'weak' | 'reject' | null
  probabilities: {
    price_sanity?: Record<string, number>
    anchor_quality?: Record<string, number>
  }
}

export interface CompConditionResult {
  /** The model's answer set, verbatim — useful for calibration forensics */
  raw: Record<string, unknown>
  renovated: boolean
  renovatedProbability: number
  asIs: boolean
  asIsProbability: number
  /** Probability the listing is marketed to investors ("investment property", "rental income", "tenant occupied", …) */
  investorLanguageProbability: number
  /** Comp-selection tier the model places the sale in — separate axis from physical condition */
  tier: CompTier
  tierProbabilities: Record<CompTier, number>
  /** Weighted score on the 0–4 condition scale */
  conditionScore: number
  /** Argmax bucket label — 'Poor' | 'Dated' | 'Maintained' | 'Updated' | 'Renovated' */
  conditionLabel: string
  /** Clef's reported confidence in the score answer, when present */
  confidence?: number
  /** Agent-assist digest — advisory pre-read the Evaluation Agent weighs
   *  next to the raw data; never a verdict by itself. */
  hint?: CompHint
  model: ClefModel
  modelVersion: string
  durationMs: number
}

export const CONDITION_SCALE = [
  'Poor — major deferred maintenance or obvious fixer condition',
  'Dated — original finishes, functional but visibly dated',
  'Maintained — typical owner-occupied condition, minor wear',
  'Updated — refreshed finishes, newer kitchen/bath or major systems',
  'Renovated — comprehensively remodeled for sale',
] as const

const CONDITION_QUESTIONS: Record<string, Question> = {
  renovated: {
    type: 'noul',
    instructions:
      'Does the listing description or the photos show this property was ' +
      'renovated, remodeled, or meaningfully updated for sale? Signals: ' +
      '"renovated"/"updated"/"remodeled"/"new roof"/"new kitchen" language, ' +
      'or photos showing visibly new finishes.',
  },
  as_is: {
    type: 'noul',
    instructions:
      'Is the property described or shown as sold as-is, a fixer-upper, ' +
      '"needs TLC", investor/handyman special, or showing significant ' +
      'deferred maintenance in the photos?',
  },
  condition: {
    type: 'score',
    instructions:
      'Rate the property\'s overall condition at the time of sale, weighing ' +
      'the listing description and the curb-appeal/listing photos as a human ' +
      'appraiser would.',
    criteria: [...CONDITION_SCALE],
  },
  investor_language: {
    type: 'noul',
    instructions:
      'Does the listing description market this property to investors ' +
      'rather than owner-occupants? Signals: "investment property", ' +
      '"investor special", "rental income", "cash flow", "tenant occupied", ' +
      '"turnkey rental", "add to your portfolio", "great rental".',
  },
  // Tier is the comp-SELECTION axis (mirrors the numerical sale tiers):
  // an investor-marketed listing can't be ARV evidence no matter how
  // updated it looks — the description tells you who the sale was for.
  tier: {
    type: 'choice',
    instructions:
      'Which sale tier does this comp belong to — the bucket an appraiser ' +
      'uses for comp selection? Investor-marketed or as-is/wholesale sales ' +
      'are never ARV evidence even if the photos look updated.',
    criteria: {
      investor:
        'Investor-grade sale — marketed to investors/landlords/flippers, sold as-is, fixer, or at wholesale/below-market pricing',
      median:
        'Median retail sale — typical owner-occupant purchase in mid-range condition and price for the neighborhood',
      arv: 'After-repair-value evidence — genuinely renovated sale at or near the top of the market',
    },
  },
  // Agent-assist digests — pre-reasoned hints the Evaluation Agent weighs
  // alongside the raw data. Advisory only: the agent owns the verdict.
  price_sanity: {
    type: 'choice',
    instructions:
      'Is the recorded sale price plausible for THIS property given the ' +
      'listing facts (size, condition, description)? Flag obvious data ' +
      'errors — a stray digit, a price-per-sqft wildly out of band, or a ' +
      'price inconsistent with the described property.',
    criteria: {
      plausible: 'Price consistent with the property\'s size, condition, and marketed features',
      suspicious: 'Price looks high or low for the described property — possibly a non-arm\'s-length or unusual sale',
      data_error: 'Price is almost certainly wrong — a typo or feed artifact (e.g. $2,000+/sqft, missing digit)',
    },
  },
  anchor_quality: {
    type: 'choice',
    instructions:
      'As ARV evidence for a similar nearby subject property, how strong is ' +
      'this sale? Weigh size similarity (the subject\'s square footage is in ' +
      'the state context), sale recency, condition tier, and how close the ' +
      'sale price-per-sqft sits to a realistic renovated-market ceiling.',
    criteria: {
      strong_anchor: 'Excellent ARV evidence — comparable size, recent sale, appropriate tier',
      supporting: 'Usable supporting evidence — some size/date/condition gaps but same market band',
      weak: 'Marginal — meaningful size mismatch, stale sale, or uncertain tier',
      reject: 'Do not anchor on this — non-arm\'s-length, data error, extreme size mismatch, or wrong market band',
    },
  },
}

// Answer shapes (observed on the wire, clef-flash 2026-10-02):
//   noul   → { type:'noul', noul: <0..1 probability the question is true> }
//   score  → { type:'score', score: <weighted float>, legend: {i: label},
//              probabilities: {i: p}, confidence }
//   choice → { type:'choice', choice: <key>, probabilities: {key: p} }
function prob(v: unknown): number {
  if (typeof v === 'number') return v
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const k of ['noul', 'probability', 'value']) {
      if (typeof o[k] === 'number') return o[k]
    }
  }
  return 0
}

/** Choice answers: {choice: key, probabilities: {key: p}} — argmax wins. */
function parseTier(v: unknown): { tier: CompTier; probabilities: Record<CompTier, number> } {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const probs = (o.probabilities ?? {}) as Record<string, number>
  const out: Record<CompTier, number> = { investor: 0, median: 0, arv: 0 }
  for (const k of Object.keys(out)) if (typeof probs[k] === 'number') out[k as CompTier] = probs[k]
  const choice = typeof o.choice === 'string' ? o.choice : null
  let tier: CompTier = choice && choice in out ? (choice as CompTier) : 'median'
  if (!choice || !(choice in out)) {
    let best = -1
    for (const [k, p] of Object.entries(out)) if (p > best) { best = p; tier = k as CompTier }
  }
  return { tier, probabilities: out }
}

/** Argmax over a choice question's probabilities → chosen key. */
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

/** Argmax over a score question's per-option probabilities → scale index. */
function scoreIdx(v: unknown): { idx: number; score: number } {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const probs = o.probabilities as Record<string, number> | undefined
  let idx = -1
  if (probs) {
    let best = -1
    for (const [k, p] of Object.entries(probs)) {
      if (typeof p === 'number' && p > best) { best = p; idx = Number(k) }
    }
  }
  if (idx < 0) {
    const s = typeof o.score === 'number' ? o.score : typeof v === 'number' ? v : 0
    idx = Math.round(s)
  }
  const score = typeof o.score === 'number' ? o.score : idx
  return { idx, score }
}

export function isClefAvailable(env: Env): boolean {
  return typeof env.AI?.run === 'function' ||
    (env.CONDITION_READER === 'decisions' && !!env.OPENAI_API_KEY)
}

export async function classifyCompCondition(
  env: Env,
  input: CompConditionInput,
): Promise<CompConditionResult> {
  if (!env.AI) throw new Error('CLEF: no Workers AI binding (env.AI)')

  const model: ClefModel = env.CLEF_MODEL === 'clef' ? 'clef' : 'clef-flash'

  const state = {
    subject: 'Comparable property condition assessment for a real-estate appraisal.',
    property: {
      address: input.address,
      salePrice: input.salePrice,
      saleDate: input.saleDate,
      yearBuilt: input.yearBuilt,
      squareFeet: input.squareFeet,
    },
    appraisalSubject: input.subject ?? null,
    listingDescription: input.description ?? null,
    listingHighlights: input.whatsSpecial ?? [],
    listedFeatures: input.features ?? [],
  }

  const started = Date.now()
  // 'decisions' lane — same questions through OpenAI's dedicated endpoint.
  const useDecisions = env.CONDITION_READER === 'decisions' && !!env.OPENAI_API_KEY
  const res: { model?: string; answers?: Record<string, unknown> } = useDecisions
    ? { ...(await decisionsRun(env, {
        state,
        questions: CONDITION_QUESTIONS,
        images: input.images?.slice(0, 4) as Array<{ content_type?: string; base64: string }> | undefined,
      })), model: env.DECISIONS_MODEL || 'gpt-6-luna' }
    : ((await env.AI.run(`@cf/cloudflare/${model}`, {
        model,
        state,
        questions: CONDITION_QUESTIONS,
        ...(input.images?.length ? { images: input.images.slice(0, 4) } : {}),
      })) as { model?: string; answers?: Record<string, unknown> })

  const answers = res?.answers ?? {}
  const { idx, score } = scoreIdx(answers.condition)
  const clamped = Math.max(0, Math.min(CONDITION_SCALE.length - 1, idx))
  const renP = prob(answers.renovated)
  const asisP = prob(answers.as_is)
  const conf = (answers.condition as Record<string, unknown> | undefined)?.confidence
  const tier = parseTier(answers.tier)
  const priceSanity = choicePick(answers.price_sanity, ['plausible', 'suspicious', 'data_error'] as const)
  const anchorQuality = choicePick(answers.anchor_quality, ['strong_anchor', 'supporting', 'weak', 'reject'] as const)
  const hint: CompHint | undefined =
    priceSanity.pick || anchorQuality.pick
      ? {
          priceSanity: priceSanity.pick,
          anchorQuality: anchorQuality.pick,
          probabilities: {
            price_sanity: priceSanity.probabilities,
            anchor_quality: anchorQuality.probabilities,
          },
        }
      : undefined

  return {
    raw: answers,
    renovated: renP >= 0.5,
    renovatedProbability: renP,
    asIs: asisP >= 0.5,
    asIsProbability: asisP,
    investorLanguageProbability: prob(answers.investor_language),
    tier: tier.tier,
    tierProbabilities: tier.probabilities,
    conditionScore: score,
    conditionLabel: CONDITION_SCALE[clamped].split(' — ')[0],
    confidence: typeof conf === 'number' ? conf : undefined,
    hint,
    model: (res?.model ?? model) as ClefModel,
    modelVersion: res?.model ?? model,
    durationMs: Date.now() - started,
  }
}
