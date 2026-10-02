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

export type ClefModel = 'clef' | 'clef-flash'

export interface ClefImage {
  content_type: 'image/png' | 'image/jpeg' | 'image/webp'
  base64: string
}

type Question =
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
}

export interface CompConditionResult {
  /** The model's answer set, verbatim — useful for calibration forensics */
  raw: Record<string, unknown>
  renovated: boolean
  renovatedProbability: number
  asIs: boolean
  asIsProbability: number
  /** Weighted score on the 0–4 condition scale */
  conditionScore: number
  /** Argmax bucket label — 'Poor' | 'Dated' | 'Maintained' | 'Updated' | 'Renovated' */
  conditionLabel: string
  /** Clef's reported confidence in the score answer, when present */
  confidence?: number
  model: ClefModel
  modelVersion: string
  durationMs: number
}

const CONDITION_SCALE = [
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
  return typeof env.AI?.run === 'function'
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
    listingDescription: input.description ?? null,
    listingHighlights: input.whatsSpecial ?? [],
    listedFeatures: input.features ?? [],
  }

  const started = Date.now()
  const res = (await env.AI.run(`@cf/cloudflare/${model}`, {
    model,
    state,
    questions: CONDITION_QUESTIONS,
    ...(input.images?.length ? { images: input.images.slice(0, 4) } : {}),
  })) as { model?: string; answers?: Record<string, unknown> }

  const answers = res?.answers ?? {}
  const { idx, score } = scoreIdx(answers.condition)
  const clamped = Math.max(0, Math.min(CONDITION_SCALE.length - 1, idx))
  const renP = prob(answers.renovated)
  const asisP = prob(answers.as_is)
  const conf = (answers.condition as Record<string, unknown> | undefined)?.confidence

  return {
    raw: answers,
    renovated: renP >= 0.5,
    renovatedProbability: renP,
    asIs: asisP >= 0.5,
    asIsProbability: asisP,
    conditionScore: score,
    conditionLabel: CONDITION_SCALE[clamped].split(' — ')[0],
    confidence: typeof conf === 'number' ? conf : undefined,
    model,
    modelVersion: res?.model ?? model,
    durationMs: Date.now() - started,
  }
}
