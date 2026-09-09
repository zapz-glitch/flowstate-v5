import assert from 'node:assert/strict'
import { createCoreLogicProvider, normalizeBuildingPermits } from '../src/services/property-api/providers/corelogic'
import { floodZoneKey, permitsKey } from '../src/services/cache'
import type { Env } from '../src/types'

const fixture = { items: [{ clip: 'test', permit: { id: 'p1', number: 'roof1', buildingPermitStatus: [{ status: 'Issued', effectiveDate: '2020-01-02' }, { status: 'Completed', effectiveDate: '2020-04-03' }], areaSquareFeet: 1200 }, project: { type: 'Roofing', subType: 'Replacement', description: 'Replace entire roof', jobValue: 12000, buildingPermitClassifications: [{ projectType: 'Roof replacement', projectTypeCategory: 'Roofing' }] }, contractors: [{ businessName: 'Fixture Contractor' }] }] }
const [permit] = normalizeBuildingPermits(fixture)
assert.equal(permit.permitId, 'p1')
assert.equal(permit.status, 'Completed')
assert.equal(permit.effectiveDate, '2020-04-03')
assert.equal(permit.statusHistory?.length, 2)
assert.equal(permit.jobValue, 12000)
assert.equal(permit.source, 'corelogic:building-permits')
assert.deepEqual(permit.raw, fixture.items[0])
assert.deepEqual(normalizeBuildingPermits({ items: [] }), [])
assert.throws(() => normalizeBuildingPermits({}), /INVALID_RESPONSE/)
assert.match(permitsKey('test', 'corelogic'), /evidence-v2/)
assert.match(floodZoneKey('test', 'corelogic'), /evidence-v2/)
const originalFetch = globalThis.fetch
let payload: unknown = fixture
let status = 200
const paths: string[] = []
globalThis.fetch = async (input, options) => {
  if (options?.method === 'POST') return Response.json({ access_token: 'fixture-token', expires_in: 3600 })
  paths.push(new URL(String(input)).pathname)
  return Response.json(payload, { status })
}
try {
  const provider = createCoreLogicProvider({ CORELOGIC_CLIENT_ID: 'fixture', CORELOGIC_CLIENT_SECRET: 'fixture' } as Env)
  assert.equal((await provider.getBuildingPermits('test')).success, true)
  assert.equal(paths[0], '/v2/properties/test/building-permits')
  payload = { message: 'not have proper entitlements' }; status = 403
  const denied = await provider.getBuildingPermits('test')
  assert.equal(denied.success, false)
  assert.equal(!denied.success && denied.code, 'ENTITLEMENTS_ERROR')
  assert.equal((await provider.getFloodZone(27, -82)).success, false)
  status = 404; payload = {}
  assert.equal((await provider.getBuildingPermits('test')).success, false)
  status = 200
  assert.equal((await provider.getFloodZone(27, -82)).success, false)
  for (const floodZone of [' ', 'unknown', 'D', 7]) {
    payload = { floodZone }
    assert.equal((await provider.getFloodZone(27, -82)).success, false)
  }
  payload = { floodZone: ' ae ' }
  const flood = await provider.getFloodZone(27, -82)
  assert.equal(flood.success && flood.data.isInFloodZone, true)
  payload = { items: [] }
  const empty = await provider.getBuildingPermits('test')
  assert.equal(empty.success && empty.data.count, 0)
} finally { globalThis.fetch = originalFetch }
console.log('Provider evidence fixtures: permit nesting/history, empty versus unavailable, flood unknown and cache version passed')
