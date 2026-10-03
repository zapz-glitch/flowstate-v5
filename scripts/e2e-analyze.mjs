import { chromium } from 'playwright'

const ADDR = '2334 Landing Way, Palm Harbor, FL 34684'
const CREDS = { email: 'local@flowstate.test', password: 'V4-Test-7mQ9-rP2x!' }

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1246/chrome-linux64/chrome',
})
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await ctx.newPage()
page.on('console', m => { if (m.type() === 'error') console.log('[console]', m.text().slice(0, 160)) })

// Sign in via the API through the page's own fetch — cookies land correctly.
await page.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' })
const login = await page.evaluate(async (creds) => {
  const r = await fetch('http://localhost:8787/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(creds),
  })
  return { status: r.status, body: await r.text().then(t => t.slice(0, 200)) }
}, CREDS)
console.log('login:', login.status)
const cookies = await ctx.cookies()
console.log('cookies:', cookies.map(c => c.name).join(', '))

await page.goto('http://localhost:3000/dashboard/analyze', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(3000)
const url = page.url()
console.log('landed:', url)
if (!url.includes('/dashboard')) {
  console.log('NOT AUTHED')
  await page.screenshot({ path: '/tmp/e2e-notauth.png' })
  await browser.close()
  process.exit(1)
}
await page.screenshot({ path: '/tmp/e2e-1-page.png' })

// Dismiss any modal/backdrop that opened on load
await page.keyboard.press('Escape').catch(() => {})
await page.locator('div[data-state="open"].bg-black\\/80').waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {})
await page.keyboard.press('Escape').catch(() => {})

// Expand the collapsed search bar if a report is already loaded
const expander = page.locator('button:has(svg.lucide-chevron-down)').first()
const input = page.locator('input[placeholder*="Main St"], input[placeholder*="address" i]').first()
if (!(await input.isVisible().catch(() => false))) {
  if (await expander.count()) await expander.click().catch(() => {})
  await page.waitForTimeout(800)
  // fallback: click the collapsed address bar itself
  if (!(await input.isVisible().catch(() => false))) {
    await page.locator('text=Landing Way').first().click().catch(() => {})
    await page.waitForTimeout(800)
  }
}
await input.waitFor({ timeout: 15000 })
await input.fill(ADDR)
await page.waitForTimeout(1500)
await page.screenshot({ path: '/tmp/e2e-2-typed.png' })
// pick the first autocomplete suggestion, then Run
const suggestion = page.locator('button:has-text("LANDING WAY"), li:has-text("LANDING WAY"), div[role="option"]:has-text("LANDING WAY")').first()
if (await suggestion.count()) { await suggestion.click(); await page.waitForTimeout(800) }
const runBtn = page.locator('button:has-text("Run")').first()
if (await runBtn.count() && await runBtn.isVisible().catch(() => false)) await runBtn.click()
else await input.press('Enter')

try {
  await page.waitForSelector('text=ARV', { timeout: 150000 })
  await page.waitForTimeout(3000)
  const body = await page.textContent('body')
  const arv = body.match(/ARV[\s\S]{0,80}?\$[\d,]+/)?.[0]?.replace(/\s+/g, ' ')
  console.log('ARV render:', arv ?? 'text found, value not parsed')
  await page.screenshot({ path: '/tmp/e2e-3-result.png' })
  console.log('DONE — valuation rendered')
} catch (e) {
  console.log('TIMEOUT waiting for ARV')
  await page.screenshot({ path: '/tmp/e2e-timeout.png' })
  const t = await page.textContent('body')
  console.log(t.slice(0, 500))
}
await browser.close()
