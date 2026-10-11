import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseSearchResults, webSearch } from './index'

const result = (url: string, title: string, snippet: string) => `
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}&amp;rut=abc">${title}</a>
  </h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}&amp;rut=abc">${snippet}</a>
</div>`

const SERP = `<html><body>
${result('https://duckduckgo.com/y.js?ad_domain=example.com', 'Sponsored row', 'ad')}
${result('https://www.redfin.com/GA/Fairburn/3757-Oakman-Pl-30213/home/24822947', '3757 Oakman Pl, Fairburn, GA 30213 | Redfin', '3 beds, 2 baths <b>house</b> &amp; lot')}
${result('https://www.redfin.com/GA/Fairburn/3957-Oakman-Pl-30213/home/24597926', '3957 Oakman Pl', '')}
</body></html>`

const scrapflyResponse = (content: string, status = 200) =>
  new Response(JSON.stringify({ result: { status_code: status, content } }), { status: 200 })

afterEach(() => vi.unstubAllGlobals())

describe('parseSearchResults', () => {
  it('unwraps redirect links, strips markup, and skips sponsored rows', () => {
    expect(parseSearchResults(SERP)).toEqual([
      {
        link: 'https://www.redfin.com/GA/Fairburn/3757-Oakman-Pl-30213/home/24822947',
        title: '3757 Oakman Pl, Fairburn, GA 30213 | Redfin',
        snippet: '3 beds, 2 baths house & lot',
      },
      {
        link: 'https://www.redfin.com/GA/Fairburn/3957-Oakman-Pl-30213/home/24597926',
        title: '3957 Oakman Pl',
        snippet: '',
      },
    ])
  })

  it('returns nothing for a page with no results', () => {
    expect(parseSearchResults('<html><body>No results.</body></html>')).toEqual([])
  })
})

describe('webSearch', () => {
  it('scrapes the search page through Scrapfly and honors the limit', async () => {
    const fetchMock = vi.fn(async () => scrapflyResponse(SERP))
    vi.stubGlobal('fetch', fetchMock)

    const results = await webSearch({ SCRAPFLY_API_KEY: 'k' }, 'site:redfin.com 3757 Oakman Pl', { limit: 1 })

    expect(results).toHaveLength(1)
    expect(results[0].link).toContain('3757-Oakman-Pl')
    const called = new URL(String(fetchMock.mock.calls[0][0]))
    expect(called.origin + called.pathname).toBe('https://api.scrapfly.io/scrape')
    expect(called.searchParams.get('key')).toBe('k')
    expect(called.searchParams.get('url')).toBe(
      'https://html.duckduckgo.com/html/?q=site%3Aredfin.com%203757%20Oakman%20Pl',
    )
  })

  it('makes no request without a key', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await webSearch({}, 'q')).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never sends the key to a non-Scrapfly host', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await webSearch({ SCRAPFLY_API_KEY: 'k', SCRAPFLY_URL: 'https://evil.example/scrape' }, 'q')).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('retries when Scrapfly reports its concurrency cap', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('too many', { status: 429 }))
      .mockResolvedValueOnce(scrapflyResponse(SERP))
    vi.stubGlobal('fetch', fetchMock)
    const pending = webSearch({ SCRAPFLY_API_KEY: 'k' }, 'q')
    await vi.advanceTimersByTimeAsync(1000)
    expect(await pending).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('returns [] on an API error or an upstream wall instead of throwing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Insufficient credits', { status: 402 })))
    expect(await webSearch({ SCRAPFLY_API_KEY: 'k' }, 'q')).toEqual([])
    vi.stubGlobal('fetch', vi.fn(async () => scrapflyResponse('<html>blocked</html>', 429)))
    expect(await webSearch({ SCRAPFLY_API_KEY: 'k' }, 'q')).toEqual([])
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout') }))
    expect(await webSearch({ SCRAPFLY_API_KEY: 'k' }, 'q')).toEqual([])
  })
})
