import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { comparablesKey } from '../src/services/cache'
import { createPropertyApi } from '../src/services/property-api'
import type { ComparablesSearchParams } from '../src/services/property-api/types'
import type { Env } from '../src/types'

const base: ComparablesSearchParams = { propertyId: 'fixture', radiusMiles: 0.5, monthsBack: 12, maxComps: 25, subjectSqft: 2000, sqftVariance: 20, minBeds: 2, maxBeds: 5, minBaths: 1, maxBaths: 4 }
const key = (params: ComparablesSearchParams) => comparablesKey(params.propertyId, params.radiusMiles, params.monthsBack, 'corelogic', { ...params })
assert.match(key(base), /search-v4/)
assert.equal(key(base), key(Object.fromEntries(Object.entries(base).reverse()) as unknown as ComparablesSearchParams))
const variants = [
  { propertyId: 'other' }, { radiusMiles: 1 }, { monthsBack: 6 }, { maxComps: 100 },
  { subjectSqft: 1500 }, { sqftVariance: 10 }, { minBeds: 3 }, { maxBeds: 4 }, { minBaths: 2 }, { maxBaths: 3 },
].map(change => ({ ...base, ...change }))
assert.equal(new Set([key(base), ...variants.map(key)]).size, variants.length + 1)
assert.notEqual(comparablesKey('fixture', 0.5, 12, 'attom', { ...base }), key(base))
const store = new Map<string, string>()
const urls: URL[] = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  if (init?.method === 'POST') return Response.json({ access_token: 'synthetic-token', expires_in: 3600 })
  urls.push(new URL(String(input)))
  return Response.json({ comparables: [] })
}
try {
  const api = createPropertyApi({ PROPERTY_PROVIDER: 'corelogic', CORELOGIC_CLIENT_ID: 'synthetic', CORELOGIC_CLIENT_SECRET: 'synthetic', API_CACHE: {
    get: async (name: string) => store.has(name) ? JSON.parse(store.get(name)!) : null,
    put: async (name: string, value: string) => { store.set(name, value) },
  } } as unknown as Env)
  assert.equal((await api.getComparables(base)).success, true)
  assert.equal((await api.getComparables(base)).success, true)
  assert.equal(urls.length, 1)
  for (const variant of variants) assert.equal((await api.getComparables(variant)).success, true)
  assert.equal(urls.length, variants.length + 1)
  const query = urls[0].searchParams
  assert.equal(urls[0].pathname, '/v2/properties/fixture/comparables')
  assert.deepEqual(Object.fromEntries(query), {
    searchDistance: '0.5', maxComps: '25', monthsBack: '12', minBeds: '2', maxBeds: '5',
    minBaths: '1', maxBaths: '4', minBldgSqFt: '1600', maxBldgSqFt: '2400', sortBy: 'Distance',
  })
  const docs = JSON.parse(readFileSync(new URL('../src/services/property-api/providers/docs/corelogic-api-docs.json', import.meta.url), 'utf8'))
  const documented = new Set(docs.paths['/v2/properties/{clipId}/comparables'].get.parameters.filter((p: any) => p.in === 'query').map((p: any) => p.name))
  for (const name of query.keys()) assert(documented.has(name), `${name} is not a documented comparable query parameter`)
  assert.equal(urls.find(url => url.searchParams.get('maxComps') === '100')?.searchParams.get('monthsBack'), '12')
} finally {
  globalThis.fetch = originalFetch
}
console.log('Comparable search: all-parameter cache isolation, cache hit, documented query names and bounds passed')
