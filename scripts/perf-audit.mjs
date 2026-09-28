// Flowstate navigation/perf audit harness.
// Drives a real browser through the main user journeys and measures
// request fan-out, duplicate fetches, server-action POSTs, and
// click-to-useful-content timing per navigation.
//
// Usage:
//   node scripts/perf-audit.mjs --label before
//   FLOWSTATE_PLAYWRIGHT_MODULE=/path/to/playwright CHROME_BIN=/path/chrome \
//     BROWSER=firefox node scripts/perf-audit.mjs --label after
//
// Requires the dashboard on :3000 and API on :8787 (npm run dev) and a
// local login at .data/local-candidate/login.json (or PERF_EMAIL/PERF_PASS).
//
// Budgets: the run exits non-zero (or warns with --warn-only) when a
// journey regresses past its budget — server-action POSTs per nav,
// duplicate requests, or click-to-useful-content time.

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BASE = process.env.PERF_BASE || 'http://localhost:3000'
const API = process.env.PERF_API || 'http://localhost:8787'
const OUT_DIR = join(ROOT, 'scripts', 'artifacts')
const label = arg('--label', 'run')
const warnOnly = process.argv.includes('--warn-only')

function arg(name, dflt) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : dflt
}

// ── playwright resolution ────────────────────────────────────────────────────
const pwModule = process.env.FLOWSTATE_PLAYWRIGHT_MODULE || 'playwright'
const pw = await import(pwModule)
const browserName = process.env.BROWSER || 'chromium'
const launchOpts = {}
if (process.env.CHROME_BIN && browserName === 'chromium') launchOpts.executablePath = process.env.CHROME_BIN
const browser = await pw[browserName].launch(launchOpts)

const creds = JSON.parse(readFileSync(
  process.env.PERF_LOGIN || join(ROOT, '.data/local-candidate/login.json'), 'utf8'))
const REPORT_JOB = process.env.PERF_REPORT_JOB || 'job_1790459209688_d83a1f066aff41d2'

// Per-journey budgets: [max server-action POSTs, max duplicate requests,
// warn click→useful ms]. Exceed = budget violation.
const BUDGETS = {
  'Overview → Property Search': [2, 0, 4000],
  'Property Search → Offers': [2, 0, 2000],
  'Offers → item report': [3, 0, 4000],
  'item → Offers (back)': [2, 0, 2000],
  'Offers → Property Reports': [2, 0, 2500],
  'Reports → report detail': [3, 0, 4000],
  'report → back': [2, 0, 2000],
  '→ Analytics': [2, 0, 3000],
  'Analytics → Offers': [2, 0, 2000],
}

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()

// auth: sign in via API, inject session cookie
const signin = await page.request.post(`${API}/auth/sign-in/email`, {
  data: { email: creds.email, password: creds.password },
})
const token = /better-auth\.session_token=([^;]+)/.exec(signin.headers()['set-cookie'] ?? '')?.[1]
if (!token) { console.error('login failed'); process.exit(1) }
await ctx.addCookies([{ name: 'better-auth.session_token', value: decodeURIComponent(token), domain: 'localhost', path: '/' }])

let reqs = []
page.on('request', (r) => { reqs.push({ url: r.url(), method: r.method(), t0: Date.now() }) })
page.on('response', (r) => {
  const q = reqs.find((x) => x.url === r.url() && x.t1 == null)
  if (q) { q.t1 = Date.now(); q.ms = q.t1 - q.t0; q.status = r.status() }
})

const isApiReq = (r) => r.url.startsWith(API) || r.url.includes('api.flowstate')
const isActionPost = (r) => r.method === 'POST' && r.url.startsWith(BASE)
const isNoise = (r) => r.url.includes('_next/static/chunks') || r.url.includes('googleapis') || r.url.includes('gstatic') || r.url.includes('cdn-redfin') || r.url.includes('google.com')

function dupes() {
  const c = {}
  for (const r of reqs) {
    if (isNoise(r)) continue
    const k = `${r.method} ${r.url.split('?')[0].replace(/^https?:\/\/[^/]+/, '')}`
    c[k] = (c[k] ?? 0) + 1
  }
  return Object.entries(c).filter(([, n]) => n > 1)
}

async function journey(name, act, waitSel) {
  await page.evaluate(() => { window.__AUDIT_MARK = 'survives' }).catch(() => {})
  reqs = []
  const errors = []
  const errH = (e) => errors.push(e.message)
  page.on('pageerror', errH)
  const t0 = Date.now()
  await act().catch((e) => errors.push(`act: ${e.message}`))
  let useful = null
  if (waitSel) {
    useful = await page.waitForSelector(waitSel, { timeout: 20000 })
      .then(() => Date.now() - t0).catch(() => null)
  }
  await page.waitForTimeout(400)
  const total = Date.now() - t0
  const reloaded = await page.evaluate(() => window.__AUDIT_MARK !== 'survives').catch(() => true)
  const api = reqs.filter(isApiReq)
  const posts = reqs.filter(isActionPost)
  const dups = dupes()
  const slowest = [...reqs].filter((r) => r.ms).sort((a, b) => b.ms - a.ms)[0]
  page.off('pageerror', errH)
  const result = {
    name, reloaded, total, useful, reqs: reqs.length, api: api.length,
    posts: posts.length, dupes: dups.map(([k, n]) => `${n}× ${k}`),
    slowest: slowest ? `${slowest.ms}ms ${slowest.url.slice(0, 80)}` : null,
    errors,
  }
  console.log(`══ ${name}: ${reloaded ? 'RELOAD' : 'SPA'} total=${total}ms useful=${useful}ms reqs=${reqs.length} api=${api.length} posts=${posts.length}${dups.length ? ` DUPES: ${dups.map(([k, n]) => `${n}×${k.slice(0, 50)}`).join(' | ')}` : ''}${errors.length ? ` ERRORS: ${errors[0].slice(0, 80)}` : ''}`)
  if (api.length) console.log(`   api: ${[...new Set(api.map((r) => r.url.replace(API, '').split('?')[0]))].join(' | ')}`)
  return result
}

const results = []
await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('text=Overview', { timeout: 30000 }).catch(() => null)
await page.waitForTimeout(2500)

results.push(await journey('Overview → Property Search',
  () => page.click('a:has-text("Property Search")'),
  'input[placeholder*="Main St"]'))

results.push(await journey('Property Search → Offers',
  () => page.click('a:has-text("Offers")'),
  'text=Prep offers'))

results.push(await journey('Offers → item report',
  async () => {
    // wait for queue rows to exist before clicking — strict-mode remounts
    // can detach the first row mid-click otherwise.
    await page.waitForSelector('.divide-y > a', { timeout: 15000 })
    await page.locator('.divide-y > a').first().click()
    await page.waitForURL('**/give-offer/job_*', { timeout: 15000 }).catch(() => {})
  },
  'text=READY FOR OFFER, text=Report Not Found, text=Valuation'))

results.push(await journey('item → Offers (back)',
  () => page.click('a:has-text("Offers")'),
  'text=Prep offers'))

results.push(await journey('Offers → Property Reports',
  () => page.click('a:has-text("Property Reports")'),
  'h1:has-text("Property Reports")'))

results.push(await journey('Reports → report detail',
  async () => {
    const link = page.locator(`a[href*="${REPORT_JOB}"]`).first()
    if (await link.count()) await link.evaluate((el) => el.click())
    else await page.goto(`${BASE}/dashboard/reports/${REPORT_JOB}`)
  },
  'text=Report Not Found, text=Valuation, text=Valuation, text=Report Not Found, button:has-text("PDF")'))

results.push(await journey('report → back',
  () => page.goBack(), 'h1:has-text("Property Reports")'))

await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
results.push(await journey('→ Analytics',
  () => page.click('a:has-text("Analytics")'),
  'button:has-text("Today")'))

results.push(await journey('Analytics → Offers',
  () => page.click('a:has-text("Offers")'),
  'text=Prep offers'))

// ── budgets + artifact ────────────────────────────────────────────────────────
console.log('\n════ SUMMARY ════')
let violations = 0
for (const r of results) {
  const [maxPosts, maxDupes, warnMs] = BUDGETS[r.name] ?? [Infinity, Infinity, Infinity]
  const flags = []
  if (r.posts > maxPosts) flags.push(`posts>${maxPosts}`)
  if (r.dupes.length > maxDupes) flags.push(`dupes>${maxDupes}`)
  if (r.useful != null && r.useful > warnMs) flags.push(`slow>${warnMs}ms`)
  if (r.useful == null) flags.push('useful-timeout')
  if (flags.length) violations++
  console.log(`${r.reloaded ? 'RELOAD' : 'SPA  '} ${r.name.padEnd(30)} total=${String(r.total).padStart(5)}ms useful=${r.useful}ms reqs=${r.reqs} api=${r.api} posts=${r.posts} dup=${r.dupes.length}${flags.length ? ' ⚠ ' + flags.join(',') : ''}`)
}
mkdirSync(OUT_DIR, { recursive: true })
const out = join(OUT_DIR, `perf-audit-${label}-${Date.now()}.json`)
writeFileSync(out, JSON.stringify({ label, at: new Date().toISOString(), results }, null, 2))
console.log(`\nartifact: ${out}`)
await browser.close()
if (violations && !warnOnly) { console.error(`${violations} budget violations`); process.exit(1) }
