// UI performance harness for the analyze page.
// Drives a real browser through login -> analysis -> comp interactions while a
// MutationObserver counts DOM mutations in 250ms buckets. Produces an artifact
// JSON + screenshots for before/after render-efficiency comparisons.
//
// Usage:
//   node scripts/ui-perf-baseline.mjs --label baseline [--headed]
//
// Requires dashboard on :3005 and API on :8793 (swe-2-eval local pair).

import { createRequire } from 'module'
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'

const require = createRequire('/home/lucke/src/flowstate-v3/apps/web/package.json')
const { chromium } = require('playwright-core')

const BASE = 'http://localhost:3005'
const EMAIL = 'local@flowstate.test'
const PASSWORD = 'V4-Test-7mQ9-rP2x!'
const ADDRESS = '228 Cobblestone Dr, Spring Hill, FL 34606'
const ROOT = '/home/lucke/src/flowstate-v5-swe-2-eval'
const OUT_DIR = join(ROOT, 'e2e', 'artifacts')

const label = process.argv.includes('--label')
  ? process.argv[process.argv.indexOf('--label') + 1]
  : 'run'
const headed = process.argv.includes('--headed')

function findChromium() {
  const dir = `${process.env.HOME}/.cache/ms-playwright`
  const candidates = readdirSync(dir)
    .filter((d) => d.startsWith('chromium'))
    .sort()
    .reverse()
  for (const c of candidates) {
    for (const rel of [
      'chrome-headless-shell-linux64/chrome-headless-shell',
      'chrome-linux64/chrome',
      'chrome-linux/headless_shell',
      'chrome-linux/chrome',
    ]) {
      const p = join(dir, c, rel)
      if (existsSync(p)) return p
    }
  }
  throw new Error(`no chromium binary under ${dir}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function mark(page, name) {
  await page.evaluate((n) => window.__perfMark(n), name)
  console.log(`  mark: ${name}`)
}

async function mutations(page) {
  return page.evaluate(() => ({ ...window.__perf, commits: window.__perfCommits }))
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const browser = await chromium.launch({
    headless: !headed,
    executablePath: findChromium(),
    args: ['--disable-dev-shm-usage'],
  })
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    recordVideo: undefined,
  })
  const consoleErrors = []
  const pageErrors = []

  await context.addInitScript(() => {
    // React commit counter — counts every committed render pass, including
    // no-op re-renders the MutationObserver can't see (the real amplification
    // metric). Must be installed before React DOM loads.
    const commits = { total: 0, buckets: {} }
    const t0c = performance.now()
    const hook = {
      renderers: new Map(),
      supportsFiber: true,
      inject(r) { const id = this.renderers.size + 1; this.renderers.set(id, r); return id },
      onCommitFiberRoot() {
        commits.total++
        const b = Math.floor((performance.now() - t0c) / 250)
        commits.buckets[b] = (commits.buckets[b] || 0) + 1
      },
      onCommitFiberUnmount() {},
      onScheduleFiberRoot() {},
      checkDCE() {},
    }
    Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: hook })
    window.__perfCommits = commits

    window.__perf = { buckets: {}, marks: {}, total: 0, t0: 0 }
    window.__perfMark = (name) => {
      window.__perf.marks[name] = performance.now() - window.__perf.t0
    }
    window.__perf.t0 = performance.now()
    new MutationObserver((list) => {
      window.__perf.total += list.length
      const b = Math.floor((performance.now() - window.__perf.t0) / 250)
      window.__perf.buckets[b] = (window.__perf.buckets[b] || 0) + list.length
    }).observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    })
  })

  const page = await context.newPage()
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300))
  })
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)))

  const result = { label, address: ADDRESS, steps: [], consoleErrors, pageErrors }
  const step = (name, ok, detail) => {
    result.steps.push({ name, ok, detail })
    console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  }

  try {
    // --- Login -------------------------------------------------------------
    await page.goto(`${BASE}/?signin=true`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('#signin-email', { timeout: 15000 })
    await page.fill('#signin-email', EMAIL)
    await page.fill('#signin-password', PASSWORD)
    await page.click('button[type="submit"]:has-text("Sign In")')
    await page.waitForURL('**/dashboard**', { timeout: 20000 })
    step('login', true, page.url())

    // --- Analyze page ------------------------------------------------------
    // ?address= prefills + auto-runs the analysis and skips the report-restore
    // path — deterministic entry, no collapsed-form race. KV must be flushed
    // beforehand for a live eval window.
    await page.goto(`${BASE}/dashboard/analyze?address=${encodeURIComponent(ADDRESS)}`, {
      waitUntil: 'domcontentloaded',
    })
    await mark(page, 'run_click') // auto-run fires on hydration; mark right after nav
    step('analyze page', true)

    // Re-running a known address pops the existing-report dialog — confirm.
    const newAnalysis = page.locator('button:has-text("New Analysis")')
    if (await newAnalysis.waitFor({ timeout: 15000 }).then(() => true).catch(() => false)) {
      await newAnalysis.dispatchEvent('click')
      step('existing-report dialog → New Analysis', true)
    }

    // Wait for the first comp card.
    await page.waitForSelector('[data-card-key]', { timeout: 180000 })
    await mark(page, 'first_card')
    step('comps rendered', true, `${await page.locator('[data-card-key]').count()} cards`)

    // Eval complete: Jev card ("N tested") OR card count >5 and stable 4s.
    // The Jev card is conditional — some runs (e.g. alternate eval outcomes)
    // render comps without it.
    const jevText = page.waitForSelector('text=/\\d+ tested/', { timeout: 180000 }).then(() => 'jev').catch(() => 'jev-timeout')
    const cardStable = (async () => {
      const deadline = Date.now() + 180000
      let last = -1
      let since = Date.now()
      while (Date.now() - since < 4000 && Date.now() < deadline) {
        const c = await page.locator('[data-card-key]').count()
        if (c !== last) { last = c; since = Date.now() }
        await sleep(500)
      }
      return 'stable'
    })()
    const how = await Promise.race([jevText, cardStable]).catch(() => 'timeout')
    await sleep(1500) // trailing SSE updates settle
    await mark(page, 'eval_settled')
    console.log(`  settled via: ${how}`)
    result.compCardCount = await page.locator('[data-card-key]').count()
    step('eval settled', true, `${result.compCardCount} cards`)
    await page.screenshot({ path: join(OUT_DIR, `ui-perf-${label}-results.png`), fullPage: false })

    // Click→paint latency: measures main-thread render cost of an interaction.
    // rAF fires after React's synchronous commit for the state update.
    const clickToPaint = async (locator) => {
      return page.evaluate(async (el) => {
        const t0 = performance.now()
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        return Math.round(performance.now() - t0)
      }, await locator.elementHandle())
    }

    // --- Interaction: pin ARV (grid cards render pin buttons directly) -------
    // Note: [data-card-key] also includes the subject card — filter to cards
    // that actually carry pin buttons.
    const pinBtn = page.locator('[data-card-key]:has(button[title^="Pin as ARV"]) button[title^="Pin as ARV"]').first()
    const pinVisible = await pinBtn.waitFor({ timeout: 8000 }).then(() => true).catch(() => false)
    if (pinVisible) {
      await mark(page, 'pin_click')
      result.latency = result.latency || {}
      result.latency.pinMs = await clickToPaint(pinBtn)
      const badge = await page
        .waitForSelector('text=/·YOU/', { timeout: 10000 })
        .then(() => true)
        .catch(() => false)
      await mark(page, 'pin_done')
      // Wait for the server write to land — the badge is optimistic, and in dev
      // the server action cold-compiles on first hit. tierPending clears the
      // button's disabled state once assignCompTier resolves.
      await page
        .waitForFunction(
          () => ![...document.querySelectorAll('button[title^="Pin as"],button[title^="Clear your pin"]')].some((b) => b.disabled),
          null,
          { timeout: 60000 },
        )
        .catch(() => {})
      await sleep(500)
      step('pin ARV', badge, badge ? '·YOU badge + write settled' : 'badge not found')
    } else {
      step('pin ARV', false, 'no pin buttons found')
    }

    // --- Interaction: list view toggle --------------------------------------
    await mark(page, 'list_view_click')
    result.latency.listViewMs = await clickToPaint(page.locator('button[title="List view"]'))
    await page.waitForFunction(() => document.querySelectorAll('.comps-grid').length === 0, null, { timeout: 8000 })
    await mark(page, 'list_view_done')
    step('list view', true, `${await page.locator('[data-card-key]').count()} list cards`)

    // --- Interaction: expand a comp card (first card carrying a toggle) -----
    await mark(page, 'expand_click')
    const compCard = page.locator('[data-card-key]:has(div.cursor-pointer)').first()
    result.latency.expandMs = await clickToPaint(compCard.locator('div.cursor-pointer').first())
    const expanded = await page
      .waitForSelector('[data-card-key] .pb-4.pt-2', { timeout: 5000 })
      .then(() => true)
      .catch(() => false)
    await mark(page, 'expand_done')
    step('card expand', expanded)

    // --- Interaction: sort change --------------------------------------------
    await mark(page, 'sort_click')
    result.latency.sortMs = await clickToPaint(page.locator('button:text-is("Distance")'))
    await sleep(800)
    await mark(page, 'sort_done')
    const sortApplied = await page
      .locator('button:text-is("Distance").bg-primary\\/15')
      .count()
      .then((c) => c > 0)
    step('sort by distance', sortApplied)

    // --- Reload: pin persistence ---------------------------------------------
    result.perf = await mutations(page) // snapshot pre-reload; init script resets counters
    // Navigate WITHOUT ?address= — that param skips the restore path entirely.
    await page.goto(`${BASE}/dashboard/analyze`, { waitUntil: 'domcontentloaded' })
    await mark(page, 'reload_start')
    await page.waitForSelector('[data-card-key]', { timeout: 180000 })
    await sleep(3000)
    await mark(page, 'reload_settled')
    const persisted = await page.locator('text=/·YOU/').count()
    step('pin persisted after reload', persisted > 0, `${persisted} badges`)
    await page.screenshot({ path: join(OUT_DIR, `ui-perf-${label}-restored.png`) })
    result.perfAfterReload = await mutations(page)
  } catch (err) {
    step('harness', false, String(err).slice(0, 400))
    result.error = String(err)
    try {
      await page.screenshot({ path: join(OUT_DIR, `ui-perf-${label}-error.png`) })
      result.perf = await mutations(page)
    } catch {}
  }

  await browser.close()

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(OUT_DIR, `ui-perf-${label}-${ts}.json`)
  writeFileSync(file, JSON.stringify(result, null, 2))
  console.log(`\nartifact: ${file}`)

  // Summarize mutation windows between marks.
  if (result.perf?.marks) {
    const m = result.perf.marks
    const inWindow = (a, b) => {
      // Round outward so sub-250ms windows still capture their bucket.
      const lo = Math.floor((m[a] ?? 0) / 250) * 250
      const hi = m[b] != null ? Math.ceil(m[b] / 250) * 250 : Infinity
      let sum = 0
      for (const [k, v] of Object.entries(result.perf.buckets)) {
        const t = Number(k) * 250
        if (t >= lo && t < hi) sum += v
      }
      return sum
    }
    const inCommitsWindow = (a, b) => {
      const lo = Math.floor((m[a] ?? 0) / 250) * 250
      const hi = m[b] != null ? Math.ceil(m[b] / 250) * 250 : Infinity
      let sum = 0
      for (const [k, v] of Object.entries(result.perf.commits?.buckets ?? {})) {
        const t = Number(k) * 250
        if (t >= lo && t < hi) sum += v
      }
      return sum
    }
    console.log(`mutations: total=${result.perf.total} | react commits: ${result.perf.commits?.total ?? 'n/a'}`)
    for (const [a, b, name] of [
      ['run_click', 'eval_settled', 'eval window'],
      ['list_view_click', 'list_view_done', 'list-view toggle'],
      ['expand_click', 'expand_done', 'card expand'],
      ['pin_click', 'pin_done', 'pin ARV'],
      ['sort_click', 'sort_done', 'sort'],
      ['reload_start', 'reload_settled', 'reload settle'],
    ]) {
      if (m[a] != null) console.log(`  ${name}: ${inWindow(a, b)} mut / ${inCommitsWindow(a, b)} commits`)
    }
    if (result.latency) console.log(`latency (click→paint): ${JSON.stringify(result.latency)}`)
  }

  const failed = result.steps.filter((s) => !s.ok)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
