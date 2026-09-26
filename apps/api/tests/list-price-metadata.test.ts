import assert from 'node:assert/strict'
import { ListingPhotoScraper, LISTING_ADAPTERS } from '../src/services/photo-provider/providers/listing-scraper'
import { createPhotoService } from '../src/services/photo-provider'

// A listing that resolves but yields no photos must still surface its
// extracted list price / flood signal — previously fetchPhotos returned
// null on photos.length === 0 and the list price was thrown away.

const property = {
  propertyId: 'p1',
  address: '5802 Test St',
  city: 'Tampa',
  state: 'FL',
  zipCode: '33625',
}
const listingUrl = 'https://www.redfin.com/FL/Tampa/5802-Test-St-33625/home/12345'

const origFetch = globalThis.fetch
globalThis.fetch = (async (url: unknown) => {
  const u = String(url)
  if (u.includes('api.firecrawl.dev/v1/search')) {
    return Response.json({ success: true, data: [{ url: listingUrl }] })
  }
  if (u.includes('api.firecrawl.dev/v1/scrape')) {
    // Listing page: carries a listPrice embed but zero photo URLs
    return Response.json({
      success: true,
      data: {
        rawHtml: '<html><script>{"listPrice":285000}</script><body>no images</body></html>',
        html: '',
        markdown: '',
      },
    })
  }
  return new Response('not found', { status: 404 })
}) as typeof fetch

try {
  const scraper = new ListingPhotoScraper({ apiKey: 'test' })
  const res = await scraper.fetchPhotos(property, LISTING_ADAPTERS.redfin)
  assert.ok(res, 'expected a result even with zero photos')
  assert.equal(res!.photos.length, 0)
  assert.equal(res!.listPrice, 285000)
  assert.equal(res!.sourceUrl, listingUrl)
} finally {
  globalThis.fetch = origFetch
}

// Service-level: metadata from a no-photos attempt merges into the winner,
// and a chain that only finds metadata still returns it.

const ident = { propertyId: 'p', address: '1 Main St', city: 'X', state: 'FL', zipCode: '1' }

const fake = (
  name: string,
  data: { photos: string[]; metadata?: Record<string, unknown>; sourceUrl?: string } | null
) => ({
  isAvailable: () => true,
  fetchPhotos: async () =>
    data
      ? { success: true as const, data: { propertyId: 'p', photos: data.photos, source: name, sourceUrl: data.sourceUrl, fetchedAt: 'now', metadata: data.metadata } }
      : { success: false as const, propertyId: 'p', error: `${name} failed`, code: 'NOT_FOUND' as const },
})

// Case 1: redfin finds the list price but no photos; zillow wins on photos —
// the merged result must carry both.
{
  const svc = createPhotoService({ FIRECRAWL_API_KEY: 'k' } as never)
  ;(svc as unknown as { providers: Map<string, unknown> }).providers = new Map([
    ['redfin', fake('redfin', { photos: [], metadata: { listPrice: 285000 }, sourceUrl: 'https://redfin.example/x' })],
    ['zillow', fake('zillow', { photos: ['https://img.example/1.jpg'] })],
  ])
  const r = await svc.fetchPhotos(ident)
  assert.equal(r.success, true)
  if (!r.success) throw new Error('unreachable')
  assert.equal(r.data.photos.length, 1)
  assert.equal(r.data.source, 'zillow')
  assert.equal((r.data.metadata as { listPrice?: number }).listPrice, 285000)
  assert.equal(r.data.sourceUrl, 'https://redfin.example/x')
}

// Case 2: nothing yields photos anywhere — metadata still comes back.
{
  const svc = createPhotoService({ FIRECRAWL_API_KEY: 'k' } as never)
  ;(svc as unknown as { providers: Map<string, unknown> }).providers = new Map([
    ['redfin', fake('redfin', { photos: [], metadata: { listPrice: 312000 }, sourceUrl: 'https://redfin.example/y' })],
    ['zillow', fake('zillow', null)],
    ['realtor', fake('realtor', null)],
  ])
  const r = await svc.fetchPhotos(ident)
  assert.equal(r.success, true)
  if (!r.success) throw new Error('unreachable')
  assert.equal(r.data.photos.length, 0)
  assert.equal((r.data.metadata as { listPrice?: number }).listPrice, 312000)
  assert.equal(r.data.source, 'redfin')
}

// Case 3: no listing anywhere — still a clean NOT_FOUND.
{
  const svc = createPhotoService({ FIRECRAWL_API_KEY: 'k' } as never)
  ;(svc as unknown as { providers: Map<string, unknown> }).providers = new Map([
    ['redfin', fake('redfin', null)],
    ['zillow', fake('zillow', null)],
    ['realtor', fake('realtor', null)],
  ])
  const r = await svc.fetchPhotos(ident)
  assert.equal(r.success, false)
  if (r.success) throw new Error('unreachable')
  assert.equal(r.code, 'NOT_FOUND')
}

console.log('list-price-metadata: all assertions passed')
