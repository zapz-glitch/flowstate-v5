/**
 * Specialist escalation — claude-opus-5-5 consults on the hardest slice of
 * band adjudications. Deterministic banding gets first pass, the arm's
 * reasoning model (luna/haiku) adjudicates second, and Opus is called only
 * when a trigger fires — the 10–20% of cases where disagreement could
 * materially move ARV, not routine classification.
 *
 * Opus receives the same evidence and doctrine as the adjudicator plus the
 * adjudicator's verdict and why it was flagged, then judges independently —
 * a consultant, not a parrot. Its overrides merge over the adjudication's
 * and edges recompute again.
 *
 * Failure modes degrade to the adjudicated bands — escalation is additive.
 */

import type { BandName } from '@flowstate-api/shared/appraisal'
import { createSpecialistProvider } from '../llm'
import { BAND_DOCTRINE } from './band-doctrine'
import { buildCompRows, isAsIsEvidence, type BandAdjudicationInput, type BandAdjudicationResult, type BandAdjustment } from './band-adjudicate'

export interface BandEscalationInput {
  subject: BandAdjudicationInput['subject']
  /** Comp rows with DRAFT (pre-adjudication) band labels. */
  comps: BandAdjudicationInput['comps']
  /** The adjudicator's verdict under review. */
  adjudication: BandAdjudicationResult
  /** ARV band mid before adjudication vs after — the materiality test. */
  draftArvMid: number | null
  adjudicatedArvMid: number | null
  /** ARV band membership after adjudication. */
  arvMemberIds: string[]
  /** ARV band spread (high-low)/mid after adjudication. */
  arvSpread: number | null
}

export interface BandEscalationResult {
  /** compId → final band label; merges OVER adjudication overrides. */
  overrides: Record<string, BandName | null>
  adjustments: BandAdjustment[]
  model: string
  triggers: string[]
  /** Whether the expert materially agreed with the adjudicator. */
  agreesWithAdjudication: boolean
  /** One-paragraph verdict from the expert. */
  verdict?: string
  confidence?: number
}

/** Trigger detection — the hard-10–20% predicate. Every trigger names a
 *  disagreement or thinness that could materially move ARV; routine pools
 *  never reach the specialist. */
export function detectEscalationTriggers(input: BandEscalationInput): string[] {
  const t: string[] = []
  const adj = input.adjudication
  if (typeof adj.confidence === 'number' && adj.confidence < 0.7) t.push('low_confidence')
  if ((adj.ambiguous?.length ?? 0) > 0) t.push('ambiguous_members')
  if (input.draftArvMid != null && input.draftArvMid > 0 && input.adjudicatedArvMid != null
      && Math.abs(input.adjudicatedArvMid - input.draftArvMid) / input.draftArvMid > 0.05) {
    t.push('material_arv_shift')
  }
  if (input.arvMemberIds.length <= 1) t.push('thin_arv_anchor')
  if (input.arvSpread != null && input.arvSpread > 0.4) t.push('wide_arv_spread')
  // Conflicting condition evidence — listing classification and vision
  // read disagree on any member. Either direction counts.
  for (const c of input.comps) {
    const cls = c.classification?.type
    const cond = c.curbAppeal?.condition
    if ((cls === 'after_renovation' && cond === 'distressed')
      || (cls === 'as_is' && cond === 'renovated')) {
      t.push('conflicting_condition_evidence')
      break
    }
  }
  return t
}

const ESCALATION_SCHEMA = {
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
    agreesWithAdjudication: { type: 'boolean' },
    verdict: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['adjustments', 'agreesWithAdjudication', 'verdict', 'confidence'],
  additionalProperties: false,
} as const

const ESCALATION_PROMPT = `You are an expert real-estate investor and appraiser consulted on a comp banding problem — an advisor, not the decision-maker.

The deterministic bander drafted this pool's membership, and your findings go to the agent who makes the final calls. Review the flagged aspects independently, cite specific evidence, and give your recommendation the way an expert consultant would: the data, the reasoning, and what you'd do — the agent decides whether to adopt it.

Return STRICT JSON:
{
  "adjustments": [
    { "compId": "<id>", "action": "include|exclude|move", "band": "as_is|median|arv|null", "reason": "<one line citing evidence>" }
  ],
  "agreesWithAdjudication": true|false,
  "verdict": "<2-4 sentences: your findings and reasoning — what you'd do and why>",
  "confidence": 0.0-1.0
}
Only list adjustments where YOU are recommending a membership change relative to the draft bands. If the draft bands are right as-is, return an empty adjustments array and agreesWithAdjudication=true.

DOCTRINE:
${BAND_DOCTRINE}
`

export async function escalateBandReview(
  env: Parameters<typeof createSpecialistProvider>[0],
  input: BandEscalationInput,
): Promise<BandEscalationResult | null> {
  const triggers = detectEscalationTriggers(input)
  if (triggers.length === 0) return null
  const provider = createSpecialistProvider(env, 'expert')
  if (!provider) return null

  const draftBands = {
    model: input.adjudication.model,
    adjustments: input.adjudication.adjustments,
    ambiguous: input.adjudication.ambiguous ?? [],
    confidence: input.adjudication.confidence ?? null,
  }
  const state = {
    task: 'Expert consult on the draft comp band membership. The flagged triggers explain why this pool reached you — advise, do not decide.',
    triggers,
    subject: input.subject,
    draftBaseline: draftBands,
    bands: {
      draftArvMid: input.draftArvMid,
      adjudicatedArvMid: input.adjudicatedArvMid,
      arvMemberIds: input.arvMemberIds,
      arvSpread: input.arvSpread,
    },
    comps: buildCompRows(input.comps),
  }

  const res = await provider.execute({
    prompt: `${ESCALATION_PROMPT}\n\nSTATE:\n${JSON.stringify(state)}`,
    responseFormat: 'json',
    jsonSchema: { name: 'band_escalation', schema: ESCALATION_SCHEMA },
    maxTokens: 4096,
  }).catch(() => null)
  if (!res?.success || !res.data?.content) {
    console.warn('[band-escalate] expert call failed:', !res ? 'exception' : (res as { error?: unknown }).error)
    return null
  }

  let parsed: { adjustments?: unknown; agreesWithAdjudication?: unknown; verdict?: unknown; confidence?: unknown }
  try {
    parsed = JSON.parse(String(res.data.content).replace(/^```(?:json)?\s*|\s*```$/g, '').trim())
  } catch { return null }

  const validIds = new Set(input.comps.map((c) => c.id))
  const byId = new Map(input.comps.map((c) => [c.id, c] as const))
  const overrides: Record<string, BandName | null> = {}
  const adjustments: BandAdjustment[] = []
  for (const raw of Array.isArray(parsed.adjustments) ? parsed.adjustments : []) {
    const a = raw as { compId?: unknown; action?: unknown; band?: unknown; reason?: unknown }
    const compId = typeof a.compId === 'string' ? a.compId : typeof a.compId === 'number' ? String(a.compId) : null
    if (!compId || !validIds.has(compId)) continue
    const action = a.action === 'include' || a.action === 'exclude' || a.action === 'move' ? a.action : null
    if (!action) continue
    const band = typeof a.band === 'string' && (['as_is', 'median', 'arv'] as string[]).includes(a.band) ? (a.band as BandName) : null
    if (band === 'arv' && isAsIsEvidence(byId.get(compId)!)) continue
    adjustments.push({ compId, action, band, reason: typeof a.reason === 'string' ? a.reason.slice(0, 300) : undefined })
    overrides[compId] = action === 'exclude' ? null : band
  }

  return {
    overrides,
    adjustments,
    model: provider.model,
    triggers,
    agreesWithAdjudication: parsed.agreesWithAdjudication === true,
    verdict: typeof parsed.verdict === 'string' ? parsed.verdict.slice(0, 1000) : undefined,
    confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : undefined,
  }
}
