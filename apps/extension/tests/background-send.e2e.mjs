// End-to-end: background send against the real local Flowstate.
//
//   npm run dev   (dashboard :3000, API :8787)
//   LD_LIBRARY_PATH=$HOME/.local/lib/playwright-deps \
//     node apps/extension/tests/background-send.e2e.mjs ["new address"]
//   (set FLOWSTATE_E2E_API_KEY if the local account cannot create another key)
//
// 1. An address that already has a report comes back at once (no run).
// 2. A new address runs a REAL evaluation in the background — this spends
//    provider calls, once. Then its report opens from the popup.
// The listing page is a local fixture; the API, sign-in and dashboard are real.
// Artifact: .data/extension-e2e/{background-send.json,popup.png,report.png}
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, request } from 'playwright'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const extension = resolve(root, 'apps/extension')
const out = resolve(root, '.data/extension-e2e')
const DASH = 'http://localhost:3000'
const API = 'http://localhost:8787'
const login = JSON.parse(readFileSync(resolve(root, '.data/local-candidate/login.json'), 'utf8'))
const newAddress = process.argv[2] ?? '1457 E 56th St, Los Angeles, CA 90011'
const [street, city, region, zip] = newAddress.match(/^(.*?),\s*(.*?),\s*([A-Z]{2})\s+(\d{5})/).slice(1)

// A key for the run (removed at the end) and an address the user already analyzed.
const api = await request.newContext({ extraHTTPHeaders: { origin: DASH } })
assert.equal((await api.post(`${API}/auth/sign-in/email`, { data: { email: login.email, password: login.password } })).ok(), true, 'local sign-in failed')
const knownAddress = (await (await api.get(`${API}/user/reports?limit=1`)).json()).reports?.[0]?.propertyAddress
assert.ok(knownAddress, 'the local user has no saved report')
const already = (await (await api.get(`${API}/user/reports/by-property?address=${encodeURIComponent(newAddress)}`)).json()).reports
assert.equal(already.length, 0, `"${newAddress}" already has a report — pass an address that has never been run`)
// FLOWSTATE_E2E_API_KEY supplies a key when the account is at its plan's key limit.
const key = process.env.FLOWSTATE_E2E_API_KEY
  ? { key: process.env.FLOWSTATE_E2E_API_KEY }
  : await (await api.post(`${API}/user/api-keys`, { data: { name: 'extension-e2e' } })).json()
assert.ok(key.key, `could not create an API key (${key.error ?? 'no key returned'}) — set FLOWSTATE_E2E_API_KEY`)

// Fixture listing pages: one with a listing site's structured data, one with only a title.
const listing = (s, c, r, z) => `<title>Home for sale</title><script type="application/ld+json">${JSON.stringify({ '@type': 'SingleFamilyResidence', address: { streetAddress: s, addressLocality: c, addressRegion: r, postalCode: z } })}</script>`
// The known address sits in the page title only, the way some sites show it.
const pages = { '/known': `<title>${knownAddress} | Listing</title>`, '/new': listing(street, city, region, zip) }
const site = createServer((req, res) => { res.writeHead(pages[req.url] ? 200 : 404, { 'content-type': 'text/html' }); res.end(pages[req.url] ?? '') })
await new Promise((done) => site.listen(0, 'localhost', done))
const listings = `http://localhost:${site.address().port}`

const ctx = await chromium.launchPersistentContext(mkdtempSync(resolve(tmpdir(), 'fs-ext-')), {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1440, height: 900 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
})
const result = { knownAddress, newAddress, steps: [] }
const step = (name, detail) => { result.steps.push({ name, detail }); console.log('ok', name, detail ?? '') }
try {
  // The saved report page autosaves on load — block that write so the run changes nothing but the evaluation.
  // (Routes also see the extension's own calls, so only /user writes are stopped.)
  await ctx.route(`${API}/user/**`, (route) => (route.request().method() === 'GET' ? route.continue() : route.abort()))

  // Sign in to the dashboard in this browser, as a user would be.
  const dash = await ctx.newPage()
  await dash.goto(DASH)
  await dash.getByPlaceholder('you@example.com').fill(login.email)
  await dash.getByPlaceholder('••••••••').fill(login.password)
  await dash.getByRole('button', { name: 'Sign In' }).click()
  await dash.waitForURL((url) => url.pathname === '/dashboard/analyze', { timeout: 30_000 })

  let [worker] = ctx.serviceWorkers()
  if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 15_000 })
  const extensionId = new URL(worker.url()).host

  const options = await ctx.newPage()
  await options.goto(`chrome-extension://${extensionId}/options.html`)
  await options.fill('#baseUrl', 'localhost:3000')
  await options.fill('#apiKey', key.key)
  await options.click('#save')
  await options.getByText('The key works').waitFor({ timeout: 20_000 })
  step('settings page accepted a real API key')

  for (const path of Object.keys(pages)) await (await ctx.newPage()).goto(listings + path)
  const popup = await ctx.newPage()
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  const row = (address) => popup.locator('#jobs li').filter({ hasText: address })
  // Chrome fires this same event for the real shortcut. A popup message wakes the worker first.
  const shortcut = async (path) => {
    await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'refresh' }))
    const live = ctx.serviceWorkers()[0]
    await live.evaluate(async (path) => {
      const tab = (await chrome.tabs.query({})).find((t) => t.url?.endsWith(path))
      chrome.commands.onCommand.dispatch('send-to-flowstate', tab)
    }, path)
  }

  // 1. Already analyzed: found through the dashboard sign-in, no new run.
  await shortcut('/known')
  await row(knownAddress).locator('.status.done').waitFor({ timeout: 20_000 })
  step('an already-analyzed address came back at once', await row(knownAddress).locator('.status').textContent())

  // 2. New address: a real evaluation in the background. The extension's own 30-second timer checks on it.
  const startedAt = Date.now()
  await shortcut('/new')
  await row(street).locator('.status', { hasText: 'Evaluating' }).waitFor({ timeout: 100_000 })
  step('a new address started evaluating in the background')
  await row(street).locator('.status.done, .status.error').waitFor({ timeout: 8 * 60_000 })
  const outcome = await row(street).locator('.status').textContent()
  await popup.screenshot({ path: (mkdirSync(out, { recursive: true }), resolve(out, 'popup.png')) })
  assert.match(outcome, /ARV \$[\d,]+/, `the evaluation did not finish with a value: ${outcome}`)
  step('the evaluation finished on its own', `${outcome} (${Math.round((Date.now() - startedAt) / 1000)}s)`)

  const reportTab = ctx.waitForEvent('page')
  await row(street).click()
  const report = await reportTab
  await report.waitForURL(/\/dashboard\/reports\/job_/, { timeout: 30_000 })
  await report.getByText(new RegExp(street.split(' ').slice(0, 2).join(' '), 'i')).first().waitFor({ timeout: 60_000 })
  await report.screenshot({ path: resolve(out, 'report.png') })
  step('its report opens from the popup', report.url())

  writeFileSync(resolve(out, 'background-send.json'), JSON.stringify({ ...result, passed: true, at: new Date().toISOString() }, null, 2))
  console.log('PASS — artifact in .data/extension-e2e/')
} finally {
  await ctx.close()
  site.close()
  if (key.id) await api.delete(`${API}/user/api-keys/${key.id}`)
  await api.dispose()
}
