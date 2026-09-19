import assert from 'node:assert/strict'
import { classifyOutcomeWithJev, OUTCOME_DIMENSIONS, scoreCompTruthWithJev } from '../src/services/jev'
import type { AnalysisResponse } from '../src/services/analysis'

function fakeResponse(): AnalysisResponse {
  return {
    subject: {
      id: 'clip-1', address: '1 Main St', county: 'DeKalb', latitude: null, longitude: null,
      bedrooms: 3, bathrooms: 2, bedsBaths: '3/2', squareFeet: 1400, lotSizeAcres: 0.2,
      yearBuilt: 1985, propertyType: 'Single Family', subdivision: 'Test Sub', parcelId: null,
      apnFormatted: null, neighborhoodName: null, neighborhoodCode: null, cbsaCode: null,
      censusTract: null, legalDescription: null, lastSale: null, taxAssessment: null,
      photos: [], foundationType: null, buildingStyle: null, storiesType: null, pool: null,
      garage: null, garageSquareFeet: null, carport: null, hoaFee: null, zillowUrl: null,
      condition: 'renovated', curbAppeal: null, listingUrl: null, listPrice: 180000,
      permits: null, classification: null, buildingCondition: null, buildingGrade: null,
      improvementValue: null, additionSquareFeet: null, roofCover: null, constructionType: null,
      exteriorWalls: null, roofType: null, heating: null, cooling: null, fireplacesCount: null,
      avm: null,
    },
    valuation: {
      arv: 250000, arvSource: 'appraisal', arvMethodology: 'test', arvPerSqft: 178,
      asIsValue: 170000, afterRenovationValue: 250000, spread: 80000,
      spreadAnalysis: null, asIsMarketIntel: null, listPrice: 180000, arvVsListPrice: -70000,
      buyPrice: 150000, buyPricePercent: 60, locationPenalty: 0, locationPenaltyPercent: 0,
      rehabCost: 40000, rehabLevel: 'moderate', rehabPerSqft: 28.5, rehabLevelEstimates: [],
      closingCosts: 20000, carryingCosts: 5000, totalCosts: 65000, totalInvestment: 215000,
      projectedProfit: 35000, projectedROI: 16, wholesalePrice: 160000,
      recommendation: 'buy', recommendationReason: 'test', confidence: 'high',
      confidenceReasons: [], requiresHumanReview: false,
    },
    comps: {
      total: 2, retrieval: null, enabledCount: 1, disabledCount: 1,
      avgPricePerSqft: 170, medianPrice: 240000, asIsCompIds: [], afterRenovationCompIds: ['c1'],
      items: [
        {
          id: 'c1', address: '2 Main St', latitude: null, longitude: null, salePrice: 245000,
          saleDate: '2026-06-01', squareFeet: 1420, pricePerSqft: 172, distanceMiles: 0.3,
          bedrooms: 3, bathrooms: 2, bedsBaths: '3/2', yearBuilt: 1988, lotSizeAcres: 0.21,
          adjustedPrice: 248000, photos: [], subdivision: 'Test Sub', isEnabled: true,
          compGroup: 'arv', disableReasons: [], classification: null,
          appraisalRules: {
            passedFilters: true, totalAdjustment: 3000,
            filters: [{ type: 'distance', passed: true }],
            adjustments: [{ type: 'sqft_diff', applied: true, amount: 3000 }],
          },
        } as never,
        {
          id: 'c2', address: '9 Far Rd', latitude: null, longitude: null, salePrice: 200000,
          saleDate: '2025-01-01', squareFeet: 1500, pricePerSqft: 133, distanceMiles: 3.2,
          bedrooms: 3, bathrooms: 1, bedsBaths: '3/1', yearBuilt: 1970, lotSizeAcres: 0.3,
          adjustedPrice: null, photos: [], subdivision: null, isEnabled: false,
          compGroup: null, disableReasons: ['distance'], classification: null, appraisalRules: null,
        } as never,
      ],
    },
    meta: { analysisId: 'job-test', timestamp: '2026-09-18T00:00:00Z', dataProvider: 'test' },
  } as unknown as AnalysisResponse
}

const answers = Object.fromEntries(
  OUTCOME_DIMENSIONS.flatMap((d, i) => {
    const options = [
      ['sufficient', 'limited', 'insufficient'],
      ['strong', 'adequate', 'weak'],
      ['favorable', 'marginal', 'unfavorable'],
      ['agree', 'disagree', 'uncertain'],
      ['none', 'minor', 'material'],
    ][i]
    return [[`outcome_${d}`, {
      type: 'choice', choice: options[0], confidence: 0.9,
      probabilities: { [options[0]]: 0.9, [options[1]]: 0.07, [options[2]]: 0.03 },
    }]]
  }),
)
// Mirror whatever driver questions the service emits — assert via request body
// shape in test 2 rather than hardcoding keys here.

const originalFetch = globalThis.fetch

// 1. No key → skipped, no request
{
  globalThis.fetch = async () => { throw new Error('fetch should not be called') }
  const result = await classifyOutcomeWithJev(fakeResponse(), {})
  assert.equal(result.status, 'skipped')
}

// 2. Valid typed response → completed with all dimensions classified
{
  let body: Record<string, unknown> | null = null
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body))
    const questions = (body!.questions ?? {}) as Record<string, { type: string; criteria?: Record<string, string> }>
    const echoed = Object.fromEntries(Object.entries(questions).map(([id, q]) => {
      if (q.type === 'choice') {
        const options = Object.keys(q.criteria ?? {})
        return [id, answers[id] ?? {
          type: 'choice', choice: options[0], confidence: 0.9,
          probabilities: { [options[0]]: 0.9, [options[1]]: 0.07, [options[2]]: 0.03 },
        }]
      }
      return [id, { type: 'noul', noul: 0.75 }]
    }))
    return Response.json({ model: 'jev-test-1', answers: echoed, usage: { input_tokens: 1234 } })
  }
  const result = await classifyOutcomeWithJev(fakeResponse(), { TYPESAFE_API_KEY: 'k', TYPESAFE_MODEL: 'jev-test-1' })
  assert.equal(result.status, 'completed')
  if (result.status !== 'completed') throw new Error('unreachable')
  assert.equal(result.model, 'jev-test-1')
  assert.equal(result.inputTokens, 1234)
  assert.equal(result.classifications.evidence_sufficiency?.choice, 'sufficient')
  assert.equal(result.classifications.risk_flags?.choice, 'none')
  assert.equal(Object.keys(result.classifications).length, OUTCOME_DIMENSIONS.length)
  // Raw passthrough carries every answer
  assert.equal(Object.keys(result.answers).length, Object.keys((body!.questions ?? {})).length)
  assert.equal(result.answers.outcome_deal_outlook?.choice, 'favorable')
  // Driver nouls folded under their dimension
  assert.equal(result.drivers.evidence_sufficiency.enough_comps, 0.75)
  assert.equal(result.drivers.risk_flags.thin_evidence, 0.75)
  assert.ok(Object.keys(result.drivers.comp_set_quality).length > 0)
  // Only enabled comps are projected as selected
  assert.equal((body!.state as { comps: { selected: unknown[] } }).comps.selected.length, 1)
  // Input response is not mutated
  assert.equal(fakeResponse().valuation.arv, 250000)
}

// 2b. Question-type changes still return the outcome — score answers,
// missing keys, and unknown question types pass through `answers`
{
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    const questions = (body!.questions ?? {}) as Record<string, { type: string }>
    const echoed: Record<string, unknown> = {}
    for (const [id, q] of Object.entries(questions)) {
      if (id === 'outcome_risk_flags') continue // dimension unanswered entirely
      if (id === 'outcome_deal_outlook') {
        // Retyped to a score question — must not nuke the classification
        echoed[id] = { type: 'score', score: 1.4, confidence: 0.8, probabilities: { '0': 0.1, '1': 0.5, '2': 0.4 } }
      } else if (q.type === 'choice') {
        const options = Object.keys((q as { criteria?: Record<string, string> }).criteria ?? {})
        echoed[id] = answers[id] ?? {
          type: 'choice', choice: options[0], confidence: 0.9,
          probabilities: { [options[0]]: 0.9, [options[1]]: 0.07, [options[2]]: 0.03 },
        }
      } else {
        echoed[id] = { type: 'noul', noul: 0.75 }
      }
    }
    echoed['future_custom_key'] = { type: 'wat', value: 42 } // unknown future type
    return Response.json({ model: 'jev-test-1', answers: echoed, usage: { input_tokens: 9 } })
  }
  const result = await classifyOutcomeWithJev(fakeResponse(), { TYPESAFE_API_KEY: 'k', TYPESAFE_MODEL: 'jev-test-1' })
  assert.equal(result.status, 'completed')
  if (result.status !== 'completed') throw new Error('unreachable')
  // The retyped dimension stays in `classifications` under its stable name;
  // the unanswered one is the only absent key
  assert.equal(result.classifications.deal_outlook?.type, 'score')
  assert.equal(result.classifications.deal_outlook?.score, 1.4)
  assert.equal(result.classifications.risk_flags, undefined)
  assert.equal(result.answers.outcome_deal_outlook?.type, 'score')
  assert.equal(result.answers.future_custom_key?.type, 'wat')
  // Surviving dimensions still classify
  assert.equal(result.classifications.evidence_sufficiency?.choice, 'sufficient')
  // Drivers still extracted under the changed set
  assert.equal(result.drivers.evidence_sufficiency.enough_comps, 0.75)
}

// 3. HTTP error → throws (caller degrades to unavailable)
{
  globalThis.fetch = async () => Response.json({ error: 'x' }, { status: 500 })
  await assert.rejects(() => classifyOutcomeWithJev(fakeResponse(), { TYPESAFE_API_KEY: 'k' }))
}

// 4. Empty answer payload → throws (nothing to report)
{
  globalThis.fetch = async () => Response.json({ model: 'jev-test-1', answers: {}, usage: { input_tokens: 1 } })
  await assert.rejects(() => classifyOutcomeWithJev(fakeResponse(), { TYPESAFE_API_KEY: 'k' }))
}

// ─── Comp truth scoring ────────────────────────────────────────────────────────

const fakeSubject = {
  id: 's1', address: '1 Main St', city: 'Atlanta', state: 'GA', zipCode: '30301',
  bedrooms: 3, bathrooms: 2, squareFeet: 1400, yearBuilt: 1985, subdivision: 'Test Sub',
} as never

const fakeComp = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, address: `${id} Oak Ln`, city: 'Atlanta', state: 'GA', salePrice: 240000,
  saleDate: '2026-06-01', squareFeet: 1420, distanceMiles: 0.4, bedrooms: 3, bathrooms: 2,
  yearBuilt: 1987, adjustedSalePrice: 245000,
  evaluation: {
    comparableId: id, shouldDisable: false, disableReasons: [],
    filterResults: [{ type: 'distance', passed: true }],
    totalAdjustment: 5000, adjustmentResults: [], originalPrice: 240000, adjustedPrice: 245000,
  },
  ...overrides,
}) as never

// 5. No key → throws
{
  globalThis.fetch = async () => { throw new Error('fetch should not be called') }
  await assert.rejects(() => scoreCompTruthWithJev(fakeSubject, [fakeComp('c1')], {}, {}))
}

// 6. Valid response → dual truth scores keyed by comp id, two noul questions per comp
{
  let body: Record<string, unknown> | null = null
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body))
    const questions = (body!.questions ?? {}) as Record<string, { type: string }>
    assert.ok(Object.values(questions).every((q) => q.type === 'noul'))
    const echoed = Object.fromEntries(
      Object.keys(questions).map((id) => {
        const noul = id.endsWith('_arv_truth') ? 0.9 : 0.3
        return [id, { type: 'noul', noul }]
      }),
    )
    return Response.json({ model: 'jev-test-1', answers: echoed, usage: { input_tokens: 800 } })
  }
  const comps = [fakeComp('c1'), fakeComp('c2'), fakeComp('c3')]
  const result = await scoreCompTruthWithJev(fakeSubject, comps, { filters: [] }, { TYPESAFE_API_KEY: 'k', TYPESAFE_MODEL: 'jev-test-1' })
  assert.equal(result.model, 'jev-test-1')
  assert.deepEqual(Object.keys(result.scores).sort(), ['c1', 'c2', 'c3'])
  assert.deepEqual(result.scores.c1, { arvTruth: 0.9, investmentTruth: 0.3 })
  assert.deepEqual(result.scores.c3, { arvTruth: 0.9, investmentTruth: 0.3 })
  // Two questions per comp: arv + investment truth
  assert.equal(Object.keys((body!.questions ?? {})).length, 6)
  // Comps are projected into state.comparables with rule evidence, no scores leaked
  const state = body!.state as { comparables: Array<Record<string, unknown>> }
  assert.equal(state.comparables.length, 3)
  assert.equal(state.comparables[0].jevArvTruth, undefined)
  assert.ok(Object.hasOwn(state.comparables[0], 'ruleEvidence'))
}

// 7. Missing answer for one comp → whole batch rejected
{
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }
    const keys = Object.keys(body.questions)
    const echoed = Object.fromEntries(keys.slice(0, -1).map((id) => [id, { type: 'noul', noul: 0.5 }]))
    return Response.json({ model: 'jev-test-1', answers: echoed, usage: { input_tokens: 1 } })
  }
  await assert.rejects(() => scoreCompTruthWithJev(fakeSubject, [fakeComp('c1'), fakeComp('c2')], {}, { TYPESAFE_API_KEY: 'k' }))
}

// 8. Duplicate comp ids → throws before any request
{
  globalThis.fetch = async () => { throw new Error('fetch should not be called') }
  await assert.rejects(() => scoreCompTruthWithJev(fakeSubject, [fakeComp('c1'), fakeComp('c1')], {}, { TYPESAFE_API_KEY: 'k' }))
}

globalThis.fetch = originalFetch
console.log('jev-outcome tests passed')
