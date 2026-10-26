/**
 * Site reads, pieces together — Geocodio pins → Esri aerials → Clef →
 * KV cache → Set-B site match. Network and models are faked; every
 * failure path must land on unknown, never on a wrong yes/no.
 */
import assert from 'node:assert/strict'
import { evaluateB, type BComp } from '@flowstate-api/shared/appraisal'
import { readSites } from '../src/services/site-read'
import type { Env } from '../src/types'

// ── Fakes ────────────────────────────────────────────────────────────────
const kv = new Map<string, string>()
const API_CACHE = {
  get: async (k: string) => (kv.has(k) ? JSON.parse(kv.get(k)!) : null),
  put: async (k: string, v: string) => { kv.set(k, v) },
}

// Lat encodes the lot: 27.1 water (Water Silk Dr), 27.2 inland, 27.3
// busy road, 27.4 Esri 640 fails (512 must cover), 27.5 Clef throws.
const pins: Record<string, { lat: number; lng: number; accuracy_type: string }> = {
  'subject addr': { lat: 27.1, lng: -82.7, accuracy_type: 'rooftop' },
  'water comp': { lat: 27.1, lng: -82.7, accuracy_type: 'rooftop' },
  'inland comp': { lat: 27.2, lng: -82.7, accuracy_type: 'rooftop' },
  'road comp': { lat: 27.3, lng: -82.7, accuracy_type: 'rooftop' },
  'phoenix comp': { lat: 27.4, lng: -82.7, accuracy_type: 'rooftop' },
  'flaky comp': { lat: 27.5, lng: -82.7, accuracy_type: 'rooftop' },
  'street comp': { lat: 27.6, lng: -82.7, accuracy_type: 'range_interpolation' },
}
const yOf = (lat: number) => (20037508.34 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))
const latOfBbox = (url: string) => {
  const [, y0, , y1] = new URL(url).searchParams.get('bbox')!.split(',').map(Number)
  const y = (y0 + y1) / 2
  return Object.values(pins).map((p) => p.lat).find((lat) => Math.abs(yOf(lat) - y) < 5)!
}
let geocodioCalls = 0
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  if (url.startsWith('https://api.geocod.io/v1.9/geocode')) {
    geocodioCalls++
    const qs = JSON.parse(String(init?.body)) as string[]
    return Response.json({ results: qs.map((q) => ({ query: q, response: { results: [{
      location: { lat: pins[q].lat, lng: pins[q].lng }, accuracy_type: pins[q].accuracy_type }] } })) })
  }
  if (url.includes('World_Imagery') || url.includes('USGSImageryTopo')) {
    if (latOfBbox(url) === 27.4 && url.includes('size=640,640')) return new Response('err', { status: 500 })
    return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { 'content-type': 'image/jpeg' } })
  }
  throw new Error(`unexpected fetch ${url}`)
}) as typeof fetch

let aiCalls = 0
const AI = {
  run: async (model: string, body: { images: { base64: string }[]; questions: Record<string, unknown> }) => {
    aiCalls++
    assert.equal(body.images.length, 2, 'wide + close aerial')
    const lat = currentLat
    if (lat === 27.5) throw new Error('clef 503')
    if (model.endsWith('/clef-flash')) return { answers: { water: { noul: lat === 27.1 ? 0.86 : 0.02 } } }
    return { answers: { exposure: { choice: lat === 27.3 ? 'FRONTING' : 'NEUTRAL',
      probabilities: { NEUTRAL: lat === 27.3 ? 0.12 : 0.66 } } } }
  },
}
// The fake model needs to know which lot it's reading — the last aerial
// fetched before the call names it (reads run one lot at a time per worker,
// so run this test with a single lot in flight per assertion block).
let currentLat = 0
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  if (url.includes('World_Imagery') || url.includes('USGSImageryTopo')) currentLat = latOfBbox(url)
  return realFetch(input, init)
}) as typeof fetch

const env = { API_CACHE, AI, GEOCODIO_API_KEY: 'test' } as unknown as Env
const lot = (id: string, address: string, extra: Record<string, unknown> = {}) => ({ id, address, ...extra })

// ── 1. Each lot reads right, one at a time ───────────────────────────────
const one = async (l: ReturnType<typeof lot>) => (await readSites(env, [l])).get(l.id)
assert.deepEqual(await one(lot('s', 'subject addr', { mlsPool: true })), { waterfront: true, busyRoad: false, pool: true })
assert.deepEqual(await one(lot('i', 'inland comp', { description: 'Community pool access.' })), { waterfront: false, busyRoad: false, pool: null })
assert.deepEqual(await one(lot('r', 'road comp')), { waterfront: false, busyRoad: true, pool: null })
assert.deepEqual(await one(lot('p', 'phoenix comp')), { waterfront: false, busyRoad: false, pool: null }, 'Esri 512 covers a 640 failure')
assert.deepEqual(await one(lot('f', 'flaky comp')), { waterfront: null, busyRoad: null, pool: null }, 'Clef failure is unknown')
const aiBeforeStreet = aiCalls
assert.deepEqual(await one(lot('st', 'street comp')), { waterfront: null, busyRoad: null, pool: null }, 'non-rooftop pin is unknown')
assert.equal(aiCalls, aiBeforeStreet, 'no aerial read without a rooftop pin')

// ── 2. Cache — a repeat costs no Geocodio or Clef call; failures retry ───
const geoBefore = geocodioCalls, aiBefore = aiCalls
assert.deepEqual(await one(lot('w', 'water comp')), { waterfront: true, busyRoad: false, pool: null }, 'same pin as subject — cached aerial')
assert.deepEqual(await one(lot('s', 'subject addr')), { waterfront: true, busyRoad: false, pool: null })
assert.equal(aiCalls, aiBefore, 'cached lots skip Clef')
assert.equal(geocodioCalls, geoBefore + 1, 'only the new address geocodes')
assert.ok(![...kv.keys()].some((k) => k.includes('27.50000')), 'a failed Clef read is not cached')

// ── 3. Whole run → Set-B: the water + pool subject skips the road comp ───
const sites = await readSites(env, [lot('__s', 'subject addr', { mlsPool: true }), lot('w', 'water comp'), lot('r', 'road comp')])
assert.equal(sites.size, 3)
const comp = (id: string, address: string, salePrice: number): BComp => ({
  id, address, isEnabled: true, salePrice, squareFeet: 1500, censusTract: 'T1', subdivision: 'LAKES',
  distanceMiles: 0.2, yearBuilt: 2000, classification: { type: 'after_renovation' }, site: sites.get(id),
})
const r = evaluateB(
  { squareFeet: 1500, yearBuilt: 2000, censusTract: 'T1', subdivision: 'LAKES', site: sites.get('__s') },
  [comp('r', 'road comp', 300_000), comp('w', 'water comp', 360_000)],
)
assert.deepEqual(r.drivers.map((x) => x.comp.address), ['water comp'])
assert.ok(r.flags.some((f) => f.includes('road comp: dropped from drivers — site differs from subject (waterfront, busyRoad)')))

console.log('site-read integration: passed')
