// Integration: the real extension in Chromium against a stand-in Flowstate
// (one local server plays the listing sites, the API and the dashboard).
// Nothing real is called, so nothing is spent.
//
//   LD_LIBRARY_PATH=$HOME/.local/lib/playwright-deps node apps/extension/tests/extension.integration.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const extension = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ESKIMO = '910 E Eskimo Ave, Tampa, FL 33604'
const EMPEDRADO = '4207 W Empedrado St, Tampa, FL 33629'
const VALUATION = { valuation: { arv: 290606.4, buyPrice: 171986 } }

// ─── Stand-in Flowstate ──────────────────────────────────────────────
const seen = { starts: [], lookups: [], polls: 0 }
const state = { existing: false }
const pages = {
  '/listing': `<title>Home for sale</title><script type="application/ld+json">${JSON.stringify({ '@type': 'SingleFamilyResidence', address: { streetAddress: '910 E Eskimo Ave', addressLocality: 'Tampa', addressRegion: 'FL', postalCode: '33604' } })}</script><h1>Nice house</h1>`,
  '/listing-two': `<title>${EMPEDRADO} | MLS #T3501234 | Zillow</title><h1>Price cut</h1>`,
  '/plain': '<title>Marketplace - 3 Beds 2 Baths House</title><p>12 Oak St, Tampa, FL 33604</p>',
}
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  const keyOk = req.headers.authorization === 'Bearer fs_good'
  if (pages[url.pathname]) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(pages[url.pathname]) }
  if (url.pathname.startsWith('/dashboard/')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>stand-in dashboard</title>') }
  if (url.pathname === '/user/reports/by-property') {
    seen.lookups.push({ address: url.searchParams.get('address'), cookie: req.headers.cookie ?? '' })
    return json(200, { reports: state.existing ? [{ jobId: 'job_saved', arv: 250000, maxAllowableOffer: 150000 }] : [] })
  }
  if (url.pathname.startsWith('/v1/') && !keyOk) return json(401, { success: false, error: 'Invalid API key' })
  if (url.pathname === '/v1/analyze/defaults') return json(200, { success: true, data: {} })
  if (url.pathname === '/v1/analyze' && req.method === 'POST') {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const body = JSON.parse(raw)
      seen.starts.push(body)
      json(200, { success: true, data: body.address === EMPEDRADO ? { jobId: 'job_cached', cached: true, result: VALUATION } : { jobId: 'job_stub_1', result: null } })
    })
    return
  }
  if (url.pathname === '/v1/analyze/jobs/job_stub_1') {
    seen.polls++
    return json(200, { success: true, data: seen.polls < 2 ? { jobId: 'job_stub_1', status: 'processing' } : { jobId: 'job_stub_1', status: 'complete', result: VALUATION } })
  }
  json(404, { success: false, error: 'Not found' })
})
await new Promise((done) => server.listen(0, 'localhost', done))
const origin = `http://localhost:${server.address().port}`

// ─── Browser with the extension ──────────────────────────────────────
const ctx = await chromium.launchPersistentContext(mkdtempSync(resolve(tmpdir(), 'fs-ext-')), {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
})
const ok = (name) => console.log('ok', name)
async function until(check, what) {
  for (let i = 0; i < 100; i++) {
    const value = await check()
    if (value) return value
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.fail(`timed out waiting for ${what}`)
}
try {
  let [worker] = ctx.serviceWorkers()
  if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 15_000 })
  const extensionId = new URL(worker.url()).host
  const jobs = () => worker.evaluate(async () => (await chrome.storage.local.get({ jobs: [] })).jobs)
  const badge = () => worker.evaluate(() => chrome.action.getBadgeText({}))
  // Chrome fires these same events for the real shortcut, right-click and timer.
  const fire = (event, path, selectionText) => worker.evaluate(async ([event, path, selectionText]) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url?.endsWith(path))
    if (event === 'shortcut') chrome.commands.onCommand.dispatch('send-to-flowstate', tab)
    else chrome.contextMenus.onClicked.dispatch({ menuItemId: 'flowstate-send', selectionText }, tab)
  }, [event, path, selectionText])
  const tick = () => worker.evaluate(() => chrome.alarms.onAlarm.dispatch({ name: 'flowstate-poll' }))

  // Chrome keeps its own Alt+F, so the extension ships with Alt+Shift+F.
  const commands = await worker.evaluate(() => chrome.commands.getAll())
  assert.equal(commands.find((c) => c.name === 'send-to-flowstate').shortcut, 'Alt+Shift+F')
  ok('keyboard shortcut is assigned: Alt+Shift+F')

  // Settings: a bad key is called out, a good key turns background sends on.
  const options = await ctx.newPage()
  await options.goto(`chrome-extension://${extensionId}/options.html`)
  const save = async (key) => {
    await options.fill('#baseUrl', origin.replace('http://', ''))
    await options.fill('#apiUrl', origin)
    await options.fill('#apiKey', key)
    await options.click('#save')
  }
  await save('fs_bad')
  await options.getByText('did not accept the API key').waitFor()
  await save('fs_good')
  await options.getByText('The key works').waitFor()
  ok('settings page checks the API key')

  for (const path of Object.keys(pages)) await (await ctx.newPage()).goto(origin + path)

  // Shortcut on a listing: the address is read off the page and sent in the background.
  await fire('shortcut', '/listing')
  await until(() => seen.starts.length === 1, 'the start call')
  assert.deepEqual(seen.starts[0], { address: ESKIMO, searchOptions: { radiusMiles: 1, monthsBack: 12 }, marketData: { enabled: true } })
  const running = await until(async () => (await jobs()).find((j) => j.jobId === 'job_stub_1'), 'the job to be listed')
  assert.equal(running.status, 'running')
  assert.equal(await badge(), '1')
  assert.ok(await worker.evaluate((id) => new Promise((r) => chrome.notifications.getAll((all) => r(id in all))), running.id))
  ok('shortcut reads the listing address and starts a background evaluation')

  // The timer checks on it: still running, then done with the numbers.
  await tick()
  await until(() => seen.polls === 1, 'the first check')
  assert.equal((await jobs())[0].status, 'running')
  await tick()
  const done = await until(async () => (await jobs()).find((j) => j.status === 'done'), 'the job to finish')
  assert.deepEqual([done.arv, done.offer], [290606.4, 171986])
  assert.equal(await badge(), '')
  assert.equal(await worker.evaluate(() => chrome.alarms.get('flowstate-poll')), undefined)
  ok('finished evaluation shows ARV and offer, and the checking stops')

  // The popup lists it; a click opens the report.
  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  const row = popup.locator('#jobs li').first()
  await row.getByText('ARV $290,606 · Offer $171,986').waitFor()
  assert.equal(await row.locator('.address').textContent(), ESKIMO)
  const reportTab = ctx.waitForEvent('page')
  await row.click()
  assert.equal((await reportTab).url(), `${origin}/dashboard/reports/job_stub_1`)
  ok('popup lists the send and opens its report')

  // Right-click on a second listing: address from the page title, answered at once from a saved result.
  await fire('menu', '/listing-two')
  const cached = await until(async () => (await jobs()).find((j) => j.jobId === 'job_cached'), 'the cached job')
  assert.equal(seen.starts[1].address, EMPEDRADO)
  assert.equal(cached.status, 'done')
  ok('right-click with nothing highlighted sends the listing; a repeat comes back at once')

  // A page with no address: nothing is sent, the user is told to highlight.
  await fire('shortcut', '/plain')
  await until(() => worker.evaluate(() => new Promise((r) => chrome.notifications.getAll((all) => r('flowstate-no-address' in all)))), 'the no-address notice')
  assert.equal(seen.starts.length, 2)
  ok('page with no address sends nothing and says so')

  // An address that already has a report skips the run.
  state.existing = true
  await fire('shortcut', '/listing')
  const saved = await until(async () => (await jobs()).find((j) => j.jobId === 'job_saved'), 'the existing report')
  assert.deepEqual([saved.status, saved.arv, saved.offer], ['done', 250000, 150000])
  assert.equal(seen.starts.length, 2)
  ok('existing report is used instead of a new run')

  // No API key: a send opens Flowstate in a tab — the report if one exists, else the search.
  await save('')
  await options.getByText('No API key').waitFor()
  let opened = ctx.waitForEvent('page')
  await fire('menu', '/plain', ' 12 Oak St,\n Tampa, FL 33604 ')
  assert.equal((await opened).url(), `${origin}/dashboard/reports/job_saved`)
  state.existing = false
  opened = ctx.waitForEvent('page')
  await fire('menu', '/plain', ' 12 Oak St,\n Tampa, FL 33604 ')
  assert.equal((await opened).url(), `${origin}/dashboard/analyze?address=12%20Oak%20St%2C%20Tampa%2C%20FL%2033604`)
  assert.equal(seen.starts.length, 2)
  assert.equal(seen.lookups.at(-1).address, '12 Oak St, Tampa, FL 33604')
  ok('without a key a send opens Flowstate in a tab, straight on the report when one exists')

  console.log('PASS')
} finally {
  await ctx.close()
  server.close()
}
