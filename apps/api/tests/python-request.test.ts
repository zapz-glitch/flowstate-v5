import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { buildPythonRequest } from '../src/services/evaluation/python-request'
import type { EvaluationParams } from '../src/services/evaluation'

const params = {
  jobId: 'adapter-test',
  bundle: {
    property: { id: 'subject', address: 'Subject', city: 'Tampa', state: 'FL', zipCode: '33629', squareFeet: 1000, bedrooms: 3, bathrooms: 2, yearBuilt: 2000, propertyType: 'SFR' },
    comparables: [{ id: 'comp', provider: 'corelogic', address: 'Comp', squareFeet: 1000, salePrice: 500000, saleDate: '2026-09-01', raw: { pricePerSquareFoot: 500 } }],
    metadata: { fetchedAt: '2026-09-08T12:00:00Z' },
  },
} as unknown as EvaluationParams

const request = buildPythonRequest(params)
assert.equal(request.settings.arv_selection_policy, 'provider_authoritative_upper_half_v2')
assert.equal(request.comps[0].verified_sale_price, null)
assert.equal(request.comps[0].is_sale, null)
assert.equal(request.settings.tiers[0].upper_exclusive, '500000')
assert.equal(request.settings.filters.find(rule => rule.rule_id === 'sqft_diff')?.value, '200')
params.bundle.comparables[0].raw = { saleAmount: 501000, saleDate: '20260901', isSale: false }
assert.equal(buildPythonRequest(params).comps[0].verified_sale_price, '501000')
assert.equal(buildPythonRequest(params).comps[0].is_sale, false)
const conflicting = structuredClone(params)
conflicting.bundle.comparables[0].raw = { salePrice: 501000, saleDate: '20260901', isSale: true, retrievalConflict: true }
assert.equal(buildPythonRequest(conflicting).comps[0].verified_sale_price, null)
params.bundle.comparables[0].raw = { enrichment: { lastMarketSale: { items: [{ transactionDetails: { saleAmount: 499000, saleDateDerived: '2026-09-01' } }] } } }
assert.equal(buildPythonRequest(params).comps[0].verified_sale_price, '499000')
params.bundle.comparables[0].saleDate = '2026-08-01'
assert.equal(buildPythonRequest(params).comps[0].verified_sale_price, null)
params.bundle.property.construction = { buildingStyle: 'Conventional' }
params.bundle.property.lotSizeSquareFeet = 10000
params.bundle.comparables[0].construction = { buildingStyle: 'Ranch' }
params.bundle.comparables[0].lotSizeAcres = 0.25
const styleRequest = buildPythonRequest(params)
assert.equal(styleRequest.subject.building_style, 'Conventional')
assert.equal(styleRequest.comps[0].building_style, 'Ranch')
assert.equal(styleRequest.subject.lot_sqft, '10000')
assert.equal(styleRequest.comps[0].lot_sqft, '10890')
assert.equal(styleRequest.settings.filters.find(rule => rule.kind === 'building_style_match')?.enabled, true)
const conditionParams = structuredClone(params)
conditionParams.bundle.comparables[0].raw = {
  saleAmount: 450000, saleDate: '20260901', isSale: true, garageSpaces: 1,
  conditionEvidence: { status: 'renovated', sale_relevant: true, confidence: 'high', reason: 'Trusted sale-relevant image fixture' },
  physicalSimilarity: { status: 'match', confidence: 'high', reason: 'Ignored legacy visual phenotype' },
  askingPrice: 999999,
}
const conditionRequest = buildPythonRequest(conditionParams)
assert.equal(conditionRequest.comps[0].building_style, 'Ranch')
assert.equal(conditionRequest.comps[0].garage_spaces, 1)
assert.deepEqual(conditionRequest.comps[0].condition_evidence, (conditionParams.bundle.comparables[0].raw as any).conditionEvidence)
assert.equal((conditionRequest.comps[0] as any).physical_similarity, undefined)
assert(!JSON.stringify(conditionRequest).includes('999999'))
assert.equal(buildPythonRequest({ ...params, appraisalRules: { filters: [] } }).settings.filters[0].kind, 'building_style_match')
assert.throws(() => buildPythonRequest({ ...params, appraisalRules: { filters: [{ type: 'building_style_match', enabled: false, value: 1 }] } }), /requires building-style/)
assert.throws(() => buildPythonRequest({ ...params, arvThreshold: { percent: 40 } }), /custom legacy/)
assert.throws(() => buildPythonRequest({ ...params, customTierRanges: [{ key: 'custom', label: 'Custom', minValue: 0, maxValue: 501000 }] }), /canonical/)
const manualRequest = buildPythonRequest({ ...params, buybox: { majorItems: [
  { id: 'roof', enabled: true, cost: 12000 },
  { id: 'roof', enabled: true, cost: 12000 },
  { id: 'foundation', enabled: true, cost: 18000 },
] } })
assert.equal(manualRequest.major_item_evidence.length, 0)
assert.equal(manualRequest.additional_items[0].dedup_group, 'base_overlap:roof')
const longUrlParams = structuredClone(params)
longUrlParams.bundle.comparables[0].raw = { listingResolvedSale: { source: 'zillow', sourceUrl: `https://www.zillow.com/homedetails/${'long-address-'.repeat(30)}`, retrievedAt: '2026-09-09T14:43:27.771Z' } }
manualRequest.comps[0].evidence_ref = buildPythonRequest(longUrlParams).comps[0].evidence_ref
assert(manualRequest.comps[0].evidence_ref.length <= 128)
assert.equal(manualRequest.comps[0].evidence_ref, 'zillow:comp:sale:2026-09-09T14:43:27.771Z')
const python = spawnSync(process.env.PYTHON ?? 'python3', ['-c', `
import json, sys
from decimal import Decimal
from eval_engine.contracts import EvaluationRequestV4
from eval_engine.domain.renovation import evaluate_major_items
request = EvaluationRequestV4.model_validate(json.load(sys.stdin))
ledger = []
items, auto, additional, limitations, results = evaluate_major_items(request.settings.major_items, request.major_item_evidence, request.additional_items, ledger, [])
assert auto == Decimal('0'), auto
assert additional == Decimal('30000'), additional
assert sum(item.signed_amount for item in ledger) == Decimal('30000'), ledger
assert len([item for item in results if item.included]) == 2, results
print('Manual roof and foundation included once without fabricated ages')
`], { input: JSON.stringify(manualRequest), encoding: 'utf8', timeout: 15000, env: { ...process.env, PYTHONPATH: 'services/eval-engine/src' } })
assert.equal(python.status, 0, python.stderr)
console.log(python.stdout.trim())
console.log('Python request adapter: evidence provenance, date matching, canonical tiers, filters and unsupported settings passed')
