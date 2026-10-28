/**
 * A cached comp listing whose condition read failed is read again, not
 * served empty for the 90-day evidence TTL. Seen on the 2026-10-28 flip
 * backtest: every comp's Decisions read failed (401), the listing was
 * pinned with condition null, and later runs never re-read it.
 */
import assert from 'node:assert/strict'
import { gatherCompConditionEvidence } from '../src/services/comp-evidence'

const kv = new Map<string, string>()
const comp = { propertyId: '8717942', address: '4615 Webster St', salePrice: 299_000, saleDate: '2026-07-17', squareFeet: 910 }
const key = `clef-evidence:${comp.propertyId}:${comp.saleDate}:${comp.salePrice}`
kv.set(key, JSON.stringify({
  propertyId: comp.propertyId, condition: null, investorSignal: false, investorSignalSources: [],
  listing: { source: 'redfin', sourceUrl: 'https://redfin/x', coverPhotoUrl: 'https://img/cover.jpg', description: 'Fully renovated 2/1 with new roof.', photoCount: 8, details: { squareFeet: 910 } },
}))
let scrapes = 0
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input)
  if (url.startsWith('https://img/')) return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { 'content-type': 'image/jpeg' } })
  scrapes++
  return new Response('no', { status: 500 })
}) as typeof fetch

let clefImages = -1
const env = {
  CONDITION_READER: 'clef',
  API_CACHE: { get: async (k: string) => (kv.has(k) ? JSON.parse(kv.get(k)!) : null), put: async (k: string, v: string) => { kv.set(k, v) } },
  AI: { run: async (_m: string, body: { images?: unknown[] }) => {
    clefImages = body.images?.length ?? 0
    return { answers: { condition: { choice: 'Renovated', confidence: 0.8 }, renovated: { noul: 0.9 }, as_is: { noul: 0.05 } } }
  } },
} as never

// Deferred (a pool reader will run) — the cached listing is returned untouched.
const deferred = await gatherCompConditionEvidence(env, comp, undefined, { deferClassify: true })
assert.equal(deferred.condition, null)
assert.equal(clefImages, -1)

// Not deferred — Clef reads the cached cover photo + listing text; no re-scrape.
const ev = await gatherCompConditionEvidence(env, comp)
assert.ok(ev.condition, 'condition read from the cached listing')
assert.equal(clefImages, 1, 'cover photo sent')
assert.equal(scrapes, 0, 'no listing re-scrape')
assert.equal(ev.listing?.photoCount, 8, 'cached listing kept as it was')
await new Promise((r) => setTimeout(r, 0))
assert.ok(JSON.parse(kv.get(key)!).condition, 'the read is pinned for next time')

console.log('comp evidence re-read: passed')
