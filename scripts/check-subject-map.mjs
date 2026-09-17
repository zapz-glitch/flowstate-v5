import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { parse } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Build dashboard first. Uses fixture account/report APIs and REAL Google Maps.
// No production account data is read or written. Google API access/key is required.
const { chromium } = await import(process.env.FLOWSTATE_PLAYWRIGHT_MODULE || 'playwright')
// Optional existing local credentials only; never persist or print a key.
const testKey = process.env.FLOWSTATE_MAP_TEST_ENV ? parse(await readFile(process.env.FLOWSTATE_MAP_TEST_ENV)).NEXT_PUBLIC_GOOGLE_MAP_KEY : undefined
if (process.env.FLOWSTATE_MAP_TEST_ENV && !testKey) throw new Error('Selected test environment has no Google Maps browser key')
const root = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '')
const artifacts = await mkdtemp(join(tmpdir(), 'flowstate-subject-map-'))
const base = 'http://127.0.0.1:3109'
const server = spawn(process.execPath, [root + '/node_modules/next/dist/bin/next', 'start', '-p', '3109', '-H', '127.0.0.1'], { cwd: root + '/apps/dashboard', stdio: 'pipe' })
let serverLog = '', browser, page
server.stdout.on('data', d => { serverLog += d })
server.stderr.on('data', d => { serverLog += d })
const sanitize = text => text.replace(/https?:\/\/[^\s)]+/g, value => { try { const url = new URL(value); return url.origin + url.pathname } catch { return '[URL]' } }).replace(/AIza[\w-]+/g, '[REDACTED]')
const errors = [], consoleErrors = [], consoleWarnings = [], failedGoogleResponses = [], checks = []
const subject = { address: '710 Steiner St, San Francisco, CA 94117', latitude: 37.77625, longitude: -122.43272, bedrooms: 3, bathrooms: 2, squareFeet: 1500, yearBuilt: 1900, photos: [] }
const comps = [
  { id: 'nearby', address: '720 Steiner St', latitude: 37.77645, longitude: -122.43277, distanceMiles: 0.03 },
  { id: 'far', address: '100 Far Comparison Street', latitude: 37.8, longitude: -122.47, distanceMiles: 2.5 },
].map(comp => ({ ...comp, bedrooms: 3, bathrooms: 2, squareFeet: 1500, yearBuilt: 1900, salePrice: 800000, adjustedPrice: 800000, saleDate: '2026-06-01', photos: [], isEnabled: true }))
const report = { jobId: 'map-report', address: subject.address, createdAt: new Date().toISOString(), analysis: { evaluationEngine: 'python-v4', subject, valuation: { arv: 800000, buyPrice: 500000, rehabCost: 40000, projectedProfit: 100000, projectedROI: 20 }, comps: { items: comps, count: comps.length } } }
const user = { id: 'map-fixture', name: 'Map Test', email: 'map@example.test', emailVerified: true, plan: 'free', role: 'user', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
const session = { user, session: { id: 'map-session', userId: user.id, token: 'fixture', expiresAt: new Date(Date.now() + 86400000).toISOString() } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function camera() {
  return page.locator('gmp-map-3d').evaluate(map => ({ center: { lat: map.center.lat, lng: map.center.lng, altitude: map.center.altitude }, heading: map.heading, tilt: map.tilt, range: map.range }))
}
async function until(predicate, label, timeout = 15000) {
  const start = Date.now()
  while (Date.now() - start < timeout) { if (await predicate()) return; await sleep(150) }
  throw new Error(label)
}
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base)).ok) break } catch {}
    if (server.exitCode !== null) throw new Error(`Local server exited (${server.exitCode}): ${sanitize(serverLog) || 'No output; verify localhost permissions and production build.'}`)
    if (i === 99) throw new Error(`Local server did not become reachable at ${base}: ${sanitize(serverLog) || 'No server output; check sandbox localhost access.'}`)
    await sleep(100)
  }
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined, headless: true, args: ['--no-sandbox', '--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1600, height: 1100 } })
  page = await context.newPage()
  page.on('pageerror', error => errors.push(sanitize(error.message)))
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(sanitize(message.text())); if (message.type() === 'warning') consoleWarnings.push(sanitize(message.text())) })
  page.on('response', response => { const url = new URL(response.url()); if (response.status() >= 400 && /google|gstatic|ggpht/.test(url.hostname)) failedGoogleResponses.push({ host: url.hostname, path: url.pathname, status: response.status() }) })
  await page.addInitScript(() => {
    window.__mapDiagnostics = []
    const tracked = new WeakSet()
    const snapshot = map => ({ center: map.center ? { lat: map.center.lat, lng: map.center.lng, altitude: map.center.altitude } : null, range: map.range, tilt: map.tilt, heading: map.heading, isSteady: map.isSteady, connected: map.isConnected })
    const record = (event, map, extra = {}) => window.__mapDiagnostics.push({ event, at: Math.round(performance.now()), ...snapshot(map), ...extra })
    new MutationObserver(records => {
      for (const mutation of records) {
        for (const node of mutation.removedNodes) if (node instanceof Element) {
          if (node.matches('gmp-map-3d')) record('removed', node)
          node.querySelectorAll('gmp-map-3d').forEach(map => record('removed-with-parent', map))
        }
      }
      document.querySelectorAll('gmp-map-3d').forEach(map => {
        if (tracked.has(map)) return
        tracked.add(map)
        record('added', map)
        for (const name of ['gmp-animationend', 'gmp-steadychange', 'gmp-error']) map.addEventListener(name, event => record(name, map, { message: event.message ?? event.error?.message, code: event.code ?? event.error?.code }))
        const fly = map.flyCameraTo
        if (typeof fly === 'function') map.flyCameraTo = function (options) { record('flyCameraTo', map, { options: { durationMillis: options.durationMillis, endCamera: options.endCamera } }); return fly.call(this, options) }
        else record('flyCameraTo-unavailable', map)
        for (const delay of [1000, 6000, 14000]) setTimeout(() => record('snapshot-' + delay, map), delay)
      })
    }).observe(document, { childList: true, subtree: true })
  })
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (testKey && url.hostname === 'maps.googleapis.com' && url.pathname === '/maps/api/js') { url.searchParams.set('key', testKey); return route.continue({ url: url.href }) }
    if (url.origin === base || ['google.com', 'googleapis.com', 'gstatic.com', 'googleusercontent.com', 'ggpht.com'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) return route.continue()
    if (!['api.flowstate.homes', 'api.staging.flowstate.homes'].includes(url.hostname)) return route.abort()
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': base, 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': 'Content-Type,X-Impersonate-User-Id', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }, body: JSON.stringify(body) })
    if (request.method() === 'OPTIONS') return json({})
    if (url.pathname === '/auth/get-session') return json(session)
    if (url.pathname === '/user') return json(user)
    if (url.pathname === '/user/api-keys') return json({ keys: [{ id: 'fixture-key', isActive: true }] })
    if (url.pathname === '/user/usage') return json({ currentUsage: 7, monthlyLimit: 100, remaining: 93 })
    if (url.pathname === '/user/reports') return json({ reports: [] })
    if (url.pathname === '/user/reports/map-report') return json(report)
    if (url.pathname === '/user/usage/logs') return json({ logs: [], pagination: { page: 1, total: 0 } })
    if (url.pathname === '/ui-prefs') return json({})
    if (url.pathname === '/tasks') return json({ tasks: [] })
    if (url.pathname === '/arv-threshold') return json({ config: { percent: 15 } })
    return json({ error: 'Fixture settings unavailable' }, 503)
  })
  await context.addInitScript(({ address }) => localStorage.setItem('flowstate:last-analysis', JSON.stringify({ jobId: 'map-report', address, savedAt: Date.now() })), subject)
  await page.goto(base + '/dashboard/analyze')
  const map = page.getByTestId('subject-map')
  await map.waitFor({ timeout: 20000 })
  await until(async () => (await map.getAttribute('data-view')) !== 'loading', 'Subject imagery resolution did not finish', 25000)
  await page.waitForTimeout(3000)
  await page.screenshot({ path: join(artifacts, 'initial.png') })
  assert.equal(await map.getAttribute('data-view'), 'street', 'Real nearby Street View must open automatically; inspect Google errors/artifact for account or coverage failures')
  assert.match(await map.innerText(), /facing subject/)
  checks.push({ check: 'Automatic nearby panorama selection with proximity disclosure (imagery requires screenshot inspection)', pass: true })
  await map.getByRole('button', { name: 'Back to map' }).click()
  await until(async () => await page.locator('gmp-map-3d').count() > 0 || (await map.innerText()).includes('Satellite fallback'), 'Aerial view did not resolve', 25000)
  await until(async () => !(await map.innerText()).includes('Loading subject'), '3D camera did not finish ground placement', 20000)
  assert.equal(await page.locator('gmp-map-3d').count(), 1, '3D unavailable: inspect Google account entitlement/WebGL errors')
  const markers = await page.locator('gmp-map-3d').evaluate(map => Array.from(map.querySelectorAll('gmp-marker-3d-interactive')).map(marker => ({ title: marker.title, drawsWhenOccluded: marker.drawsWhenOccluded, collisionBehavior: marker.collisionBehavior, pinCount: marker.querySelectorAll('gmp-pin').length })))
  assert.equal(markers.length, 3, 'Subject and both comp markers must mount')
  assert.ok(markers.every(marker => marker.drawsWhenOccluded && marker.pinCount === 1 && marker.collisionBehavior === 'REQUIRED'), 'Every marker needs a native visible pin and required collision behavior')
  checks.push({ check: 'Native subject/comp pins mount with occlusion and collision visibility', pass: true, markers })
  const initial = await camera()
  assert.ok(Math.abs(initial.tilt - 45) < 0.02)
  assert.ok(Math.abs(initial.center.lat - subject.latitude) < 0.002 && Math.abs(initial.center.lng - subject.longitude) < 0.002)
  const anchored = async () => { const current = await camera(); assert.ok(Math.abs(current.center.lat - initial.center.lat) < 0.000001); assert.ok(Math.abs(current.center.lng - initial.center.lng) < 0.000001); assert.ok(Math.abs(current.tilt - 45) < 0.02) }
  const canvas = page.getByTestId('subject-aerial-map')
  for (const heading of [270, 180, 90, 0]) {
    await canvas.dblclick({ position: { x: 100, y: 100 } })
    await until(async () => Math.abs((await camera()).heading - heading) < 0.1, `Double click failed to rotate to ${heading}`)
    await anchored()
  }
  checks.push({ check: '45-degree ground-relative map and N→W→S→E double-click rotation', pass: true })
  await map.getByRole('button', { name: 'Zoom out', exact: true }).click()
  await anchored()
  await page.setViewportSize({ width: 1400, height: 1000 })
  await sleep(500)
  await anchored()
  const compCard = page.getByText('720 Steiner St', { exact: true }).locator('visible=true').first()
  await compCard.hover()
  await sleep(200)
  await anchored()
  // Simulate external camera drift; the normal event path must restore the subject.
  await page.locator('gmp-map-3d').evaluate(map => { map.center = { lat: map.center.lat + 0.01, lng: map.center.lng + 0.01, altitude: map.center.altitude }; map.dispatchEvent(new Event('gmp-centerchange')) })
  await sleep(300)
  await anchored()
  checks.push({ check: 'Subject center survives zoom, resize, comp hover and camera drift', pass: true })
  for (let i = 0; i < 12 && await map.getAttribute('data-view') === 'aerial'; i++) { await map.getByRole('button', { name: 'Zoom in', exact: true }).click(); await sleep(200) }
  assert.equal(await map.getAttribute('data-view'), 'street')
  let streetZoomOutClicks = 0
  while (streetZoomOutClicks < 8 && await map.getAttribute('data-view') === 'street') {
    await map.getByRole('button', { name: 'Zoom out', exact: true }).click()
    streetZoomOutClicks++
    await page.waitForTimeout(300)
  }
  await until(async () => await map.getAttribute('data-view') === 'aerial', 'Street View zoom out did not return to aerial')
  checks.push({ check: 'Close zoom enters subject Street View; zoom out returns to aerial', pass: true, streetZoomOutClicks })
  assert.deepEqual(errors, [])
  await until(async () => await page.locator('gmp-map-3d').count() === 1 && !(await map.innerText()).includes('Loading subject'), 'Returning aerial camera did not become ready', 25000)
  await page.waitForTimeout(1000)
  await page.screenshot({ path: join(artifacts, 'aerial.png') })
  await page.setViewportSize({ width: 380, height: 850 })
  await page.waitForTimeout(1000)
  await page.screenshot({ path: join(artifacts, 'mobile.png') })
} catch (error) {
  checks.push({ check: 'Browser QA', pass: false, error: sanitize(error.message || String(error)) })
  if (page) await page.screenshot({ path: join(artifacts, 'failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  const mapDiagnostics = page ? await page.evaluate(() => window.__mapDiagnostics ?? []).catch(() => []) : []
  const result = { mapDiagnostics, consoleWarnings, failedGoogleResponses, credentialMode: testKey ? 'existing-local-test-key' : 'production-build-key', limitation: 'Production-origin imagery and key authorization require deployment QA.', checks, errors, consoleErrors }
  await writeFile(join(artifacts, 'results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
  console.log('Artifacts:', artifacts)
  if (browser) await browser.close()
  server.kill('SIGTERM')
}
