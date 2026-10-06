import assert from 'node:assert/strict'
import { ScrapflyZillowFetcher } from '../src/services/photo-provider/providers/zillow/scrapfly-fetcher'
import {
  isZillowFetcherAvailable,
  createZillowFetcher,
  getZillowFetcherProvider,
} from '../src/services/photo-provider/providers/zillow'
import { parseZillowHtml } from '../src/services/photo-provider/providers/zillow/firecrawl-fetcher'
import type { Env } from '../src/types'

// Unit coverage for the Serper+Scrapfly listing fetcher: Zillow HTML parsing,
// URL-resolution ladder (generated URL → Serper → site fallbacks), fetch
// transport, and provider selection. Fetch is stubbed — no network.

const PROP = {
  propertyId: 'p1',
  address: '4428 Crenshaw Ave',
  city: 'Fort Worth',
  state: 'TX',
  zipCode: '76105',
}

const ZILLOW_HTML = `
<html><head>
<link rel="canonical" href="https://www.zillow.com/homedetails/4428-Crenshaw-Ave-Fort-Worth-TX-76105/12345_zpid/"/>
</head><body>
<div class="hollywood-gallery">
  <img src="https://photos.zillowstatic.com/fp/abc123abc123abc123abc123-p_f.jpg"/>
  <img src="https://photos.zillowstatic.com/fp/def456def456def456def456-p_f.jpg"/>
  <img src="https://photos.zillowstatic.com/fp/aaa111aaa111aaa111aaa111-h_a.jpg"/>
</div>
<div class="ds-data-col"><span data-testid="price">$120,000</span></div>
<meta property="og:description" content="Charming 3 bed 1 bath ranch in Eastwood Addition with updated kitchen and large backyard."/>
</body></html>`

const EMPTY_HTML = '<html><body>not found</body></html>'

function stubFetch(handlers: Array<{ match: string | RegExp; body: unknown; ok?: boolean }>) {
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    calls.push(url)
    for (const h of handlers) {
      const hit = typeof h.match === 'string' ? url.includes(h.match) : h.match.test(url)
      if (hit) {
        const body = typeof h.body === 'string' ? h.body : JSON.stringify(h.body)
        return new Response(body, { status: h.ok === false ? 500 : 200 })
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

// ── 2. Provider selection: Scrapfly preferred, provider name reflects keys ──
{
  const env = { SCRAPFLY_API_KEY: 'k', SERPER_API_KEY: 's' } as Env
  assert.equal(isZillowFetcherAvailable(env), true)
  assert.equal(getZillowFetcherProvider(env), 'serper+scrapfly')
  const fetcher = createZillowFetcher(env)
  assert.ok(fetcher instanceof ScrapflyZillowFetcher)
  const noKeys = {} as Env
  assert.equal(isZillowFetcherAvailable(noKeys), false)
  assert.equal(createZillowFetcher(noKeys), null)
}

// ── 3. Happy path: generated Zillow URL scrape yields photos ──
{
  const calls = stubFetch([
    {
      match: 'api.scrapfly.io/scrape',
      body: { result: { status_code: 200, content: ZILLOW_HTML } },
    },
  ])
  const f = new ScrapflyZillowFetcher({ apiKey: 'k' })
  const res = await f.fetchListing(PROP, { skipCache: true })
  assert.ok(res.listing, 'expected a listing')
  assert.ok((res.listing?.photos.length ?? 0) >= 2)
  assert.ok(calls.every((c) => c.includes('asp=true') && c.includes('render_js=true')))
  assert.equal(f.firecrawlCallCount >= 1, true)
}

// ── 3b. Search-page photos are NOT listing evidence: a scrape that lands
// on a results page (no homedetails canonical) must be rejected even when
// it carries photos — wrong-house evidence is worse than none.
{
  const SEARCH_PAGE_HTML = `
  <html><body>
    <img src="https://photos.zillowstatic.com/fp/other111other111other111-p_f.jpg"/>
    <img src="https://photos.zillowstatic.com/fp/other222other222other222-p_f.jpg"/>
  </body></html>`
  stubFetch([
    { match: 'api.scrapfly.io/scrape', body: { result: { status_code: 200, content: SEARCH_PAGE_HTML } } },
  ])
  const f = new ScrapflyZillowFetcher({ apiKey: 'k' })
  const res = await f.fetchListing(PROP, { skipCache: true })
  assert.equal(res.listing, undefined, 'results-page photos must not pass as listing evidence')
}

// ── 4. Ladder: search-page miss → Serper homedetails → photos ──
{
  stubFetch([
    { match: 'google.serper.dev', body: { organic: [{ link: 'https://www.zillow.com/homedetails/4428-Crenshaw-Ave-Fort-Worth-TX-76105/12345_zpid/' }] } },
    { match: /scrape\?.*homedetails/, body: { result: { status_code: 200, content: ZILLOW_HTML } } },
    { match: 'api.scrapfly.io/scrape', body: { result: { status_code: 200, content: EMPTY_HTML } } },
  ])
  const f = new ScrapflyZillowFetcher({ apiKey: 'k', serperApiKey: 's' })
  const res = await f.fetchListing(PROP, { skipCache: true })
  assert.ok(res.listing, 'expected listing via Serper-resolved URL')
  assert.ok(res.listing?.photos.length)
}

// ── 5. Wrong-house guard: Serper neighbor URL rejected, falls to site lanes ──
{
  stubFetch([
    // Serper returns a neighbor's zillow + a correct redfin listing
    {
      match: 'google.serper.dev',
      body: {
        organic: [
          { link: 'https://www.zillow.com/homedetails/9999-Wrong-Ave-Fort-Worth-TX-76105/111_zpid/' },
        ],
      },
    },
    { match: 'api.scrapfly.io/scrape', body: { result: { status_code: 200, content: EMPTY_HTML } } },
  ])
  const f = new ScrapflyZillowFetcher({ apiKey: 'k', serperApiKey: 's' })
  const res = await f.fetchListing(PROP, { skipCache: true })
  assert.equal(res.listing, undefined, 'wrong-number listing must be rejected')
  assert.ok(res.error)
}

// ── 6. Redfin lane: zillow misses everywhere, redfin listing carries photos ──
{
  const REDFIN_HTML = `<html><body>
    <img src="https://ssl.cdn-redfin.com/photo/1/bigphoto/123/123_1.jpg"/>
    <img src="https://ssl.cdn-redfin.com/photo/1/bigphoto/123/123_2.jpg"/>
    <meta property="og:description" content="Sold as-is fixer upper in Eastwood Addition bring your contractor vision to life today."/>
  </body></html>`
  stubFetch([
    {
      match: 'serper.dev',
      body: (() => { /* dynamic per-query handled below */ return {} })(),
    },
    { match: 'api.scrapfly.io/scrape', body: { result: { status_code: 200, content: EMPTY_HTML } } },
  ])
  // serper: first call (zillow) misses, second (redfin) hits
  let serperCall = 0
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    if (url.includes('serper.dev')) {
      serperCall++
      const link = serperCall === 1
        ? null
        : 'https://www.redfin.com/TX/Fort-Worth/4428-Crenshaw-Ave-76105/home/99887766'
      return new Response(JSON.stringify({ organic: link ? [{ link }] : [] }))
    }
    if (url.includes('redfin.com')) {
      return new Response(JSON.stringify({ result: { status_code: 200, content: REDFIN_HTML } }))
    }
    if (url.includes('api.scrapfly.io')) {
      return new Response(JSON.stringify({ result: { status_code: 200, content: EMPTY_HTML } }))
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch
  const f = new ScrapflyZillowFetcher({ apiKey: 'k', serperApiKey: 's' })
  const res = await f.fetchListing(PROP, { skipCache: true })
  assert.ok(res.listing, 'expected listing via Redfin lane')
  assert.ok(res.listing?.photos.every((p) => p.includes('cdn-redfin.com')))
  assert.match(res.listing?.description ?? '', /as-is/i)
}

console.log('photo-fetcher: all assertions passed')
