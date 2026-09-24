// Sidebar isAnalysisRunning indicator check — login, start a run via ?address=,
// assert the emerald ping dot appears on the Analyze nav item while running.
import { createRequire } from 'module'
import { existsSync } from 'node:fs'

const require = createRequire('/home/lucke/src/flowstate-v3/apps/web/package.json')
const { chromium } = require('playwright-core')

const BASE = 'http://localhost:3005'
const CANDIDATES = [
  '/home/lucke/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
  '/home/lucke/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell',
]
const executablePath = CANDIDATES.find((p) => existsSync(p))
if (!executablePath) { console.error('no chromium'); process.exit(1) }

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] })
const page = await browser.newPage()
const fail = (m) => { console.error('FAIL', m); process.exitCode = 1 }

try {
  await page.goto(`${BASE}/?signin=true`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#signin-email', { timeout: 15000 })
  await page.fill('#signin-email', 'local@flowstate.test')
  await page.fill('#signin-password', 'V4-Test-7mQ9-rP2x!')
  await page.click('button[type="submit"]:has-text("Sign In")')
  await page.waitForURL(/dashboard/, { timeout: 20000 })
  console.log('PASS login')

  // Trigger a run (warm cache is fine — indicator only needs "running" briefly)
  await page.goto(`${BASE}/dashboard/analyze?address=${encodeURIComponent('228 Cobblestone Dr, Spring Hill, FL 34606')}`, { waitUntil: 'domcontentloaded' })

  // Watch the instrumented nav attribute in parallel — a fast-failing run can
  // flip it on/off before the dialog wait below returns.
  const dot = page.locator('nav[data-analysis-running]')
  const dotSeen = dot.waitFor({ state: 'attached', timeout: 120000 })
    .then(() => true).catch(() => false)

  const newAnalysis = page.locator('button:has-text("New Analysis")')
  if (await newAnalysis.waitFor({ timeout: 15000 }).then(() => true).catch(() => false)) {
    await newAnalysis.dispatchEvent('click')
    console.log('PASS existing-report dialog → New Analysis')
  }

  if (await dotSeen) {
    console.log('PASS running indicator appeared during analysis')
  } else {
    await page.screenshot({ path: 'e2e/artifacts/sidebar-check-fail.png', fullPage: true })
    console.log('URL at fail:', page.url())
    console.log('dialogs:', await page.locator('[role="dialog"]').count(),
      '| cards:', await page.locator('[data-card-key]').count(),
      '| toasts:', await page.locator('[data-sonner-toast]').allTextContents())
    fail('running indicator never appeared')
  }

  // After completion the indicator should clear
  await page.waitForSelector('[data-card-key]', { timeout: 120000 })
  await page.waitForFunction(() => !document.querySelector('a[href="/dashboard/analyze"] .animate-ping'), { timeout: 90000 })
  console.log('PASS indicator cleared after completion')
} finally {
  await browser.close()
}
console.log(process.exitCode ? 'RESULT: FAIL' : 'RESULT: PASS')
