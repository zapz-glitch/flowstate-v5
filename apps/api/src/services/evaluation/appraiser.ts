/**
 * The Opus appraiser — the final decision maker in the self-completing
 * eval pipeline. Haiku classifies (subject tier, comp condition +
 * description summary + comp-rules notation) and code handles the
 * plumbing; Opus reviews the complete dataset and posts the final comp
 * selection + ARV, verified by the deterministic gate.
 *
 * Flow (docs/EVAL-AGENT-RULESET — Sonnet seat):
 *   1. Sonnet reads the full evidence bundle and returns a selection. It
 *      may first issue bounded clarify requests — the Decisions model
 *      answers as a yes/no + probability sub-agent. Decisions has no
 *      decision authority; Sonnet decides.
 *   2. The deterministic gate (verdict-grade) grades the selection:
 *      pocket discipline, flagged picks, as-is drivers, coherence
 *      outliers, envelope. Fails come back as named violations.
 *   3. On a gate fail, each failed check is cross-examined by a targeted
 *      Decisions question on the picked comps — never the same question
 *      re-asked. Findings + gate feedback go back to Sonnet, which
 *      revises at MAX reasoning effort (≤2 rounds).
 *   4. After the budget: the deterministic engine's own selection
 *      completes — a persistently failing pool ships its honest
 *      fallback, never a forced number.
 *
 * Degrades honestly: no Opus provider → null (the caller runs the
 * deterministic path); a provider failure mid-loop → whatever the last
 * accepted/final selection was.
 */

import { createSpecialistProvider } from '../llm'
import { decisionsRun, type DecisionsEnv } from '../decisions'
import { fetchImageAsBase64 } from '../llm/image-utils'
import { compMatchProfile } from './observable'
import { COMP_DOCTRINE } from './comp-doctrine'
import { gradeVerdict, type VerdictGrade } from './verdict-grade'
import type { AgentSelection, HarnessEvidence, Phase1Context, SelectionAttempt } from './index'
import { validateAgentSelection } from './index'

const MAX_CLARIFICATIONS = 5
const MAX_REVISIONS = 2

const APPRAISER_PROMPT = `You are the appraiser — the final decision maker on comp selection and ARV for a wholesale real-estate acquisition.

You receive the COMPLETE dataset: the subject property with its haiku-assigned condition tier, the full comp pool each with a haiku condition classification (label, tier, evidence summary, and a comp-rules check noting any rules a comp fails or fields it lacks), geo stamps, verification flags, and cover-photo URLs you may cite.

You also receive the block-group PRICE LADDER (blockLadder): the pocket's sales split by $/sf into natural top/middle/bottom clusters — the top-cluster median is the ARV band, the bottom-cluster median is the as-is/investor band. Each comp carries its ladder rung and $/sf ratios (priceLadder.ppsfVsMedian, priceLadder.ppsfVsTop) plus evidenceCoverage ('photo+desc' | 'photo' | 'desc' | null) saying what the classifier could actually see — weigh photo-verified reads above description-only ones, and treat 'desc'-only or null coverage as weak condition evidence.

Each comp also carries OBSERVABLE ANSWERS (observables): small evidence reads from its cover photo + description + closed price + street view — pricePosition vs the pocket benchmark (codePosition is the code-verified tier), descCondition, coverPhotoEvidence, renoClaimP, priceConditionAgreement, unexplainedPremiumP, finalTier, physicalMatchP (probability the comp's street view physically matches the subject — style/stories/garage/curb appeal), and arvFitnessP (probability the comp is a finished/renovated/move-in-ready version of the subject — the ARV-grade ladder: flipper-complete highest, maintained ~70-80s, fixer/investor lowest). The marketBenchmark block is the matched-pocket distribution those positions classify against. Read the tiers as: priced ABOVE_MEDIAN ≈ renovated/ARV-band evidence, at MEDIAN ≈ median-market evidence, priced far BELOW_MEDIAN ≈ investor/as-is evidence — but a price tier is not proof of condition; weight conflicts the observables preserved (e.g. above-median price with DISTRESSED description or an unexplainedPremium flag ≈ 1 means a suspect comp, not an ARV anchor).

Each comp row also carries exclusionReasons — code-stamped disqualifiers (geo, stale sale, uncorroborated price, investor-priced). These are facts, not suggestions: an exclusionReason means the comp is disqualified evidence unless the reason is demonstrably wrong.

Your job, IN ORDER:
1. DISQUALIFY FIRST. Read every comp's exclusionReasons and the observables — confirm the disqualifications and set those comps aside before selecting anything. A comp that is merely cheap-but-legal ("investor-grade") is real data but not ARV evidence.
2. From the survivors, pick the comps that set the ARV — the genuinely renovated retail evidence — name which picks drove the number, and post the ARV. Prefer high arvFitnessP AND high physicalMatchP: a comp that both fits the rules and resembles the subject's finished state is the strongest evidence.
3. GEOGRAPHY IS STRICT — never reach outside the pocket for a better-matching house. Order: same block group → same neighborhood → same census tract. If NO in-pocket comp qualifies, select the median comps of the subject's block group (median-of-BG fallback) — the pocket's own market, not a similar house across town.
4. Do not pick flagged/non-market sales (nominal, data_error, disabled). A comp priced wildly off its condition group is not evidence.

If anything is missing or ambiguous, you may ask the Decisions sub-agent to clarify — up to ${MAX_CLARIFICATIONS} requests TOTAL across the whole review. Ask targeted questions ("does comp X's listing mention a kitchen remodel?", "is comp Y's sale arm's length given the $500 price?"). Decisions answers with probability + verdict; you decide.

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
    { "compId": "<id or null>", "question": "<targeted question for the Decisions sub-agent>" }
  ]
}
Set "clarifyRequests" to an empty array when you're ready to decide — presence of requests means you want answers BEFORE this selection is final (the harness will call you again with the findings; keep deciding fields null-safe but always include them).

DOCTRINE:
${COMP_DOCTRINE}
`

const REVISION_PROMPT = `The deterministic gate REJECTED your previous selection.  It is code, not a model — it cannot be argued with, only satisfied. Review the named violations and the debug note, correct the selection, and post again under the same JSON contract.
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
    // Code-stamped disqualifiers — the disprove-first half of the sheet.
    // Empty means nothing deterministic could rule the comp out.
    exclusionReasons: exclusionReasons(c, evidence),
    // Deterministic match sheet — geo tier + physical variance vs the
    // subject, computed in code. Instant, auditable, no model call.
    matchProfile: compMatchProfile(evidence.subject, c),
    coverPhotoUrl: c.coverPhotoUrl ?? null,
    evidenceCoverage: c.evidenceCoverage ?? null,
    priceLadder: c.priceLadder ?? null,
    observables: c.observables ?? null,
    adjustedPrice: c.adjustedPrice ?? null,
  }))
}

/** Deterministic disqualifiers, stamped per comp row — the disprove-first
 *  half of the evidence sheet. Code owns the verdict; the appraiser's job
 *  is to confirm and move on. */
function exclusionReasons(c: HarnessEvidence['comps'][number], evidence: HarnessEvidence): string[] {
  const rules = evidence.rules
  const reasons: string[] = []
  if (c.isEnabled === false) reasons.push('disabled by the filter rules')
  const mp = compMatchProfile(evidence.subject, c)
  if (mp.geoTier === 'OFF_POCKET') {
    reasons.push(c.distanceMiles != null
      ? `no geo match — outside block group/neighborhood/subdivision/tract (${c.distanceMiles.toFixed(1)} mi)`
      : 'no geo match — outside block group/neighborhood/subdivision/tract')
  } else if (mp.geoTier === 'TRACT') {
    reasons.push('weak geo — tract-level match only (outside block group/neighborhood/subdivision)')
  }
  if (c.saleDate) {
    const ageDays = Math.floor((Date.now() - new Date(c.saleDate).getTime()) / 864e5)
    if (Number.isFinite(ageDays) && ageDays > rules.preferredSaleAgeDays) {
      reasons.push(`stale sale (${ageDays}d old vs ${rules.preferredSaleAgeDays}d rule)`)
    }
  }
  const v = c.evidenceVerification as Record<string, unknown> | null | undefined
  if (v?.priceCheck === 'unverified' || v?.priceCheck === 'divergent') reasons.push('price uncorroborated by AVM')
  const vsMed = c.priceLadder?.ppsfVsMedian
  if (typeof vsMed === 'number' && vsMed < 0.75) {
    reasons.push('fits rules but priced far below the pocket — investor-grade sale, not ARV evidence')
  }
  return reasons
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
/** Decisions clarify — the appraiser's evidence sub-agent. Turns each
 *  clarify request into yes/no + probability questions on the comp row;
 *  probability scoring at speed, zero reasoning seat. */
async function decisionsClarify(
  env: Parameters<typeof createSpecialistProvider>[0] & DecisionsEnv,
  evidence: HarnessEvidence,
  req: { compId: string | null; question: string },
): Promise<ClarifyFinding | null> {
  const comp = req.compId ? evidence.comps.find((c) => c.id === req.compId) : undefined
  const img = comp?.coverPhotoUrl ? await fetchImageAsBase64(comp.coverPhotoUrl).catch(() => null) : null
  const res = await decisionsRun(env, {
    state: {
      role: 'Evidence clarification — answer ONLY from the supplied property data.',
      question: req.question,
      subject: evidence.subject,
      comp: comp ? appraiserCompRows({ ...evidence, comps: [comp] })[0] : null,
      rules: [
        'Answer only what the supplied evidence supports.',
        'A low probability means the evidence does not support the claim — not that the claim is false.',
      ],
    },
    questions: {
      clarify_verdict: {
        type: 'choice',
        criteria: {
          SUPPORTS: 'the evidence supports the proposition in the question',
          REFUTES: 'the evidence contradicts it',
          UNVERIFIED: 'the evidence cannot settle it either way',
        },
        instructions: `Decide whether the supplied evidence settles this question: "${req.question}"`,
      },
      clarify_probability: {
        type: 'noul',
        instructions: req.question,
      },
    },
    images: img ? [{ content_type: img.mimeType, base64: img.base64 }] : [],
  }).catch(() => null)
  const a = res?.answers as Record<string, { choice?: string | boolean | null; probability?: number; confidence?: number }> | undefined
  if (!a) return null
  const verdict = typeof a.clarify_verdict?.choice === 'string' ? a.clarify_verdict.choice : 'UNVERIFIED'
  const p = typeof a.clarify_probability?.probability === 'number' ? a.clarify_probability.probability : null
  return {
    compId: req.compId,
    question: req.question,
    answer: `${verdict} — probability ${p == null ? 'n/a' : p.toFixed(2)}`,
    confidence: typeof a.clarify_verdict?.confidence === 'number' ? a.clarify_verdict.confidence : (p ?? 0.5),
  }
}

/** Gate-failure cross-examination — when the gate rejects, each failed
 *  check becomes a targeted Decisions question per picked comp: does the
 *  evidence ACTUALLY violate the named rule? Never re-asks the same
 *  question — it probes whether the violation is real. Findings feed the
 *  next revision round through clarificationFindings. */
async function gateFailClarify(
  env: Parameters<typeof createSpecialistProvider>[0] & DecisionsEnv,
  evidence: HarnessEvidence,
  selection: AgentSelection,
  grade: VerdictGrade,
): Promise<ClarifyFinding[]> {
  const fails = grade.gateFails.length > 0 ? grade.gateFails : grade.failures
  if (fails.length === 0) return []
  const feedback = grade.gateFeedback.join('; ')
  const pickedRows = appraiserCompRows({ ...evidence, comps: evidence.comps.filter((c) => selection.selectedCompIds.includes(c.id)) })
  const questions: Record<string, { type: 'noul'; instructions: string }> = {}
  for (const row of pickedRows) {
    for (const fail of fails) {
      questions[`xq_${fail}_${row.compId}`] = {
        type: 'noul',
        instructions: `The deterministic gate rejected the selection of comp ${row.address ?? row.compId} citing "${fail}" (detail: ${feedback}). Given ONLY this comp's supplied data, is that violation actually true of this comp? Answer the violation probability — cross-examine, do not re-derive the comp's classification.`,
      }
    }
  }
  if (Object.keys(questions).length === 0) return []
  const res = await decisionsRun(env, {
    state: {
      role: 'Gate-failure cross-examination — verify whether named violations are real.',
      gateViolations: { checks: grade.checks, failures: grade.failures, feedback: grade.gateFeedback },
      pickedComps: pickedRows,
      rules: ['Judge only whether the named violation is true of each comp.', 'A high probability confirms the violation; a low probability says the evidence does not support it.'],
    },
    questions,
  }).catch(() => null)
  const findings: ClarifyFinding[] = []
  for (const [name, a] of Object.entries(res?.answers ?? {})) {
    const ans = a as { probability?: number; confidence?: number }
    if (typeof ans?.probability !== 'number') continue
    const [fail, compId] = name.replace(/^xq_/, '').split(/_(.+)/)
    findings.push({
      compId: compId ?? null,
      question: `gate violation "${fail}" real?`,
      answer: `violation probability ${ans.probability.toFixed(2)}`,
      confidence: ans.confidence ?? 0.5,
    })
  }
  return findings
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
  // Sonnet 5.5 is the appraiser seat on the observable-evidence lane —
  // high effort on the first pass, max effort on every retry.
  const provider = createSpecialistProvider(env, 'routine') ?? createSpecialistProvider(env, 'expert')
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
    marketBenchmark: evidence.marketBenchmark ?? null,
    subjectObservables: evidence.subjectObservables ?? null,
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
      reasoning: { enabled: true, effort: lastGrade ? 'xhigh' : 'high' },
    }).catch((e) => { console.warn('[appraiser] execute failed', e?.message ?? e); return null })
    const parsed = res?.data?.content ? parseSelection(res.data.content) : null
    if (!parsed) {
      console.warn('[appraiser] unparseable response', JSON.stringify({ hasData: !!res?.data, hasContent: !!res?.data?.content, preview: typeof res?.data?.content === 'string' ? res.data.content.slice(0, 300) : null, err: res?.error ?? null }))
      out.unavailable = out.attempts.length === 0; break
    }

    // Clarify round — Opus asks, haiku answers, loop continues.
    const wantsClarify = Array.isArray(parsed.clarifyRequests)
      && (parsed.clarifyRequests as unknown[]).length > 0
      && clarificationsUsed < MAX_CLARIFICATIONS
    if (wantsClarify) {
      const reqs = (parsed.clarifyRequests as Array<{ compId?: unknown; question?: unknown }>)
        .filter((r) => typeof r.question === 'string' && r.question.length > 0)
        .slice(0, MAX_CLARIFICATIONS - clarificationsUsed)
      const answers = await Promise.all(reqs.map((r) => decisionsClarify(env, evidence, {
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
          checks: { d1: 'pass', d2: 'pass', d4: 'pass', d5: 'pass', d6: 'pass', d7: 'pass', d8: 'pass' },
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
        checks: { d1: 'pass', d2: 'pass', d4: 'pass', d5: 'pass', d6: 'pass', d7: 'pass', d8: 'pass' },
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

    // Gate fail → Decisions cross-examines each failed check on the picked
    // comps; findings ride the next attempt's clarificationFindings.
    lastGrade = grade
    const xqFindings = await gateFailClarify(env, evidence, sel, grade)
    if (xqFindings.length > 0) {
      clarificationBlock = [...clarificationBlock, ...xqFindings]
      out.clarifications = clarificationBlock
    }
    lastDebug = null
    if (++revisionsUsed > MAX_REVISIONS) {
      out.attempts[out.attempts.length - 1]!.decision = 'rejected'
      break
    }
  }
  return out
}
