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
import type { AppraisedComparable, AppraisalFilter, FilterType } from '../appraisal/types'
import { DEFAULT_FILTERS } from '../appraisal/types'

export interface JevEnv {
  TYPESAFE_API_KEY?: string
  TYPESAFE_MODEL?: string
  /** 'true' → Candidate B structured choice drives comp routing (default false = Baseline A) */
  JEV_COMP_CLASSIFIER_V2_ENABLED?: string
  /** 'false' disables the Candidate B shadow run (default on — measures B beside A) */
  JEV_COMP_CLASSIFIER_V2_SHADOW?: string
  /** 'true' → the 8-question attribute screen drives comp routing (default false = shadow) */
  JEV_ATTRIBUTE_SCREEN_ENABLED?: string
  /** 'false' disables the attribute-screen shadow run entirely (default on) */
  JEV_ATTRIBUTE_SCREEN_SHADOW?: string
  /** 'true' → the v4 hybrid (classify-all + rules + recovery scoring) drives comp routing (default false = shadow) */
  JEV_HYBRID_V4_ENABLED?: string
  /** 'false' disables the v4 hybrid shadow run entirely (default on) */
  JEV_HYBRID_V4_SHADOW?: string
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

export interface JevOutcomeScenario {
  id: 'jev_v2_shadow' | 'jev_v3_shadow' | 'jev_v4_hybrid'
  selectionMethod: string
  arvCompIds: string[]
  asIsCompIds: string[]
  valuation: {
    arv: number | null
    arvPerSqft: number | null
    arvSource: string
    asIsValue: number | null
    afterRenovationValue: number | null
    buyPrice: number | null
    buyPricePercent: number | null
    rehabCost: number | null
    rehabLevel: string | null
    locationPenalty: number | null
    projectedProfit: number | null
    projectedROI: number | null
    wholesalePrice: number | null
    recommendation: string | null
    recommendationReason: string | null
  }
}

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

function projectComp(comp: CompItem, compGroup?: 'arv' | 'as_is' | null): Record<string, unknown> {
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
    compGroup: compGroup === undefined ? comp.compGroup ?? null : compGroup,
    jevArvTruth: compGroup === undefined ? comp.jevArvTruth ?? null : null,
    jevInvestmentTruth: compGroup === undefined ? comp.jevInvestmentTruth ?? null : null,
    failedFilters: failed.length ? failed : null,
  }
}

function projectOutcome(response: AnalysisResponse, scenario?: JevOutcomeScenario): Record<string, unknown> {
  const v = scenario ? scenario.valuation : response.valuation
  const s = response.subject
  const arvIds = scenario ? new Set(scenario.arvCompIds) : null
  const asIsIds = scenario ? new Set(scenario.asIsCompIds) : null
  const enabled = scenario
    ? response.comps.items.filter((c) => arvIds!.has(c.id) || asIsIds!.has(c.id))
    : response.comps.items.filter((c) => c.isEnabled)
  const scenarioRates = scenario
    ? enabled.map((c) => c.pricePerSqft).filter((n): n is number => typeof n === 'number' && n > 0)
    : []
  const scenarioPrices = scenario
    ? enabled.map((c) => c.adjustedPrice ?? c.salePrice).filter((n): n is number => typeof n === 'number' && n > 0).sort((a, b) => a - b)
    : []
  const scenarioMedian = scenarioPrices.length
    ? scenarioPrices.length % 2 === 0
      ? Math.round((scenarioPrices[scenarioPrices.length / 2 - 1] + scenarioPrices[scenarioPrices.length / 2]) / 2)
      : scenarioPrices[(scenarioPrices.length - 1) / 2]
    : null
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
      selectionMethod: scenario ? scenario.selectionMethod : 'jev_truth_ranking',
      avgPricePerSqft: scenario
        ? scenarioRates.length
          ? Math.round(scenarioRates.reduce((sum, n) => sum + n, 0) / scenarioRates.length)
          : null
        : response.comps.avgPricePerSqft,
      medianPrice: scenario ? scenarioMedian : response.comps.medianPrice,
      bestMatch: scenario ? null : response.comps.bestMatch ?? null,
      selected: enabled.map((comp) =>
        scenario ? projectComp(comp, arvIds!.has(comp.id) ? 'arv' : 'as_is') : projectComp(comp),
      ),
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
  scenario?: JevOutcomeScenario,
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
      ...projectOutcome(response, scenario),
      evaluationDate: new Date(start).toISOString().slice(0, 10),
      evidenceNote: scenario
        ? `This is the ${scenario.id} counterfactual outcome. Jev only labels this shadow outcome; it did not affect production.`
        : 'This analysis outcome was produced by the deterministic v5 pipeline. Jev only labels the outcome; selection and valuation are final.',
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
  /** Largest option probability — observability for abstention analysis */
  top1?: number | null
  /** Second-largest option probability */
  top2?: number | null
  /** top1 − top2 margin — the decisiveness signal for candidate abstention rules */
  margin?: number | null
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
  /**
   * Counterfactual (shadow mode only): what B's pool routing would have
   * produced through the same deterministic math — same ARV condition-gate
   * prune, same valuation service, same Group B summarizer. Display only;
   * never feeds the production valuation.
   */
  shadowValuation?: {
    /** ARV over B's ARV bucket after the same condition-gate prune; null when B selected none */
    arv: number | null
    arvComps: number
    /** B-ARV comps dropped by the verified-below-spec prune */
    arvPrunedBelowSpec: number
    /** Sqft-scaled mean over B's AS_IS bucket (same as asIsMarketIntel math) */
    asIsValue: number | null
    asIsComps: number
    buyPrice: number | null
    projectedProfit: number | null
    projectedROI: number | null
    recommendation: string | null
    /** B figure minus production figure per metric */
    deltas: { arv: number | null; asIsValue: number | null; buyPrice: number | null }
    assessment?: JevOutcomeClassification
    arvCompIds: string[]
    asIsCompIds: string[]
    arvPrunedCompIds: string[]
  }
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
function compPriceEvidence(comp: AppraisedComparable, eligiblePool: AppraisedComparable[], gated: boolean): Record<string, unknown> {
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
    evidenceNote: gated
      ? 'This sale already passed the deterministic appraisal eligibility gate. Rule outcomes are evidence about the sale, not the classification verdict. Missing/null fields are unknown.'
      : 'This sale is part of the raw candidate pool — the appraisal gate has NOT been applied yet and runs separately after classification. Rule outcomes are evidence about the sale, not the classification verdict. Missing/null fields are unknown.',
  }
}

function priceClassQuestion(index: number, gated: boolean): ChoiceQuestion {
  return {
    type: 'choice',
    instructions:
      (gated
        ? `Given that state.comparables[${index}] has already passed Flowstate's deterministic appraisal compatibility rules, which market price condition does this sale most likely represent? `
        : `Regardless of whether state.comparables[${index}] passes Flowstate's appraisal compatibility rules — they are applied separately afterward — which market price condition does this sale most likely represent? `) +
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
  gated: boolean,
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
        classificationNote: gated
          ? 'Every comparable in state.comparables already passed the deterministic appraisal eligibility gate; eligibility is not yours to decide. Classify each sale\'s price regime only.'
          : 'state.comparables is the raw candidate pool; the appraisal gate has NOT run yet — eligibility is applied separately after classification. Classify each sale\'s price regime only.',
      },
      questions: Object.fromEntries(
        comps.map((_, index) => [`comp_${offset + index}_price_classification`, priceClassQuestion(offset + index, gated)]),
      ),
    },
  }
}

function priceClassBatches(
  subject: NormalizedProperty, eligible: AppraisedComparable[], rules: unknown,
  model: string, evaluationDate: string, gated: boolean,
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
    const item = compPriceEvidence(comp, eligible, gated)
    const next = makePriceBatch(subjectEvidence, market, rules, [...pending, item], [...ids, comp.id], offset, model, evaluationDate, gated)
    if (truthFits(next)) { pending.push(item); ids.push(comp.id); continue }
    if (pending.length) {
      result.push(makePriceBatch(subjectEvidence, market, rules, pending, ids, offset, model, evaluationDate, gated))
      offset += pending.length
    }
    const single = makePriceBatch(subjectEvidence, market, rules, [item], [comp.id], offset, model, evaluationDate, gated)
    if (!truthFits(single)) throw new Error('Jev price-classification context limit: subject, market context, and one comparable exceed the request budget; evidence was not truncated.')
    pending = [item]
    ids = [comp.id]
  }
  if (pending.length) result.push(makePriceBatch(subjectEvidence, market, rules, pending, ids, offset, model, evaluationDate, gated))
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
    const probs = object(answer.probabilities)
      ? Object.fromEntries(
          Object.entries(answer.probabilities).filter(([, p]) => probability(p)),
        ) as Record<string, number>
      : null
    const ranked = probs ? Object.values(probs).sort((a, b) => b - a) : []
    const top1 = ranked.length ? ranked[0]! : null
    const top2 = ranked.length > 1 ? ranked[1]! : null
    classifications[id] = {
      class: answer.choice as CompPriceClass,
      probabilities: probs,
      confidence: probability(answer.confidence) ? answer.confidence : null,
      top1,
      top2,
      margin: top1 != null && top2 != null ? Math.round((top1 - top2) * 1000) / 1000 : null,
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
  opts?: { gated?: boolean },
): Promise<JevCompPriceResult> {
  const gated = opts?.gated !== false
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
  for (const batch of priceClassBatches(subject, eligible, appraisalRules, model, evaluationDate, gated)) {
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

// ─── Attribute screen: Jev judges each comp on the 8 comparability axes ──────
//
// The first layer of the comp screen: every candidate gets one noul per
// attribute — the SAME attributes the appraisal filters check — so each
// comp carries a graded 0–1 match instead of a binary pass/fail. The
// deterministic exception screen (services/comp-screen) turns these scores
// into a closeness ranking; price bands then split the pool into ARV and
// as-is sets. Jev never sees rule verdicts or prices here — only physical
// and geographic evidence, so the answers stay a pure similarity judgment.

export const COMP_ATTRIBUTE_KEYS = [
  'same_neighborhood',
  'same_subdivision',
  'within_sqft_range',
  'within_lot_sqft_range',
  'same_property_style',
  'same_construction',
  'same_foundation',
  'within_year_built_range',
] as const
export type CompAttributeKey = typeof COMP_ATTRIBUTE_KEYS[number]

/** Attribute → the appraisal filter that governs its threshold and weight. */
export const COMP_ATTRIBUTE_TO_FILTER: Record<CompAttributeKey, FilterType> = {
  same_neighborhood: 'neighborhood_match',
  same_subdivision: 'subdivision_match',
  within_sqft_range: 'sqft_diff',
  within_lot_sqft_range: 'lot_size_diff',
  same_property_style: 'building_style_match',
  same_construction: 'construction_material_match',
  same_foundation: 'foundation_match',
  within_year_built_range: 'year_built_diff',
}

/** Question identifier recorded on every run — bump when the schema changes. */
export const COMP_ATTRIBUTE_QUESTION_VERSION = 'comp_attribute_screen_v1'

export interface JevAttributeScreenResult {
  /** compId → attribute → 0–1 match probability */
  scores: Record<string, Partial<Record<CompAttributeKey, number>>>
  model: string
  latencyMs: number
  inputTokens: number
  /** FNV-1a hashes of each batch's serialized state — input-snapshot fingerprints */
  stateHashes: string[]
}

/**
 * Feature-flag resolution: 'enabled' → the screen drives comp routing;
 * 'shadow' → runs beside production and records results only; 'off' →
 * does not run. Default: shadow on.
 */
export function attributeScreenMode(env: JevEnv): 'enabled' | 'shadow' | 'off' {
  if (env.JEV_ATTRIBUTE_SCREEN_ENABLED === 'true') return 'enabled'
  if (env.JEV_ATTRIBUTE_SCREEN_SHADOW === 'false') return 'off'
  return 'shadow'
}

/** Configured numeric threshold for a range attribute, from the preset filters. */
function attributeThreshold(attribute: CompAttributeKey, filters: AppraisalFilter[]): number | null {
  const type = COMP_ATTRIBUTE_TO_FILTER[attribute]
  const filter = filters.find((f) => f.type === type)
    ?? DEFAULT_FILTERS.find((f) => f.type === type)
  return filter?.enabled === false ? null : (filter?.value ?? null)
}

const subjectScreenFields = [
  'id', 'address', 'city', 'state', 'zipCode', 'latitude', 'longitude',
  'squareFeet', 'lotSizeAcres', 'lotSizeSquareFeet', 'yearBuilt', 'effectiveYearBuilt',
  'propertyType', 'stories', 'subdivision', 'neighborhoodName', 'neighborhoodCode',
  'construction', 'buildingCondition', 'buildingGrade', 'legalDescription',
] as const satisfies readonly (keyof NormalizedProperty)[]

const compScreenFields = [
  'id', 'address', 'city', 'state', 'zipCode', 'latitude', 'longitude', 'distanceMiles',
  'squareFeet', 'lotSizeAcres', 'lotSizeSquareFeet', 'yearBuilt', 'propertyType', 'stories',
  'subdivision', 'neighborhoodName', 'neighborhoodCode', 'construction',
  'buildingCondition', 'buildingGrade', 'parcelId',
] as const satisfies readonly (keyof NormalizedComparable)[]

const SCREEN_EVIDENCE_NOTE =
  'Judge each attribute against state.subject only. Missing/null fields are unknown — score by the evidence present, never assume a match or a mismatch. Rule outcomes and sale prices are deliberately excluded: this is a pure similarity judgment.'

function attributeQuestion(index: number, attribute: CompAttributeKey, filters: AppraisalFilter[]): NoulQuestion {
  const i = `state.comparables[${index}]`
  let instructions: string
  switch (attribute) {
    case 'same_neighborhood':
      instructions = `Does ${i} sit in the same neighborhood as the subject? Compare neighborhoodName/neighborhoodCode and subdivision — name OR code equality counts, and plat unit/phase/section suffixes (e.g. "Unit 3", "Phase II") still count as the same neighborhood.`
      break
    case 'same_subdivision':
      instructions = `Does ${i} sit in the same recorded subdivision as the subject? Compare subdivision and legalDescription — unit/phase/section suffixes still count as the same subdivision.`
      break
    case 'within_sqft_range': {
      const t = attributeThreshold(attribute, filters)
      instructions = t != null
        ? `Is ${i}'s living area within the configured range of the subject's — subject.squareFeet ± ${t} sqft? Judge from the numeric fields.`
        : `Is ${i}'s living area a comparable size to the subject's squareFeet? Judge from the numeric fields — the configured range check is disabled.`
      break
    }
    case 'within_lot_sqft_range': {
      const t = attributeThreshold(attribute, filters)
      instructions = t != null
        ? `Is ${i}'s lot within the configured range of the subject's lot — ± ${t} sqft? Use lotSizeSquareFeet, or lotSizeAcres × 43560 when only acres are present.`
        : `Is ${i}'s lot a comparable size to the subject's? Use lotSizeSquareFeet, or lotSizeAcres × 43560 when only acres are present — the configured range check is disabled.`
      break
    }
    case 'same_property_style':
      instructions = `Does ${i} share the subject's building style (construction.buildingStyle and storiesType — e.g. Ranch vs Ranch, one-story vs one-story)?`
      break
    case 'same_construction':
      instructions = `Does ${i} share the subject's building construction — construction.type and exteriorWalls family (frame/wood vs masonry/brick vs stucco)?`
      break
    case 'same_foundation':
      instructions = `Is ${i} on the same foundation family as the subject — slab vs raised (pier/beam/crawl/wood) vs basement?`
      break
    case 'within_year_built_range': {
      const t = attributeThreshold(attribute, filters)
      instructions = t != null
        ? `Was ${i} built within the configured range of the subject — subject.yearBuilt ± ${t} years? Judge from the numeric fields.`
        : `Was ${i} built in a comparable era to the subject's yearBuilt? Judge from the numeric fields — the configured range check is disabled.`
      break
    }
  }
  return { type: 'noul', instructions: `${instructions} ${SCREEN_EVIDENCE_NOTE}` }
}

type AttributeBatch = {
  ids: string[]
  offset: number
  body: { model: string; state: Record<string, unknown>; questions: Record<string, NoulQuestion> }
}

function makeAttributeBatch(
  subject: Record<string, unknown>, comps: Array<Record<string, unknown>>,
  ids: string[], offset: number, model: string, evaluationDate: string,
  filters: AppraisalFilter[],
): AttributeBatch {
  return {
    ids,
    offset,
    body: {
      model,
      state: { subject, evaluationDate, comparables: comps },
      questions: Object.fromEntries(
        comps.flatMap((_, index) =>
          COMP_ATTRIBUTE_KEYS.map((attribute) => [
            `comp_${offset + index}_${attribute}`,
            attributeQuestion(offset + index, attribute, filters),
          ]),
        ),
      ),
    },
  }
}

function attributeBatches(
  subject: NormalizedProperty, comps: AppraisedComparable[],
  filters: AppraisalFilter[], model: string, evaluationDate: string,
): AttributeBatch[] {
  const subjectEvidence = truthEvidence(subject, subjectScreenFields)
  const result: AttributeBatch[] = []
  let pending: Array<Record<string, unknown>> = []
  let ids: string[] = []
  let offset = 0
  for (const comp of comps) {
    const item = truthEvidence(comp, compScreenFields)
    const next = makeAttributeBatch(subjectEvidence, [...pending, item], [...ids, comp.id], offset, model, evaluationDate, filters)
    if (truthFits(next)) { pending.push(item); ids.push(comp.id); continue }
    if (pending.length) {
      result.push(makeAttributeBatch(subjectEvidence, pending, ids, offset, model, evaluationDate, filters))
      offset += pending.length
    }
    const single = makeAttributeBatch(subjectEvidence, [item], [comp.id], offset, model, evaluationDate, filters)
    if (!truthFits(single)) throw new Error('Jev attribute-screen context limit: subject and one comparable exceed the request budget; evidence was not truncated.')
    pending = [item]
    ids = [comp.id]
  }
  if (pending.length) result.push(makeAttributeBatch(subjectEvidence, pending, ids, offset, model, evaluationDate, filters))
  return result
}

/**
 * Strict parse — every batched comp must return all 8 nouls, like truth
 * scoring: a partial batch would give some comps a full similarity vector
 * and others nothing, so the run fails rather than mixing coverage.
 */
function parseAttributeResponse(
  value: unknown, batch: AttributeBatch,
): { scores: Record<string, Partial<Record<CompAttributeKey, number>>>; model: string; inputTokens: number } {
  const malformed = () => new Error('Jev attribute screen returned an invalid or incomplete typed response; no scores were accepted.')
  if (!object(value) || typeof value.model !== 'string' || !/^jev-[\w.-]+$/.test(value.model) || !object(value.answers) || !object(value.usage)) throw malformed()
  const { input_tokens: inputTokens } = value.usage
  if (typeof inputTokens !== 'number' || !Number.isSafeInteger(inputTokens) || inputTokens < 0) throw malformed()
  const keys = Object.keys(batch.body.questions)
  if (Object.keys(value.answers).length !== keys.length || keys.some((key) => !Object.hasOwn(value.answers as object, key))) throw malformed()
  const scores: Record<string, Partial<Record<CompAttributeKey, number>>> = Object.create(null)
  batch.ids.forEach((id, index) => {
    const entry: Partial<Record<CompAttributeKey, number>> = {}
    for (const attribute of COMP_ATTRIBUTE_KEYS) {
      const answer = (value.answers as Record<string, unknown>)[`comp_${batch.offset + index}_${attribute}`]
      if (!object(answer) || answer.type !== 'noul' || !probability(answer.noul)) throw malformed()
      entry[attribute] = answer.noul
    }
    scores[id] = entry
  })
  return { scores, model: value.model, inputTokens }
}

/**
 * Layer 1 of the comp screen: one noul per comp per attribute across all
 * candidates — the graded similarity evidence the deterministic exception
 * screen ranks on. Runs over the full evaluated pool (rule failures
 * included — exception selection is the point). Batches run in parallel;
 * all-or-nothing: any failed batch throws so callers fall back whole.
 */
export async function scoreCompAttributesWithJev(
  subject: NormalizedProperty,
  comps: AppraisedComparable[],
  filters: AppraisalFilter[],
  env: JevEnv,
): Promise<JevAttributeScreenResult> {
  const start = Date.now()
  const evaluationDate = new Date(start).toISOString().slice(0, 10)
  const key = env.TYPESAFE_API_KEY?.trim()
  if (!key) throw new Error('Jev attribute screen requires TYPESAFE_API_KEY.')
  const model = env.TYPESAFE_MODEL?.trim() || 'jev-latest'
  if (!/^jev-[\w.-]+$/.test(model)) throw new Error('Jev attribute screen requires a Jev model identifier.')
  if (comps.some((comp) => typeof comp.id !== 'string' || !comp.id.trim()) || new Set(comps.map((c) => c.id)).size !== comps.length) {
    throw new Error('Jev attribute screen requires a unique, nonempty ID for every comparable.')
  }

  const batches = attributeBatches(subject, comps, filters, model, evaluationDate)
  const responses = await Promise.all(
    batches.map(async (batch) => {
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
        throw new Error('Jev attribute screen request failed or timed out.')
      }
      if (!httpResponse.ok) {
        // Never expose response bodies: they can echo credentials or request data.
        void httpResponse.body?.cancel().catch(() => {})
        throw new Error(`Jev attribute screen API returned HTTP ${httpResponse.status}.`)
      }
      let json: unknown
      try { json = await httpResponse.json() } catch { throw new Error('Jev attribute screen returned unreadable JSON.') }
      return parseAttributeResponse(json, batch)
    }),
  )

  const scores: Record<string, Partial<Record<CompAttributeKey, number>>> = Object.create(null)
  let inputTokens = 0
  let actualModel: string | undefined
  for (const parsed of responses) {
    if (actualModel && actualModel !== parsed.model) throw new Error('Jev attribute-screen model changed between batches; no mixed-model scores were accepted.')
    actualModel = parsed.model
    inputTokens += parsed.inputTokens
    Object.assign(scores, parsed.scores)
  }
  return {
    scores,
    model: actualModel ?? model,
    latencyMs: Date.now() - start,
    inputTokens,
    stateHashes: batches.map((batch) => fnv1a(serialized(batch.body.state))),
  }
}

// ─── Two-test comp evaluation ───────────────────────────────────────────────
//
// Product spec (replaces the prior screen/exam pipeline):
//
//   TEST 1 — noul on raw comps. For each raw field the question is
//     "does this comp match the subject on this field, per the appraisal
//     rules?" — bathrooms, squareFeet, lotSizeAcres, yearBuilt, salePrice,
//     saleDate. Where the preset configures a tolerance for the field it is
//     baked into the question; where it does not (bathrooms, salePrice) the
//     question asks for the appraiser's match judgment against the subject.
//     Passing ALL of them puts the comp in the "passed test 1" bucket → it
//     gets enriched.
//   TEST 2 — noul on the enriched data. A subdivision match passes test 2;
//     if subdivision fails, a neighborhood match still passes it. Both no →
//     test 2 fail → ineligible for the core comp set. Physical character
//     and material matches are asked as preferred-not-required advisory
//     nouls — recorded, never gating.
//   SCORE — one Score question per enriched comp: distance to the subject
//     dominates (closest → highest level, tapering as distance grows);
//     physical character and material similarity are preferred but not
//     required. Carries Jev's confidence.
//   SELECTION — test-2 passers are the primary core comp set (ideally 3).
//     When fewer than 3 pass, the test-1-pass / test-2-fail bucket is
//     scored on distance and fills the set to 3 by score.

export const COMP_EVAL_VERSION = 'comp_tests_v1'
export const COMP_NOUL_GATE = 0.5

const hasEvidence = (v: unknown): boolean =>
  v != null && v !== '' && !(typeof v === 'number' && Number.isNaN(v))

// ─── Test 1 — raw-field nouls ───────────────────────────────────────────────

export type CompTest1Field =
  | 'bathrooms' | 'squareFeet' | 'lotSize'
  | 'yearBuilt' | 'salePrice' | 'saleDate'

export const COMP_TEST1_FIELDS: CompTest1Field[] = [
  'bathrooms', 'squareFeet', 'lotSize', 'yearBuilt', 'salePrice', 'saleDate',
]

export const COMP_TEST1_LABELS: Record<CompTest1Field, string> = {
  bathrooms: 'Bathrooms',
  squareFeet: 'Square footage',
  lotSize: 'Lot size',
  yearBuilt: 'Year built',
  salePrice: 'Sale price',
  saleDate: 'Sale date',
}

export interface CompTest1FieldDef {
  key: CompTest1Field
  label: string
  question: (index: number) => string
  /** Field must be present on the comp (and subject where required) for the noul to be verifiable */
  verifiable: (subject: NormalizedProperty, comp: AppraisedComparable) => boolean
}

export function buildTest1Defs(filters: AppraisalFilter[], subject: NormalizedProperty): CompTest1FieldDef[] {
  const rule = (type: string) => filters.find((f) => f.type === type)
  const subjectLotSqft = hasEvidence(subject.lotSizeSquareFeet)
    ? subject.lotSizeSquareFeet!
    : hasEvidence(subject.lotSizeAcres)
      ? subject.lotSizeAcres! * 43_560
      : null

  return [
    {
      key: 'bathrooms',
      label: COMP_TEST1_LABELS.bathrooms,
      question: (i) => `Does state.comparables[${i}] match the subject's bathroom count — a comparable with the same number of bathrooms as the subject? Judge bathrooms.`,
      verifiable: (s, c) => hasEvidence(s.bathrooms) && hasEvidence(c.bathrooms),
    },
    {
      key: 'squareFeet',
      label: COMP_TEST1_LABELS.squareFeet,
      question: (i) => {
        const t = rule('sqft_diff')?.value ?? 250
        return `Is state.comparables[${i}]'s living area within ±${t} sqft of the subject's — the appraiser's size-match standard? Judge squareFeet.`
      },
      verifiable: (s, c) => hasEvidence(s.squareFeet) && hasEvidence(c.squareFeet),
    },
    {
      key: 'lotSize',
      label: COMP_TEST1_LABELS.lotSize,
      question: (i) => {
        const t = rule('lot_size_diff')?.value ?? 5_000
        return `Is state.comparables[${i}]'s lot within ±${t} sqft of the subject's — the appraiser's lot-match standard? Judge lotSizeSquareFeet/lotSizeAcres.`
      },
      verifiable: (_s, c) => subjectLotSqft != null && (hasEvidence(c.lotSizeSquareFeet) || hasEvidence(c.lotSizeAcres)),
    },
    {
      key: 'yearBuilt',
      label: COMP_TEST1_LABELS.yearBuilt,
      question: (i) => {
        const t = rule('year_built_diff')?.value ?? 15
        return `Was state.comparables[${i}] built within ±${t} years of the subject's ${subject.yearBuilt ?? 'year built'}? Judge yearBuilt.`
      },
      verifiable: (s, c) => hasEvidence(s.yearBuilt) && hasEvidence(c.yearBuilt),
    },
    {
      key: 'salePrice',
      label: COMP_TEST1_LABELS.salePrice,
      question: (i) => `Is state.comparables[${i}]'s salePrice a usable, credible market sale price for this subject's valuation — a real arm's-length price observation an appraiser can work with? Judge salePrice.`,
      verifiable: (_s, c) => hasEvidence(c.salePrice) && c.salePrice! > 0,
    },
    {
      key: 'saleDate',
      label: COMP_TEST1_LABELS.saleDate,
      question: (i) => {
        const t = rule('sale_age')?.value ?? 180
        return `Is state.comparables[${i}]'s sale within the appraiser's recency standard — a sale inside roughly the last ${t} days of evaluationDate? Judge saleDate/saleAgeDays.`
      },
      verifiable: (_s, c) => hasEvidence(c.saleDate),
    },
  ]
}

// ─── Test 2 — enriched nouls + distance score ───────────────────────────────

export type CompTest2Noul = 'subdivision' | 'neighborhood' | 'physicalCharacter' | 'material'

export const COMP_TEST2_NOUL_LABELS: Record<CompTest2Noul, string> = {
  subdivision: 'Subdivision',
  neighborhood: 'Neighborhood',
  physicalCharacter: 'Physical character',
  material: 'Material match',
}

/** Ordered level descriptions for the distance-dominant Score question — index = level. */
export const COMP_TEST2_SCORE_LEVELS = [
  'Materially far from the subject — proximity evidence too weak to carry weight',
  "Distant — outside the subject's immediate market",
  'Moderate proximity — usable distance evidence',
  'Close — strong proximity to the subject',
  'Immediately adjacent — among the closest sales available',
] as const

function test2Questions(index: number): Record<string, Question> {
  const c = `state.comparables[${index}]`
  return {
    [`t2_${index}_subdivision`]: {
      type: 'noul',
      instructions: `Is ${c} in the subject's subdivision — or a directly competing subdivision an appraiser would treat as the same market? Judge subdivision.`,
    },
    [`t2_${index}_neighborhood`]: {
      type: 'noul',
      instructions: `Is ${c} in the subject's neighborhood — matching the subject's neighborhoodName/neighborhoodCode, or a directly competing area? Judge neighborhoodName/neighborhoodCode.`,
    },
    [`t2_${index}_physicalCharacter`]: {
      type: 'noul',
      instructions: `Does ${c} match the subject's physical character — the same kind of house in building style, size, era, and layout? This match is preferred but not required. Judge construction.buildingStyle, squareFeet, yearBuilt, stories.`,
    },
    [`t2_${index}_material`]: {
      type: 'noul',
      instructions: `Do ${c}'s construction materials match the subject's — frame/block/brick, exterior walls, roof? This match is preferred but not required. Judge construction.type/exteriorWalls/roofCover.`,
    },
    [`t2_${index}_score`]: {
      type: 'score',
      instructions: `Score ${c} as comparable evidence for state.subject — distance to the subject dominates: the closest sale earns the highest level and the score tapers as distanceMiles grows materially farther. Physical character and material similarity are preferred and may lift the score, but they are not required.`,
      criteria: [...COMP_TEST2_SCORE_LEVELS],
    },
  }
}

// ─── Shared plumbing ────────────────────────────────────────────────────────

const TEST_EVIDENCE_NOTE =
  "Evaluation date is state.evaluationDate — judge every sale relative to it, not today. saleAgeDays is days since the comp's sale as of evaluationDate. Fields that are null or absent are unknown — an unverifiable fact is not a failure; answer on the evidence present."

function compTestEvidence(comp: AppraisedComparable, evaluationDate: string): Record<string, unknown> {
  const evalTime = Date.parse(evaluationDate)
  const saleTime = comp.saleDate ? Date.parse(comp.saleDate) : NaN
  return {
    address: comp.address, city: comp.city, state: comp.state, zipCode: comp.zipCode,
    distanceMiles: comp.distanceMiles,
    bedrooms: comp.bedrooms ?? null,
    bathrooms: comp.bathrooms ?? null,
    squareFeet: comp.squareFeet ?? null,
    lotSizeSquareFeet: comp.lotSizeSquareFeet ?? null,
    lotSizeAcres: comp.lotSizeAcres ?? null,
    yearBuilt: comp.yearBuilt ?? null,
    propertyType: comp.propertyType ?? null,
    salePrice: comp.salePrice ?? null,
    saleDate: comp.saleDate ?? null,
    saleAgeDays: Number.isNaN(evalTime) || Number.isNaN(saleTime) ? null : Math.max(0, Math.floor((evalTime - saleTime) / 86_400_000)),
    pricePerSqft: comp.pricePerSqft ?? null,
    subdivision: comp.subdivision ?? null,
    neighborhoodName: comp.neighborhoodName ?? null,
    neighborhoodCode: comp.neighborhoodCode ?? null,
    stories: comp.stories ?? null,
    buildingCondition: comp.buildingCondition ?? null,
    buildingGrade: comp.buildingGrade ?? null,
    construction: comp.construction ?? null,
    features: comp.features ?? null,
    transaction: comp.transaction ?? null,
    isEnriched: comp.isEnriched === true,
    evidenceNote: 'This comparable is a candidate sale being evaluated for the subject valuation — property, location, sale, and transaction facts only.',
  }
}

interface TestBatch {
  body: { model: string; state: Record<string, unknown>; questions: Record<string, Question> }
  ids: string[]
}

function makeTestBatch(
  subjectEvidence: Record<string, unknown>, rules: unknown, evaluationDate: string, model: string,
  comps: Array<Record<string, unknown>>, ids: string[],
  questionsFor: (index: number) => Record<string, Question>,
): TestBatch {
  return {
    ids,
    body: {
      model,
      state: {
        note: TEST_EVIDENCE_NOTE,
        evaluationDate,
        subject: subjectEvidence,
        appraisalRules: rules,
        comparables: comps,
      },
      questions: Object.fromEntries(
        comps.flatMap((_, index) => Object.entries(questionsFor(index))),
      ),
    },
  }
}

function testBatches(
  subject: NormalizedProperty, comps: AppraisedComparable[], rules: unknown,
  evaluationDate: string, model: string,
  questionsFor: (index: number) => Record<string, Question>,
): TestBatch[] {
  const subjectEvidence = truthEvidence(subject, subjectTruthFields)
  const result: TestBatch[] = []
  let pending: Array<Record<string, unknown>> = []
  let ids: string[] = []
  for (const comp of comps) {
    const item = compTestEvidence(comp, evaluationDate)
    const next = makeTestBatch(subjectEvidence, rules, evaluationDate, model, [...pending, item], [...ids, comp.id], questionsFor)
    if (truthFits(next)) { pending.push(item); ids.push(comp.id); continue }
    if (pending.length) {
      result.push(makeTestBatch(subjectEvidence, rules, evaluationDate, model, pending, ids, questionsFor))
    }
    const single = makeTestBatch(subjectEvidence, rules, evaluationDate, model, [item], [comp.id], questionsFor)
    if (!truthFits(single)) throw new Error('Jev comp evaluation context limit: subject, rules, and one comparable exceed the request budget; evidence was not truncated.')
    pending = [item]
    ids = [comp.id]
  }
  if (pending.length) result.push(makeTestBatch(subjectEvidence, rules, evaluationDate, model, pending, ids, questionsFor))
  return result
}

async function askTestBatches(
  batches: TestBatch[], key: string, stage: string,
): Promise<{ responses: Array<{ json: unknown; batch: TestBatch }> }> {
  const responses = await Promise.all(
    batches.map(async (batch) => {
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
        throw new Error(`Jev ${stage} request failed or timed out.`)
      }
      if (!httpResponse.ok) {
        void httpResponse.body?.cancel().catch(() => {})
        throw new Error(`Jev ${stage} API returned HTTP ${httpResponse.status}.`)
      }
      let json: unknown
      try { json = await httpResponse.json() } catch { throw new Error(`Jev ${stage} returned unreadable JSON.`) }
      return { json, batch }
    }),
  )
  return { responses }
}

function validateTestEnvelope(value: unknown, batch: TestBatch, stage: string): { answers: Record<string, unknown>; model: string; inputTokens: number } {
  const malformed = () => new Error(`Jev ${stage} returned an invalid or incomplete typed response; no results were accepted.`)
  if (!object(value) || typeof value.model !== 'string' || !/^jev-[\w.-]+$/.test(value.model) || !object(value.answers) || !object(value.usage)) throw malformed()
  const { input_tokens: inputTokens } = value.usage
  if (typeof inputTokens !== 'number' || !Number.isSafeInteger(inputTokens) || inputTokens < 0) throw malformed()
  const keys = Object.keys(batch.body.questions)
  if (Object.keys(value.answers).length !== keys.length || keys.some((key) => !Object.hasOwn(value.answers as object, key))) throw malformed()
  return { answers: value.answers as Record<string, unknown>, model: value.model, inputTokens }
}

// ─── Test 1 runner ──────────────────────────────────────────────────────────

export interface JevCompTest1Result {
  /** compId → field → 0–1 probability the comp matches the subject on it */
  results: Record<string, Record<CompTest1Field, number>>
  model: string
  latencyMs: number
  inputTokens: number
  stateHashes: string[]
}

function parseTest1Response(
  value: unknown, batch: TestBatch, defs: CompTest1FieldDef[],
): { results: Record<string, Record<CompTest1Field, number>>; model: string; inputTokens: number } {
  const malformed = () => new Error('Jev test 1 returned an invalid or incomplete typed response; no results were accepted.')
  const { answers, model, inputTokens } = validateTestEnvelope(value, batch, 'test 1')
  const results: Record<string, Record<CompTest1Field, number>> = Object.create(null)
  batch.ids.forEach((id, index) => {
    const nouls: Record<CompTest1Field, number> = Object.create(null)
    for (const def of defs) {
      const answer = answers[`t1_${index}_${def.key}`]
      if (!object(answer) || answer.type !== 'noul' || !probability(answer.noul)) throw malformed()
      nouls[def.key] = answer.noul
    }
    results[id] = nouls
  })
  return { results, model, inputTokens }
}

/**
 * Test 1 — the raw-field nouls. One noul per field per comp — "does this
 * comp match the subject on this field per the appraisal rules?" Batched;
 * all-or-nothing. Pass/fail application is the caller's decision
 * (services/comp-hybrid); this returns the raw probabilities.
 */
export async function runCompTest1WithJev(
  subject: NormalizedProperty,
  comps: AppraisedComparable[],
  filters: AppraisalFilter[],
  rules: unknown,
  env: JevEnv,
): Promise<JevCompTest1Result> {
  const start = Date.now()
  const evaluationDate = new Date(start).toISOString().slice(0, 10)
  const key = env.TYPESAFE_API_KEY?.trim()
  if (!key) throw new Error('Jev test 1 requires TYPESAFE_API_KEY.')
  const model = env.TYPESAFE_MODEL?.trim() || 'jev-latest'
  if (!/^jev-[\w.-]+$/.test(model)) throw new Error('Jev test 1 requires a Jev model identifier.')
  if (comps.some((comp) => typeof comp.id !== 'string' || !comp.id.trim()) || new Set(comps.map((c) => c.id)).size !== comps.length) {
    throw new Error('Jev test 1 requires a unique, nonempty ID for every comparable.')
  }

  const defs = buildTest1Defs(filters, subject)
  const batches = testBatches(
    subject, comps, rules, evaluationDate, model,
    (index) => Object.fromEntries(defs.map((def) => [`t1_${index}_${def.key}`, { type: 'noul' as const, instructions: def.question(index) }])),
  )
  const { responses } = await askTestBatches(batches, key, 'test 1')

  const results: Record<string, Record<CompTest1Field, number>> = Object.create(null)
  let inputTokens = 0
  let actualModel: string | undefined
  for (const { json, batch } of responses) {
    const parsed = parseTest1Response(json, batch, defs)
    if (actualModel && actualModel !== parsed.model) throw new Error('Jev test 1 model changed between batches; no mixed-model results were accepted.')
    actualModel = parsed.model
    inputTokens += parsed.inputTokens
    Object.assign(results, parsed.results)
  }
  return {
    results,
    model: actualModel ?? model,
    latencyMs: Date.now() - start,
    inputTokens,
    stateHashes: batches.map((b) => fnv1a(serialized(b.body.state))),
  }
}

// ─── Test 2 runner ──────────────────────────────────────────────────────────

export interface JevCompTest2Result {
  results: Record<string, {
    nouls: Record<CompTest2Noul, number>
    /** Raw score position across the ordered levels */
    rawScore: number
    confidence: number | null
    /** level index → probability */
    levelProbabilities: Record<string, number>
  }>
  model: string
  latencyMs: number
  inputTokens: number
  stateHashes: string[]
}

function parseTest2Response(
  value: unknown, batch: TestBatch,
): { results: JevCompTest2Result['results']; model: string; inputTokens: number } {
  const malformed = () => new Error('Jev test 2 returned an invalid or incomplete typed response; no results were accepted.')
  const { answers, model, inputTokens } = validateTestEnvelope(value, batch, 'test 2')
  const results: JevCompTest2Result['results'] = Object.create(null)
  batch.ids.forEach((id, index) => {
    const nouls: Record<CompTest2Noul, number> = Object.create(null)
    for (const key of ['subdivision', 'neighborhood', 'physicalCharacter', 'material'] as CompTest2Noul[]) {
      const answer = answers[`t2_${index}_${key}`]
      if (!object(answer) || answer.type !== 'noul' || !probability(answer.noul)) throw malformed()
      nouls[key] = answer.noul
    }
    const score = answers[`t2_${index}_score`]
    if (!object(score) || score.type !== 'score' || typeof score.score !== 'number' || !Number.isFinite(score.score)) throw malformed()
    if (score.score < 0 || score.score > COMP_TEST2_SCORE_LEVELS.length - 1) throw malformed()
    if (!object(score.probabilities)) throw malformed()
    const levelProbabilities: Record<string, number> = Object.create(null)
    for (let level = 0; level < COMP_TEST2_SCORE_LEVELS.length; level++) {
      const p = (score.probabilities as Record<string, unknown>)[String(level)]
      if (!probability(p)) throw malformed()
      levelProbabilities[String(level)] = p
    }
    if (score.confidence != null && !probability(score.confidence)) throw malformed()
    results[id] = {
      nouls,
      rawScore: score.score,
      confidence: (score.confidence as number | undefined) ?? null,
      levelProbabilities,
    }
  })
  return { results, model, inputTokens }
}

/**
 * Test 2 — the enriched-data nouls plus the distance-dominant Score. Asked
 * together per comp: subdivision, neighborhood (the pass logic — either yes
 * passes), physical character and material (advisory, preferred not
 * required), and the spectrum Score weighted on distance to the subject.
 * Pass/fail application is the caller's decision (services/comp-hybrid).
 */
export async function runCompTest2WithJev(
  subject: NormalizedProperty,
  comps: AppraisedComparable[],
  rules: unknown,
  env: JevEnv,
): Promise<JevCompTest2Result> {
  const start = Date.now()
  const evaluationDate = new Date(start).toISOString().slice(0, 10)
  const key = env.TYPESAFE_API_KEY?.trim()
  if (!key) throw new Error('Jev test 2 requires TYPESAFE_API_KEY.')
  const model = env.TYPESAFE_MODEL?.trim() || 'jev-latest'
  if (!/^jev-[\w.-]+$/.test(model)) throw new Error('Jev test 2 requires a Jev model identifier.')
  if (comps.some((comp) => typeof comp.id !== 'string' || !comp.id.trim()) || new Set(comps.map((c) => c.id)).size !== comps.length) {
    throw new Error('Jev test 2 requires a unique, nonempty ID for every comparable.')
  }

  const batches = testBatches(subject, comps, rules, evaluationDate, model, test2Questions)
  const { responses } = await askTestBatches(batches, key, 'test 2')

  const results: JevCompTest2Result['results'] = Object.create(null)
  let inputTokens = 0
  let actualModel: string | undefined
  for (const { json, batch } of responses) {
    const parsed = parseTest2Response(json, batch)
    if (actualModel && actualModel !== parsed.model) throw new Error('Jev test 2 model changed between batches; no mixed-model results were accepted.')
    actualModel = parsed.model
    inputTokens += parsed.inputTokens
    Object.assign(results, parsed.results)
  }
  return {
    results,
    model: actualModel ?? model,
    latencyMs: Date.now() - start,
    inputTokens,
    stateHashes: batches.map((b) => fnv1a(serialized(b.body.state))),
  }
}
