import assert from 'node:assert/strict'
import { mapPythonResponse, evaluateConfigured, type PythonResult } from '../src/services/evaluation/python'
import type { EvaluationParams } from '../src/services/evaluation'
import type { Env } from '../src/types'

// Synthetic contract fixture; these values are not a live property appraisal.
const params = {
  jobId: 'python-response-contract-test',
  bundle: {
    property: { id: 'subject', provider: 'corelogic', address: 'Synthetic Subject', city: 'Tampa', state: 'FL', zipCode: '33629', squareFeet: 2000 },
    comparables: [
      { id: 'accepted', provider: 'corelogic', address: 'Synthetic Accepted', city: 'Tampa', state: 'FL', squareFeet: 2000, salePrice: 600000, saleDate: '2026-09-01', raw: { saleAmount: 600000, saleDate: '20260901', isSale: true } },
      { id: 'rejected', provider: 'corelogic', address: 'Synthetic Rejected', city: 'Tampa', state: 'FL', squareFeet: 2000, salePrice: 990000, saleDate: '2026-09-01', raw: { pricePerSquareFoot: 495 } },
    ],
    enrichment: { evidenceLimitations: ['Subject flood-zone evidence is unavailable; risk is unknown'] },
    metadata: { fetchedAt: '2026-09-08T12:00:00Z' },
  },
} as unknown as EvaluationParams

const result: PythonResult = {
  methodology_version: 'evaluation-v4', status: 'REVIEW_REQUIRED', settings_snapshot_id: 'synthetic-snapshot', settings_content_hash: 'synthetic-hash',
  decisions: [
    { comp_id: 'accepted', arv_status: 'ACCEPTED', rejection_reasons: [], limitations: [], match_percent: '83.33333333333333333333333333', matched_rule_count: 5, total_rule_count: 6, mismatch_reasons: ['Sale older than threshold'], selection_reason: 'Best available rule match', rule_outcomes: [{ rule_id: 'sale', kind: 'sale', passed: true, reason: 'Synthetic verified sale' }] },
    { comp_id: 'rejected', arv_status: 'REJECTED', rejection_reasons: ['Missing verified sale price'], limitations: [], rule_outcomes: [] },
  ],
  ledger: [{ stage: 'comp', target_id: 'accepted', rule_id: 'synthetic-adjustment', signed_amount: '-12500.25', evidence: 'Synthetic adjustment evidence' }],
  errors: [], incomplete_sections: ['initial_offer'],
  arv: { final_arv: '612345.67', average_adjusted_ppsf: '306.172835', accepted_comp_ids: ['accepted'], limitations: ['Preliminary valuation: one qualifying comparable'] },
  renovation: { total_rehab: '65432.10', base_rehab: '60000', renovation_level: 'light_cosmetic', limitations: [] },
  deal: { investor_purchase_ceiling_exact: '450123.45', seller_contract_ceiling_exact: '440123.45', closing_costs: '15000.10', carrying_costs: '5000.20', flip_profit: '76789.82', displayed_mao: '440000' },
  investor: null,
}

const mapped = mapPythonResponse(params, result)
const detailParams = structuredClone(params)
detailParams.bundle.comparables[0].saleDate = null
detailParams.bundle.comparables[0].raw = { enrichment: { lastMarketSale: { items: [{ transactionDetails: { saleAmount: 300000, saleDateDerived: '2026-08-01' } }] } } }
const detailReport = mapPythonResponse(detailParams, result)
assert.equal(detailReport.comps.items[0].salePrice, 300000)
assert.equal(detailReport.comps.items[0].saleDate, '2026-08-01')
assert.equal(mapped.subject.permits.status, 'unavailable')
const permitParams = structuredClone(params)
permitParams.bundle.enrichment.permits = { count: 1, items: [{ permitId: 'roof-1', permitNumber: 'R1', status: 'Completed', effectiveDate: '2024-03-01', expirationDate: null, projectType: 'Roofing', projectCategory: null, classificationTypes: [], description: 'Roof replacement', jobValue: 12000, contractorName: null, areaSquareFeet: null, raw: { internal: 'provider payload' } }] }
const permitReport = mapPythonResponse(permitParams, result)
assert.equal(permitReport.subject.permits.items[0].permitNumber, 'R1')
assert.equal(permitReport.permits?.items[0].description, 'Roof replacement')
assert.equal('raw' in permitReport.subject.permits.items[0], false)
permitParams.bundle.enrichment.permits = { count: 0, items: [] }
assert.equal(mapPythonResponse(permitParams, result).subject.permits.status, 'empty')
assert.ok(mapped.valuation)
assert.equal(mapped.evaluationEngine, 'python-v4')
assert.equal(mapped.pythonEvaluation, result)
assert.equal(mapped.valuation.arv, 612345.67)
assert.equal(mapped.valuation.buyPrice, 450123.45)
assert.equal(mapped.valuation.wholesalePrice, 440123.45)
assert.equal(mapped.valuation.rehabCost, 65432.1)
assert.equal(mapped.valuation.closingCosts, 15000.1)
assert.equal(mapped.valuation.carryingCosts, 5000.2)
assert.equal(mapped.valuation.projectedProfit, 76789.82)
assert.equal(mapped.valuation.displayedWholesalePrice, 440000)
assert.deepEqual(mapped.valuation.displayRounding, { increment: 1000, mode: 'half_up' })
const rounded = mapPythonResponse(params, {
  ...result,
  arv: { ...result.arv!, displayed_arv: '612000' },
  deal: { ...result.deal!, displayed_buy_price: '450000' },
})
assert.equal(rounded.valuation.displayedArv, 612000)
assert.equal(rounded.valuation.displayedBuyPrice, 450000)
assert.equal(rounded.valuation.arv, mapped.valuation.arv)
assert.equal(rounded.valuation.buyPrice, mapped.valuation.buyPrice)
assert.equal(rounded.valuation.wholesalePrice, mapped.valuation.wholesalePrice)
assert.equal(rounded.valuation.rehabCost, mapped.valuation.rehabCost)
assert.throws(() => mapPythonResponse(params, { ...result, arv: { ...result.arv!, displayed_arv: 'NaN' } }), /no valid displayed ARV/)
assert.equal(mapped.comps.avgPricePerSqft, 306.172835)
assert.ok(mapped.riskFlags?.includes('Preliminary valuation: one qualifying comparable'))
assert.ok(mapped.riskFlags?.includes('Subject flood-zone evidence is unavailable; risk is unknown'))
assert.deepEqual(mapped.comps.items.map(comp => comp.isEnabled), [true, false])
assert.equal(mapped.comps.items[0].adjustedPrice, 587499.75)
assert.equal(mapped.comps.items[0].matchRuleCount, 5)
assert.equal(mapped.comps.items[0].matchRuleTotal, 6)
assert.equal(mapped.comps.items[0].appraisalRules?.passedFilters, false)
assert.ok(mapped.comps.items[0].matchPercent! < 100)
assert.deepEqual(mapped.comps.items[0].matchReasons, ['Sale older than threshold'])
const investorResult = mapPythonResponse(params, { ...result, investor: { status: 'COHORT_FOUND', method_label: 'ENGINEERING_PROPOSAL', selected_count: 1, eligible_count: 8, selected_comp_ids: ['rejected'], subject_investor_value: '300000', limitations: ['Inferred cohort, not verified buyer intent'] } })
assert.equal(investorResult.valuation.investorAnalysis?.value, 300000)
assert.equal(investorResult.valuation.asIsValue, 300000)
assert.equal(investorResult.valuation.arv, mapped.valuation.arv)
assert.equal(investorResult.valuation.buyPrice, mapped.valuation.buyPrice)
assert.equal(investorResult.comps.items[1].compGroup, 'as_is')
const noCohort = mapPythonResponse(params, { ...result, investor: { status: 'INSUFFICIENT_INVESTOR_DATA', method_label: 'ENGINEERING_PROPOSAL', selected_count: 0, eligible_count: 2, selected_comp_ids: [], subject_investor_value: null, limitations: ['No defensible cohort'] } })
assert.equal(noCohort.valuation.investorAnalysis?.value, null)
assert.equal(noCohort.comps.items[1].compGroup, null)
assert.equal(mapped.comps.items[1].salePrice, null)
assert.deepEqual(mapped.comps.items[1].disableReasons, ['Missing verified sale price'])

const insufficient = { ...result, status: 'INSUFFICIENT_COMPS', arv: { ...result.arv!, final_arv: null, accepted_comp_ids: [] }, deal: null }
const diagnostic = mapPythonResponse(params, insufficient)
assert.equal(diagnostic.valuation, null)
assert.equal(diagnostic.pythonEvaluation, insufficient)
assert.equal(diagnostic.comps.enabledCount, 0)
assert.equal(diagnostic.comps.items.length, params.bundle.comparables.length)
assert.ok(diagnostic.riskFlags.some(flag => flag.includes('No valuation or buy price was calculated')))
assert.throws(() => mapPythonResponse(params, { ...insufficient, status: 'FAILED' }), /No legacy fallback/)
for (const invalid of ['NaN', 'Infinity', '1e9', '', null]) {
  assert.throws(() => mapPythonResponse(params, { ...result, deal: { ...result.deal!, investor_purchase_ceiling_exact: invalid } }), /no valid investor ceiling/)
}

const env = { EVALUATION_ENGINE: 'python-v4', ENVIRONMENT: 'development', V4_LOCAL_BRIDGE_URL: 'http://127.0.0.1:8788', V4_LOCAL_BRIDGE_TOKEN: 'synthetic-test-token-not-a-secret-12345' } as Env
env.V4_SNAPSHOT_ACTIVE_KEY_ID = 'test'
env.V4_SNAPSHOT_KEYS = JSON.stringify({ test: 'synthetic-independent-signing-key-000001' })
const originalFetch = globalThis.fetch
let fetchCalls = 0
let nextResponse = () => Response.json({ engine: 'python-v4', result })
globalThis.fetch = async (input, init) => {
  fetchCalls += 1
  assert.equal(String(input), 'http://127.0.0.1:8788/evaluate')
  assert.equal(init?.redirect, 'manual')
  assert.equal(init?.method, 'POST')
  assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${env.V4_LOCAL_BRIDGE_TOKEN}`)
  assert.equal(JSON.parse(String(init?.body)).subject.subject_id, 'subject')
  return nextResponse()
}

try {
  const evaluated = await evaluateConfigured(params, env)
  assert.equal(evaluated.response.valuation.arv, mapped.valuation.arv)
  assert.equal((evaluated.response as typeof mapped).evaluationEngine, 'python-v4')
  for (const status of [302, 401, 500, 503]) {
    nextResponse = () => new Response(null, { status, headers: { Location: 'https://outside.example/evaluate' } })
    await assert.rejects(evaluateConfigured(params, env), new RegExp(`HTTP ${status}; no legacy fallback`))
  }
  nextResponse = () => { throw new Error('Synthetic connection refused') }
  await assert.rejects(evaluateConfigured(params, env), /connection refused/)
  nextResponse = () => Response.json({ engine: 'legacy', result })
  await assert.rejects(evaluateConfigured(params, env), /Invalid Python V4 response/)
  nextResponse = () => Response.json({ engine: 'python-v4', result: { ...result, methodology_version: 'wrong-version' } })
  await assert.rejects(evaluateConfigured(params, env), /Invalid Python V4 response/)
  nextResponse = () => Response.json({ engine: 'python-v4', result: insufficient })
  const insufficientReport = await evaluateConfigured(params, env)
  assert.equal(insufficientReport.response.valuation, null)
  assert.ok((insufficientReport.response as typeof mapped & { pythonRequestSignature: string }).pythonRequestSignature)
  const callsBeforeInvalidConfiguration = fetchCalls
  for (const [override, expected] of [
    [{ EVALUATION_ENGINE: 'typo' }, /Unknown evaluation engine/],
    [{ ENVIRONMENT: 'production' }, /restricted to local development/],
    [{ V4_LOCAL_BRIDGE_URL: 'https://localhost:8788' }, /loopback HTTP/],
    [{ V4_LOCAL_BRIDGE_URL: 'http://outside.example' }, /loopback HTTP/],
    [{ V4_LOCAL_BRIDGE_URL: 'http://localhost.attacker.example' }, /loopback HTTP/],
    [{ V4_LOCAL_BRIDGE_URL: 'http://user:password@localhost:8788' }, /loopback HTTP/],
    [{ V4_LOCAL_BRIDGE_TOKEN: 'short' }, /token is not configured/],
  ] as const) {
    await assert.rejects(evaluateConfigured(params, { ...env, ...override } as Env), expected)
  }
  assert.equal(fetchCalls, callsBeforeInvalidConfiguration)
} finally {
  globalThis.fetch = originalFetch
}

console.log('Python response and dispatcher: authority, provenance, explicit failures, redirect protection, and local configuration checks passed')
