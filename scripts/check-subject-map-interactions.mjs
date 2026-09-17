// No Google credentials/network required: exercise real React map code against
// deterministic API objects. Live imagery/CSP must also be checked separately.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const artifacts = await mkdtemp(join(tmpdir(), 'flowstate-subject-map-'))
const fixture = join(root, 'scripts/fixtures/subject-map')
const output = await build({
  entryPoints: [join(fixture, 'app.jsx')], bundle: true, write: false, format: 'iife', jsx: 'automatic',
  define: { 'process.env.NEXT_PUBLIC_GOOGLE_MAP_KEY': '"fixture"', 'process.env.NODE_ENV': '"development"' },
  alias: { '@vis.gl/react-google-maps': join(fixture, 'maps.jsx'), 'next/dynamic': join(fixture, 'dynamic.jsx'), '@': join(root, 'apps/dashboard/src') },
})
const html = '<!doctype html><html><body><div id="root"></div><script>' + output.outputFiles[0].text + '</script></body></html>'
await writeFile(join(artifacts, 'fixture.html'), html)
const server = http.createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end(html) })
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
let browser
const results = []
try {
  const { chromium } = await import(process.env.FLOWSTATE_PLAYWRIGHT_MODULE || 'playwright')
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}), args: ['--no-sandbox'] })
  const origin = `http://127.0.0.1:${server.address().port}`
  async function scenario(name, query, run) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
    const errors = []
    page.setDefaultTimeout(10000)
    page.on('pageerror', error => errors.push(error.message))
    if (query.includes('stalled-3d')) await page.clock.install()
    await page.goto(origin + query)
    try { await run(page); assert.deepEqual(errors, []); results.push({ name, passed: true }) }
    catch (error) { await page.screenshot({ path: join(artifacts, `${results.length}-failure.png`) }); throw error }
    finally { await page.close() }
  }
  const street = page => page.locator('[data-panorama]').waitFor()
  const aerial = async page => {
    await page.getByTestId('native-aerial').waitFor()
    await page.getByText('Loading subject’s 3D map…').waitFor({ state: 'hidden' })
  }
  await scenario('subject panorama, aerial controls, drift, zoom, rerender', '', async page => {
    await street(page)
    assert.equal(await page.locator('[data-panorama]').getAttribute('data-panorama'), 'pano-101')
    const lookup = await page.evaluate(() => ({ request: fixture.panoramaRequests[0], options: fixture.panoramaMounts[0] }))
    assert.deepEqual(lookup.request.location, { lat: 39.75, lng: -104.99 })
    assert.deepEqual(lookup.request.sources, ['google', 'outdoor'])
    assert.equal(lookup.options.pov.heading, 0)
    await page.getByRole('button', { name: 'Back to map', exact: true }).click()
    await aerial(page)
    const initialCamera = await page.evaluate(() => ({ center: fixture.aerial.center, tilt: fixture.aerial.tilt, mode: fixture.groundMode, range: fixture.aerial.range }))
    assert.deepEqual(initialCamera.center, { lat: 39.75, lng: -104.99, altitude: 1600 })
    assert.ok(Math.abs(initialCamera.tilt - 45) < 0.01)
    assert.equal(initialCamera.range, 200)
    assert.equal(initialCamera.mode, 'RELATIVE_TO_GROUND')
    const headings = []
    for (let count = 0; count < 4; count++) {
      await page.getByRole('button', { name: 'Rotate counterclockwise' }).click()
      headings.push(await page.evaluate(() => fixture.aerial.heading))
      assert.equal(await page.getByTestId('subject-map').getAttribute('data-view'), 'aerial')
      assert.equal(await page.evaluate(() => fixture.aerial.range), 200)
    }
    assert.deepEqual(headings, [270, 180, 90, 0])
    await page.getByTestId('native-aerial').dblclick({ position: { x: 400, y: 180 } })
    assert.equal(await page.evaluate(() => fixture.aerial.heading), 270)
    assert.equal(await page.evaluate(() => fixture.nativeDoubleZooms ?? 0), 0)
    assert.equal(await page.evaluate(() => fixture.aerial.range), 200)
    await page.evaluate(() => { fixture.aerial.range = 0; fixture.aerial.dispatchEvent(new Event('gmp-rangechange')) })
    await page.waitForFunction(() => fixture.aerial.range === 200)
    assert.equal(await page.getByTestId('subject-map').getAttribute('data-view'), 'aerial')
    await page.evaluate(() => { fixture.aerial.center = { lat: 39, lng: -105, altitude: 0 }; fixture.aerial.tilt = 0; fixture.aerial.dispatchEvent(new Event('gmp-centerchange')) })
    await page.waitForFunction(() => fixture.aerial.center.lat === 39.75 && fixture.aerial.tilt === 45)
    await page.evaluate(() => { fixture.aerial.center = { lat: 38, lng: -106, altitude: 10 }; fixture.aerial.style.width = '680px' })
    await page.waitForFunction(() => fixture.aerial.center.lat === 39.75 && fixture.aerial.center.altitude === 1600)
    await page.evaluate(() => fixture.toggleComp())
    await page.waitForTimeout(80)
    assert.equal(await page.evaluate(() => fixture.aerialMounts), 1)
    assert.equal(await page.evaluate(() => fixture.panoramaRequests.length), 1)
    assert.equal(await page.evaluate(() => fixture.aerial.heading), 270)
    await page.locator('[data-marker="103 Test Street"]').click()
    assert.equal(await page.evaluate(() => fixture.selected[0][0]), 'comp')
    for (let count = 0; count < 4; count++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
    await street(page)
    await page.locator('[data-panorama]').dispatchEvent('wheel', { deltaY: 120 })
    await aerial(page)
    assert.equal(await page.evaluate(() => fixture.aerial.range), 200)
  })
  await scenario('subject change ignores late old panorama', '?delayed', async page => {
    await page.waitForFunction(() => typeof fixture.resolveOldPanorama === 'function')
    await page.evaluate(() => fixture.replaceSubject())
    await street(page)
    assert.equal(await page.locator('[data-panorama]').getAttribute('data-panorama'), 'pano-202')
    await page.evaluate(() => fixture.resolveOldPanorama())
    await page.waitForTimeout(80)
    assert.equal(await page.locator('[data-panorama]').getAttribute('data-panorama'), 'pano-202')
    assert.deepEqual(await page.evaluate(() => fixture.panoramaMounts.map(item => item.pano)), ['pano-202'])
  })
  await scenario('wheel zoom, drag orbit, and touch pinch keep subject anchor', '', async page => {
    await street(page)
    await page.getByRole('button', { name: 'Back to map', exact: true }).click()
    await aerial(page)
    const map = page.getByTestId('native-aerial')
    const bounds = await map.boundingBox()
    await page.mouse.move(bounds.x + 400, bounds.y + 150)
    await page.mouse.down()
    await page.mouse.move(bounds.x + 460, bounds.y + 150, { steps: 3 })
    await page.mouse.up()
    assert.equal(await page.evaluate(() => fixture.aerial.heading), 330)
    assert.deepEqual(await page.evaluate(() => fixture.aerial.center), { lat: 39.75, lng: -104.99, altitude: 1600 })
    await map.dispatchEvent('wheel', { deltaY: -120 })
    assert.ok(await page.evaluate(() => fixture.aerial.range < 200 && fixture.aerial.range > 45))
    await page.getByRole('button', { name: 'Subject', exact: true }).click()
    await map.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100, button: 0 })
    await map.dispatchEvent('pointerdown', { pointerId: 2, pointerType: 'touch', clientX: 200, clientY: 100, button: 0 })
    await map.dispatchEvent('pointermove', { pointerId: 2, pointerType: 'touch', clientX: 400, clientY: 100 })
    assert.ok(await page.evaluate(() => fixture.aerial.range > 45 && fixture.aerial.range < 100))
    await map.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100 })
    await map.dispatchEvent('pointermove', { pointerId: 2, pointerType: 'touch', clientX: 410, clientY: 100 })
    assert.equal(await page.evaluate(() => fixture.aerial.heading), 325, 'remaining finger orbits smoothly after pinch release')
    await map.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 100, button: 0 })
    await map.dispatchEvent('pointermove', { pointerId: 2, pointerType: 'touch', clientX: 600, clientY: 100 })
    await street(page)
  })
  await scenario('missing panorama keeps subject-centered aerial usable', '?no-panorama', async page => {
    await aerial(page)
    assert.equal(await page.getByRole('button', { name: 'Street View', exact: true }).isDisabled(), true)
    assert.equal(await page.evaluate(() => fixture.aerial.center.lat), 39.75)
    await page.getByText('No nearby Street View available for this subject.').waitFor()
    for (let count = 0; count < 6; count++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
    assert.equal(await page.getByTestId('subject-map').getAttribute('data-view'), 'aerial')
    assert.ok(await page.evaluate(() => fixture.aerial.range <= 45 && fixture.aerial.range >= 20))
  })
  await scenario('3D library unavailable falls back to subject satellite', '?no-3d', async page => {
    await street(page)
    await page.getByRole('button', { name: 'Back to map', exact: true }).click()
    await page.getByTestId('flat-map').waitFor()
    assert.deepEqual(await page.evaluate(() => fixture.flat.center), { lat: 39.75, lng: -104.99 })
    assert.equal(await page.getByRole('button', { name: 'Rotate counterclockwise' }).isDisabled(), true)
    await page.getByText('Satellite fallback · 3D unavailable').waitFor()
  })
  await scenario('native 3D renderer failure falls back', '', async page => {
    await street(page)
    await page.getByRole('button', { name: 'Back to map', exact: true }).click()
    await aerial(page)
    await page.evaluate(() => fixture.aerial.dispatchEvent(new Event('gmp-error')))
    await page.getByTestId('flat-map').waitFor()
  })
  await scenario('3D imagery readiness timeout falls back', '?stalled-3d', async page => {
    await street(page)
    await page.getByRole('button', { name: 'Back to map', exact: true }).click()
    await page.getByTestId('native-aerial').waitFor()
    await page.clock.fastForward(15001)
    await page.getByTestId('flat-map').waitFor()
  })
  await writeFile(join(artifacts, 'results.json'), JSON.stringify(results, null, 2))
  console.log(`PASS: ${results.length} subject map browser scenarios. Evidence: ${artifacts}`)
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }
