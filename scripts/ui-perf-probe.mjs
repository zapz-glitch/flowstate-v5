// Probe: inspect comp-card DOM structure on a restored report.
import { createRequire } from 'module'
import { existsSync } from 'fs'
import { join } from 'path'
import { readdirSync } from 'fs'

const require = createRequire('/home/lucke/src/flowstate-v3/apps/web/package.json')
const { chromium } = require('playwright-core')

const dir = `${process.env.HOME}/.cache/ms-playwright`
const bin = join(dir, 'chromium_headless_shell-1243', 'chrome-headless-shell-linux64', 'chrome-headless-shell')

const browser = await chromium.launch({ headless: true, executablePath: bin, args: ['--disable-dev-shm-usage'] })
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await ctx.newPage()

await page.goto('http://localhost:3005/?signin=true')
await page.fill('#signin-email', 'local@flowstate.test')
await page.fill('#signin-password', 'V4-Test-7mQ9-rP2x!')
await page.click('button[type="submit"]:has-text("Sign In")')
await page.waitForURL('**/dashboard**', { timeout: 20000 })
await page.goto('http://localhost:3005/dashboard/analyze')
await page.waitForSelector('[data-card-key]', { timeout: 120000 })
await new Promise((r) => setTimeout(r, 2000))

const info = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('[data-card-key]')]
  const first = cards[0]
  return {
    total: cards.length,
    gridContainers: document.querySelectorAll('.comps-grid').length,
    firstTag: first?.tagName,
    firstClass: first?.className?.slice(0, 160),
    cursorPointers: first?.querySelectorAll('.cursor-pointer').length,
    pinButtons: document.querySelectorAll('button[title^="Pin as"]').length,
    expandedSections: document.querySelectorAll('[data-card-key] .pb-4.pt-2').length,
    layoutBtns: [...document.querySelectorAll('button[title]')].map((b) => b.title).filter((t) => t.includes('view')),
  }
})
console.log(JSON.stringify(info, null, 2))

// Switch to list and re-inspect
await page.locator('button[title="List view"]').dispatchEvent('click')
await page.waitForFunction(() => document.querySelectorAll('.comps-grid').length === 0, null, { timeout: 8000 })
await new Promise((r) => setTimeout(r, 500))
const info2 = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('[data-card-key]')]
  const first = cards[0]
  return {
    total: cards.length,
    firstClass: first?.className?.slice(0, 200),
    cursorPointers: first?.querySelectorAll('.cursor-pointer').length,
    firstInnerDivClasses: [...(first?.querySelectorAll('div') || [])].slice(0, 6).map((d) => d.className.slice(0, 80)),
  }
})
console.log('--- after list toggle ---')
console.log(JSON.stringify(info2, null, 2))
await browser.close()
