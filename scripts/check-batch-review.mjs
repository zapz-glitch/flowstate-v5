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
const artifacts = await mkdtemp(join(tmpdir(), 'flowstate-batch-review-'))
const base = 'http://127.0.0.1:3108'
const server = spawn(process.execPath, [root + '/node_modules/next/dist/bin/next', 'start', '-p', '3108', '-H', '127.0.0.1'], { cwd: root + '/apps/dashboard', stdio: 'pipe' })
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
const imageryRequests = []
let failStreetView = false
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmioAAAAASUVORK5CYII=', 'base64')
async function setup(override = async () => false) {
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1365, height: 1000 } })
  const errors = []
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', msg => { if (msg.text().includes('PDF generation failed')) console.log('PDF ERROR:', msg.text()) })
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url())
    if (url.origin === base && url.pathname.startsWith('/user/reports/')) return route.fulfill({ contentType: 'image/png', body: png })
    if (url.origin === base) return route.continue()
    if (url.hostname === 'maps.googleapis.com') imageryRequests.push(url.pathname)
    if (url.hostname === 'maps.googleapis.com' && url.pathname === '/maps/api/streetview') {
      return route.fulfill({ status: failStreetView ? 404 : 200, contentType: 'image/png', body: failStreetView ? '' : png })
    }
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
  const image = '/user/reports/report-b/assets/11111111-1111-1111-1111-111111111111'
  const bReport = { ...report, jobId: 'report-b', address: '200 Batch Street', analysis: {
    ...report.analysis,
    subject: { ...report.analysis.subject, address: '200 Batch Street', photos: [image] },
    comps: { count: 1, enabledCount: 1, items: [{ id: 'comp-fixture', address: '210 Comparable Street', city: 'Tampa', state: 'FL', zipCode: '33607', photos: [image], isEnabled: true, bedrooms: 3, bathrooms: 2, squareFeet: 1500, yearBuilt: 2000, salePrice: 300000, adjustedPrice: 300000, pricePerSqft: 200, saleDate: '2026-09-01' }] },
  } }
  const makeJob = (id, jobId, address) => ({ id, status: 'completed', totalAddresses: 1, completedCount: 1, failedCount: 0, createdAt: new Date().toISOString(), results: [{ index: 0, address, jobId, status: 'completed', confidence: 'high', arv: 300000, buyPrice: 180000 }] })
  const aJob = makeJob('job-a', 'report-a', '100 Older Street')
  const bJob = makeJob('job-b', 'report-b', '200 Batch Street')
  const waitUntil = async check => {
    for (let i = 0; i < 100; i++) { if (check()) return; await sleep(50) }
    assert.fail('Condition did not become true')
  }
  {
    let releaseJobs, releaseOld, releaseAll, releaseReport
    const jobsHeld = new Promise(r => { releaseJobs = r })
    const oldHeld = new Promise(r => { releaseOld = r })
    const allHeld = new Promise(r => { releaseAll = r })
    const reportHeld = new Promise(r => { releaseReport = r })
    let aggregate = false, oldRead = false, reportRead = false
    const allReads = new Set()
    const start = requests.length
    const { context, page: batchPage, errors } = await setup(async (url, json) => {
      if (url.pathname === '/batch') { await jobsHeld; await json({ jobs: [aJob, bJob] }); return true }
      if (url.pathname === '/batch/job-a' || url.pathname === '/batch/job-b') {
        if (aggregate) { allReads.add(url.pathname); await allHeld }
        else if (url.pathname.endsWith('job-a')) { oldRead = true; await oldHeld }
        await json(url.pathname.endsWith('job-a') ? aJob : bJob)
        return true
      }
      if (url.pathname === '/user/reports/report-b') { reportRead = true; await reportHeld; await json(bReport); return true }
      return false
    })
    let page = batchPage
    await page.goto(base + '/dashboard/batch')
    await page.getByRole('heading', { name: 'Batch Import', exact: true }).waitFor()
    releaseJobs()
    await page.getByRole('button', { name: 'All lists', exact: true }).waitFor()
    await waitUntil(() => oldRead)
    await page.getByRole('button', { name: /^List 1/ }).click()
    await page.getByRole('link', { name: 'Review', exact: true }).first().waitFor()
    assert.match(await page.getByRole('link', { name: 'Review', exact: true }).first().getAttribute('href'), /report-b/)
    releaseOld()
    await page.waitForTimeout(250)
    assert.match(await page.getByRole('link', { name: 'Review', exact: true }).first().getAttribute('href'), /report-b/)
    results.push({ check: 'List picker appears before details; late list cannot replace selection', pass: true })
    aggregate = true
    await page.getByRole('button', { name: 'All lists', exact: true }).click()
    await waitUntil(() => allReads.size === 2)
    releaseAll()
    await page.locator('a[href*="report-a"]').first().waitFor()
    await page.locator('a[href*="report-b"]').first().waitFor()
    aggregate = false
    results.push({ check: 'All lists reads execute concurrently', pass: true })
    await page.getByRole('button', { name: /^List 1/ }).click()
    const popup = page.waitForEvent('popup')
    await page.getByRole('link', { name: 'Review', exact: true }).first().click()
    page = await popup
    page.on('pageerror', error => errors.push(error.message))
    assert.equal(new URL(batchPage.url()).pathname, '/dashboard/batch')
    await page.waitForURL(/reports\/report-b/)
    assert.equal(await page.evaluate(() => window.opener), null)
    await waitUntil(() => reportRead)
    await page.getByRole('heading', { name: 'Property report', exact: true }).waitFor()
    await page.getByRole('link', { name: 'Back to Batch Import', exact: true }).waitFor()
    releaseReport()
    await page.getByRole('button', { name: 'Download Report' }).waitFor()
    await page.getByAltText('Google Street View: 200 Batch Street').waitFor()
    await page.getByAltText('Google Street View: 210 Comparable Street, Tampa, FL, 33607').waitFor()
    const imgs = page.locator('img[alt^="Google Street View"]')
    assert.equal(await imgs.count(), 2)
    for (const img of await imgs.all()) {
      await img.scrollIntoViewIfNeeded()
      await img.evaluate(el => el.decode())
      const src = new URL(await img.getAttribute('src'))
      assert.equal(src.hostname, 'maps.googleapis.com')
      assert.equal(src.searchParams.get('return_error_code'), 'true')
    }
    assert(!imageryRequests.some(path => path.includes('/metadata')))
    assert.deepEqual(errors, [])
    assert(requests.slice(start).filter(r => r.path.startsWith('/batch')).every(r => r.method === 'GET'))
    await page.screenshot({ path: join(artifacts, 'batch-review.png'), fullPage: true })
    await context.close()
    results.push({ check: 'Review shell before report; subject and comp prefer Street View despite saved photos', pass: true })
  }
  {
    failStreetView = true
    const { context, page, errors } = await setup(async (url, json) => {
      if (url.pathname === '/user/reports/report-b') { await json(bReport); return true }
      return false
    })
    await page.goto(base + '/dashboard/reports/report-b')
    const savedSubject = page.getByAltText('Saved property photo: 200 Batch Street')
    await savedSubject.waitFor()
    await savedSubject.evaluate(el => el.decode())
    const savedComp = page.getByAltText('Saved property photo: 210 Comparable Street, Tampa, FL, 33607')
    await savedComp.scrollIntoViewIfNeeded()
    await savedComp.waitFor()
    await savedComp.evaluate(el => el.decode())
    assert.deepEqual(errors, [])
    await context.close()
    results.push({ check: 'Unavailable Street View falls back to private saved photo on both cards', pass: true })
  }
  console.log(JSON.stringify(results, null, 2))
  console.log('Artifacts:', artifacts)
  await writeFile(join(artifacts, 'results.json'), JSON.stringify(results, null, 2))
} finally {
  if (browser) await browser.close()
  server.kill('SIGTERM')
}
