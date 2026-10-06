import assert from 'node:assert/strict'
import { ScrapflyZillowFetcher } from '../src/services/photo-provider/providers/zillow/scrapfly-fetcher'
import {
  isZillowFetcherAvailable,
  createZillowFetcher,
  getZillowFetcherProvider,
} from '../src/services/photo-provider/providers/zillow'
import { parseZillowHtml } from '../src/services/photo-provider/providers/zillow/firecrawl-fetcher'
import type { Env } from '../src/types'

// Unit coverage for the Firecrawl listing fetcher — the owner-specified
// chain: /v1/search → URL → /v1/scrape → photos+description, with
// Zillow → Redfin → Realtor fallback lanes. Fetch is stubbed — no network.

const PROP = {
  propertyId: 'p1',
  address: '4428 Crenshaw Ave',
  city: 'Fort Worth',
  state: 'TX',
  zipCode: '76105',
}

const ZILLOW_URL = 'https://www.zillow.com/homedetails/4428-Crenshaw-Ave-Fort-Worth-TX-76105/12345_zpid/'
const REDFIN_URL = 'https://www.redfin.com/TX/Fort-Worth/4428-Crenshaw-Ave-76105/home/99887766'

const ZILLOW_HTML = `
<html><head>
<link rel="canonical" href="${ZILLOW_URL}"/>
</head><body>
<div class="hollywood-gallery">
  <img src="https://photos.zillowstatic.com/fp/abc123abc123abc123abc123-p_f.jpg"/>
  <img src="https://photos.zillowstatic.com/fp/def456def456def456def456-p_f.jpg"/>
  <img src="https://photos.zillowstatic.com/fp/aaa111aaa111aaa111aaa111-h_a.jpg"/>
</div>
<div class="ds-data-col"><span data-testid="price">$120,000</span></div>
<meta property="og:description" content="Charming 3 bed 1 bath ranch in Eastwood Addition with updated kitchen and large backyard."/>
</body></html>`

const REDFIN_HTML = `<html><body>
  <img src="https://ssl.cdn-redfin.com/photo/1/bigphoto/123/123_1.jpg"/>
  <img src="https://ssl.cdn-redfin.com/photo/1/bigphoto/123/123_2.jpg"/>
  <meta property="og:description" content="Sold as-is fixer upper in Eastwood Addition bring your contractor vision to life today."/>
</body></html>`

const SEARCH_PAGE_HTML = `
<html><body>
  <img src="https://photos.zillowstatic.com/fp/other111other111other111-p_f.jpg"/>
  <img src="https://photos.zillowstatic.com/fp/other222other222other222-p_f.jpg"/>
</body></html>`

const fcSearch = (urls: string[]) => ({
  success: true,
  data: urls.map((url) => ({ url })),
})
const fcScrape = (html: string) => ({
  success: true,
  data: { rawHtml: html, html },
})

/** Stub fetch: handlers keyed on the Firecrawl endpoint + (optionally) a
 *  substring the POSTed query/url must contain, matched against the request
 *  body too. Calls log `endpoint :: body` so tests can assert order. */
function stubFetch(handlers: Array<{ endpoint: string; contains?: string; body: unknown }>) {
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const reqBody = typeof init?.body === 'string' ? init.body : ''
    calls.push(`${url} :: ${reqBody}`)
    for (const h of handlers) {
      if (url.includes(h.endpoint) && (!h.contains || reqBody.includes(h.contains))) {
        return new Response(JSON.stringify(h.body), { status: 200 })
      }
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  return calls
}

// ── 1. parseZillowHtml: gallery photos, agent-headshot exclusion, description ──
{
  const ext = parseZillowHtml(ZILLOW_HTML)
  assert.ok(ext.photos.length >= 2, `expected >=2 photos, got ${ext.photos.length}`)
  assert.ok(ext.photos.every((p) => p.includes('zillowstatic.com')))
  assert.ok(ext.photos.every((p) => !p.includes('-h_')), 'agent headshots must be excluded')
}

// ── 2. Provider selection: Firecrawl key only — no Scrapfly/Serper needed ──
{
  const env = { FIRECRAWL_API_KEY: 'fc-x' } as Env
  assert.equal(isZillowFetcherAvailable(env), true)
  assert.equal(getZillowFetcherProvider(env), 'firecrawl-search+scrape')
  const fetcher = createZillowFetcher(env)
  assert.ok(fetcher instanceof ScrapflyZillowFetcher)
  const noKeys = {} as Env
  assert.equal(isZillowFetcherAvailable(noKeys), false)
  assert.equal(createZillowFetcher(noKeys), null)
}

// ── 3. Happy path: search resolves Zillow URL, scrape yields photos ──
{
  const calls = stubFetch([
    { endpoint: 'v1/search', contains: 'zillow.com/homedetails', body: fcSearch([ZILLOW_URL]) },
    { endpoint: 'v1/scrape', body: fcScrape(ZILLOW_HTML) },
  ])
  const f = new ScrapflyZillowFetcher({ firecrawlApiKey: 'k' })
  const res = await f.fetchListing(PROP, { skipCache: true })
  assert.ok(res.listing, 'expected a listing')
  assert.ok((res.listing?.photos.length ?? 0) >= 2)
  assert.match(res.listing?.description ?? '', /Charming 3 bed/)
  // Exactly the decision tree: one search call, one scrape call, in order.
  const searches = calls.filter((c) => c.includes('v1/search'))
  const scrapes = calls.filter((c) => c.includes('v1/scrape'))
  assert.equal(searches.length, 1)
  assert.equal(scrapes.length, 1)
  assert.ok(scrapes[0].includes(ZILLOW_URL))
  assert.equal(f.firecrawlCallCount, 2)
}

// ── 3b. Search-page photos are NOT listing evidence: a scrape that lands on
// a results page (no homedetails canonical) must be rejected even when it
// carries photos — wrong-house evidence is worse than none.
{
  stubFetch([
    { endpoint: 'v1/search', body: fcSearch([ZILLOW_URL, REDFIN_URL]) },
    { endpoint: 'v1/scrape', contains: 'zillow.com', body: fcScrape(SEARCH_PAGE_HTML) },
    { endpoint: 'v1/scrape', contains: 'redfin.com', body: fcScrape(REDFIN_HTML) },
  ])
  const f = new ScrapflyZillowFetcher({ firecrawlApiKey: 'k' })
  const res = await f.fetchListing(PROP, { skipCache: true })
  assert.ok(res.listing, 'results-page zillow photos rejected → redfin lane should win')
  assert.ok(res.listing?.photos.every((p) => p.includes('cdn-redfin.com')))
}

// ── 4. Wrong-house guard: neighbor URL rejected at resolution ──
{
  const calls = stubFetch([
    { endpoint: 'v1/search', body: fcSearch(['https://www.zillow.com/homedetails/9999-Wrong-Ave-Fort-Worth-TX-76105/111_zpid/']) },
    { endpoint: 'v1/scrape', body: fcScrape(ZILLOW_HTML) },
  ])
  const f = new ScrapflyZillowFetcher({ firecrawlApiKey: 'k' })
  const res = await f.fetchListing(PROP, { skipCache: true })
  assert.equal(res.listing, undefined, 'wrong-number listing must be rejected')
  assert.ok(res.error)
  // Every lane searched, but no scrape may fire on a wrong-number URL.
  assert.ok(!calls.some((c) => c.includes('v1/scrape') && c.includes('9999-Wrong')))
}

// ── 5. Ladder: zillow lane misses → redfin lane hits → photos ──
{
  const calls = stubFetch([
    { endpoint: 'v1/search', contains: 'zillow', body: fcSearch([]) },
    { endpoint: 'v1/search', contains: 'redfin', body: fcSearch([REDFIN_URL]) },
    { endpoint: 'v1/scrape', body: fcScrape(REDFIN_HTML) },
  ])
  const f = new ScrapflyZillowFetcher({ firecrawlApiKey: 'k' })
  const res = await f.fetchListing(PROP, { skipCache: true })
  assert.ok(res.listing, 'expected listing via Redfin lane')
  assert.ok(res.listing?.photos.every((p) => p.includes('cdn-redfin.com')))
  assert.match(res.listing?.description ?? '', /as-is/i)
  // Redfin search only fires after the zillow lane failed — order matters.
  const zi = calls.findIndex((c) => c.includes('v1/search') && c.includes('zillow'))
  const rd = calls.findIndex((c) => c.includes('v1/search') && c.includes('redfin'))
  assert.ok(zi >= 0 && rd > zi, 'zillow search must run before redfin search')
}

// ── 6. Total miss: all lanes empty → honest error, never fabricated evidence ──
{
  stubFetch([
    { endpoint: 'v1/search', body: fcSearch([]) },
  ])
  const f = new ScrapflyZillowFetcher({ firecrawlApiKey: 'k' })
  const res = await f.fetchListing(PROP, { skipCache: true })
  assert.equal(res.listing, undefined)
  assert.ok(res.error?.includes('no listing found'))
}

console.log('photo-fetcher: all assertions passed')
