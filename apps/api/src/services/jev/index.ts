/**
 * Jev integration — two surfaces:
 *
 * 1. COMP TRUTH + SELECTION (authoritative): every candidate comparable gets
 *    a Noul "truth" score (0–1: is this comp reliable evidence of the
 *    subject's market value). The top-N by truth become the ARV set — Jev is
 *    in charge of total comp selection. Appraisal rules still run first and
 *    their results are part of Jev's evidence; they remain visible on cards.
 *
 * 2. OUTCOME CLASSIFICATION (read-only): Jev sees the COMPLETED analysis and
 *    labels the outcome along five dimensions plus atomic driver sub-checks.
 *    Attached to the response for display/review only. `answers` carries
 *    every returned answer verbatim — the durable API contract that keeps
 *    the five outcome dimensions in the response even when question types
 *    change (choice/score/noul or future primitives).
 */

import type { AnalysisResponse } from '../analysis'
import type { NormalizedComparable, NormalizedProperty } from '../property-api/types'
import type { AppraisedComparable } from '../appraisal/types'

export interface JevEnv {
  TYPESAFE_API_KEY?: string
  TYPESAFE_MODEL?: string
  /** 'true' → Candidate B structured choice drives comp routing (default false = Baseline A) */
  JEV_COMP_CLASSIFIER_V2_ENABLED?: string
  /** 'false' disables the Candidate B shadow run (default on — measures B beside A) */
  JEV_COMP_CLASSIFIER_V2_SHADOW?: string
}

export const OUTCOME_DIMENSIONS = [
  'evidence_sufficiency',
  'comp_set_quality',
  'deal_outlook',
  'recommendation_agreement',
  'risk_flags',
] as const
export type JevOutcomeDimension = typeof OUTCOME_DIMENSIONS[number]

/**
 * A single Jev answer, passed through unmodified. `choice`, `score`, and
 * `noul` are today's primitives; any future answer type still lands in
 * `answers` so API consumers always see what Jev returned.
 */
export type JevAnswer = {
  type: string
  choice?: string
  score?: number
  noul?: number
  confidence?: number
  probabilities?: Record<string, number>
} & Record<string, unknown>

/** Driver sub-check: 0–1 probability the statement holds. Keyed `dimension.key`. */
export type JevOutcomeDrivers = Record<JevOutcomeDimension, Record<string, number>>

export type JevOutcomeClassification =
  | {
      status: 'completed'
      /**
       * The five outcome dimensions, keyed by dimension name — the stable
       * API contract. Each entry is Jev's raw answer whatever its primitive:
       * `choice` answers carry `.choice`, `score` answers `.score`, `noul`
       * answers `.noul`. A dimension is absent only when Jev returned no
       * answer for it; it is never dropped because its type changed.
       */
      classifications: Partial<Record<JevOutcomeDimension, JevAnswer>>
      /** Atomic yes/no sub-checks that expose what drove each headline label */
      drivers: JevOutcomeDrivers
      /**
       * Every answer Jev returned, keyed by question key — the durable API
       * contract. Survives question-type changes (choice/score/noul or
       * future types), added questions, and renamed keys.
       */
      answers: Record<string, JevAnswer>
      model: string
      latencyMs: number
      inputTokens: number
      classifiedAt: string
    }
  | { status: 'skipped' | 'unavailable'; reason: string }

type ChoiceQuestion = {
  type: 'choice'
  instructions: string
  criteria: Record<string, string>
}
type ScoreQuestion = {
  type: 'score'
  instructions: string
  /** Ordered level descriptions — position in the array is the level number */
  criteria: string[]
}
type NoulQuestion = { type: 'noul'; instructions: string }
type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const TIMEOUT_MS = 20_000

const encoder = new TextEncoder()
function serialized(value: unknown): string {
  try {
    const json = JSON.stringify(value)
    if (typeof json !== 'string') throw new Error()
    return json
  } catch {
    throw new Error('Jev outcome evidence must be JSON-serializable.')
  }
}
const bytes = (value: unknown) => encoder.encode(serialized(value)).byteLength
const REQUEST_BYTES = 56_000

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
const probability = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

const descriptions: Record<JevOutcomeDimension, string> = {
  evidence_sufficiency:
    'Whether the supplied comparable and market evidence is sufficient to rely on this outcome.',
  comp_set_quality:
    'How strong the selected comp set is as evidence for the produced ARV.',
  deal_outlook:
    'The deal economics implied by the valuation (ARV, buy price, projected profit/ROI).',
  recommendation_agreement:
    'Whether the computed recommendation follows from the supplied evidence.',
  risk_flags:
    'Whether the outcome evidence contains material risk factors (thin comps, stale sales, location penalties, low confidence).',
}

const CRITERIA: Record<JevOutcomeDimension, Record<string, string>> = {
  evidence_sufficiency: {
    sufficient: 'Evidence adequately supports the outcome.',
    limited: 'Evidence exists but is thin, stale, or partially missing.',
    insufficient: 'Evidence is too weak or missing to support the outcome.',
  },
  comp_set_quality: {
    strong: 'Selected comps are recent, nearby, and physically similar.',
    adequate: 'Selected comps are usable but with notable compromises.',
    weak: 'Selected comps are poor evidence for this subject.',
  },
  deal_outlook: {
    favorable: 'Deal economics look favorable under the supplied valuation.',
    marginal: 'Deal economics are borderline under the supplied valuation.',
    unfavorable: 'Deal economics look unfavorable under the supplied valuation.',
  },
  recommendation_agreement: {
    agree: 'The computed recommendation is consistent with the evidence.',
    disagree: 'The computed recommendation conflicts with the evidence.',
    uncertain: 'Evidence is too mixed or thin to judge the recommendation.',
  },
  risk_flags: {
    none: 'No material risk factors in the supplied outcome evidence.',
    minor: 'Minor risk factors present that a reviewer should note.',
    material: 'Material risk factors present that undermine the outcome.',
  },
}

function question(dimension: JevOutcomeDimension): ChoiceQuestion {
  return {
    type: 'choice',
    instructions: `Classify the completed property analysis outcome on ${dimension}: ${descriptions[dimension]} Use only the supplied state.outcome, state.subject, state.comps and state.appraisalRules as evidence. Missing/null values are unknown, never false or zero. This is a read-only label — it cannot change the outcome.`,
    criteria: CRITERIA[dimension],
  }
}

/**
 * Atomic yes/no sub-checks per dimension. These are Jev's "reasoning",
 * exposed as data: each noul answers one concrete factor feeding the
 * headline label. `favorable` drivers read yes=good; `risk` drivers read
 * yes=risk present. Dashboard labels mirror these keys.
 */
const DRIVERS: Record<JevOutcomeDimension, Array<{ key: string; favorable: boolean; instructions: string }>> = {
  evidence_sufficiency: [
    { key: 'enough_comps', favorable: true, instructions: 'The outcome is supported by at least three enabled comparable sales.' },
    { key: 'recent_sales', favorable: true, instructions: 'The selected comparable sales are recent enough to reflect current market value (roughly the trailing 12 months).' },
    { key: 'condition_verified', favorable: true, instructions: 'The subject condition or renovation level is backed by direct evidence rather than assumption.' },
  ],
  comp_set_quality: [
    { key: 'comps_nearby', favorable: true, instructions: 'The selected comps are geographically close to the subject — roughly within a mile or in the same neighborhood.' },
    { key: 'comps_similar', favorable: true, instructions: 'The selected comps are physically similar to the subject in size, age, and bed/bath count.' },
    { key: 'minor_adjustments', favorable: true, instructions: 'Price adjustments applied to the selected comps are minor relative to their sale prices.' },
  ],
  deal_outlook: [
    { key: 'adequate_margin', favorable: true, instructions: 'Projected profit and ROI meet a typical investor threshold for this price range.' },
    { key: 'headroom', favorable: true, instructions: 'The ARV comfortably exceeds buy price plus rehab and transaction costs.' },
  ],
  recommendation_agreement: [
    { key: 'numbers_support', favorable: true, instructions: 'The valuation metrics — profit, ROI, margin — support the computed recommendation.' },
    { key: 'evidence_supports', favorable: true, instructions: 'The quality of the comp evidence supports the computed recommendation.' },
  ],
  risk_flags: [
    { key: 'thin_evidence', favorable: false, instructions: 'The outcome relies on thin or weak comparable evidence.' },
    { key: 'stale_sales', favorable: false, instructions: 'Key comparable sales are stale or near the edge of the acceptable window.' },
    { key: 'location_risk', favorable: false, instructions: 'Location-based penalties or flags materially affect this outcome.' },
    { key: 'data_gaps', favorable: false, instructions: 'Material subject or comparable data fields are missing or unknown where the outcome depends on them.' },
  ],
}

const DRIVER_KEYS = Object.fromEntries(
  Object.entries(DRIVERS).flatMap(([dimension, drivers]) =>
    drivers.map((driver) => [`driver_${dimension}_${driver.key}`, { dimension: dimension as JevOutcomeDimension, key: driver.key }]),
  ),
) as Record<string, { dimension: JevOutcomeDimension; key: string }>

function driverQuestion(dimension: JevOutcomeDimension, driver: { instructions: string }): NoulQuestion {
  return {
    type: 'noul',
    instructions: `${driver.instructions} Judge against state.outcome, state.comps, state.report and state.subject only — the ${dimension} factor. Missing/null values are unknown; answer by what the supplied evidence supports, not by assumption.`,
  }
}

type CompItem = AnalysisResponse['comps']['items'][number]

function projectComp(comp: CompItem): Record<string, unknown> {
  const failed = (comp.appraisalRules?.filters ?? [])
    .filter((f) => f.passed === false)
    .map((f) => f.type)
  return {
    address: comp.address,
    salePrice: comp.salePrice,
    saleDate: comp.saleDate,
    squareFeet: comp.squareFeet,
    pricePerSqft: comp.pricePerSqft,
    distanceMiles: comp.distanceMiles,
    yearBuilt: comp.yearBuilt,
    bedrooms: comp.bedrooms,
    bathrooms: comp.bathrooms,
    adjustedPrice: comp.adjustedPrice,
    subdivision: comp.subdivision,
    compGroup: comp.compGroup ?? null,
    jevArvTruth: comp.jevArvTruth ?? null,
    jevInvestmentTruth: comp.jevInvestmentTruth ?? null,
    failedFilters: failed.length ? failed : null,
  }
}

function projectOutcome(response: AnalysisResponse): Record<string, unknown> {
  const v = response.valuation
  const s = response.subject
  const enabled = response.comps.items.filter((c) => c.isEnabled)
  return {
    subject: {
      address: s.address,
      county: s.county,
      bedrooms: s.bedrooms,
      bathrooms: s.bathrooms,
      squareFeet: s.squareFeet,
      lotSizeAcres: s.lotSizeAcres,
      yearBuilt: s.yearBuilt,
      propertyType: s.propertyType,
      subdivision: s.subdivision,
      neighborhoodName: s.neighborhoodName,
      lastSale: s.lastSale,
      listPrice: s.listPrice,
      condition: s.condition,
      classification: s.classification
        ? { type: s.classification.type, confidence: s.classification.confidence }
        : null,
      curbAppeal: s.curbAppeal?.condition ?? null,
    },
    outcome: {
      arv: v.arv,
      arvPerSqft: v.arvPerSqft,
      arvSource: v.arvSource,
      asIsValue: v.asIsValue,
      afterRenovationValue: v.afterRenovationValue,
      buyPrice: v.buyPrice,
      buyPricePercent: v.buyPricePercent,
      rehabCost: v.rehabCost,
      rehabLevel: v.rehabLevel,
      locationPenalty: v.locationPenalty,
      projectedProfit: v.projectedProfit,
      projectedROI: v.projectedROI,
      wholesalePrice: v.wholesalePrice,
      recommendation: v.recommendation ?? null,
      recommendationReason: v.recommendationReason ?? null,
      // Pipeline self-assessment (confidence gate, human-review flag) is
      // deliberately excluded: it derives from the same evidence Jev is
      // judging, so feeding it back would double-count the negatives.
    },
    comps: {
      candidatesConsidered: response.comps.total,
      selectedCount: enabled.length,
      // Jev truth-ranked the whole candidate pool; non-selected candidates
      // simply ranked lower — they are not rejections or rule failures.
      selectionMethod: 'jev_truth_ranking',
      avgPricePerSqft: response.comps.avgPricePerSqft,
      medianPrice: response.comps.medianPrice,
      bestMatch: response.comps.bestMatch ?? null,
      selected: enabled.map(projectComp),
    },
    report: response.report
      ? {
          // Step provenance only — the report's confidence gate and fallback
          // notes are pipeline self-assessment, not evidence.
          steps: response.report.steps.map((step) => ({
            step: step.step,
            status: step.status,
          })),
        }
      : null,
    appraisalRules: response.appliedSettings
      ? {
          filters: response.appliedSettings.filters,
          adjustments: response.appliedSettings.adjustments,
        }
      : null,
  }
}

function parseResponse(
  json: unknown,
): {
  classifications: Partial<Record<JevOutcomeDimension, JevAnswer>>
  drivers: JevOutcomeDrivers
  answers: Record<string, JevAnswer>
  model: string
  inputTokens: number
} {
  const malformed = () =>
    new Error('Jev outcome classification returned an invalid or incomplete typed response.')
  if (!object(json) || typeof json.model !== 'string' || !/^jev-[\w.-]+$/.test(json.model) || !object(json.answers) || !object(json.usage)) throw malformed()
  const { input_tokens: inputTokens } = json.usage
  if (typeof inputTokens !== 'number' || !Number.isSafeInteger(inputTokens) || inputTokens < 0) throw malformed()

  // Iterate the answers Jev RETURNED, not the questions we registered —
  // added/renamed/retyped questions all flow through `answers`, and one
  // malformed entry degrades its typed view without dropping the rest.
  const entries = Object.entries(json.answers)
  if (!entries.length) throw malformed()

  const answers: Record<string, JevAnswer> = {}
  const classifications: Partial<Record<JevOutcomeDimension, JevAnswer>> = {}
  const drivers = Object.fromEntries(OUTCOME_DIMENSIONS.map((d) => [d, {}])) as JevOutcomeDrivers
  for (const [key, answer] of entries) {
    if (!object(answer) || typeof answer.type !== 'string') continue
    answers[key] = answer as JevAnswer

    // A dimension answered under ANY primitive lands in `classifications`
    // under its stable name — the report contract survives retyping
    // (choice → score → noul or future types) without code changes.
    if (key.startsWith('outcome_')) {
      const dimension = key.slice('outcome_'.length) as JevOutcomeDimension
      if (OUTCOME_DIMENSIONS.includes(dimension)) classifications[dimension] = answer as JevAnswer
    } else if (key.startsWith('driver_') && answer.type === 'noul' && probability(answer.noul)) {
      const driver = DRIVER_KEYS[key]
      if (driver) drivers[driver.dimension][driver.key] = answer.noul
    }
  }
  return { classifications, drivers, answers, model: json.model, inputTokens }
}

/**
 * Classify a completed analysis outcome. Never throws for a missing key —
 * returns `{ status: 'skipped' }` so the pipeline stays intact. API/parse
 * failures throw; callers decide whether to surface or swallow them.
 */
export async function classifyOutcomeWithJev(
  response: AnalysisResponse,
  env: JevEnv,
): Promise<JevOutcomeClassification> {
  const start = Date.now()
  const key = env.TYPESAFE_API_KEY?.trim()
  if (!key) return { status: 'skipped', reason: 'TYPESAFE_API_KEY not configured' }
  const model = env.TYPESAFE_MODEL?.trim() || 'jev-latest'
  if (!/^jev-[\w.-]+$/.test(model)) throw new Error('Jev outcome classification requires a Jev model identifier.')

  const questions: Record<string, Question> = {
    ...Object.fromEntries(
      OUTCOME_DIMENSIONS.map((dimension) => [`outcome_${dimension}`, question(dimension)]),
    ),
    ...Object.fromEntries(
      Object.entries(DRIVERS).flatMap(([dimension, drivers]) =>
        drivers.map((driver) => [`driver_${dimension}_${driver.key}`, driverQuestion(dimension as JevOutcomeDimension, driver)]),
      ),
    ),
  }
  const body = {
    model,
    state: {
      ...projectOutcome(response),
      evaluationDate: new Date(start).toISOString().slice(0, 10),
      evidenceNote:
        'This analysis outcome was produced by the deterministic v5 pipeline. Jev only labels the outcome; selection and valuation are final.',
    },
    questions,
  }
  if (bytes(body) > REQUEST_BYTES) {
    throw new Error('Jev outcome evidence exceeded the request budget; classification skipped.')
  }

  let httpResponse: Response
  try {
    httpResponse = await fetch(ENDPOINT, {
      method: 'POST',
      redirect: 'manual',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: serialized(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new Error('Jev outcome classification request failed or timed out.')
  }
  if (!httpResponse.ok) {
    // Never expose response bodies: they can echo credentials or request data.
    void httpResponse.body?.cancel().catch(() => {})
    throw new Error(`Jev outcome classification API returned HTTP ${httpResponse.status}.`)
  }
  let json: unknown
  try {
    json = await httpResponse.json()
  } catch {
    throw new Error('Jev outcome classification returned unreadable JSON.')
  }
  const parsed = parseResponse(json)
  return {
    status: 'completed',
    classifications: parsed.classifications,
    drivers: parsed.drivers,
    answers: parsed.answers,
    model: parsed.model,
    latencyMs: Date.now() - start,
    inputTokens: parsed.inputTokens,
    classifiedAt: new Date(start).toISOString(),
  }
}

// ─── Comp truth scoring (Jev is authoritative for selection) ──────────────────

export interface JevCompTruthResult {
  /**
   * compId → dual truth scores. `arvTruth`: evidence of the subject's
   * after-renovation retail value. `investmentTruth`: evidence of what an
   * investor would pay for the subject as-is.
   */
  scores: Record<string, { arvTruth: number; investmentTruth: number }>
  model: string
  latencyMs: number
  inputTokens: number
}

// Copy factual normalized fields explicitly: runtime objects may carry prior
// selection flags or scores — those are not evidence for this decision.
const subjectTruthFields = [
  'id', 'provider', 'address', 'city', 'state', 'zipCode', 'county', 'latitude', 'longitude',
  'bedrooms', 'bathrooms', 'fullBathrooms', 'halfBathrooms', 'squareFeet', 'lotSizeAcres',
  'lotSizeSquareFeet', 'basementSquareFeet', 'yearBuilt', 'effectiveYearBuilt', 'propertyType',
  'stories', 'lastSalePrice', 'lastSaleDate', 'pricePerSqft', 'assessedValue', 'marketValue',
  'construction', 'features', 'subdivision', 'neighborhoodName', 'neighborhoodCode',
  'buildingCondition', 'buildingGrade', 'additionSquareFeet', 'legalDescription',
] as const satisfies readonly (keyof NormalizedProperty)[]

const compTruthFields = [
  'id', 'provider', 'address', 'city', 'state', 'zipCode', 'latitude', 'longitude', 'distanceMiles',
  'bedrooms', 'bathrooms', 'squareFeet', 'lotSizeAcres', 'lotSizeSquareFeet', 'basementSquareFeet',
  'yearBuilt', 'propertyType', 'salePrice', 'saleDate', 'pricePerSqft', 'subdivision', 'parcelId',
  'neighborhoodName', 'neighborhoodCode', 'buildingCondition', 'buildingGrade', 'stories',
  'construction', 'transaction', 'features', 'isEnriched', 'saleReconciled', 'flip',
] as const satisfies readonly (keyof NormalizedComparable)[]

function truthEvidence<T extends object>(value: T, fields: readonly (keyof T)[]): Record<string, unknown> {
  return Object.fromEntries(fields.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]))
}

function compTruthEvidence(comp: AppraisedComparable): Record<string, unknown> {
  const ev = comp.evaluation
  return {
    ...truthEvidence(comp, compTruthFields),
    adjustedSalePrice: comp.adjustedSalePrice ?? null,
    ruleEvidence: ev
      ? {
          failedFilters: ev.filterResults.filter((f) => f.passed === false).map((f) => f.type),
          passedFilterCount: ev.filterResults.filter((f) => f.passed === true).length,
          totalFilterCount: ev.filterResults.length,
          totalAdjustment: ev.totalAdjustment ?? null,
          originalPrice: ev.originalPrice ?? null,
          adjustedPrice: ev.adjustedPrice ?? null,
        }
      : null,
    evidenceNote:
      'Rule results are pipeline evidence about this comp, not a verdict — the truth judgment is yours. Missing/null fields are unknown.',
  }
}

const TRUTH_STATE_AND_QUESTION_BYTES = 28_000

function arvTruthQuestion(index: number): NoulQuestion {
  return {
    type: 'noul',
    instructions: `Is state.comparables[${index}] a reliable source of truth for the subject's AFTER-RENOVATION retail market value — does its sale reflect what a retail buyer would credibly pay for the subject once renovated? This is the ARV bucket: the comp should read like a renovated/retail-priced sale (strong condition signals, retail-grade price per sqft), physically similar and nearby. distanceMiles is the primary location signal — closer is stronger evidence; subdivision and neighborhood are often missing (enrichment is limited to rule-matched comps) and their absence must NOT reduce the score. flip (when present) is a verified profit resale 30–365 days after its priorSale — the flip resale price is strong after-renovation retail evidence. saleReconciled means the sale price/date were corrected to a newer Zillow sale — treat them as current. Judge against state.subject using state.appraisalRules as context; the comp's ruleEvidence lists appraisal-rule outcomes as evidence, not verdicts. Missing or null fields are unknown — they must NOT reduce the score; score only the evidence that is present.`,
  }
}

function investmentTruthQuestion(index: number): NoulQuestion {
  return {
    type: 'noul',
    instructions: `Is state.comparables[${index}] a reliable source of truth for the subject's AS-IS investment value — does its sale reflect what an investor would credibly pay for the subject today, in current condition? This is the investment bucket: the comp should read like an as-is or investment-grade sale (dated/distressed condition or below-retail pricing), physically similar and nearby. distanceMiles is the primary location signal — closer is stronger evidence; subdivision and neighborhood are often missing (enrichment is limited to rule-matched comps) and their absence must NOT reduce the score. flip (when present) is a verified profit resale 30–365 days after its priorSale — priorSale is what an investor paid for it as-is, strong as-is evidence. saleReconciled means the sale price/date were corrected to a newer Zillow sale — treat them as current. Judge against state.subject using state.appraisalRules as context; the comp's ruleEvidence lists appraisal-rule outcomes as evidence, not verdicts. Missing or null fields are unknown — they must NOT reduce the score; score only the evidence that is present.`,
  }
}

type TruthBatch = { ids: string[]; offset: number; body: { model: string; state: Record<string, unknown>; questions: Record<string, NoulQuestion> } }

function makeTruthBatch(
  subject: Record<string, unknown>, rules: unknown, comps: Array<Record<string, unknown>>,
  ids: string[], offset: number, model: string, evaluationDate: string,
): TruthBatch {
  return {
    ids,
    offset,
    body: {
      model,
      state: { subject, appraisalRules: rules, evaluationDate, comparables: comps },
      questions: Object.fromEntries(
        comps.flatMap((_, index) => [
          [`comp_${offset + index}_arv_truth`, arvTruthQuestion(index)],
          [`comp_${offset + index}_investment_truth`, investmentTruthQuestion(index)],
        ]),
      ),
    },
  }
}

function truthFits(batch: { body: { state: Record<string, unknown>; questions: Record<string, Question> } }): boolean {
  const longestQuestion = Math.max(0, ...Object.values(batch.body.questions).map(bytes))
  return bytes(batch.body.state) + longestQuestion <= TRUTH_STATE_AND_QUESTION_BYTES && bytes(batch.body) <= REQUEST_BYTES
}

function truthBatches(
  subject: NormalizedProperty, comps: AppraisedComparable[], rules: unknown,
  model: string, evaluationDate: string,
): TruthBatch[] {
  const subjectEvidence = truthEvidence(subject, subjectTruthFields)
  const result: TruthBatch[] = []
  let pending: Array<Record<string, unknown>> = []
  let ids: string[] = []
  let offset = 0
  for (const comp of comps) {
    const item = compTruthEvidence(comp)
    const next = makeTruthBatch(subjectEvidence, rules, [...pending, item], [...ids, comp.id], offset, model, evaluationDate)
    if (truthFits(next)) { pending.push(item); ids.push(comp.id); continue }
    if (pending.length) {
      result.push(makeTruthBatch(subjectEvidence, rules, pending, ids, offset, model, evaluationDate))
      offset += pending.length
    }
    const single = makeTruthBatch(subjectEvidence, rules, [item], [comp.id], offset, model, evaluationDate)
    if (!truthFits(single)) throw new Error('Jev truth context limit: subject, rules, and one comparable exceed the request budget; evidence was not truncated.')
    pending = [item]
    ids = [comp.id]
  }
  if (pending.length) result.push(makeTruthBatch(subjectEvidence, rules, pending, ids, offset, model, evaluationDate))
  return result
}

function parseTruthResponse(
  value: unknown, batch: TruthBatch,
): { scores: Record<string, { arvTruth: number; investmentTruth: number }>; model: string; inputTokens: number } {
  const malformed = () => new Error('Jev truth scoring returned an invalid or incomplete typed response; no scores were accepted.')
  if (!object(value) || typeof value.model !== 'string' || !/^jev-[\w.-]+$/.test(value.model) || !object(value.answers) || !object(value.usage)) throw malformed()
  const { input_tokens: inputTokens } = value.usage
  if (typeof inputTokens !== 'number' || !Number.isSafeInteger(inputTokens) || inputTokens < 0) throw malformed()
  const keys = Object.keys(batch.body.questions)
  if (Object.keys(value.answers).length !== keys.length || keys.some((key) => !Object.hasOwn(value.answers as object, key))) throw malformed()
  const scores: Record<string, { arvTruth: number; investmentTruth: number }> = Object.create(null)
  batch.ids.forEach((id, index) => {
    const arv = (value.answers as Record<string, unknown>)[`comp_${batch.offset + index}_arv_truth`]
    const inv = (value.answers as Record<string, unknown>)[`comp_${batch.offset + index}_investment_truth`]
    if (!object(arv) || arv.type !== 'noul' || !probability(arv.noul)) throw malformed()
    if (!object(inv) || inv.type !== 'noul' || !probability(inv.noul)) throw malformed()
    scores[id] = { arvTruth: arv.noul, investmentTruth: inv.noul }
  })
  return { scores, model: value.model, inputTokens }
}

/**
 * Score every candidate on two truths — 0–1 nouls for ARV (after-renovation
 * retail value) and investment (as-is investor value) evidence. Jev sees the
 * whole candidate pool per batch, so scores are relative to all supplied
 * addresses. Selection (top-N per bucket) is the caller's decision; this only
 * returns scores. Throws on missing key / API / malformed response — callers
 * degrade to the appraisal-rules selection.
 */
export async function scoreCompTruthWithJev(
  subject: NormalizedProperty,
  comps: AppraisedComparable[],
  appraisalRules: unknown,
  env: JevEnv,
): Promise<JevCompTruthResult> {
  const start = Date.now()
  const evaluationDate = new Date(start).toISOString().slice(0, 10)
  const key = env.TYPESAFE_API_KEY?.trim()
  if (!key) throw new Error('Jev truth scoring requires TYPESAFE_API_KEY.')
  const model = env.TYPESAFE_MODEL?.trim() || 'jev-latest'
  if (!/^jev-[\w.-]+$/.test(model)) throw new Error('Jev truth scoring requires a Jev model identifier.')
  if (comps.some((comp) => typeof comp.id !== 'string' || !comp.id.trim()) || new Set(comps.map((c) => c.id)).size !== comps.length) {
    throw new Error('Jev truth scoring requires a unique, nonempty ID for every comparable.')
  }

  const scores: Record<string, { arvTruth: number; investmentTruth: number }> = Object.create(null)
  let inputTokens = 0
  let actualModel: string | undefined
  for (const batch of truthBatches(subject, comps, appraisalRules, model, evaluationDate)) {
    let httpResponse: Response
    try {
      httpResponse = await fetch(ENDPOINT, {
        method: 'POST',
        redirect: 'manual',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: serialized(batch.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw new Error('Jev truth scoring request failed or timed out.')
    }
    if (!httpResponse.ok) {
      // Never expose response bodies: they can echo credentials or request data.
      void httpResponse.body?.cancel().catch(() => {})
      throw new Error(`Jev truth scoring API returned HTTP ${httpResponse.status}.`)
    }
    let json: unknown
    try { json = await httpResponse.json() } catch { throw new Error('Jev truth scoring returned unreadable JSON.') }
    const parsed = parseTruthResponse(json, batch)
    if (actualModel && actualModel !== parsed.model) throw new Error('Jev truth model changed between batches; no mixed-model scores were accepted.')
    actualModel = parsed.model
    inputTokens += parsed.inputTokens
    Object.assign(scores, parsed.scores)
  }
  return { scores, model: actualModel ?? model, latencyMs: Date.now() - start, inputTokens }
}

// ─── Candidate B: structured comp price classification ───────────────────────
//
// One Choice question per ELIGIBLE comp: ARV | AS_IS | UNIDENTIFIED —
// mutually exclusive categories (never a Score; there is no BOTH state).
// The caller supplies only comps that already passed the deterministic
// appraisal eligibility gate — Jev classifies price regime, it does not
// decide comparability. Application code owns routing via
// routeCompPriceClass: ARV → ARV pool, AS_IS → as-is pool, UNIDENTIFIED →
// neither. Every answer lands under the comp's id, so retried/duplicated
// responses can never duplicate a comp.

export const COMP_PRICE_CLASSES = ['ARV', 'AS_IS', 'UNIDENTIFIED'] as const
export type CompPriceClass = typeof COMP_PRICE_CLASSES[number]

/** Question identifier recorded on every run — bump when the schema changes. */
export const COMP_PRICE_QUESTION_VERSION = 'comp_price_classification_v1'

export interface JevCompPriceClass {
  class: CompPriceClass
  /** Per-option probability mass (debug/calibration only — never routing) */
  probabilities: Record<string, number> | null
  confidence: number | null
  /** Jev's raw choice string when it wasn't a known class (always UNIDENTIFIED then) */
  rawChoice?: string | null
}

export interface JevCompPriceResult {
  /** compId → classification. Eligible comps missing a usable answer are UNIDENTIFIED. */
  classifications: Record<string, JevCompPriceClass>
  model: string
  latencyMs: number
  inputTokens: number
  /** FNV-1a hashes of each batch's serialized state — input-snapshot fingerprints */
  stateHashes: string[]
}

/** Deterministic routing — the only mapping from class to pools. */
export function routeCompPriceClass(cls: CompPriceClass | null | undefined): { arvPool: boolean; asIsPool: boolean } {
  return { arvPool: cls === 'ARV', asIsPool: cls === 'AS_IS' }
}

/**
 * Apply routing to a whole classification map — the single routing
 * application point. Sets are disjoint by construction: a comp has one
 * class, so it can never land in both pools.
 */
export function routeCompPriceClasses(
  classifications: Record<string, JevCompPriceClass | null | undefined>,
): { arvIds: Set<string>; asIsIds: Set<string> } {
  const arvIds = new Set<string>()
  const asIsIds = new Set<string>()
  for (const [id, c] of Object.entries(classifications)) {
    const r = routeCompPriceClass(c?.class)
    if (r.arvPool) arvIds.add(id)
    if (r.asIsPool) asIsIds.add(id)
  }
  return { arvIds, asIsIds }
}

/** Location radius for comp classification — the uniform location signal (geo enrichment is sparse). */
export const JEV_COMP_RADIUS_MILES = 0.5

/**
 * The comp-classification eligibility gate — the SINGLE predicate shared by
 * Baseline A truth scoring and Candidate B choice classification, so both
 * always see exactly the same pool: distance ≤0.5mi AND no hard-priority
 * rule failure (evaluation.shouldDisable). Soft failures and 'not_verified'
 * (missing data) never disqualify; verified mismatches still do. Comps that
 * fail this gate must never reach JEV classification or either pool.
 */
export function compClassifierEligible(comp: AppraisedComparable): boolean {
  return comp.distanceMiles != null && comp.distanceMiles <= JEV_COMP_RADIUS_MILES &&
    (!comp.evaluation || !comp.evaluation.shouldDisable)
}

/**
 * Feature-flag resolution: 'enabled' → B is production routing;
 * 'shadow' → B runs beside Baseline A and records results without
 * affecting anything; 'off' → B does not run. Default: shadow on.
 */
export function compClassifierMode(env: JevEnv): 'enabled' | 'shadow' | 'off' {
  if (env.JEV_COMP_CLASSIFIER_V2_ENABLED === 'true') return 'enabled'
  if (env.JEV_COMP_CLASSIFIER_V2_SHADOW === 'false') return 'off'
  return 'shadow'
}

/** Run metadata persisted on the response for A/B measurement. */
export interface JevCompClassificationRun {
  status: 'completed' | 'skipped' | 'unavailable'
  reason?: string
  mode: 'enabled' | 'shadow'
  questionVersion: typeof COMP_PRICE_QUESTION_VERSION
  model?: string
  latencyMs?: number
  inputTokens?: number
  /** Comps that passed the deterministic gate and reached classification */
  eligibleCount?: number
  counts?: { arv: number; asIs: number; unidentified: number }
  /** Eligible comps where B's class differs from Baseline A's argmax bucket (shadow only) */
  disagreements?: number | null
  stateHashes?: string[]
  classifiedAt?: string
}

function fnv1a(str: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo)
}

function distributionStats(values: Array<number | null | undefined>) {
  const v = values.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b)
  if (!v.length) return null
  return {
    min: v[0],
    q25: Math.round(quantile(v, 0.25) * 100) / 100,
    median: Math.round(quantile(v, 0.5) * 100) / 100,
    q75: Math.round(quantile(v, 0.75) * 100) / 100,
    max: v[v.length - 1],
  }
}

/**
 * The candidate's rank within the eligible pool, EXCLUDING itself —
 * e.g. 0.9 = priced above 90% of eligible peers. Pure price position;
 * never derives from any classification or valuation output, so it
 * cannot be circular.
 */
function rankAmong(value: number | null | undefined, others: Array<number | null | undefined>): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const pool = others.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
  if (!pool.length) return null
  return Math.round((pool.filter((n) => n < value).length / pool.length) * 1000) / 1000
}

/**
 * Price-first evidence for one eligible comp. Every field is a provider,
 * assessor, transaction-record, or deterministic-appraisal fact — none
 * are derived from any classification or valuation output:
 *
 * - salePrice/pricePerSqft/saleDate + adjustedSalePrice (deterministic
 *   appraisal adjustment of the raw sale — rule math, not a verdict)
 * - rank vs the eligible pool (self-excluded percentiles — raw sale
 *   prices of gate-passed candidates only)
 * - transaction flags (cash/foreclosure/short-sale/interfamily/investor/
 *   corporate-buyer — recorded transaction facts = distressed-investor
 *   evidence)
 * - flip (verified prior-sale record: priorSale ≈ investor entry price,
 *   current sale ≈ retail exit)
 * - saleReconciled (price/date corrected to a newer Zillow sale)
 * - buildingCondition/buildingGrade (assessor records — the only
 *   condition evidence; photos are unavailable by design)
 * - ruleEvidence (the comp's own gate results, as evidence not verdict)
 *
 * Deliberately absent: jevArvTruth/jevInvestmentTruth (Baseline A's own
 * outputs would leak its answer into B) and any ARV/as-is estimate —
 * those are computed FROM classifications, so feeding them back would be
 * circular.
 */
function compPriceEvidence(comp: AppraisedComparable, eligiblePool: AppraisedComparable[]): Record<string, unknown> {
  const ev = comp.evaluation
  const others = eligiblePool.filter((c) => c.id !== comp.id)
  return {
    ...truthEvidence(comp, compTruthFields),
    transaction: comp.transaction
      ? {
          buyerIsCorporate: comp.transaction.buyerIsCorporate ?? null,
          isCashPurchase: comp.transaction.isCashPurchase ?? null,
          isShortSale: comp.transaction.isShortSale ?? null,
          isForeclosure: comp.transaction.isForeclosure ?? null,
          isInterfamilyTransfer: comp.transaction.isInterfamilyTransfer ?? null,
          isInvestorPurchase: comp.transaction.isInvestorPurchase ?? null,
        }
      : null,
    adjustedSalePrice: comp.adjustedSalePrice ?? null,
    pricePercentileAmongEligible: rankAmong(comp.salePrice, others.map((c) => c.salePrice)),
    pricePerSqftPercentileAmongEligible: rankAmong(comp.pricePerSqft, others.map((c) => c.pricePerSqft)),
    ruleEvidence: ev
      ? {
          failedFilters: ev.filterResults.filter((f) => f.passed === false).map((f) => f.type),
          passedFilterCount: ev.filterResults.filter((f) => f.passed === true).length,
          totalFilterCount: ev.filterResults.length,
          totalAdjustment: ev.totalAdjustment ?? null,
          originalPrice: ev.originalPrice ?? null,
          adjustedPrice: ev.adjustedPrice ?? null,
        }
      : null,
    evidenceNote:
      'This sale already passed the deterministic appraisal eligibility gate. Rule outcomes are evidence about the sale, not the classification verdict. Missing/null fields are unknown.',
  }
}

function priceClassQuestion(index: number): ChoiceQuestion {
  return {
    type: 'choice',
    instructions:
      `Given that state.comparables[${index}] has already passed Flowstate's deterministic appraisal compatibility rules, which market price condition does this sale most likely represent? ` +
      `Classify the transaction based primarily on its sale-price position within the qualified local comparable evidence (state.eligibleMarket and the other comparables). ` +
      `Photographs are unavailable — do not infer renovation quality from nonexistent visual evidence. ` +
      `Do not re-evaluate whether the sale passes appraisal rules. ` +
      `Do not force ARV or AS_IS when the available price evidence does not distinguish them — use UNIDENTIFIED when evidence is insufficient, conflicting, or genuinely ambiguous. ` +
      `The categories are mutually exclusive: pick exactly one. ` +
      `Signals: pricePercentileAmongEligible and pricePerSqftPercentileAmongEligible rank this sale among gate-passed candidates excluding itself; ` +
      `transaction flags (isCashPurchase/isForeclosure/isShortSale/isInterfamilyTransfer/isInvestorPurchase/buyerIsCorporate) are recorded transaction facts indicating investor or distressed pricing; ` +
      `flip (when present) is a verified resale 30–365 days after priorSale — the current flip resale price is after-renovation retail evidence while priorSalePrice is what an investor paid as-is; ` +
      `saleReconciled means price/date were corrected to a newer Zillow sale — treat as current; ` +
      `adjustedSalePrice is the deterministic appraisal adjustment of the raw sale; ` +
      `buildingCondition/buildingGrade are assessor condition records, not photos. ` +
      `Missing or null fields are unknown — never evidence for or against a class.`,
    criteria: {
      ARV:
        'The sale price is consistent with the renovated / retail-ready price regime for otherwise comparable properties in this market. ' +
        'Not for: clearly discounted investor/as-is pricing, distressed price behavior, insufficient price evidence, or a forced classification based only on being the higher-priced candidate.',
      AS_IS:
        'The sale price is consistent with dated, distressed, investor, or otherwise unrenovated/as-is market pricing for comparable properties. ' +
        'Not for: renovated retail pricing, insufficient price evidence, or a forced classification based only on being the lower-priced candidate.',
      UNIDENTIFIED:
        'The available price evidence cannot reliably distinguish whether the sale represents renovated retail value or as-is/investor value. ' +
        'Use when: price evidence is too sparse, the candidate sits in an ambiguous price region, relevant benchmarks conflict, or there is not enough information for a defensible classification. ' +
        'Not for: a weak guess simply to ensure every qualified sale enters a valuation pool.',
    },
  }
}

type PriceBatch = { ids: string[]; offset: number; body: { model: string; state: Record<string, unknown>; questions: Record<string, ChoiceQuestion> } }

function makePriceBatch(
  subject: Record<string, unknown>, market: Record<string, unknown>, rules: unknown,
  comps: Array<Record<string, unknown>>, ids: string[], offset: number, model: string, evaluationDate: string,
): PriceBatch {
  return {
    ids,
    offset,
    body: {
      model,
      state: {
        subject,
        eligibleMarket: market,
        appraisalRules: rules,
        evaluationDate,
        comparables: comps,
        classificationNote:
          'Every comparable in state.comparables already passed the deterministic appraisal eligibility gate; eligibility is not yours to decide. Classify each sale\'s price regime only.',
      },
      questions: Object.fromEntries(
        comps.map((_, index) => [`comp_${offset + index}_price_classification`, priceClassQuestion(index)]),
      ),
    },
  }
}

function priceClassBatches(
  subject: NormalizedProperty, eligible: AppraisedComparable[], rules: unknown,
  model: string, evaluationDate: string,
): PriceBatch[] {
  const subjectEvidence = truthEvidence(subject, subjectTruthFields)
  const market = {
    eligibleCount: eligible.length,
    salePrice: distributionStats(eligible.map((c) => c.salePrice)),
    pricePerSqft: distributionStats(eligible.map((c) => c.pricePerSqft)),
    adjustedSalePrice: distributionStats(eligible.map((c) => c.adjustedSalePrice)),
  }
  const result: PriceBatch[] = []
  let pending: Array<Record<string, unknown>> = []
  let ids: string[] = []
  let offset = 0
  for (const comp of eligible) {
    const item = compPriceEvidence(comp, eligible)
    const next = makePriceBatch(subjectEvidence, market, rules, [...pending, item], [...ids, comp.id], offset, model, evaluationDate)
    if (truthFits(next)) { pending.push(item); ids.push(comp.id); continue }
    if (pending.length) {
      result.push(makePriceBatch(subjectEvidence, market, rules, pending, ids, offset, model, evaluationDate))
      offset += pending.length
    }
    const single = makePriceBatch(subjectEvidence, market, rules, [item], [comp.id], offset, model, evaluationDate)
    if (!truthFits(single)) throw new Error('Jev price-classification context limit: subject, market context, and one comparable exceed the request budget; evidence was not truncated.')
    pending = [item]
    ids = [comp.id]
  }
  if (pending.length) result.push(makePriceBatch(subjectEvidence, market, rules, pending, ids, offset, model, evaluationDate))
  return result
}

/**
 * Strict envelope (model/answers/usage — same as truth scoring), but
 * per-comp answers fail CLOSED instead of fatal: a missing, malformed, or
 * unknown-choice answer classifies that comp UNIDENTIFIED — excluded from
 * both pools — rather than contaminating either.
 */
function parsePriceClassResponse(
  value: unknown, batch: PriceBatch,
): { classifications: Record<string, JevCompPriceClass>; model: string; inputTokens: number } {
  const malformed = () => new Error('Jev price classification returned an invalid typed response envelope; no classifications were accepted.')
  if (!object(value) || typeof value.model !== 'string' || !/^jev-[\w.-]+$/.test(value.model) || !object(value.answers) || !object(value.usage)) throw malformed()
  const { input_tokens: inputTokens } = value.usage
  if (typeof inputTokens !== 'number' || !Number.isSafeInteger(inputTokens) || inputTokens < 0) throw malformed()

  const closed: JevCompPriceClass = { class: 'UNIDENTIFIED', probabilities: null, confidence: null }
  const classifications: Record<string, JevCompPriceClass> = Object.create(null)
  const answers = value.answers as Record<string, unknown>
  batch.ids.forEach((id, index) => {
    const answer = answers[`comp_${batch.offset + index}_price_classification`]
    if (!object(answer) || answer.type !== 'choice' || typeof answer.choice !== 'string') {
      classifications[id] = closed
      return
    }
    if (!(COMP_PRICE_CLASSES as readonly string[]).includes(answer.choice)) {
      classifications[id] = { ...closed, rawChoice: answer.choice }
      return
    }
    classifications[id] = {
      class: answer.choice as CompPriceClass,
      probabilities: object(answer.probabilities)
        ? Object.fromEntries(
            Object.entries(answer.probabilities).filter(([, p]) => probability(p)),
          ) as Record<string, number>
        : null,
      confidence: probability(answer.confidence) ? answer.confidence : null,
    }
  })
  return { classifications, model: value.model, inputTokens }
}

/**
 * Candidate B: classify each ELIGIBLE comp's price regime with one
 * structured Choice — ARV | AS_IS | UNIDENTIFIED. Callers must pre-filter
 * to comps that passed the deterministic appraisal gate; this function
 * trusts that contract (the gate is application code's job). Returns
 * classifications only — routing is routeCompPriceClasses(). Throws on
 * missing key / API / malformed envelope; per-comp bad answers degrade to
 * UNIDENTIFIED.
 */
export async function classifyCompPriceWithJev(
  subject: NormalizedProperty,
  eligible: AppraisedComparable[],
  appraisalRules: unknown,
  env: JevEnv,
): Promise<JevCompPriceResult> {
  const start = Date.now()
  const evaluationDate = new Date(start).toISOString().slice(0, 10)
  const key = env.TYPESAFE_API_KEY?.trim()
  if (!key) throw new Error('Jev price classification requires TYPESAFE_API_KEY.')
  const model = env.TYPESAFE_MODEL?.trim() || 'jev-latest'
  if (!/^jev-[\w.-]+$/.test(model)) throw new Error('Jev price classification requires a Jev model identifier.')
  if (eligible.some((comp) => typeof comp.id !== 'string' || !comp.id.trim()) || new Set(eligible.map((c) => c.id)).size !== eligible.length) {
    throw new Error('Jev price classification requires a unique, nonempty ID for every comparable.')
  }

  const classifications: Record<string, JevCompPriceClass> = Object.create(null)
  const stateHashes: string[] = []
  let inputTokens = 0
  let actualModel: string | undefined
  for (const batch of priceClassBatches(subject, eligible, appraisalRules, model, evaluationDate)) {
    stateHashes.push(fnv1a(serialized(batch.body.state)))
    let httpResponse: Response
    try {
      httpResponse = await fetch(ENDPOINT, {
        method: 'POST',
        redirect: 'manual',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: serialized(batch.body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw new Error('Jev price classification request failed or timed out.')
    }
    if (!httpResponse.ok) {
      // Never expose response bodies: they can echo credentials or request data.
      void httpResponse.body?.cancel().catch(() => {})
      throw new Error(`Jev price classification API returned HTTP ${httpResponse.status}.`)
    }
    let json: unknown
    try { json = await httpResponse.json() } catch { throw new Error('Jev price classification returned unreadable JSON.') }
    const parsed = parsePriceClassResponse(json, batch)
    if (actualModel && actualModel !== parsed.model) throw new Error('Jev price-classification model changed between batches; no mixed-model classifications were accepted.')
    actualModel = parsed.model
    inputTokens += parsed.inputTokens
    Object.assign(classifications, parsed.classifications)
  }
  return { classifications, model: actualModel ?? model, latencyMs: Date.now() - start, inputTokens, stateHashes }
}
