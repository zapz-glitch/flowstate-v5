// Route navigation smoke — verify each route with a new loading.tsx renders.
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
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] })
const page = await browser.newPage()
let failed = false

try {
  await page.goto(`${BASE}/?signin=true`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#signin-email', { timeout: 15000 })
  await page.fill('#signin-email', 'local@flowstate.test')
  await page.fill('#signin-password', 'V4-Test-7mQ9-rP2x!')
  await page.click('button[type="submit"]:has-text("Sign In")')
  await page.waitForURL(/dashboard/, { timeout: 20000 })
  console.log('PASS login')

  const routes = [
    ['/dashboard/analyze', 'input, button:has-text("Run")'],
    ['/dashboard/reports', 'text=/report/i'],
    ['/dashboard/batch', 'text=/batch/i'],
    ['/dashboard/settings', 'text=/setting|profile|account/i'],
    ['/dashboard/evaluation-settings', 'text=/evaluation|filter|adjustment|rule/i'],
  ]
  for (const [route, sel] of routes) {
    try {
      await page.goto(`${BASE}${route}`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector(sel, { timeout: 20000 })
      console.log(`PASS ${route}`)
    } catch (e) {
      console.log(`FAIL ${route} — ${e.message.split('\n')[0]}`)
      failed = true
    }
  }
} finally {
  await browser.close()
}
console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS')
process.exit(failed ? 1 : 0)
