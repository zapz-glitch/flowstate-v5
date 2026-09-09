import assert from 'node:assert/strict'
import { evaluateConfigured, recalculatePythonReport, mapPythonResponse, type PythonResult } from '../src/services/evaluation/python'
import type { EvaluationParams } from '../src/services/evaluation'
import type { Env } from '../src/types'
import { signPythonSnapshot } from '../src/services/evaluation/python-snapshot'

const params = {
  jobId: 'synthetic-manual-report',
  bundle: {
    property: { id: 'subject', provider: 'corelogic', address: 'Synthetic Subject', city: 'Tampa', state: 'FL', zipCode: '33629', squareFeet: 2000 },
    comparables: ['one', 'two'].map(id => ({ id, provider: 'corelogic', address: id, city: 'Tampa', state: 'FL', squareFeet: 2000, saleDate: '2026-09-01', raw: { saleAmount: 600000, saleDate: '20260901', isSale: true }, construction: { buildingStyle: 'Conventional', foundationType: 'Slab' }, features: { poolType: 'Pool', garageType: 'Attached' } })),
    enrichment: {}, metadata: { fetchedAt: '2026-09-08T12:00:00Z' },
  },
} as unknown as EvaluationParams
const result: PythonResult = {
  methodology_version: 'evaluation-v4', status: 'REVIEW_REQUIRED', settings_snapshot_id: 'test', settings_content_hash: 'test',
  decisions: ['one', 'two'].map((comp_id, i) => ({ comp_id, priority_rank: i + 1, arv_status: i ? 'REJECTED' : 'ACCEPTED', rejection_reasons: [], limitations: [], rule_outcomes: [] })),
  ledger: [], errors: [], incomplete_sections: [],
  arv: { final_arv: '600000', displayed_arv: '600000', average_adjusted_ppsf: '300', accepted_comp_ids: ['one'], limitations: [] },
  renovation: { total_rehab: '90000', base_rehab: '90000', renovation_level: 'full_cosmetic', limitations: [] },
  deal: { investor_purchase_ceiling_exact: '400000', displayed_buy_price: '400000', seller_contract_ceiling_exact: '390000', closing_costs: '48000', carrying_costs: '12000', flip_profit: '50000', displayed_mao: '390000' }, investor: null,
}
const env = { EVALUATION_ENGINE: 'python-v4', ENVIRONMENT: 'development', V4_LOCAL_BRIDGE_URL: 'http://127.0.0.1:8788', V4_LOCAL_BRIDGE_TOKEN: 'synthetic-manual-test-token-not-secret-123' } as Env
env.V4_SNAPSHOT_ACTIVE_KEY_ID = 'test'
env.V4_SNAPSHOT_KEYS = JSON.stringify({ test: 'synthetic-independent-signing-key-000001' })
env.V4_SNAPSHOT_LEGACY_KEYS = JSON.stringify([env.V4_LOCAL_BRIDGE_TOKEN])
const originalFetch = globalThis.fetch
let requests: Record<string, unknown>[] = []
globalThis.fetch = async (_input, init) => {
  const request = JSON.parse(String(init?.body))
  requests.push(request)
  return Response.json({ engine: 'python-v4', result: { ...result, arv: { ...result.arv, accepted_comp_ids: request.selected_comp_ids ?? ['one'] } } })
}
try {
  const { response } = await evaluateConfigured(params, env)
  const saved = response as ReturnType<typeof mapPythonResponse> & { pythonRequestSignature: string }
  assert.equal(saved.evaluationRevision, 0)
  assert.ok(saved.pythonRequestSignature)
  const before = JSON.stringify(saved)
  const updated = await recalculatePythonReport(saved, params.jobId, ['one', 'two'], env)
  assert.equal(updated.evaluationRevision, 1)
  assert.equal(updated.comps.enabledCount, 2)
  assert.equal(updated.comps.items[0].buildingStyle, 'Conventional')
  assert.equal(updated.comps.items[0].foundationType, 'Slab')
  assert.equal(updated.comps.items[0].pool, 'Pool')
  assert.equal(updated.comps.items[0].garage, 'Attached')
  assert.deepEqual(updated.manualCompSelection, ['one', 'two'])
  assert.deepEqual(requests.at(-1)?.settings, saved.pythonRequest.settings)
  assert.deepEqual(requests.at(-1)?.comps, JSON.parse(JSON.stringify(saved.pythonRequest.comps)))
  assert.ok(updated.riskFlags.some(flag => flag.includes('Listing evidence unavailable')))
  assert.equal(JSON.stringify(saved), before)
  const reset = await recalculatePythonReport(updated, params.jobId, null, env)
  assert.equal(reset.evaluationRevision, 2)
  assert.equal(reset.manualCompSelection, null)
  assert.equal(reset.comps.enabledCount, 1)
  const recovered = await recalculatePythonReport({ ...saved, valuation: null }, params.jobId, ['one'], env)
  assert.equal(recovered.valuation?.arv, 600000)
  for (const policy of ['legacy_physical_v1', 'upper_half_rule_weighted_v1']) {
    const priorRequest = structuredClone(saved.pythonRequest) as any
    priorRequest.settings.arv_selection_policy = policy
    const priorReport = { ...saved, pythonRequest: priorRequest, pythonSettings: priorRequest.settings,
      pythonRequestSignature: await signPythonSnapshot(params.jobId, priorRequest, env.V4_LOCAL_BRIDGE_TOKEN!) }
    await recalculatePythonReport(priorReport, params.jobId, ['one', 'two'], env)
    assert.equal((requests.at(-1)?.settings as any).arv_selection_policy, policy)
  }
  const priorCalls = requests.length
  await assert.rejects(recalculatePythonReport(saved, 'different-report', ['one'], env), /no verified recalculation snapshot/)
  await assert.rejects(recalculatePythonReport({ ...saved, pythonRequestSignature: undefined }, params.jobId, ['one'], env), /no verified recalculation snapshot/)
  await assert.rejects(recalculatePythonReport(saved, params.jobId, ['unknown'], env), /lack valid sale evidence/)
  assert.equal(requests.length, priorCalls)
  globalThis.fetch = async () => { throw new Error('Synthetic bridge outage') }
  await assert.rejects(recalculatePythonReport(saved, params.jobId, ['two'], env), /bridge outage/)
  assert.equal(JSON.stringify(saved), before)
} finally {
  globalThis.fetch = originalFetch
}
console.log('Manual Python adapter: signed immutable evidence, add/reset, revision, display preservation and failure rollback passed')
