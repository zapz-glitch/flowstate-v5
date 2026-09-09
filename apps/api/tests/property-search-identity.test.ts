import assert from 'node:assert/strict'
import { createCoreLogicProvider } from '../src/services/property-api/providers/corelogic'
import type { Env } from '../src/types'

const requests: URL[] = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  if (init?.method === 'POST') return Response.json({ access_token: 'synthetic-token', expires_in: 3600 })
  requests.push(new URL(String(input)))
  return Response.json({ items: [] })
}
try {
  const provider = createCoreLogicProvider({ CORELOGIC_CLIENT_ID: 'synthetic', CORELOGIC_CLIENT_SECRET: 'synthetic' } as Env)
  const cases = [
    ['123 Main Ct, Hartford, CT 06103', { streetAddress: '123 Main Ct', city: 'Hartford', state: 'CT', zipCode: '06103' }],
    ['123 Main Ct Hartford CT 06103', { streetAddress: '123 Main Ct', city: 'Hartford', state: 'CT', zipCode: '06103' }],
    ['123 Main Ct 32707', { streetAddress: '123 Main Ct', zipCode: '32707' }],
    ['123 Main Ct, 32707', { streetAddress: '123 Main Ct', zipCode: '32707' }],
  ] as const
  for (const [address, expected] of cases) {
    const before = requests.length
    await provider.searchProperty({ address })
    assert.equal(requests.length, before + 1, address)
    const query = requests.at(-1)!.searchParams
    assert.equal(query.get('streetAddress'), expected.streetAddress, address)
    assert.equal(query.get('zipCode'), expected.zipCode, address)
    assert.equal(query.get('city'), 'city' in expected ? expected.city : null, address)
    assert.equal(query.get('state'), 'state' in expected ? expected.state : null, address)
  }
} finally { globalThis.fetch = originalFetch }
console.log('CoreLogic search parsing: Connecticut state retained, Court suffix preserved for street-plus-ZIP queries')
