import assert from 'node:assert/strict'
import { corroborateZillowSale, matchesZillowAddress, refreshZillowEvidence, resolveZillowEvidence } from '../src/services/evaluation/zillow-evidence'
import type { NormalizedComparable, NormalizedProperty } from '../src/services/property-api/types'
const comp = { id: 'c1', provider: 'corelogic', address: '3 Heritage Cove Ct', city: 'Casselberry', state: 'FL', zipCode: '32707', salePrice: 300000, saleDate: '2025-01-01', squareFeet: 1500, raw: { salePrice: 300000, saleDate: '2025-01-01', isSale: true } } as NormalizedComparable
const { salePrice: _salePrice, saleDate: _saleDate, ...subjectFields } = comp
const subject = { ...subjectFields, lastSalePrice: 300000, lastSaleDate: '2025-01-01' } as unknown as NormalizedProperty
const identity = { address: '3 Heritage Cove Court', city: 'Casselberry', state: 'Florida', zipCode: '32707' }
const data = { identity, status: 'for_sale', askingPrice: 450000, priceHistory: [{ date: '2026-06-01', event: 'Sold', price: 400000 }, { date: '2026-08-01', event: 'Listed for sale', price: 450000 }], photos: ['https://photos.zillowstatic.com/fp/test.jpg', 'https://evil.example/fp/test.jpg'], garageSpaces: 2 }
const markdown = '# 3 Heritage Cove Ct, Casselberry, FL 32707\n![Property](https://photos.zillowstatic.com/fp/test.jpg)\n\n## Price history\n| Date | Event | Price |\n| 6/1/2026 | Sold | $400,000 |\n\n## Public tax history\n'
const resolve = (d: unknown) => resolveZillowEvidence(comp, d, 'https://www.zillow.com/homes/test_rb/', '2026-09-08T00:00:00Z', false, markdown)
assert(matchesZillowAddress(comp, identity))
assert(!matchesZillowAddress(comp, { ...identity, address: '3 Heritage Cove Ct Apt 2' }))
assert(!matchesZillowAddress(comp, { ...identity, zipCode: '32708' }))
const result = resolve(data)
assert.equal(result.property.salePrice, 400000)
assert.equal(result.property.saleDate, '2026-06-01')
assert.equal(result.audit.askingPrice, null)
assert.equal(result.audit.listingStatus, null)
assert.deepEqual(result.audit.attributes, {})
assert.equal(result.audit.photos.length, 1)
assert.equal(result.audit.frontPhoto, null)
assert.equal(resolve({ ...data, photos: ['https://user:password@photos.zillowstatic.com/fp/test.jpg'] }).audit.photos.length, 0)
assert.equal(result.audit.originalSale.price, 300000)
assert.deepEqual(result.audit.originalRaw, comp.raw)
assert.equal((result.property.raw as any).isSale, true)
assert.equal(resolve({ ...data, identity: { ...identity, address: '4 Heritage Cove Ct' } }).property, comp)
assert.equal(resolve({ ...data, priceHistory: [{ date: '2025-01-01', event: 'Sold', price: 350000 }] }).audit.status, 'conflict')
for (const event of ['Pending', 'Listed for sale', 'Listing removed', 'Estimate', 'Not sold']) assert.equal(resolve({ ...data, priceHistory: [{ date: '2026-06-01', event, price: 450000 }] }).property, comp)
for (const date of ['2027-01-01', '2026-02-30', 'not a date']) assert.equal(resolve({ ...data, priceHistory: [{ date, event: 'Sold', price: 450000 }] }).property, comp)
assert.equal(resolve({ ...data, priceHistory: [{ date: '2026-06-01', event: 'Sold', price: 400000 }, { date: '2026-06-01', event: 'Sold', price: 410000 }] }).audit.status, 'conflict')
assert.equal(resolve({ ...data, status: 'sold' }).audit.askingPrice, null)
const cache = { get: async () => null, put: async () => undefined } as any
let calls = 0
const refreshed = await refreshZillowEvidence({ FIRECRAWL_API_KEY: 'test', API_CACHE: cache }, subject, [comp], { now: '2026-09-08T00:00:00Z', fetcher: (async () => { calls++; return Response.json({ success: true, data: { json: data, markdown } }) }) as typeof fetch })
assert.equal(calls, 2)
assert.equal(refreshed.comps[0].salePrice, 400000)
assert.equal(refreshed.subject.lastSalePrice, 400000)
assert.equal(refreshed.subject.lastSaleDate, '2026-06-01')
let active = 0, maxActive = 0
await refreshZillowEvidence({ FIRECRAWL_API_KEY: 'test', API_CACHE: cache }, subject, Array.from({ length: 7 }, (_, i) => ({ ...comp, id: `c${i}` })), { fetcher: (async () => { active++; maxActive = Math.max(maxActive, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return Response.json({ success: true, data: { json: data } }) }) as typeof fetch })
assert.equal(maxActive, 3)
const hit = await refreshZillowEvidence({ FIRECRAWL_API_KEY: 'test', API_CACHE: { get: async () => ({ data, supportingMarkdown: markdown, sourceUrl: 'https://www.zillow.com/homes/test_rb/', retrievedAt: '2026-09-08T00:00:00Z' }) } as any }, subject, [comp], { now: '2026-09-08T01:00:00Z', fetcher: (async () => { throw new Error('Cache should avoid fetching') }) as typeof fetch })
assert.equal(hit.providerCalls, 0)
assert.equal(hit.compEvidence[0].fromCache, true)
const failed = await refreshZillowEvidence({ FIRECRAWL_API_KEY: 'test', API_CACHE: cache }, subject, [comp], { fetcher: (async () => new Response('secret should not appear', { status: 401 })) as typeof fetch })
assert.equal(failed.compEvidence[0].status, 'unavailable')
assert(!JSON.stringify(failed.compEvidence).includes('secret should not appear'))
const noKey = await refreshZillowEvidence({ API_CACHE: cache }, subject, [comp])
assert.equal(noKey.providerCalls, 0)
assert.equal(noKey.compEvidence[0].status, 'unavailable')
assert.equal(resolveZillowEvidence(comp, data, 'https://www.zillow.com/homes/test_rb/', '2026-09-08T00:00:00Z').property, comp)
assert.equal(corroborateZillowSale(comp, { date: '2026-06-01', price: 400000 }, markdown.replace('3 Heritage', '4 Heritage')), null)
assert.equal(corroborateZillowSale(comp, { date: '2026-06-01', price: 40000 }, markdown), null)
assert.equal(corroborateZillowSale(comp, { date: '2026-06-01', price: 400000 }, markdown.replace('| Sold |', '| Pending sale |')), null)
assert.equal(corroborateZillowSale(comp, { date: '2026-06-01', price: 400000 }, markdown.replace('## Price history', '## Nearby homes')), null)
assert(corroborateZillowSale(comp, { date: '2026-06-01', price: 400000 }, markdown.replace('Ct, Casselberry', 'Court,Casselberry')))
console.log('Zillow evidence tests passed')
