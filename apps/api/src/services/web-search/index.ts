/**
 * Web search via Scrapfly — the single search lane for listing-URL
 * resolution and pocket-desirability evidence (replaced Serper).
 *
 * Scrapfly has no search endpoint, so a search is a Scrapfly scrape of
 * DuckDuckGo's HTML results page: 1 credit, ~2s, no JS render. Google's
 * SERP is not used — it answers Scrapfly with a 429 wall.
 *
 * Failures never throw: callers treat search as best-effort evidence, so
 * a failed search returns [] and logs why (credits, upstream wall, timeout).
 */

import { REPLAYED_HEADER } from '../observability/call-log'

export interface WebSearchEnv {
  SCRAPFLY_API_KEY?: string
  /** Scrapfly scrape endpoint — defaults to https://api.scrapfly.io/scrape */
  SCRAPFLY_URL?: string
}

export interface WebSearchResult {
  link: string
  title: string
  snippet: string
}

const SCRAPFLY_SCRAPE_URL = 'https://api.scrapfly.io/scrape'
/** Waits between retries when Scrapfly reports its concurrency cap (429). */
const CONCURRENCY_RETRY_MS = [1000, 2000, 4000, 6000]

export function isWebSearchAvailable(env: WebSearchEnv): boolean {
  return !!env.SCRAPFLY_API_KEY
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

/** DuckDuckGo wraps outbound links as //duckduckgo.com/l/?uddg=<encoded>. */
function unwrapLink(href: string): string | null {
  const raw = decodeEntities(href)
  const wrapped = raw.match(/[?&]uddg=([^&]+)/)
  let link = raw
  if (wrapped) {
    try { link = decodeURIComponent(wrapped[1]) } catch { return null }
  }
  if (link.startsWith('//')) link = `https:${link}`
  return /^https?:\/\//.test(link) ? link : null
}

/** Parse DuckDuckGo HTML results into organic {link, title, snippet} rows. */
export function parseSearchResults(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = []
  // Each organic result has one result__a title anchor; its snippet anchor
  // (when present) sits between it and the next result's title anchor.
  const titles = [...html.matchAll(/<a\b([^>]*\bclass="result__a"[^>]*)>([\s\S]*?)<\/a>/g)]
  titles.forEach((m, i) => {
    const link = unwrapLink(m[1].match(/\bhref="([^"]+)"/)?.[1] ?? '')
    // Sponsored rows route through DuckDuckGo's ad redirect — not organic.
    if (!link || /duckduckgo\.com\/y\.js/.test(link)) return
    const start = (m.index ?? 0) + m[0].length
    const body = html.slice(start, titles[i + 1]?.index ?? html.length)
    const snippet = body.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)
    results.push({
      link,
      title: stripTags(m[2]),
      snippet: snippet ? stripTags(snippet[1]) : '',
    })
  })
  return results
}

/**
 * Run one web search. Returns organic results in rank order, [] on any
 * failure (the reason is logged).
 */
export async function webSearch(
  env: WebSearchEnv,
  query: string,
  opts?: { limit?: number; timeoutMs?: number },
): Promise<WebSearchResult[]> {
  if (!env.SCRAPFLY_API_KEY) return []
  // The API key rides in the query string — only ever send it to
  // Scrapfly's own hosts, no matter what the env says.
  const endpoint = env.SCRAPFLY_URL || SCRAPFLY_SCRAPE_URL
  const host = (() => { try { return new URL(endpoint).hostname } catch { return '' } })()
  if (!host.endsWith('scrapfly.io')) {
    console.warn(`[WebSearch] Scrapfly endpoint refused: ${endpoint}`)
    return []
  }
  const params = new URLSearchParams({
    key: env.SCRAPFLY_API_KEY,
    url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    country: 'us',
  })
  try {
    // Scrapfly plans cap concurrent scrapes (429 while the cap is full). A
    // search is short, so a brief wait usually clears it — retry inside the
    // caller's time budget rather than report "no results".
    const deadline = Date.now() + (opts?.timeoutMs ?? 15_000)
    let resp: Response
    for (let attempt = 0; ; attempt++) {
      resp = await fetch(`${endpoint}?${params}`, {
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      })
      const wait = CONCURRENCY_RETRY_MS[attempt]
      if (resp.status !== 429 || wait == null || Date.now() + wait >= deadline) break
      // A replayed 429 comes from an earlier run's log — there is nothing to wait out.
      if (resp.headers.get(REPLAYED_HEADER)) break
      await new Promise((r) => setTimeout(r, wait))
    }
    if (!resp.ok) {
      console.warn(`[WebSearch] Scrapfly HTTP ${resp.status} — ${(await resp.text().catch(() => '')).slice(0, 200)}`)
      return []
    }
    const data = (await resp.json()) as { result?: { status_code?: number; content?: string } }
    const status = data.result?.status_code
    const content = data.result?.content ?? ''
    if (!content || (status != null && status >= 400)) {
      console.warn(`[WebSearch] search page upstream ${status ?? 'empty'}`)
      return []
    }
    return parseSearchResults(content).slice(0, opts?.limit ?? 10)
  } catch (err) {
    console.warn(`[WebSearch] search failed: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}
