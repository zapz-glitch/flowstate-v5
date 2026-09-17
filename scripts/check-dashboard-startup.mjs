import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, mkdtemp, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Build apps/dashboard first. Install Playwright, or set FLOWSTATE_PLAYWRIGHT_MODULE
// to an existing playwright/index.mjs. CHROME_BIN optionally selects Chromium.
const { chromium } = await import(process.env.FLOWSTATE_PLAYWRIGHT_MODULE || 'playwright')

const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '')
const artifacts = await mkdtemp(join(tmpdir(), 'flowstate-startup-'))
const base = 'http://127.0.0.1:3107'
const server = spawn(process.execPath, [root + '/node_modules/next/dist/bin/next', 'start', '-p', '3107', '-H', '127.0.0.1'], { cwd: root + '/apps/dashboard', stdio: 'pipe' })
let serverLog = ''
server.stdout.on('data', d => { serverLog += d })
server.stderr.on('data', d => { serverLog += d })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
let browser
const user = { id: 'startup-fixture', name: 'Startup Test', email: 'startup@example.test', emailVerified: true, plan: 'free', role: 'user', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
const session = { user, session: { id: 'session-fixture', userId: user.id, token: 'fixture', expiresAt: new Date(Date.now() + 86400000).toISOString() } }
const usage = { currentUsage: 7, monthlyLimit: 100, remaining: 93, resetDate: '2026-10-01T00:00:00Z' }
const report = { jobId: 'startup-report', address: '100 Test Street', createdAt: new Date().toISOString(), analysis: { evaluationEngine: 'python-v4', subject: { address: '100 Test Street', bedrooms: 3, bathrooms: 2, squareFeet: 1500, yearBuilt: 2000, photos: [] }, valuation: { arv: 300000, buyPrice: 180000, rehabCost: 40000, projectedProfit: 50000, projectedROI: 20 }, comps: { items: [], count: 0 } } }
const requests = []
async function setup(override = async () => false) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1365, height: 1000 } })
  const errors = []
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', msg => { if (msg.text().includes('PDF generation failed')) console.log('PDF ERROR:', msg.text()) })
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url())
    if (url.origin === base) return route.continue()
    if (url.hostname !== 'api.flowstate.homes') return route.abort()
    requests.push({ path: url.pathname, method: req.method(), headers: req.headers() })
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': base, 'Access-Control-Allow-Credentials': 'true' }, body: JSON.stringify(body) })
    if (await override(url, json, req)) return
    if (url.pathname === '/auth/get-session') return json(session)
    if (url.pathname === '/user') return json(user)
    if (url.pathname === '/user/api-keys') return json({ keys: [{ id: 'key-1', isActive: true }] })
    if (url.pathname === '/user/usage') return json(usage)
    if (url.pathname === '/user/usage/logs') return json({ logs: [], pagination: { page: 1, limit: 5, total: 0, totalPages: 0 } })
    if (url.pathname === '/ui-prefs') return json({})
    if (url.pathname === '/tasks') return json({ tasks: [] })
    if (url.pathname === '/arv-threshold') return json({ config: { percent: 15 } })
    if (url.pathname === '/user/reports') return json({ reports: [] })
    if (url.pathname === '/user/reports/startup-report') return json(report)
    if (url.pathname === '/typeahead') return json({ results: [] })
    return json({ error: 'Fixture: settings unavailable' }, 503)
  })
  return { context, page, errors }
}
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base)).ok) break } catch {}
    if (i === 99) throw new Error(serverLog)
    await sleep(100)
  }
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined, headless: true, args: ['--no-sandbox'] })
  // Overview remains useful while usage is unresolved, including error/retry.
  {
    let release, held = new Promise(r => { release = r }), failed = false, received = false
    const { context, page, errors } = await setup(async (url, json) => {
      if (url.pathname !== '/user/usage' || failed) return false
      received = true
      await held
      failed = true
      await json({ error: 'Fixture delayed failure' }, 503)
      return true
    })
    const started = Date.now()
    await page.goto(base + '/dashboard')
    await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor()
    assert(received)
    await page.getByText('1/1', { exact: true }).waitFor()
    assert(await page.getByRole('link', { name: 'API Hub', exact: true }).first().isVisible())
    results.push({ check: 'Overview usable while usage held', ms: Date.now() - started })
    release()
    await page.getByRole('alert').filter({ hasText: 'Some account details' }).waitFor()
    assert(await page.getByRole('heading', { name: 'Dashboard', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Try again' }).click()
    await page.getByText('Monthly Usage', { exact: true }).waitFor()
    await page.getByRole('alert').filter({ hasText: 'Some account details' }).waitFor({ state: 'hidden', timeout: 5000 })
    assert.deepEqual(errors, [])
    await page.screenshot({ path: join(artifacts, 'overview.png') })
    await context.close()
    results.push({ check: 'Overview partial failure/retry', pass: true })
  }
  // Slow latest-report lookup never locks the input; new input cancels restore.
  {
    let release, held = new Promise(r => { release = r }), reportReads = 0
    const start = requests.length
    const { context, page, errors } = await setup(async (url, json) => {
      if (url.pathname === '/user/reports') {
        await held
        await json({ reports: [{ jobId: report.jobId, propertyAddress: report.address, createdAt: report.createdAt }] })
        return true
      }
      if (url.pathname === '/user/reports/startup-report') reportReads++
      return false
    })
    await page.goto(base + '/dashboard/analyze')
    const input = page.getByPlaceholder('123 Main St, Tampa, FL 33607')
    await input.waitFor()
    assert(await input.isEnabled())
    await page.getByText('Restoring your last report. You can start a new search now.').waitFor()
    const before = requests.slice(start)
    assert(!before.some(r => r.path === '/appraisal-presets/mine'))
    await input.fill('200 New Street')
    release()
    await page.waitForTimeout(400)
    assert.equal(await input.inputValue(), '200 New Street')
    assert.equal(reportReads, 0)
    assert.deepEqual(errors, [])
    await page.screenshot({ path: join(artifacts, 'search.png') })
    await context.close()
    results.push({ check: 'Search usable before restore; typing cancels lookup; no settings batch', pass: true })
  }
  // An already-in-flight report response also must not replace new input.
  {
    let release, held = new Promise(r => { release = r }), received = false
    const { context, page, errors } = await setup(async (url, json) => {
      if (url.pathname !== '/user/reports/startup-report') return false
      received = true
      await held
      await json(report)
      return true
    })
    await context.addInitScript(() => localStorage.setItem('flowstate:last-analysis', JSON.stringify({ jobId: 'startup-report', address: '100 Test Street', savedAt: Date.now() })))
    await page.goto(base + '/dashboard/analyze')
    const input = page.getByPlaceholder('123 Main St, Tampa, FL 33607')
    await input.waitFor()
    await page.getByText('Restoring your last report. You can start a new search now.').waitFor()
    assert(received)
    await input.fill('300 New Street')
    release()
    await page.waitForTimeout(400)
    assert.equal(await input.inputValue(), '300 New Street')
    assert.equal(await page.getByRole('button', { name: 'Download Report' }).count(), 0)
    assert.deepEqual(errors, [])
    await context.close()
    results.push({ check: 'Late report cannot overwrite new input', pass: true })
  }
  // Normal restore, round-trip navigation, settings requests once, PDF on demand.
  {
    const start = requests.length
    const { context, page, errors } = await setup()
    await context.addInitScript(() => localStorage.setItem('flowstate:last-analysis', JSON.stringify({ jobId: 'startup-report', address: '100 Test Street', savedAt: Date.now() })))
    const chunks = []
    page.on('request', req => { if (req.url().includes('/_next/static/chunks/')) chunks.push(req.url()) })
    await page.goto(base + '/dashboard/analyze')
    await page.getByRole('button', { name: 'Download Report' }).waitFor()
    await page.getByText('100 Test Street', { exact: true }).first().waitFor()
    assert.equal(requests.slice(start).filter(r => r.path === '/appraisal-presets/mine').length, 1)
    const beforePdf = new Set(chunks)
    const downloadPromise = page.waitForEvent('download', { timeout: 20000 })
    await page.getByRole('button', { name: 'Download Report' }).click()
    const download = await downloadPromise.catch(async err => { console.log('BROWSER ERRORS:', errors); throw err })
    const pdfPath = await download.path()
    assert.equal((await readFile(pdfPath)).subarray(0, 4).toString(), '%PDF')
    assert(chunks.some(url => !beforePdf.has(url)), 'PDF request must load deferred chunks')
    const readsBefore = requests.filter(r => r.path === '/user/reports/startup-report').length
    await page.getByRole('link', { name: 'Overview', exact: true }).click()
    await page.getByRole('heading', { name: 'Dashboard', exact: true }).waitFor()
    await page.getByRole('link', { name: 'Property Search', exact: true }).click()
    await page.getByRole('button', { name: 'Download Report' }).waitFor()
    assert.equal(requests.filter(r => r.path === '/user/reports/startup-report').length, readsBefore)
    assert.deepEqual(errors, [])
    await context.close()
    results.push({ check: 'Report restore, PDF export, immediate return to retained report', pass: true })
  }
  {
    const { context, page } = await setup(async (url, json) => {
      if (url.pathname !== '/auth/get-session') return false
      await json(null)
      return true
    })
    await page.goto(base + '/dashboard')
    await page.waitForURL(base + '/')
    await context.close()
    results.push({ check: 'Unauthenticated dashboard redirects home', pass: true })
  }
  assert(!requests.some(r => r.method === 'GET' && r.path.startsWith('/user/') && r.headers['content-type'] === 'application/json'))
  // Sign-in still enters the prefetched client route without a router refresh.
  {
    let signedIn = false
    const { context, page, errors } = await setup(async (url, json, req) => {
      if (url.pathname === '/auth/get-session') {
        await json(signedIn ? session : null)
        return true
      }
      if (url.pathname === '/auth/sign-in/email' && req.method() === 'POST') {
        signedIn = true
        await json({ redirect: false, token: 'fixture', user })
        return true
      }
      return false
    })
    await page.goto(base + '/?signin=true')
    await page.locator('#signin-email').fill('startup@example.test')
    await page.locator('#signin-password').fill('fixture-password')
    await page.getByRole('button', { name: 'Sign In', exact: true }).click()
    await page.waitForURL(base + '/dashboard/analyze')
    await page.getByPlaceholder('123 Main St, Tampa, FL 33607').waitFor({ timeout: 5000 }).catch(async err => {
      console.log('Sign-in diagnostic:', page.url(), await page.locator('body').innerText(), errors, requests.slice(-15).map(r => r.path))
      throw err
    })
    assert.deepEqual(errors, [])
    await context.close()
    results.push({ check: 'Sign-in reaches prefetched Property Search without refresh', pass: true })
  }
  console.log(JSON.stringify(results, null, 2))
  console.log('Artifacts:', artifacts)
  await writeFile(join(artifacts, 'results.json'), JSON.stringify(results, null, 2))
} finally {
  if (browser) await browser.close()
  server.kill('SIGTERM')
}
