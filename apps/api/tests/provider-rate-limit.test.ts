import assert from 'node:assert/strict'
import { createCoreLogicProvider } from '../src/services/property-api/providers/corelogic'
import type { Env } from '../src/types'

const originalFetch = globalThis.fetch
let tokenCalls = 0, propertyCalls = 0
globalThis.fetch = async (_url, init) => {
  assert(init?.signal)
  assert.equal(init?.redirect, 'manual')
  if (init?.method === 'POST') { tokenCalls++; return Response.json({ access_token: 'synthetic-token', expires_in: 3600 }) }
  propertyCalls++
  return Response.json({ error: 'Rate limited' }, { status: 429, headers: { 'Retry-After': '120' } })
}
try {
  const provider = createCoreLogicProvider({ CORELOGIC_CLIENT_ID: 'rate-fixture', CORELOGIC_CLIENT_SECRET: 'synthetic-secret' } as Env)
  const first = await provider.getComparables({ propertyId: 'fixture' })
  assert.equal(first.success, false)
  const second = await provider.getComparables({ propertyId: 'fixture' })
  assert.equal(second.success, false)
  assert.equal(propertyCalls, 1)
  assert.equal(tokenCalls, 1)
  assert.match(!second.success ? second.error : '', /retry window/)
  console.log('CoreLogic bounded requests and Retry-After cooldown passed without token refresh storm')
} finally { globalThis.fetch = originalFetch }
