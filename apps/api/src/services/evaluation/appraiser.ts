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

import { createReasoningProvider, createSpecialistProvider } from '../llm'
import { decisionsRun, type DecisionsEnv } from '../decisions'
import { fetchImageAsBase64 } from '../llm/image-utils'
import { compMatchProfile } from './observable'
import { COMP_DOCTRINE } from './comp-doctrine'
import { gradeVerdict, type VerdictGrade } from './verdict-grade'
import type { AgentSelection, HarnessEvidence, Phase1Context, SelectionAttempt } from './index'
import { validateAgentSelection } from './index'
import { assistModel, assistReason } from './assist'
import { noCompPassesRules } from './rule-passers'

const MAX_CLARIFICATIONS = 5
/** Ceiling on the assist model's shadow selection (A/B runs only). */
const SHADOW_SELECTION_TIMEOUT_MS = 240_000
/** Ceiling on one selection call when the reasoning-lane model holds the
 *  appraiser seat — a full pool at high effort outruns the 60s default. */
const APPRAISER_SEAT_TIMEOUT_MS = 480_000
/** Reasoning requests the appraiser may send its assist sub-agent per review. */
const MAX_REASONING_REQUESTS = 5
const MAX_REVISIONS = 2

const APPRAISER_PROMPT = `You are the appraiser — the final decision maker on comp selection and ARV for a wholesale real-estate acquisition.

You receive the COMPLETE dataset: the subject property with its haiku-assigned condition tier, the full comp pool each with a haiku condition classification (label, tier, evidence summary, and a comp-rules check noting any rules a comp fails or fields it lacks), geo stamps, verification flags, and cover-photo URLs you may cite.

You also receive the block-group PRICE LADDER (blockLadder): the pocket's sales split by $/sf into natural top/middle/bottom clusters — the top-cluster median is the ARV band, the bottom-cluster median is the as-is/investor band. Each comp carries its ladder rung and $/sf ratios (priceLadder.ppsfVsMedian, priceLadder.ppsfVsTop) plus evidenceCoverage ('photo+desc' | 'photo' | 'desc' | null) saying what the classifier could actually see — weigh photo-verified reads above description-only ones, and treat 'desc'-only or null coverage as weak condition evidence.

Each comp also carries OBSERVABLE ANSWERS (observables): small evidence reads from its cover photo + description + closed price + street view — pricePosition vs the pocket benchmark (codePosition is the code-verified tier), descCondition, coverPhotoEvidence, renoClaimP, priceConditionAgreement, unexplainedPremiumP (extreme-variance outlier detector — near 1 only means a far-outlier sale like $1M in a $300k pocket; a renovated comp's modest premium is explained and scores ~0), premiumAttributes + premiumProbabilities (satellite lot read — WATERFRONT / CORNER_CULDESAC / LARGE_LOT / VIEW / POOL — a comp premium the subject may not share), siteFacts (yes/no aerial facts — waterfront, lakefront, riverfront, cornerLot, culdesac, frontsBusyRoad / backsBusyRoad / sidesBusyRoad, commercial, infillLot, pool — null means no evidence to answer), siteExposure (adverse site edge on the aerial), finalTier, physicalMatchP (probability the comp's street view physically matches the subject — style/stories/garage/curb appeal), exteriorMatchP (probability the comp's listing cover photo shows a house whose exterior matches the subject's listing cover photo — style/stories/roofline/garage/materials; null when either photo is missing, and trust it less when coverIsFrontP or subjectCoverIsFrontP is low because that photo is not a front-of-house shot), conditionTierProbabilities (probability per renovation tier behind conditionTier), and arvFitnessP (probability the comp is a finished/renovated/move-in-ready version of the subject — the ARV-grade ladder: flipper-complete highest, maintained ~70-80s, fixer/investor lowest). The marketBenchmark block is the matched-pocket distribution those positions classify against. Read the tiers as: priced ABOVE_MEDIAN ≈ renovated/ARV-band evidence, at MEDIAN ≈ median-market evidence, priced far BELOW_MEDIAN ≈ investor/as-is evidence — but a price tier is not proof of condition; weight conflicts the observables preserved (e.g. above-median price with DISTRESSED description means a suspect comp, not an ARV anchor — while unexplainedPremium ≈ 1 means an extreme outlier, likely bad data).

Each comp row also carries exclusionReasons — code-stamped disqualifiers (geo, uncorroborated price, investor-priced) plus soft cautions (stale sale). These are facts, not suggestions: a hard exclusionReason means the comp is disqualified evidence unless the reason is demonstrably wrong. A stale-sale caution is NOT a disqualification — see rule 5.

Your job, IN ORDER:
1. DISQUALIFY FIRST. Read every comp's exclusionReasons and the observables — confirm the disqualifications and set those comps aside before selecting anything. A comp that is merely cheap-but-legal ("investor-grade") is real data but not ARV evidence.
2. From the survivors, pick the comps that set the ARV — the genuinely renovated retail evidence — name which picks drove the number, and post the ARV. Prefer high arvFitnessP AND high physicalMatchP: a comp that both fits the rules and resembles the subject's finished state is the strongest evidence.
3. GEOGRAPHY IS STRICT — never reach outside the pocket for a better-matching house. Order: same neighborhood/subdivision FIRST, then same block group, then same census tract. A comp outside the named pocket must never cut ahead of an in-pocket match. If NO in-pocket comp qualifies, select the median comps of the subject's pocket (median fallback) — the pocket's own market, not a similar house across town.

4. POCKET-PRICE DISCIPLINE — the pocket's median sale price bounds every pick. Prefer comps priced within +5% of the pocket median; up to +10% is fallback-only. A driver priced more than +10% over the pocket median belongs to a different market — demote it to supporting context, never let it drive ARV. Prefer above-market comps that satisfy the rules (above-median price band, real ARV evidence); when none qualify, fall back to at-market picks. Never stretch the rules just to land an above-market pick.
5. Do not pick flagged/non-market sales (nominal, data_error, disabled). A comp priced wildly off its condition group is not evidence. FEATURE MISMATCH: a comp premium the subject cannot sell — a pool on the comp when the subject has none, waterfront, an oversized lot (its premiumAttributes/premiumProbabilities vs subject.poolType and the subject's own lot reads) — explains THAT comp's higher price, not the subject's value. Treat it as bound evidence, never a driver, unless the unmatched feature's contributory value is small and you name it.
6. STALENESS IS A CAUTION, NOT A VETO. When the market itself is stale, the pocket's renovated sales are the freshest ARV evidence that exists — a completed in-pocket flip IS the realized ARV and belongs in the drivers even past the preferred-sale-age line. Staleness lowers your confidence, not the comp's eligibility — note it in conf/dataQuality instead of excluding or demoting the sale to supporting-only.

WHEN NO COMP PASSES THE FILTER RULES (state.noCompPassesFilterRules is true): every comp is stamped 'disabled by the filter rules', and that stamp is then NOT a disqualifier. Your job is to select the comps that come CLOSEST to the rules — judge each on three things, in this order: (a) location identity — same neighborhood/subdivision first, then same block group, then same tract; (b) physical characteristics — living area, year built, beds/baths, lot, stories, construction, and the exterior match to the subject; (c) how narrowly it misses each filter (a comp 40 sqft over the size limit beats one 600 over; a sale 20 days past the age limit beats one a year past). Say in your notes which rules each pick misses and by how much, and set conf to "low". Non-market sales (nominal, package, bulk, data errors) stay disqualified.

If anything is missing or ambiguous, you may ask the Decisions sub-agent to clarify — up to ${MAX_CLARIFICATIONS} requests TOTAL across the whole review. Ask targeted questions ("does comp X's listing mention a kitchen remodel?", "is comp Y's sale arm's length given the $500 price?"). Decisions answers with probability + verdict; you decide.

You also have a REASONING ASSISTANT — a separate model you can hand a question that needs judgment rather than a probability: weigh conflicting evidence on a comp, look over the findings already gathered (condition reads, satellite reads, exterior match, price position) and say what they add up to, or work out why the gate is rejecting a selection. Up to ${MAX_REASONING_REQUESTS} requests TOTAL across the whole review, and only when it would change your decision — you never have to use it. The assistant answers in prose with its confidence and the evidence it used; it has no authority, you decide.

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
  ],
  "reasoningRequests": [
    { "compId": "<id, or null for a question about the whole pool>", "question": "<question for the reasoning assistant>" }
  ]
}
Set "clarifyRequests" and "reasoningRequests" to empty arrays when you're ready to decide — presence of requests means you want answers BEFORE this selection is final (the harness will call you again with the findings; keep deciding fields null-safe but always include them).

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
    reasoningRequests: {
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
  required: ['selectedCompIds', 'drivers', 'arv', 'conf', 'notes', 'dataQuality', 'flags', 'clarifyRequests', 'reasoningRequests'],
  additionalProperties: false,
} as const

export interface ClarifyFinding {
  compId: string | null
  question: string
  answer: string
  confidence: number
  /** Which sub-agent answered — 'decisions' (probability) when unset */
  source?: 'decisions' | 'assist'
  /** The model that answered, for assist findings */
  model?: string
  /** Evidence the assist model said it relied on */
  evidence?: string[]
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
  /** The reasoning model available as the assist sub-agent this run */
  assistModel?: string | null
  /** How many reasoning requests the appraiser actually sent it */
  assistCalls?: number
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
export function exclusionReasons(c: HarnessEvidence['comps'][number], evidence: HarnessEvidence): string[] {
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
      reasons.push(`caution: stale sale (${ageDays}d old vs ${rules.preferredSaleAgeDays}d rule) — not a disqualifier; in a stale market, in-pocket renovated sales still qualify as drivers`)
    }
  }
  const v = c.evidenceVerification as Record<string, unknown> | null | undefined
  const tx = v?.transactionCheck
  if (tx === 'package_deed') reasons.push('package deed — split-price transfer, not market evidence')
  else if (tx === 'bulk_sale') reasons.push('bulk sale — shared-party portfolio transfer, not market evidence')
  else if (tx === 'nominal_sale') reasons.push('nominal sale — deed transfer price, not market evidence')
  if (v?.priceCheck === 'divergent') reasons.push('price contradicts its own AVM')
  else if (v?.priceCheck === 'unverified') reasons.push('caution: no AVM on record to corroborate price — treat as unverified evidence, not a disqualifier')
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
  reasoningRequests?: unknown
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

/**
 * How many extra rounds the appraiser gets. APPRAISER_SINGLE_PASS=true
 * means one model call: it reads the whole bundle, posts its selection, and
 * the gate grades that — no questions, no revision, no empty-answer retry.
 * A gate rejection then completes on the deterministic engine.
 */
export function appraiserLimits(env: { APPRAISER_SINGLE_PASS?: string }) {
  return env.APPRAISER_SINGLE_PASS === 'true'
    ? { clarifications: 0, reasoning: 0, revisions: 0, emptyRetry: false }
    : { clarifications: MAX_CLARIFICATIONS, reasoning: MAX_REASONING_REQUESTS, revisions: MAX_REVISIONS, emptyRetry: true }
}

const SINGLE_PASS_NOTE = 'This is a single-pass review: you get one answer. Decide from the evidence as given, and leave "clarifyRequests" and "reasoningRequests" empty.'

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
type EffortLevel = (typeof EFFORT_LEVELS)[number]

/**
 * Reasoning effort for one appraiser pass. APPRAISER_EFFORT pins every pass
 * to that level (e.g. 'max'); unset keeps high on the first pass and xhigh
 * on a retry.
 */
export function appraiserEffort(env: { APPRAISER_EFFORT?: string }, retry: boolean): EffortLevel {
  const pinned = EFFORT_LEVELS.find((level) => level === env.APPRAISER_EFFORT)
  return pinned ?? (retry ? 'xhigh' : 'high')
}

/**
 * Output budget for one appraiser pass. Thinking shares this budget with
 * the answer, and it grows with effort — at xhigh/max a 16K budget can be
 * spent entirely on thinking, leaving no room to write the selection.
 */
export function appraiserMaxTokens(effort: EffortLevel): number {
  return effort === 'max' ? 64000 : effort === 'xhigh' ? 32000 : 16384
}

/** The evidence state every selection seat reads — the appraiser, and the
 *  assist model's shadow selection, see exactly the same bundle. */
function appraiserState(evidence: HarnessEvidence) {
  return {
    task: 'Review the complete dataset and post the final comp selection + ARV.',
    noCompPassesFilterRules: noCompPassesRules(evidence.comps),
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
}

export interface ShadowSelection {
  model: string
  durationMs: number
  /** Null when the model's answer was not a usable selection */
  selection: AgentSelection | null
  /** Gate grade of that selection — the same code gate the appraiser faces */
  gate: { accepted: boolean; score: number; gateFails: string[]; failures: string[]; warnings: string[] } | null
  error?: string
}

/**
 * Shadow selection — the assist model makes its own comp selection.
 *
 * For the assist-model A/B only. The arm's model (haiku or DeepSeek) gets
 * the appraiser's exact prompt and evidence, posts one selection, and the
 * deterministic gate grades it. Nothing is fed back: the report's picks and
 * ARV still come from the appraiser. What this records is how each model
 * decides on identical evidence — its picks, drivers, ARV, written
 * reasoning, whether the gate would accept it, and how long it took — so
 * the two arms can be compared on decision quality against latency.
 */
export async function runAssistShadowSelection(
  env: Parameters<typeof createReasoningProvider>[0],
  ctx: Phase1Context,
  evidence: HarnessEvidence,
): Promise<ShadowSelection | null> {
  // A full-pool selection at high reasoning effort can run minutes on a
  // slower model — the point is to measure it, not to cut it off at 60s.
  const provider = createReasoningProvider(env, 'openai/gpt-6-luna', { timeout: SHADOW_SELECTION_TIMEOUT_MS })
  if (!provider) return null
  const started = Date.now()
  const done = (rest: Omit<ShadowSelection, 'model' | 'durationMs'>): ShadowSelection =>
    ({ model: provider.model, durationMs: Date.now() - started, ...rest })
  const prompt = `${APPRAISER_PROMPT}\n\nThis is a single-pass review: decide from the evidence as given and leave "clarifyRequests" and "reasoningRequests" empty.\n\nSTATE:\n${JSON.stringify(appraiserState(evidence))}`
  const res = await provider.execute({
    prompt,
    responseFormat: 'json',
    jsonSchema: { name: 'appraiser_selection', schema: SELECTION_SCHEMA },
    maxTokens: 16384,
    reasoning: { enabled: true, effort: 'high' },
  }).catch((e) => ({ success: false as const, error: { message: e instanceof Error ? e.message : String(e) }, data: undefined }))
  const content = res?.success ? res.data?.content : null
  if (!content) return done({ selection: null, gate: null, error: (res as { error?: { message?: string } })?.error?.message ?? 'no answer' })
  const parsed = parseSelection(String(content))
  const sel = parsed ? toAgentSelection(parsed, new Set(evidence.comps.map((c) => c.id))) : null
  if (!sel) return done({ selection: null, gate: null, error: 'answer was not a usable selection' })
  const invalid = validateAgentSelection(sel, ctx.appraisalResult.comparables)
  if (invalid.length > 0) {
    return done({ selection: sel, gate: { accepted: false, score: 0, gateFails: ['validation'], failures: ['coherence_validation'], warnings: invalid } })
  }
  const grade = gradeVerdict(evidence, sel)
  return done({
    selection: sel,
    gate: { accepted: grade.gateFails.length === 0, score: grade.score, gateFails: grade.gateFails, failures: grade.failures, warnings: grade.warnings },
  })
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
  // The appraiser seat. APPRAISER_SEAT=reasoning puts the reasoning lane's
  // model in it (haiku, or the assist-model arm's model) — the same model
  // then selects the comps, backs up the decision model, and answers its own
  // reasoning requests as a sub-agent. Unset keeps Sonnet 5.5 in the seat.
  // High effort on the first pass, max effort on every retry.
  // Gate-rejection ladder: APPRAISER_ESCALATION_MODEL names the model the
  // seat hands off to once any pass fails the gate (haiku pass 1 → sonnet
  // on every retry, until the gate passes). Unset = one seat for the whole
  // run.
  const escalationModel = (env as { APPRAISER_ESCALATION_MODEL?: string }).APPRAISER_ESCALATION_MODEL
  const makeProvider = (model?: string) =>
    (env as { APPRAISER_SEAT?: string }).APPRAISER_SEAT === 'reasoning'
      ? createReasoningProvider(
          model ? { ...env, REASONING_MODEL: model } : env,
          'openai/gpt-6-luna', { timeout: APPRAISER_SEAT_TIMEOUT_MS })
      : createSpecialistProvider(env, 'routine') ?? createSpecialistProvider(env, 'expert')
  let provider = makeProvider()
  if (!provider) { out.unavailable = true; return out }
  out.model = provider.model

  const compIds = new Set(evidence.comps.map((c) => c.id))
  const baseState = appraiserState(evidence)

  out.assistModel = assistModel(env)
  out.assistCalls = 0
  let clarificationsUsed = 0
  let reasoningUsed = 0
  let revisionsUsed = 0
  let clarificationBlock: ClarifyFinding[] = []
  let lastGrade: VerdictGrade | null = null
  let lastDebug: string | null = null
  let emptyResponseRetry = false
  const limits = appraiserLimits(env as { APPRAISER_SINGLE_PASS?: string })
  const singlePass = limits.revisions === 0 && limits.clarifications === 0 && limits.reasoning === 0

  // Decision loop — clarify rounds count against MAX_CLARIFICATIONS; gate
  // rejects consume revisions; a passing grade (or a plain-text answer we
  // can coerce) ends the loop.
  for (let round = 0; round <= limits.clarifications + limits.reasoning + limits.revisions + 1; round++) {
    // A rejected pass moves the seat to the escalation model for every
    // remaining attempt.
    if (lastGrade && escalationModel && provider!.model !== escalationModel) {
      const next = makeProvider(escalationModel)
      if (next) {
        provider = next
        out.model = next.model
        out.debugNotes.push(`appraiser: gate rejected — escalating seat to ${escalationModel}`)
      }
    }
    const state = {
      ...baseState,
      ...(clarificationBlock.length ? { clarificationFindings: clarificationBlock } : {}),
      ...(lastGrade ? { rejectedSelection: { feedback: lastGrade.gateFeedback, failures: lastGrade.failures }, gateDebugNote: lastDebug } : {}),
    }
    const prompt = lastGrade
      ? `${REVISION_PROMPT}\n\n${APPRAISER_PROMPT}\n\nSTATE:\n${JSON.stringify(state)}`
      : `${APPRAISER_PROMPT}${singlePass ? `\n\n${SINGLE_PASS_NOTE}` : ''}\n\nSTATE:\n${JSON.stringify(state)}`

    const effort = appraiserEffort(env as { APPRAISER_EFFORT?: string }, !!(lastGrade || emptyResponseRetry))
    const res = await provider.execute({
      prompt,
      responseFormat: 'json',
      jsonSchema: { name: 'appraiser_selection', schema: SELECTION_SCHEMA },
      maxTokens: appraiserMaxTokens(effort),
      reasoning: { enabled: true, effort },
    }).catch((e) => { console.warn('[appraiser] execute failed', e?.message ?? e); return null })
    const parsed = res?.data?.content ? parseSelection(res.data.content) : null
    if (!parsed) {
      console.warn('[appraiser] unparseable response', JSON.stringify({ hasData: !!res?.data, hasContent: !!res?.data?.content, preview: typeof res?.data?.content === 'string' ? res.data.content.slice(0, 300) : null, err: res?.error ?? null }))
      if (!emptyResponseRetry && limits.emptyRetry) { emptyResponseRetry = true; continue } // one retry at xhigh before failing closed
      out.unavailable = out.attempts.length === 0; break
    }

    // Sub-agent round — the appraiser asks, the sub-agents answer, the loop
    // continues. Probability questions go to Decisions; reasoning questions
    // go to the assist model. Each has its own budget, and a round with any
    // answerable request is not a selection (and consumes no revision), so
    // the appraiser can also ask after a gate rejection.
    const requestsOf = (v: unknown) => (Array.isArray(v) ? v as Array<{ compId?: unknown; question?: unknown }> : [])
      .filter((r) => typeof r.question === 'string' && r.question.length > 0)
      .map((r) => ({
        compId: typeof r.compId === 'string' && compIds.has(r.compId) ? r.compId : null,
        question: String(r.question),
      }))
    const clarifyReqs = requestsOf(parsed.clarifyRequests).slice(0, limits.clarifications - clarificationsUsed)
    const reasoningReqs = out.assistModel
      ? requestsOf(parsed.reasoningRequests).slice(0, limits.reasoning - reasoningUsed)
      : []
    if (clarifyReqs.length > 0 || reasoningReqs.length > 0) {
      const rows = appraiserCompRows(evidence)
      const [clarified, reasoned] = await Promise.all([
        Promise.all(clarifyReqs.map((r) => decisionsClarify(env, evidence, r))),
        Promise.all(reasoningReqs.map((r) => assistReason(env, {
          evidence,
          comps: rows,
          request: r,
          gateFeedback: lastGrade ? { failures: lastGrade.failures, feedback: lastGrade.gateFeedback } : null,
        }))),
      ])
      // A request counts against its budget whether or not it was answered —
      // an unanswerable question must not be re-asked forever.
      clarificationsUsed += clarifyReqs.length
      reasoningUsed += reasoningReqs.length
      out.assistCalls = reasoningUsed
      for (const a of clarified) if (a) clarificationBlock.push({ ...a, source: 'decisions' })
      for (const a of reasoned) {
        if (a) clarificationBlock.push({ compId: a.compId, question: a.question, answer: a.answer, confidence: a.confidence, source: 'assist', model: a.model, evidence: a.evidence })
      }
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
          checks: { d1: 'pass', d2: 'pass', d4: 'pass', d5: 'pass', d6: 'pass', d7: 'pass', d8: 'pass', d9: 'pass' },
          score: 0, failures: ['coherence_validation'], warnings: [], scorePenalty: 0,
          gateFails: ['validation'], gateFeedback: vfails, gradedAt: new Date().toISOString(),
        }
        out.attempts.push({ selection: sel, grade, decision: 'rejected', at: new Date().toISOString() })
        lastGrade = grade
        lastDebug = null
        if (++revisionsUsed > limits.revisions) break
        continue
      }
    }
    if (!sel) {
      // Unusable selection shape — one more chance counts as a revision.
      if (++revisionsUsed > limits.revisions) break
      lastGrade = {
        checks: { d1: 'pass', d2: 'pass', d4: 'pass', d5: 'pass', d6: 'pass', d7: 'pass', d8: 'pass', d9: 'pass' },
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
    // No revision left to use the findings — skip the cross-examination.
    const xqFindings = revisionsUsed >= limits.revisions ? [] : await gateFailClarify(env, evidence, sel, grade)
    if (xqFindings.length > 0) {
      clarificationBlock = [...clarificationBlock, ...xqFindings]
      out.clarifications = clarificationBlock
    }
    lastDebug = null
    if (++revisionsUsed > limits.revisions) {
      out.attempts[out.attempts.length - 1]!.decision = 'rejected'
      break
    }
  }
  return out
}
