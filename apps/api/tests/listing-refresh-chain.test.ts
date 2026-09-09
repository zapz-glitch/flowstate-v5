import assert from 'node:assert/strict'
import { matchesZillowAddress, refreshZillowEvidence, resolveZillowEvidence } from '../src/services/evaluation/zillow-evidence'
import { corroborateListingSale, hasListingHeading, normalizeListingState, safeListingPhoto, safeListingScreenshot } from '../src/services/evaluation/listing-source'
import type { NormalizedProperty } from '../src/services/property-api/types'

const subject = { id: 's', provider: 'corelogic', address: '3 Heritage Cove Ct', city: 'Casselberry', state: 'FL', zipCode: '32707', squareFeet: 1500, lastSalePrice: 300000, lastSaleDate: '2025-01-01', bedrooms: 3, raw: { retained: 'original' } } as NormalizedProperty
const identity = { address: subject.address, city: subject.city, state: subject.state, zipCode: subject.zipCode }
const urls = { zillow: 'https://www.zillow.com/homedetails/3-Heritage-Cove-Ct/1_zpid/', redfin: 'https://www.redfin.com/FL/Casselberry/3-Heritage-Cove-Ct-32707/home/123', realtor: 'https://www.realtor.com/realestateandhomes-detail/3-Heritage-Cove-Ct_Casselberry_FL_32707_M123' }
const photos = { zillow: 'https://photos.zillowstatic.com/fp/property.jpg', redfin: 'https://ssl.cdn-redfin.com/photo/12/mbphoto/123.jpg', realtor: 'https://ap.rdcpix.com/property.jpg' }
const heading = `# ${subject.address}, ${subject.city}, ${subject.state} ${subject.zipCode}`
const shotUrl = 'https://storage.googleapis.com/firecrawl-scrape-media/screenshot-test.png?Expires=9999999999'
function page(source: keyof typeof urls, price = 400000, date = '2026-06-01', includePhoto = true) {
  const [year, month, day] = date.split('-')
  return { url: urls[source], markdown: `${heading}\n${includePhoto ? `![Home](${photos[source]})` : ''}\n\n## Price history\n| Date | Event | Price |\n| ${Number(month)}/${Number(day)}/${year} | Sold | $${price.toLocaleString('en-US')} |\n\n## Public tax history\n`, json: { identity, priceHistory: [{ date, event: 'Sold', price }], photos: includePhoto ? [photos[source]] : [], askingPrice: 9999999, status: 'for_sale', squareFeet: 1, bedrooms: 99 } }
}
const cache = { get: async () => null, put: async () => undefined } as any
type Call = { endpoint: string; body: any }
async function run(respond: (call: Call, calls: Call[]) => Response | Promise<Response>) {
  const calls: Call[] = []
  const result = await refreshZillowEvidence({ FIRECRAWL_API_KEY: 'test', API_CACHE: cache }, subject, [], { now: '2026-09-09T00:00:00Z', fetcher: (async (url, init) => {
    const call = { endpoint: String(url).split('/').at(-1)!, body: JSON.parse(String(init?.body)) }
    calls.push(call)
    assert.equal(init?.redirect, 'manual')
    assert(!JSON.stringify(call.body.formats ?? []).includes('askingPrice'))
    return respond(call, calls)
  }) as typeof fetch })
  return { result, calls }
}
const ok = (data: unknown) => Response.json({ success: true, data })
const first = await run(() => ok(page('zillow')))
assert.equal(first.calls.length, 1)
assert.equal(first.result.subject.lastSalePrice, 400000)
assert.equal(first.result.subject.bedrooms, 3)
assert.equal(first.result.subject.squareFeet, 1500)
assert.equal(first.result.subjectEvidence.askingPrice, null)
assert.equal(first.result.subjectEvidence.listingStatus, null)
assert.deepEqual(first.result.subjectEvidence.attributes, {})
assert.equal(first.result.subjectEvidence.attempts?.length, 1)
assert.equal(first.result.subjectEvidence.photoEvidence?.[0].retrievedAt, '2026-09-09T00:00:00Z')
const limited = await run(() => new Response('', { status: 429, headers: { 'Retry-After': '120' } }))
assert.equal(limited.calls.length, 1)
assert.equal(limited.result.providerCalls, 1)
assert.equal(limited.result.subject.lastSalePrice, 300000)
assert.equal(limited.result.subjectEvidence.attempts?.length, 3)
assert(limited.result.subjectEvidence.attempts?.every(attempt => attempt.reason.includes('429')))

const fallback = await run(call => call.endpoint === 'search' ? ok({ web: [{ url: urls.redfin }] }) : call.body.url.includes('zillow') ? new Response('', { status: 403 }) : ok(page('redfin')))
assert.equal(fallback.calls.length, 3)
assert.equal(fallback.result.subjectEvidence.source, 'redfin')
assert.equal(fallback.result.subject.lastSaleDate, '2026-06-01')
assert.equal((fallback.result.subject.raw as any).listingResolvedSale.source, 'redfin')
assert.equal((fallback.result.subject.raw as any).zillowResolvedSale, undefined)

const third = await run(call => call.endpoint === 'search' ? ok({ web: [{ url: call.body.query.includes('redfin') ? urls.redfin : urls.realtor }] }) : call.body.url.includes('realtor') ? ok(page('realtor')) : new Response('', { status: 403 }))
assert.equal(third.calls.length, 5)
assert.equal(third.result.subjectEvidence.source, 'realtor')
assert.deepEqual(third.result.subjectEvidence.attempts?.map(a => a.source), ['zillow', 'redfin', 'realtor'])

const conflict = await run(call => call.endpoint === 'search' ? ok({ web: [{ url: urls.redfin }] }) : ok(call.body.url.includes('zillow') ? page('zillow', 350000, '2025-01-01') : page('redfin', 300000, '2025-01-01')))
assert.equal(conflict.result.subject.lastSalePrice, 300000)
assert.equal(conflict.result.subjectEvidence.status, 'unchanged')
assert.equal(conflict.result.subjectEvidence.source, 'redfin')
assert.equal(conflict.result.subjectEvidence.attempts?.[0].status, 'conflict')

const unresolved = await run(call => call.endpoint === 'search' ? ok({ web: [{ url: call.body.query.includes('redfin') ? urls.redfin : urls.realtor }] }) : ok(call.body.url.includes('zillow') ? page('zillow', 350000, '2025-01-01') : page(call.body.url.includes('redfin') ? 'redfin' : 'realtor', 250000, '2024-01-01')))
assert.equal(unresolved.result.subjectEvidence.status, 'conflict')
assert.equal(unresolved.result.subject.lastSalePrice, 300000)
assert.equal(unresolved.result.subjectEvidence.attempts?.length, 3)

const screenshot = await run(call => ok(call.body.formats.includes('screenshot') ? { url: urls.zillow, markdown: heading, screenshot: shotUrl } : page('zillow', 400000, '2026-06-01', false)))
assert.equal(screenshot.calls.length, 2)
assert.equal(screenshot.result.subjectEvidence.screenshots?.length, 1)
assert.equal(screenshot.result.subjectEvidence.screenshots?.[0].status, 'unverified')
assert.equal(screenshot.result.subjectEvidence.frontPhoto, null)
assert.equal(screenshot.result.subjectEvidence.photos.length, 0)
const blocked = await run(call => ok(call.body.formats.includes('screenshot') ? { url: urls.zillow, markdown: `${heading}\nVerify you are human`, screenshot: shotUrl } : page('zillow', 400000, '2026-06-01', false)))
assert.equal(blocked.result.subjectEvidence.screenshots?.length, 0)

const wrongIdentity = await run(call => call.endpoint === 'search' ? ok({ web: [] }) : ok({ ...page('zillow'), json: { ...page('zillow').json, identity: { ...identity, address: `${subject.address} Apt 2` } } }))
assert.equal(wrongIdentity.result.subject.lastSalePrice, 300000)
assert.equal(wrongIdentity.result.subjectEvidence.attempts?.[0].status, 'identity_mismatch')
assert.equal(wrongIdentity.result.subjectEvidence.photos.length, 0)
const unsafeRedirect = await run(call => call.endpoint === 'search' ? ok({ web: [{ url: 'https://evil.example/home/123' }] }) : ok({ ...page('zillow'), url: 'https://evil.example/listing' }))
assert.equal(unsafeRedirect.result.subject.lastSalePrice, 300000)
assert.equal(unsafeRedirect.calls.filter(c => c.endpoint === 'scrape').length, 1)
assert(!safeListingPhoto('https://evil.example/photo/property.jpg', 'redfin'))
assert(!safeListingScreenshot('https://storage.googleapis.com/other-bucket/screenshot-test.png'))
assert(!safeListingScreenshot('https://user:secret@storage.googleapis.com/firecrawl-scrape-media/screenshot-test.png'))
assert.equal(corroborateListingSale(subject, { date: '2026-06-01', price: 400000 }, page('redfin').markdown.replace('6/1/2026', 'Jun 1, 2026')), '| Jun 1, 2026 | Sold | $400,000 |')
assert.equal(corroborateListingSale(subject, { date: '2026-06-01', price: 400000 }, `${heading}\n## Sale and tax history for ${subject.address}\nJun 1, 2026\n\nSold\n\n$400,000\n$267/sq ft\n## Public record`), 'Jun 1, 2026\nSold\n$400,000')
assert.equal(corroborateListingSale(subject, { date: '2026-06-01', price: 400000 }, `${heading}\n## Property history\n### Price history\nJun 1, 2026 | Sold StellarMLS | $400,000 | $267/sqft\n## Other`), 'Jun 1, 2026 | Sold StellarMLS | $400,000 | $267/sqft')
assert.equal(corroborateListingSale(subject, { date: '2026-06-01', price: 400000 }, `${heading}\n## Sale and tax history for ${subject.address}\nJun 1, 2026\n\nPending\n\n$400,000\nJun 2, 2026\nSold\n$300,000\n## Public record`), null)
const neighbor = 'https://photos.zillowstatic.com/fp/neighbor.jpg'
for (const label of ['## Nearby homes', '##### Comparable homes', 'Similar homes', '## Price history']) {
  const input = page('zillow')
  const md = `${heading}\n![Subject](${photos.zillow})\n${label}\n![5 Heritage Cove Ct](${neighbor})\n\n## Price history\n| 6/1/2026 | Sold | $400,000 |`
  const resolved = resolveZillowEvidence(subject, { ...input.json, photos: [photos.zillow, neighbor], frontPhoto: neighbor }, urls.zillow, '2026-09-09T00:00:00Z', false, md)
  assert.deepEqual(resolved.audit.photos, [photos.zillow])
  assert.equal(resolved.audit.frontPhoto, null)
}
const fabricatedPhoto = resolveZillowEvidence(subject, { ...page('zillow').json, photos: [neighbor] }, urls.zillow, '2026-09-09T00:00:00Z', false, `${heading}\nText mentions ${neighbor}\n## Price history\n| 6/1/2026 | Sold | $400,000 |`)
assert.equal(fabricatedPhoto.audit.photos.length, 0)
for (const [name, code] of [['California', 'CA'], ['New York', 'NY'], ['North Carolina', 'NC'], ['District of Columbia', 'DC'], ['Puerto Rico', 'PR'], ['West Virginia', 'WV'], ['Hawaii', 'HI']]) {
  const national = { ...subject, city: 'Example City', state: code }
  assert.equal(normalizeListingState(name), code.toLowerCase())
  assert(matchesZillowAddress(national, { ...national, state: name }))
  assert(hasListingHeading(national, `# ${national.address}, Example City, ${name} ${national.zipCode}`))
  assert(!matchesZillowAddress(national, { ...national, state: 'FL' }))
}
const northlake = { ...subject, address: '3889 N Lake Orlando Pkwy', city: 'Orlando', zipCode: '32808' }
assert(matchesZillowAddress(northlake, { ...northlake, address: '3889 North Lake Orlando Parkway' }))
assert(hasListingHeading(northlake, '# 3889 North Lake Orlando Parkway, Orlando, FL 32808'))
for (const [full, short] of [['Parkway', 'Pkwy'], ['Pky', 'Pkwy'], ['Terrace', 'Ter'], ['Trail', 'Trl'], ['Highway', 'Hwy'], ['Expressway', 'Expy'], ['Freeway', 'Fwy'], ['Turnpike', 'Tpke']]) {
  const property = { ...subject, address: `3 Example ${short}` }
  assert(matchesZillowAddress(property, { ...property, address: `3 Example ${full}` }))
  assert(!matchesZillowAddress(property, { ...property, address: `4 Example ${full}` }))
  assert(!matchesZillowAddress(property, { ...property, address: `3 Example ${full} Apt 2` }))
  assert(!matchesZillowAddress(property, { ...property, address: `3 Example ${full}`, city: 'Orlando' }))
  assert(!matchesZillowAddress(property, { ...property, address: `3 Example ${full}`, zipCode: '32708' }))
}
console.log('Listing refresh chain tests passed')
