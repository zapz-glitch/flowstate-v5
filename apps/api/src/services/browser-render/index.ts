/**
 * Cloudflare Browser Rendering — dedicated headless-browser pool for
 * listing-page renders. The comp-evidence lane uses this as a render
 * provider beside Scrapfly: puppeteer.launch(env.BROWSER) hands each comp
 * a real Chrome session on CF's infra (paid plan: ~10 concurrent
 * sessions, billed per browser-minute).
 *
 * First question it answers: does Redfin's CloudFront challenge CF
 * datacenter browser sessions the way it blocks plain Worker fetches?
 * `renderListingPage` reports `blocked` so callers can route around it.
 */
import puppeteer from '@cloudflare/puppeteer'
import type { Env } from '../../types'

// The page.evaluate callback executes inside the browser — the Worker
// tsconfig has no DOM lib, so declare just the shape we use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const document: any

export interface RenderedListingPage {
  url: string
  /** Final URL after redirects. */
  finalUrl: string | null
  status: number | null
  /** True when the response looks like a bot challenge, not a listing. */
  blocked: boolean
  photoUrls: string[]
  description: string | null
  title: string | null
  durationMs: number
}

const CHALLENGE_RE = /request blocked|access denied|verify you are a human|attention required|cf-chl|robot or human/i

export async function renderListingPage(env: Env, url: string, timeoutMs = 30_000): Promise<RenderedListingPage> {
  const t0 = Date.now()
  const out: RenderedListingPage = {
    url, finalUrl: null, status: null, blocked: false,
    photoUrls: [], description: null, title: null, durationMs: 0,
  }
  if (!env.BROWSER) { out.durationMs = Date.now() - t0; return out }
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null
  try {
    browser = await puppeteer.launch(env.BROWSER as unknown as Parameters<typeof puppeteer.launch>[0])
    const page = await browser.newPage()
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    out.status = resp?.status() ?? null
    out.finalUrl = page.url()
    // Sold-comp evidence lives on the photo CDN + remark copy — pull both
    // straight from the DOM rather than regexing raw HTML.
    const data = await page.evaluate(() => {
      const photos = Array.from(document.querySelectorAll('img'))
        .map((i) => (i as { src?: string }).src ?? '')
        .filter((s) => /cdn-redfin\.com\/photo|ssl\.cdn-redfin\.com/.test(s))
      const remark =
        document.querySelector('[data-rf-test-id="abp-homeinfo-remarks"]')?.textContent ??
        document.querySelector('#marketing-remarks-scroll, .remarks, .marketingRemarks')?.textContent ??
        null
      return { photos, remark, title: document.title, bodyText: document.body?.innerText?.slice(0, 2000) ?? '' }
    })
    out.photoUrls = [...new Set(data.photos)]
    out.description = data.remark
    out.title = data.title
    out.blocked = CHALLENGE_RE.test(data.bodyText) || CHALLENGE_RE.test(data.title ?? '')
  } finally {
    if (browser) await browser.close().catch(() => {})
    out.durationMs = Date.now() - t0
  }
  return out
}
