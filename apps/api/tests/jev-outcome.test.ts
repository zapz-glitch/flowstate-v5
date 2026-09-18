import assert from 'node:assert/strict'
import { classifyOutcomeWithJev, OUTCOME_DIMENSIONS } from '../src/services/jev'
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
  OUTCOME_DIMENSIONS.map((d, i) => {
    const options = [
      ['sufficient', 'limited', 'insufficient'],
      ['strong', 'adequate', 'weak'],
      ['favorable', 'marginal', 'unfavorable'],
      ['agree', 'disagree', 'uncertain'],
      ['none', 'minor', 'material'],
    ][i]
    return [`outcome_${d}`, {
      type: 'choice', choice: options[0], confidence: 0.9,
      probabilities: { [options[0]]: 0.9, [options[1]]: 0.07, [options[2]]: 0.03 },
    }]
  }),
)

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
    return Response.json({ model: 'jev-test-1', answers, usage: { input_tokens: 1234 } })
  }
  const result = await classifyOutcomeWithJev(fakeResponse(), { TYPESAFE_API_KEY: 'k', TYPESAFE_MODEL: 'jev-test-1' })
  assert.equal(result.status, 'completed')
  if (result.status !== 'completed') throw new Error('unreachable')
  assert.equal(result.model, 'jev-test-1')
  assert.equal(result.inputTokens, 1234)
  assert.equal(result.classifications.evidence_sufficiency.choice, 'sufficient')
  assert.equal(result.classifications.risk_flags.choice, 'none')
  assert.equal(Object.keys(result.classifications).length, OUTCOME_DIMENSIONS.length)
  // Only enabled comps are projected as selected
  assert.equal((body!.state as { comps: { selected: unknown[] } }).comps.selected.length, 1)
  // Input response is not mutated
  assert.equal(fakeResponse().valuation.arv, 250000)
}

// 3. HTTP error → throws (caller degrades to unavailable)
{
  globalThis.fetch = async () => Response.json({ error: 'x' }, { status: 500 })
  await assert.rejects(() => classifyOutcomeWithJev(fakeResponse(), { TYPESAFE_API_KEY: 'k' }))
}

// 4. Malformed answer payload → throws
{
  globalThis.fetch = async () => Response.json({ model: 'jev-test-1', answers: {}, usage: { input_tokens: 1 } })
  await assert.rejects(() => classifyOutcomeWithJev(fakeResponse(), { TYPESAFE_API_KEY: 'k' }))
}

globalThis.fetch = originalFetch
console.log('jev-outcome tests passed')
