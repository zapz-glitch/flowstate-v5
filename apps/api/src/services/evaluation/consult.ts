/**
 * Expert consult — claude-opus-5-5 reviews an agent's proposed comp
 * selection BEFORE the gate consumes a revision. The Devin agent calls
 * /harness/consult on a revision turn (or any time it wants a second
 * opinion): Opus sees the same evidence + doctrine the pipeline verified,
 * the proposal, the gate's grade of it, and any prior rejection feedback,
 * then judges independently — accept or revise, with named fixes.
 *
 * Read-only: the consult never mutates job state, never consumes the
 * revision budget, and never accepts a selection itself — it advises the
 * agent, which still posts the final verdict to /harness/selection.
 */

import { createSpecialistProvider } from '../llm'
import { BAND_DOCTRINE } from './band-doctrine'
import type { AgentSelection, HarnessEvidence, SelectionAttempt } from './index'
import type { VerdictGrade } from './verdict-grade'

export interface SelectionConsultResult {
  verdict: 'accept' | 'revise'
  confidence?: number
  notes?: string
  suggestedFixes?: string[]
  model: string
}

const CONSULT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['accept', 'revise'] },
    confidence: { type: 'number' },
    notes: { type: 'string' },
    suggestedFixes: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'confidence', 'notes', 'suggestedFixes'],
  additionalProperties: false,
} as const

const CONSULT_PROMPT = `You are the senior appraisal reviewer consulted on a proposed comp selection before it finalizes.

An agent proposes picks/drivers/ARV/band edges for this subject. The deterministic gate has already graded the proposal (checkFails = hard violations; failures/warns = named issues). Judge independently against the evidence and doctrine: accept the proposal, or name the specific revision it needs.

Return STRICT JSON:
{
  "verdict": "accept" | "revise",
  "confidence": 0.0-1.0,
  "notes": "<2-4 sentences — your reasoning>",
  "suggestedFixes": ["<concrete fix the agent should apply>", "..."]
}
suggestedFixes is [] when verdict is accept. Be concrete: name compIds, bands, or the ARV envelope the fix implies.

DOCTRINE:
${BAND_DOCTRINE}
`

function compactComp(c: Record<string, unknown>) {
  const cond = c.curbAppeal as { condition?: string; label?: string; tier?: string } | undefined
  const ver = c.evidenceVerification as { transactionCheck?: string; priceSanity?: string } | undefined
  const cls = c.classification as { type?: string } | undefined
  return {
    id: c.id,
    address: c.address,
    salePrice: c.salePrice,
    saleDate: c.saleDate,
    squareFeet: c.squareFeet,
    pricePerSqft:
      typeof c.salePrice === 'number' && typeof c.squareFeet === 'number' && c.squareFeet > 0
        ? Math.round((c.salePrice as number) / (c.squareFeet as number))
        : null,
    distanceMiles: c.distanceMiles,
    sameBlockGroup: c.sameBlockGroup,
    censusTract: c.censusTract,
    neighborhoodName: c.neighborhoodName,
    band: c.band ?? null,
    classification: cls?.type ?? null,
    condition: cond?.condition ?? cond?.label ?? null,
    conditionTier: cond?.tier ?? null,
    verification: ver ? { transactionCheck: ver.transactionCheck ?? null, priceSanity: ver.priceSanity ?? null } : null,
    coverPhotoUrl: c.coverPhotoUrl ?? null,
    isEnabled: c.isEnabled,
    flags: c.flags,
  }
}

export async function consultOnSelection(
  env: Parameters<typeof createSpecialistProvider>[0],
  input: {
    evidence: HarnessEvidence
    selection: AgentSelection
    grade: VerdictGrade
    priorAttempts?: SelectionAttempt[]
  },
): Promise<SelectionConsultResult | null> {
  const provider = createSpecialistProvider(env, 'expert')
  if (!provider) return null

  const prior = (input.priorAttempts ?? []).map((a) => ({
    decision: a.decision,
    checkFails: a.grade.gateFails,
    failures: a.grade.failures,
    arv: a.selection.arv,
    selectedCompIds: a.selection.selectedCompIds,
    drivers: a.selection.drivers ?? [],
  }))

  const state = {
    task: 'Review this proposed comp selection. Judge it against the evidence and doctrine; advise accept or the specific revision needed.',
    subject: input.evidence.subject,
    proposal: {
      arv: input.selection.arv,
      conf: input.selection.conf,
      selectedCompIds: input.selection.selectedCompIds,
      drivers: input.selection.drivers ?? [],
      bands: input.selection.bands ?? null,
      bandEdges: input.selection.bandEdges ?? null,
      notes: input.selection.notes ?? null,
    },
    gateGrade: {
      score: input.grade.score,
      checkFails: input.grade.gateFails,
      failures: input.grade.failures,
      warnings: input.grade.warnings,
    },
    priorAttempts: prior,
    evidenceBands: input.evidence.evidenceBands,
    geoBands: input.evidence.geoBands,
    comps: (input.evidence.comps ?? []).map((c) => compactComp(c as unknown as Record<string, unknown>)),
  }

  const res = await provider.execute({
    prompt: `${CONSULT_PROMPT}\n\nSTATE:\n${JSON.stringify(state)}`,
    responseFormat: 'json',
    jsonSchema: { name: 'selection_consult', schema: CONSULT_SCHEMA },
    maxTokens: 4096,
  }).catch(() => null)
  if (!res?.success || !res.data?.content) {
    console.warn('[consult] expert call failed:', !res ? 'exception' : (res as { error?: unknown }).error)
    return null
  }

  let parsed: { verdict?: unknown; confidence?: unknown; notes?: unknown; suggestedFixes?: unknown }
  try {
    parsed = JSON.parse(String(res.data.content).replace(/^```(?:json)?\s*|\s*```$/g, '').trim())
  } catch { return null }

  return {
    verdict: parsed.verdict === 'accept' ? 'accept' : 'revise',
    confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : undefined,
    notes: typeof parsed.notes === 'string' ? parsed.notes.slice(0, 2000) : undefined,
    suggestedFixes: Array.isArray(parsed.suggestedFixes)
      ? parsed.suggestedFixes.filter((f): f is string => typeof f === 'string').slice(0, 20)
      : [],
    model: provider.model,
  }
}
