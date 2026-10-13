// End-to-end: signed out → right-click "Send to Flowstate" → sign in → the
// address is prefilled on the analyze page and the normal flow runs.
//
//   npm run dev   (dashboard :3000, API :8787)
//   LD_LIBRARY_PATH=$HOME/.local/lib/playwright-deps node apps/extension/tests/send-address.e2e.mjs
//
// Sends an address that already has a report, so the flow ends at the
// existing-report dialog and no provider calls are spent. Artifact:
// .data/extension-e2e/{result.json,analyze.png}
import assert from 'node:assert/strict'
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

// Pick an address the local user has already analyzed.
const api = await request.newContext({ extraHTTPHeaders: { origin: DASH } })
const signedIn = await api.post(`${API}/auth/sign-in/email`, { data: { email: login.email, password: login.password } })
assert.equal(signedIn.ok(), true, `local sign-in failed: ${signedIn.status()}`)
const latest = await (await api.get(`${API}/user/reports?limit=1`)).json()
const address = latest.reports?.[0]?.propertyAddress
assert.ok(address, 'the local user has no saved report to send')
await api.dispose()

const ctx = await chromium.launchPersistentContext(mkdtempSync(resolve(tmpdir(), 'fs-ext-')), {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1440, height: 900 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
})
const result = { address, steps: [] }
const step = (name, detail) => { result.steps.push({ name, detail }); console.log('ok', name, detail ?? '') }
try {
  let [worker] = ctx.serviceWorkers()
  if (!worker) worker = await ctx.waitForEvent('serviceworker', { timeout: 15_000 })
  const extensionId = new URL(worker.url()).host

  // Never spend a real analysis from this test.
  let analysisBlocked = false
  await ctx.route(`${DASH}/**`, (route) => {
    const req = route.request()
    if (req.method() === 'POST' && req.headers()['next-action'] && (req.postData() ?? '').includes('"searchOptions"')) {
      analysisBlocked = true
      return route.abort()
    }
    return route.continue()
  })

  const options = await ctx.newPage()
  await options.goto(`chrome-extension://${extensionId}/options.html`)
  await options.fill('#baseUrl', 'localhost:3000')
  await options.click('#save')
  await options.waitForFunction(() => document.getElementById('saved').textContent.startsWith('Saved'))
  step('options page saved the local dashboard URL')

  // The right-click itself is native browser UI; fire the same event Chrome does.
  const selection = `  ${address.replace(', ', ',\n ')}  `
  const opened = ctx.waitForEvent('page')
  await worker.evaluate((selectionText) => chrome.contextMenus.onClicked.dispatch({ menuItemId: 'flowstate-send', selectionText }, { id: 1, index: 0 }), selection)
  const tab = await opened
  await tab.waitForURL(`${DASH}/`, { timeout: 30_000 })
  step('signed out: the new tab lands on sign-in')

  await tab.getByPlaceholder('you@example.com').fill(login.email)
  await tab.getByPlaceholder('••••••••').fill(login.password)
  await tab.getByRole('button', { name: 'Sign In' }).click()
  await tab.waitForURL((url) => url.pathname === '/dashboard/analyze', { timeout: 30_000 })
  assert.equal(new URL(tab.url()).searchParams.get('address'), address)
  step('after sign-in the address is still on the link', tab.url())

  const dialog = tab.getByText('Existing Reports Found')
  await dialog.waitFor({ timeout: 30_000 })
  assert.equal(analysisBlocked, false)
  step('the address ran through the normal flow (existing-report dialog)')

  mkdirSync(out, { recursive: true })
  await tab.screenshot({ path: resolve(out, 'analyze.png') })
  writeFileSync(resolve(out, 'result.json'), JSON.stringify({ ...result, passed: true, at: new Date().toISOString() }, null, 2))
  console.log('PASS — artifact in .data/extension-e2e/')
} finally {
  await ctx.close()
}
