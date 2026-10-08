/**
 * The Opus appraiser — the final decision maker in the self-completing
 * eval pipeline. Haiku classifies (subject tier, comp condition +
 * description summary + comp-rules notation) and code handles the
 * plumbing; Opus reviews the complete dataset and posts the final comp
 * selection + ARV, verified by the deterministic gate.
 *
 * Flow (docs/EVAL-AGENT-RULESET — Opus seat):
 *   1. Opus reads the full evidence bundle and returns a selection. It
 *      may first issue bounded clarify requests — haiku answers as a
 *      sub-agent (classify missing info or find it in the listing
 *      evidence). Haiku has no decision authority; Opus decides.
 *   2. The deterministic gate (verdict-grade) grades the selection:
 *      pocket discipline, flagged picks, as-is drivers, coherence
 *      outliers, envelope. Fails come back as named violations.
 *   3. On a gate fail, haiku writes a debug note explaining WHY the
 *      selection failed in plain terms (docs/GATE-DEBUG-RULESET) —
 *      annotation, never a second judgment. Gate feedback + the debug
 *      note go back to Opus, which revises (≤2 rounds).
 *   4. After the budget: the deterministic engine's own selection
 *      completes — a persistently failing pool ships its honest
 *      fallback, never a forced number.
 *
 * Degrades honestly: no Opus provider → null (the caller runs the
 * deterministic path); a provider failure mid-loop → whatever the last
 * accepted/final selection was.
 */

import { createSpecialistProvider, createReasoningProvider } from '../llm'
import { COMP_DOCTRINE } from './comp-doctrine'
import { gradeVerdict, type VerdictGrade } from './verdict-grade'
import type { AgentSelection, HarnessEvidence, Phase1Context, SelectionAttempt } from './index'
import { validateAgentSelection } from './index'

const MAX_CLARIFICATIONS = 5
const MAX_REVISIONS = 2

const APPRAISER_PROMPT = `You are the appraiser — the final decision maker on comp selection and ARV for a wholesale real-estate acquisition.

You receive the COMPLETE dataset: the subject property with its haiku-assigned condition tier, the full comp pool each with a haiku condition classification (label, tier, evidence summary, and a comp-rules check noting any rules a comp fails or fields it lacks), geo stamps, verification flags, and cover-photo URLs you may cite.

You also receive the block-group PRICE LADDER (blockLadder): the pocket's sales split by $/sf into natural top/middle/bottom clusters — the top-cluster median is the ARV band, the bottom-cluster median is the as-is/investor band. Each comp carries its ladder rung and $/sf ratios (priceLadder.ppsfVsMedian, priceLadder.ppsfVsTop) plus evidenceCoverage ('photo+desc' | 'photo' | 'desc' | null) saying what the classifier could actually see — weigh photo-verified reads above description-only ones, and treat 'desc'-only or null coverage as weak condition evidence.

Your job: choose the comps that set the ARV (the genuinely renovated retail evidence — never as-is/investor-marketed stock), name which picks drove the number, and post the ARV. Prefer in-pocket comps (same block group > neighborhood > census tract) whose $/sf sits in the top ladder rung at or near the top-cluster median — that is ARV pricing the market itself proved. Do not pick flagged/non-market sales (nominal, data_error, disabled). A comp priced wildly off its condition group is not evidence.

If anything is missing or ambiguous, you may ask your haiku sub-agent to clarify or classify — up to ${MAX_CLARIFICATIONS} requests TOTAL across the whole review. Ask targeted questions ("does comp X's listing mention a kitchen remodel?", "is comp Y's sale arm's length given the $500 price?"). Haiku answers; you decide.

Return STRICT JSON:
{
  "selectedCompIds": ["<compId>", ...],
  "drivers": ["<compId>", ...]  // subset of selectedCompIds that drove the ARV,
  "arv": number,
  "conf": "high" | "medium" | "low",
  "notes": "<2-4 sentences: your reasoning — what the evidence supports>",
  "dataQuality": {
    "score": <0-10: the quality of the dataset you were given — 10 means the evidence made this an easy, unambiguous decision>,
    "notes": "<one sentence: what was missing or ambiguous, if anything>"
  },
  "flags": ["<evidence gaps or caveats worth surfacing>"],
  "clarifyRequests": [
    { "compId": "<id or null>", "question": "<targeted question for the haiku sub-agent>" }
  ]
}
Set "clarifyRequests" to an empty array when you're ready to decide — presence of requests means you want answers BEFORE this selection is final (the harness will call you again with the findings; keep deciding fields null-safe but always include them).

DOCTRINE:
${COMP_DOCTRINE}
`

const REVISION_PROMPT = `The deterministic gate REJECTED your previous selection. It is code, not a model — it cannot be argued with, only satisfied. Review the named violations and the debug note, correct the selection, and post again under the same JSON contract.
`

const CLARIFY_PROMPT = `You are the haiku sub-agent to the appraiser. Answer the question from the comp listing evidence and facts provided — classify or find the missing information. One comp, one question, one answer. No verdicts, no comp-selection advice: you have no decision authority.

Return STRICT JSON: { "answer": "<1-3 sentences citing the evidence>", "confidence": 0.0-1.0 }
`

const GATE_DEBUG_PROMPT = `You are the gate debugger — you explain gate rejections, never re-judge them. The deterministic gate rejected the appraiser's selection; read the named violations, the selection, and the evidence pool, then write a debug note: which comp(s) caused each violation, what rule they tripped, and the concrete fix (swap/remove/re-anchor). Under 150 words. Plain text, no verdict.
`

const SELECTION_SCHEMA = {
  type: 'object',
  properties: {
    selectedCompIds: { type: 'array', items: { type: 'string' } },
    drivers: { type: 'array', items: { type: 'string' } },
    arv: { type: 'number' },
    conf: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: { type: 'string' },
    flags: { type: 'array', items: { type: 'string' } },
    dataQuality: {
      type: 'object',
      properties: {
        score: { type: 'number' },
        notes: { type: 'string' },
      },
      required: ['score', 'notes'],
      additionalProperties: false,
    },
    clarifyRequests: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          compId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          question: { type: 'string' },
        },
        required: ['compId', 'question'],
        additionalProperties: false,
      },
    },
  },
  required: ['selectedCompIds', 'drivers', 'arv', 'conf', 'notes', 'dataQuality', 'flags', 'clarifyRequests'],
  additionalProperties: false,
} as const

const CLARIFY_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['answer', 'confidence'],
  additionalProperties: false,
} as const

export interface ClarifyFinding {
  compId: string | null
  question: string
  answer: string
  confidence: number
}

export interface AppraiserResult {
  /** The accepted selection — null when the gate never accepted (the
   *  caller then completes on the deterministic engine path). */
  selection: AgentSelection | null
  model: string | null
  /** Every selection Opus posted with its gate grade + decision. */
  attempts: SelectionAttempt[]
  clarifications: ClarifyFinding[]
  /** Haiku debug notes written for gate rejections — run telemetry. */
  debugNotes: string[]
  /** True when Opus never answered (provider missing or call failed) —
   *  deterministic path is the right continuation, not a retry. */
  unavailable: boolean
}

/** The comp row Opus sees — trimmed to decision inputs, in the order the
 *  evidence bundle carries them. */
function appraiserCompRows(evidence: HarnessEvidence) {
  return evidence.comps.map((c) => ({
    compId: c.id,
    address: c.address ?? null,
    salePrice: c.salePrice ?? null,
    saleDate: c.saleDate ?? null,
    squareFeet: c.squareFeet ?? null,
    pricePerSqft: c.pricePerSqft ?? null,
    distanceMiles: c.distanceMiles ?? null,
    sameBlockGroup: c.sameBlockGroup ?? null,
    censusTract: c.censusTract ?? null,
    neighborhoodName: c.neighborhoodName ?? null,
    yearBuilt: c.yearBuilt ?? null,
    isEnabled: c.isEnabled !== false,
    // Haiku's classification — the appraiser's condition evidence. Clef's
    // curbAppeal shadow stamp stays out of the appraiser prompt.
    condition: {
      label: c.conditionLabel ?? null,
      tier: c.compTier ?? null,
      asIs: c.conditionAsIs ?? null,
      listingType: c.classification?.type ?? null,
      summary: c.conditionSummary ?? null,
    },
    rulesCheck: c.rulesCheck ?? null,
    verifiedFlip: c.verifiedFlip ?? null,
    // Verification fields minus the `flags` prose — each flag restates a
    // machine field already in this block ("Sale is 486 days old" ==
    // saleAgeDays vs preferredSaleAgeDays, "No comp AVM" ==
    // priceCheck:'unverified'). The fields are the decision inputs; the
    // prose was ~40% of every comp row. The bundle itself keeps flags.
    verification: c.evidenceVerification
      ? (() => { const { flags: _flags, ...fields } = c.evidenceVerification; return fields })()
      : null,
    coverPhotoUrl: c.coverPhotoUrl ?? null,
    evidenceCoverage: c.evidenceCoverage ?? null,
    priceLadder: c.priceLadder ?? null,
    adjustedPrice: c.adjustedPrice ?? null,
  }))
}

interface ParsedSelection {
  selectedCompIds?: unknown
  drivers?: unknown
  arv?: unknown
  conf?: unknown
  notes?: unknown
  dataQuality?: unknown
  flags?: unknown
  clarifyRequests?: unknown
}

function parseSelection(content: string): ParsedSelection | null {
  try {
    return JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, '').trim())
  } catch { return null }
}

const strIds = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

function toAgentSelection(p: ParsedSelection, byId: Set<string>): AgentSelection | null {
  const ids = strIds(p.selectedCompIds).filter((id) => byId.has(id))
  const arv = typeof p.arv === 'number' && Number.isFinite(p.arv) ? p.arv : null
  const conf = p.conf === 'high' || p.conf === 'medium' || p.conf === 'low' ? p.conf : 'low'
  if (ids.length === 0 || arv == null || arv <= 0) return null
  const drivers = strIds(p.drivers).filter((id) => ids.includes(id))
  return {
    arv,
    conf,
    selectedCompIds: ids,
    ...(drivers.length ? { drivers } : {}),
    notes: typeof p.notes === 'string' ? p.notes.slice(0, 4000) : undefined,
    flags: Array.isArray(p.flags) ? p.flags.filter((f): f is string => typeof f === 'string').slice(0, 20) : [],
    ...(typeof (p.dataQuality as { score?: unknown } | undefined)?.score === 'number'
      ? { dataQuality: { score: Math.max(0, Math.min(10, (p.dataQuality as { score: number }).score)), notes: typeof (p.dataQuality as { notes?: unknown }).notes === 'string' ? (p.dataQuality as { notes: string }).notes.slice(0, 500) : '' } }
      : {}),
  }
}

/** Haiku clarify — one question answered from the comp's listing
 *  evidence. Sub-agent only: no verdict authority. */
async function haikuClarify(
  env: Parameters<typeof createSpecialistProvider>[0],
  evidence: HarnessEvidence,
  req: { compId: string | null; question: string },
): Promise<ClarifyFinding | null> {
  const provider = createReasoningProvider(env, 'openai/gpt-6-luna')
  if (!provider) return null
  const comp = req.compId ? evidence.comps.find((c) => c.id === req.compId) : undefined
  const context = {
    subject: evidence.subject,
    comp: comp
      ? appraiserCompRows({ ...evidence, comps: [comp] })[0]
      : null,
    question: req.question,
  }
  const res = await provider.execute({
    prompt: `${CLARIFY_PROMPT}\n\nCONTEXT:\n${JSON.stringify(context)}`,
    responseFormat: 'json',
    jsonSchema: { name: 'clarify_answer', schema: CLARIFY_SCHEMA },
    maxTokens: 512,
  }).catch(() => null)
  let parsed: { answer?: unknown; confidence?: unknown } | null = null
  try {
    parsed = res?.data?.content
      ? JSON.parse(res.data.content.replace(/^```(?:json)?\s*|\s*```$/g, '').trim())
      : null
  } catch { parsed = null }
  const answer = typeof parsed?.answer === 'string' ? parsed.answer : null
  if (!answer) return null
  return {
    compId: req.compId,
    question: req.question,
    answer,
    confidence: typeof parsed?.confidence === 'number' ? parsed.confidence : 0.5,
  }
}

/** Haiku gate debugger — explains WHY the deterministic gate rejected a
 *  selection in plain terms for the run record and the revision prompt.
 *  Annotates; never re-judges. */
async function haikuGateDebug(
  env: Parameters<typeof createSpecialistProvider>[0],
  evidence: HarnessEvidence,
  selection: AgentSelection,
  grade: VerdictGrade,
): Promise<string | null> {
  const provider = createReasoningProvider(env, 'openai/gpt-6-luna')
  if (!provider) return null
  const picked = new Set(selection.selectedCompIds)
  const context = {
    selection: {
      arv: selection.arv,
      conf: selection.conf,
      picks: appraiserCompRows({ ...evidence, comps: evidence.comps.filter((c) => picked.has(c.id)) }),
      notes: selection.notes ?? null,
    },
    violations: { checks: grade.checks, failures: grade.failures, feedback: grade.gateFeedback },
    pool: appraiserCompRows(evidence),
  }
  const res = await provider.execute({
    prompt: `${GATE_DEBUG_PROMPT}\n\nCONTEXT:\n${JSON.stringify(context)}`,
    maxTokens: 512,
  }).catch(() => null)
  const text = res?.data?.content?.trim()
  return text ? text.slice(0, 1500) : null
}

/** Run the Opus appraiser over a frozen evidence bundle. The bundle is
 *  immutable — clarify answers and revision feedback are appended to the
 *  prompt state, never written back. */
export async function runOpusAppraiser(
  env: Parameters<typeof createSpecialistProvider>[0],
  ctx: Phase1Context,
  evidence: HarnessEvidence,
): Promise<AppraiserResult> {
  const out: AppraiserResult = {
    selection: null, model: null, attempts: [], clarifications: [], debugNotes: [], unavailable: false,
  }
  const provider = createSpecialistProvider(env, 'expert')
  if (!provider) { out.unavailable = true; return out }
  out.model = provider.model

  const compIds = new Set(evidence.comps.map((c) => c.id))
  const baseState = {
    task: 'Review the complete dataset and post the final comp selection + ARV.',
    subject: evidence.subject,
    renovationEvidence: evidence.renovationEvidence ?? null,
    pocketDesirability: evidence.pocketDesirability ?? null,
    engineSuggestion: {
      // The deterministic engine's own suggestion — context, not an anchor.
      selectedCompIds: evidence.suggestedSelection,
    },
    rules: {
      // Disabled rows carry no signal — the appraiser only needs the
      // active ladder + its thresholds.
      filters: evidence.rules.filters.filter((f) => f.enabled !== false),
      adjustments: evidence.rules.adjustments.filter((a) => a.enabled !== false),
      preferredSaleAgeDays: evidence.rules.preferredSaleAgeDays,
      asIsThresholdPercent: evidence.rules.asIsThresholdPercent,
    },
    classificationSummary: evidence.classificationSummary ?? null,
    blockLadder: evidence.blockLadder ?? null,
    comps: appraiserCompRows(evidence),
  }

  let clarificationsUsed = 0
  let revisionsUsed = 0
  let clarificationBlock: ClarifyFinding[] = []
  let lastGrade: VerdictGrade | null = null
  let lastDebug: string | null = null

  // Decision loop — clarify rounds count against MAX_CLARIFICATIONS; gate
  // rejects consume revisions; a passing grade (or a plain-text answer we
  // can coerce) ends the loop.
  for (let round = 0; round <= MAX_CLARIFICATIONS + MAX_REVISIONS + 1; round++) {
    const state = {
      ...baseState,
      ...(clarificationBlock.length ? { clarificationFindings: clarificationBlock } : {}),
      ...(lastGrade ? { rejectedSelection: { feedback: lastGrade.gateFeedback, failures: lastGrade.failures }, gateDebugNote: lastDebug } : {}),
    }
    const prompt = lastGrade
      ? `${REVISION_PROMPT}\n\n${APPRAISER_PROMPT}\n\nSTATE:\n${JSON.stringify(state)}`
      : `${APPRAISER_PROMPT}\n\nSTATE:\n${JSON.stringify(state)}`

    const res = await provider.execute({
      prompt,
      responseFormat: 'json',
      jsonSchema: { name: 'appraiser_selection', schema: SELECTION_SCHEMA },
      maxTokens: 4096,
    }).catch(() => null)
    const parsed = res?.data?.content ? parseSelection(res.data.content) : null
    if (!parsed) { out.unavailable = out.attempts.length === 0; break }

    // Clarify round — Opus asks, haiku answers, loop continues.
    const wantsClarify = Array.isArray(parsed.clarifyRequests)
      && (parsed.clarifyRequests as unknown[]).length > 0
      && clarificationsUsed < MAX_CLARIFICATIONS
    if (wantsClarify) {
      const reqs = (parsed.clarifyRequests as Array<{ compId?: unknown; question?: unknown }>)
        .filter((r) => typeof r.question === 'string' && r.question.length > 0)
        .slice(0, MAX_CLARIFICATIONS - clarificationsUsed)
      const answers = await Promise.all(reqs.map((r) => haikuClarify(env, evidence, {
        compId: typeof r.compId === 'string' && compIds.has(r.compId) ? r.compId : null,
        question: String(r.question),
      })))
      for (const a of answers) if (a) { clarificationBlock.push(a); clarificationsUsed++ }
      out.clarifications = clarificationBlock
      continue
    }

    const sel = toAgentSelection(parsed, compIds)
    if (sel) {
      // Same coherence bounds the /harness/selection endpoint enforces —
      // enabled comps only, ARV inside the pick-price envelope.
      const vfails = validateAgentSelection(sel, ctx.appraisalResult.comparables)
      if (vfails.length > 0) {
        const grade: VerdictGrade = {
          checks: { d1: 'pass', d2: 'pass', d4: 'pass', d5: 'pass', d6: 'pass', d7: 'pass' },
          score: 0, failures: ['coherence_validation'], warnings: [], scorePenalty: 0,
          gateFails: ['validation'], gateFeedback: vfails, gradedAt: new Date().toISOString(),
        }
        out.attempts.push({ selection: sel, grade, decision: 'rejected', at: new Date().toISOString() })
        lastGrade = grade
        lastDebug = null
        if (++revisionsUsed > MAX_REVISIONS) break
        continue
      }
    }
    if (!sel) {
      // Unusable selection shape — one more chance counts as a revision.
      if (++revisionsUsed > MAX_REVISIONS) break
      lastGrade = {
        checks: { d1: 'pass', d2: 'pass', d4: 'pass', d5: 'pass', d6: 'pass', d7: 'pass' },
        score: 0, failures: ['malformed_selection'], warnings: [], scorePenalty: 0,
        gateFails: ['shape'], gateFeedback: ['selection was missing comps or a positive ARV — repost under the schema'], gradedAt: new Date().toISOString(),
      }
      lastDebug = null
      continue
    }

    const grade = gradeVerdict(evidence, sel)
    const rejected = grade.gateFails.length > 0
    out.attempts.push({
      selection: sel,
      grade,
      decision: rejected
        ? (revisionsUsed >= MAX_REVISIONS ? 'rejected' : 'rejected')
        : 'accepted',
      at: new Date().toISOString(),
    })

    if (!rejected) {
      out.selection = sel
      return out
    }

    // Gate fail → haiku debug note + revision round while budget lasts.
    lastGrade = grade
    lastDebug = await haikuGateDebug(env, evidence, sel, grade)
    if (lastDebug) out.debugNotes.push(lastDebug)
    if (++revisionsUsed > MAX_REVISIONS) {
      out.attempts[out.attempts.length - 1]!.decision = 'rejected'
      break
    }
  }
  return out
}
