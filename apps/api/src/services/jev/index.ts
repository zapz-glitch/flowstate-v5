/**
 * Jev outcome classification (read-only).
 *
 * Jev sees the COMPLETED v5 analysis — subject, valuation, selected comps,
 * confidence gate, pipeline fallbacks — and labels the outcome along five
 * fixed dimensions. It has zero influence on comp selection, ARV, or the
 * recommendation: classification runs after the result is built and is
 * attached to the response for display/review only.
 */

import type { AnalysisResponse } from '../analysis'

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
    { key: 'confidence_flagged', favorable: false, instructions: "The pipeline's own confidence gate flagged this outcome for human review." },
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
      confidence: v.confidence ?? null,
      confidenceReasons: v.confidenceReasons ?? null,
      requiresHumanReview: v.requiresHumanReview ?? null,
    },
    comps: {
      total: response.comps.total,
      enabledCount: response.comps.enabledCount,
      disabledCount: response.comps.disabledCount,
      avgPricePerSqft: response.comps.avgPricePerSqft,
      medianPrice: response.comps.medianPrice,
      bestMatch: response.comps.bestMatch ?? null,
      selected: enabled.map(projectComp),
    },
    report: response.report
      ? {
          confidence: response.report.confidence,
          confidenceReasons: response.report.confidenceReasons,
          fallbacksUsed: response.report.fallbacksUsed,
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
