/**
 * Reasoned band adjudication — the reasoning model's pass over band
 * membership after the deterministic draft bands form.
 *
 * The deterministic bander (shared/appraisal/banding.ts) assigns labels
 * and trims by math. This module hands the draft membership + each comp's
 * evidence to the arm's reasoning provider (gpt-6-luna via OpenRouter, or
 * claude-haiku-5-5 via Anthropic when ANTHROPIC_API_KEY is set) and lets it
 * include / exclude / move members per docs/BAND-FIRST-PRINCIPLES.md —
 * the judgment calls math can't make (reader over-promotion, incoherent
 * members inside a band, verified renovation evidence under-read).
 *
 * Output: compId → band override applied at member assignment in
 * computeEvidenceBands, so edges recompute on adjudicated membership.
 * Failure modes degrade to the deterministic bands — the reasoning pass
 * is additive, never blocking.
 */

import type { BandName, BComp } from '@flowstate-api/shared/appraisal'
import { createReasoningProvider, isReasoningProviderAvailable } from '../llm'
import { BAND_DOCTRINE } from './band-doctrine'

export interface BandAdjudicationInput {
  subject: {
    address?: string | null
    squareFeet?: number | null
    censusTract?: string | null
    neighborhoodName?: string | null
  }
  /** Comp rows with their draft band label + the evidence behind it. */
  comps: Array<BComp & { id: string; band?: BandName | null }>
}

export interface BandAdjustment {
  compId: string
  action: 'include' | 'exclude' | 'move'
  /** Target band for 'include'/'move' (or the band being dropped for 'exclude' as context). */
  band?: BandName | null
  reason?: string
}

export interface BandAdjudicationResult {
  /** compId → final band label (null = unbanded). Only CHANGED membership
   *  appears — absent comps keep their deterministic label. */
  overrides: Record<string, BandName | null>
  adjustments: BandAdjustment[]
  model: string
  /** Members the model flagged as ambiguous but left alone. */
  ambiguous?: string[]
  /** 0-1 — model's overall confidence in the adjudicated membership. */
  confidence?: number
}

const BANDS: BandName[] = ['as_is', 'median', 'arv']

const ADJUDICATION_SCHEMA = {
  type: 'object',
  properties: {
    adjustments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          compId: { type: 'string' },
          action: { type: 'string', enum: ['include', 'exclude', 'move'] },
          band: { anyOf: [{ type: 'string', enum: ['as_is', 'median', 'arv'] }, { type: 'null' }] },
          reason: { type: 'string' },
        },
        required: ['compId', 'action', 'band', 'reason'],
        additionalProperties: false,
      },
    },
    ambiguous: { type: 'array', items: { type: 'string' } },
    /** 0-1 — how confident the model is in the adjudicated membership
     *  as a whole (not per-adjustment). */
    confidence: { type: 'number' },
  },
  required: ['adjustments', 'ambiguous', 'confidence'],
  additionalProperties: false,
} as const

const ADJUDICATION_PROMPT = `You are adjudicating comp band membership for a real-estate appraisal, per the doctrine below.

Each comp carries its draft band label plus the evidence behind it. Review every member and return STRICT JSON:
{
  "adjustments": [
    { "compId": "<id>", "action": "include|exclude|move", "band": "as_is|median|arv|null", "reason": "<one line citing evidence>" }
  ],
  "ambiguous": ["<compId>", "..."] ,
  "confidence": 0.0-1.0
}
Rules: only list a comp in adjustments when you are CHANGING its membership (exclude unbands it; move sets the named band; include re-bands a comp the draft left unbanded). Leave everything else out. Cite the specific evidence driving each change. When uncertain, do not adjust — put the id in "ambiguous" instead.

DOCTRINE:
${BAND_DOCTRINE}
`

/** Evidence rows the reasoning/specialist models adjudicate over — one
 *  serialization shared by the reasoning adjudication and the expert
 *  escalation so neither model sees evidence the other didn't. */
export function buildCompRows(comps: BandAdjudicationInput['comps']) {
  return comps.map((c) => ({
    compId: c.id,
    draftBand: c.band ?? null,
    address: c.address,
    salePrice: c.salePrice,
    saleDate: c.saleDate,
    squareFeet: c.squareFeet,
    pricePerSqft: c.salePrice && c.squareFeet ? Math.round(c.salePrice / c.squareFeet) : null,
    distanceMiles: c.distanceMiles,
    sameBlockGroup: c.sameBlockGroup,
    censusTract: c.censusTract,
    neighborhoodName: c.neighborhoodName,
    classification: c.classification?.type ?? null,
    condition: c.curbAppeal
      ? {
          label: (c.curbAppeal as { label?: string }).label ?? (c.curbAppeal as { condition?: string }).condition ?? null,
          tier: (c.curbAppeal as { tier?: string }).tier ?? null,
          renovatedProbability: (c.curbAppeal as { renovatedProbability?: number }).renovatedProbability ?? null,
          asIsProbability: (c.curbAppeal as { asIsProbability?: number }).asIsProbability ?? null,
        }
      : null,
    coverPhotoUrl: c.coverPhotoUrl ?? null,
    verifiedFlip: c.verifiedFlip ?? false,
    investorSignal: (c.curbAppeal as { investorSignal?: boolean } | null)?.investorSignal ?? false,
    verification: c.evidenceVerification
      ? {
          transactionCheck: c.evidenceVerification.transactionCheck ?? null,
          priceSanity: (c.evidenceVerification as { priceSanity?: string }).priceSanity ?? null,
        }
      : null,
    digestHint: c.clefDigest?.B
      ? { priceSanity: (c.clefDigest.B as { priceSanity?: string }).priceSanity ?? null, geoFit: (c.clefDigest.B as { geoFit?: string }).geoFit ?? null }
      : null,
  }))
}

/** Doctrine hard rule — as-is evidence can never sit in the ARV band.
 *  Shared by adjudication + escalation validation. */
export function isAsIsEvidence(c: BandAdjudicationInput['comps'][number]): boolean {
  return c.classification?.type === 'as_is' ||
    c.curbAppeal?.condition === 'distressed' ||
    c.evidenceVerification?.transactionCheck === 'nominal_sale'
}

/** Shared include/exclude/move → overrides validator. Used by the
 *  in-pipeline reasoning adjudication AND by the gate when an agent posts
 *  bandAdjustments with its selection — the agent holds the initial
 *  banding seat, so its membership calls get the same validation: real
 *  comp ids only, include/move require a named band, exclude unbands, and
 *  as-is evidence can never be moved into the ARV band. */
export function bandAdjustmentsToOverrides(
  rawAdjustments: Array<{ compId?: unknown; action?: unknown; band?: unknown; reason?: unknown }>,
  comps: BandAdjudicationInput['comps'],
): { overrides: Record<string, BandName | null>; adjustments: BandAdjustment[] } {
  const validIds = new Set(comps.map((c) => c.id))
  const byId = new Map(comps.map((c) => [c.id, c] as const))
  const overrides: Record<string, BandName | null> = {}
  const adjustments: BandAdjustment[] = []
  for (const a of rawAdjustments) {
    const compId = typeof a.compId === 'string' ? a.compId : typeof a.compId === 'number' ? String(a.compId) : null
    if (!compId || !validIds.has(compId)) continue
    const action = a.action === 'include' || a.action === 'exclude' || a.action === 'move' ? a.action : null
    if (!action) continue
    const band = typeof a.band === 'string' && (BANDS as string[]).includes(a.band) ? (a.band as BandName) : null
    if (band === 'arv' && isAsIsEvidence(byId.get(compId)!)) continue
    const adj: BandAdjustment = { compId, action, band, reason: typeof a.reason === 'string' ? a.reason.slice(0, 300) : undefined }
    adjustments.push(adj)
    overrides[compId] = action === 'exclude' ? null : band
  }
  return { overrides, adjustments }
}

/** Adjudicate the draft band membership. Returns null when no reasoning
 *  provider is configured or the call fails — the caller keeps
 *  deterministic bands. */
export async function adjudicateBandMembership(
  env: Parameters<typeof createReasoningProvider>[0],
  input: BandAdjudicationInput,
): Promise<BandAdjudicationResult | null> {
  if (!isReasoningProviderAvailable(env)) return null
  const provider = createReasoningProvider(env, 'openai/gpt-6-luna')
  if (!provider) return null

  const compRows = buildCompRows(input.comps)

  const state = {
    task: 'Adjudicate band membership for the comp pool of this appraisal subject.',
    subject: input.subject,
    comps: compRows,
  }

  const res = await provider.execute({
    prompt: `${ADJUDICATION_PROMPT}\n\nSTATE:\n${JSON.stringify(state)}`,
    responseFormat: 'json',
    // Anthropic structured outputs 400s on a bare {type:'object'} schema —
    // pass the real contract.
    jsonSchema: { name: 'band_adjudication', schema: ADJUDICATION_SCHEMA },
    maxTokens: 4096,
  }).catch(() => null)
  if (!res?.success || !res.data?.content) {
    console.warn('[band-adjudicate] reasoning call failed:', !res ? 'exception' : (res as { error?: unknown }).error)
    return null
  }

  let parsed: { adjustments?: unknown; ambiguous?: unknown }
  try {
    parsed = JSON.parse(String(res.data.content).replace(/^```(?:json)?\s*|\s*```$/g, '').trim())
  } catch { return null }

  const validIds = new Set(input.comps.map((c) => c.id))
  const { overrides, adjustments } = bandAdjustmentsToOverrides(
    Array.isArray(parsed.adjustments) ? parsed.adjustments as BandAdjustment[] : [],
    input.comps,
  )

  return {
    overrides,
    adjustments,
    model: provider.model,
    ambiguous: Array.isArray(parsed.ambiguous)
      ? parsed.ambiguous.filter((v): v is string => typeof v === 'string' && validIds.has(v))
      : undefined,
    confidence: typeof (parsed as { confidence?: unknown }).confidence === 'number'
      ? Math.max(0, Math.min(1, (parsed as { confidence: number }).confidence))
      : undefined,
  }
}
