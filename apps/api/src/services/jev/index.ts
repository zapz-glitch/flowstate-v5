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
 *    Attached to the response for display/review only.
 */

import type { AnalysisResponse } from '../analysis'
import type { NormalizedComparable, NormalizedProperty } from '../property-api/types'
import type { AppraisedComparable } from '../appraisal/types'

export interface JevEnv {
  TYPESAFE_API_KEY?: string
  TYPESAFE_MODEL?: string
}

export const OUTCOME_DIMENSIONS = [
  'evidence_sufficiency',
  'comp_set_quality',
  'deal_outlook',
  'recommendation_agreement',
  'risk_flags',
] as const
export type JevOutcomeDimension = typeof OUTCOME_DIMENSIONS[number]

export interface JevSignal {
  choice: string
  confidence: number
  probabilities: Record<string, number>
}

/** Driver sub-check: 0–1 probability the statement holds. Keyed `dimension.key`. */
export type JevOutcomeDrivers = Record<JevOutcomeDimension, Record<string, number>>

export type JevOutcomeClassification =
  | {
      status: 'completed'
      classifications: Record<JevOutcomeDimension, JevSignal>
      /** Atomic yes/no sub-checks that expose what drove each headline label */
      drivers: JevOutcomeDrivers
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
type NoulQuestion = { type: 'noul'; instructions: string }
type Question = ChoiceQuestion | NoulQuestion

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
  questions: Record<string, Question>,
): { classifications: Record<JevOutcomeDimension, JevSignal>; drivers: JevOutcomeDrivers; model: string; inputTokens: number } {
  const malformed = () =>
    new Error('Jev outcome classification returned an invalid or incomplete typed response.')
  if (!object(json) || typeof json.model !== 'string' || !/^jev-[\w.-]+$/.test(json.model) || !object(json.answers) || !object(json.usage)) throw malformed()
  const { input_tokens: inputTokens } = json.usage
  if (typeof inputTokens !== 'number' || !Number.isSafeInteger(inputTokens) || inputTokens < 0) throw malformed()
  const keys = Object.keys(questions)
  if (Object.keys(json.answers).length !== keys.length || keys.some((key) => !Object.hasOwn(json.answers as object, key))) throw malformed()
  const classifications = {} as Record<JevOutcomeDimension, JevSignal>
  const drivers = Object.fromEntries(OUTCOME_DIMENSIONS.map((d) => [d, {}])) as JevOutcomeDrivers
  for (const key of keys) {
    const question = questions[key]
    const answer = (json.answers as Record<string, unknown>)[key]
    if (!object(answer)) throw malformed()
    if (question.type === 'choice') {
      const options = Object.keys(question.criteria)
      if (answer.type !== 'choice' || typeof answer.choice !== 'string' || !options.includes(answer.choice) || !probability(answer.confidence) || !object(answer.probabilities)) throw malformed()
      const probabilities = answer.probabilities
      if (Object.keys(probabilities).length !== options.length || options.some((option) => !probability(probabilities[option])) || Math.abs(options.reduce((sum, option) => sum + (probabilities[option] as number), 0) - 1) > options.length * 0.005 + Number.EPSILON) throw malformed()
      const dimension = key.slice('outcome_'.length) as JevOutcomeDimension
      if (!OUTCOME_DIMENSIONS.includes(dimension)) throw malformed()
      classifications[dimension] = {
        choice: answer.choice,
        confidence: answer.confidence,
        probabilities: probabilities as Record<string, number>,
      }
    } else {
      const driver = DRIVER_KEYS[key]
      if (!driver || answer.type !== 'noul' || !probability(answer.noul)) throw malformed()
      drivers[driver.dimension][driver.key] = answer.noul
    }
  }
  return { classifications, drivers, model: json.model, inputTokens }
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
  const parsed = parseResponse(json, questions)
  return {
    status: 'completed',
    classifications: parsed.classifications,
    drivers: parsed.drivers,
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
  'construction', 'transaction', 'features', 'isEnriched',
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
    instructions: `Is state.comparables[${index}] a reliable source of truth for the subject's AFTER-RENOVATION retail market value — does its sale reflect what a retail buyer would credibly pay for the subject once renovated? This is the ARV bucket: the comp should read like a renovated/retail-priced sale (strong condition signals, retail-grade price per sqft), physically similar and nearby. distanceMiles is the primary location signal — closer is stronger evidence; subdivision and neighborhood are often missing (enrichment is limited to rule-matched comps) and their absence must NOT reduce the score. Judge against state.subject using state.appraisalRules as context; the comp's ruleEvidence lists appraisal-rule outcomes as evidence, not verdicts. Missing or null fields are unknown — they must NOT reduce the score; score only the evidence that is present.`,
  }
}

function investmentTruthQuestion(index: number): NoulQuestion {
  return {
    type: 'noul',
    instructions: `Is state.comparables[${index}] a reliable source of truth for the subject's AS-IS investment value — does its sale reflect what an investor would credibly pay for the subject today, in current condition? This is the investment bucket: the comp should read like an as-is or investment-grade sale (dated/distressed condition or below-retail pricing), physically similar and nearby. distanceMiles is the primary location signal — closer is stronger evidence; subdivision and neighborhood are often missing (enrichment is limited to rule-matched comps) and their absence must NOT reduce the score. Judge against state.subject using state.appraisalRules as context; the comp's ruleEvidence lists appraisal-rule outcomes as evidence, not verdicts. Missing or null fields are unknown — they must NOT reduce the score; score only the evidence that is present.`,
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

function truthFits(batch: TruthBatch): boolean {
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
