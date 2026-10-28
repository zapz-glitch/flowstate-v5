#!/usr/bin/env node
/**
 * Flip backtest — run verified flips through the local harness and score
 * the ARV against the known resale price.
 *
 *   node scripts/flip-backtest.mjs <local D1 .sqlite> [--per-state 10] [--since 2026-01-01]
 *        [--min-price 75000] [--concurrency 3] [--out .data/flip-backtest/run.json]
 *
 * Picks the most recent high-confidence flips per state from verified_flips
 * (fill it with scripts/backfill-verified-flips.mts). Runs with rerun: true —
 * a fresh evaluation on cached provider data, so a repeat inside the 30-day
 * window spends no new ATTOM calls.
 *
 * Caveats a reader must keep: comps are pulled as of today, not as of the
 * resale date (post-sale drivers are counted per run), and the ATTOM AVM
 * already knows the resale.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const args = process.argv.slice(2)
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt }
const dbFile = args[0]
if (!dbFile || dbFile.startsWith('--')) { console.error('usage: flip-backtest.mjs <d1 sqlite> [options]'); process.exit(1) }
const PER_STATE = Number(opt('per-state', 10))
const SINCE = opt('since', '2026-01-01')
const MIN_PRICE = Number(opt('min-price', 75000))
const CONCURRENCY = Number(opt('concurrency', 3))
const OUT = opt('out', `.data/flip-backtest/${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`)
const API = process.env.EVAL_API_URL ?? 'http://localhost:8797'
const RUN_TIMEOUT_MS = 15 * 60_000

const vars = Object.fromEntries(readFileSync('apps/api/.dev.vars', 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')] }))

const db = new DatabaseSync(dbFile, { readOnly: true })
const userId = db.prepare('select u.id from user u join saved_reports s on s.user_id = u.id group by u.id order by count(*) desc limit 1').get()?.id
if (!userId) { console.error('no local user with saved reports'); process.exit(1) }
const headers = { 'Content-Type': 'application/json', 'X-Dashboard-User-Id': userId, 'X-Dashboard-Secret': vars.DASHBOARD_INTERNAL_SECRET }

const flips = db.prepare(`
  select * from (
    select *, row_number() over (partition by state order by sell_date desc) rn
    from verified_flips
    where confidence = 'high' and sell_date >= ? and sell_price >= ?
  ) where rn <= ? order by state, sell_date desc`).all(SINCE, MIN_PRICE, PER_STATE)
console.log(`${flips.length} flips picked (${PER_STATE}/state, high, sold since ${SINCE}, ≥$${MIN_PRICE.toLocaleString()})`)

const streetKey = (a) => String(a ?? '').split(',')[0].toUpperCase().replace(/[^A-Z0-9]/g, '')
const usd = (n) => (n == null ? '-' : `$${Math.round(n).toLocaleString('en-US')}`)
const DONE = ['complete', 'completed', 'failed', 'error']

async function runOne(f) {
  const t0 = Date.now()
  const row = { address: f.address, state: f.state, buy: f.buy_price, buyDate: f.buy_date, sell: f.sell_price, sellDate: f.sell_date, sqft: f.square_feet }
  try {
    const q = await (await fetch(`${API}/v1/analyze`, { method: 'POST', headers, body: JSON.stringify({ address: f.address, rerun: true }) })).json()
    const jobId = q?.data?.jobId ?? q?.jobId
    if (!jobId) return { ...row, status: 'queue-failed', error: (q?.error ?? JSON.stringify(q)).slice(0, 200) }
    row.jobId = jobId
    let d
    for (;;) {
      await new Promise((r) => setTimeout(r, 5000))
      d = (await (await fetch(`${API}/v1/analyze/jobs/${jobId}`, { headers })).json().catch(() => null))?.data
      if (DONE.includes(d?.status)) break
      if (Date.now() - t0 > RUN_TIMEOUT_MS) { d = { ...d, status: 'timeout' }; break }
    }
    const r = d?.result ?? {}
    const v = r.valuation ?? {}
    const m = v.bMechanics ?? {}
    const items = r.comps?.items ?? []
    const byStreet = new Map(items.map((c) => [streetKey(c.address), c]))
    const drivers = (m.drivers ?? []).map((x) => {
      const c = byStreet.get(streetKey(x.address))
      return { address: x.address, contribution: x.contribution, tier: x.tier, salePrice: c?.salePrice ?? null, saleDate: c?.saleDate ?? null, distanceMiles: c?.distanceMiles ?? null }
    })
    const arv = v.arv ?? null
    return {
      ...row,
      status: d?.status,
      error: d?.error ?? null,
      secs: Math.round((Date.now() - t0) / 1000),
      arv,
      errPct: arv && f.sell_price ? Math.round(((arv - f.sell_price) / f.sell_price) * 1000) / 10 : null,
      arvSource: v.arvSource ?? m.source ?? null,
      confidence: v.confidence ?? m.confidence ?? null,
      resultGrade: v.resultGrade ?? null,
      rehabLevel: v.rehabLevel ?? null,
      harnessVersion: m.harnessVersion ?? null,
      anchor: m.anchorAddress ?? null,
      drivers,
      postSaleDrivers: drivers.filter((x) => x.saleDate && x.saleDate > f.sell_date).length,
      selfComp: items.some((c) => streetKey(c.address) === streetKey(f.address)),
      compCount: items.length,
      subjectSite: r.subject?.site ?? null,
      flags: (m.flags ?? []).slice(0, 30),
    }
  } catch (e) {
    return { ...row, status: 'error', error: String(e).slice(0, 200), secs: Math.round((Date.now() - t0) / 1000) }
  }
}

const results = new Array(flips.length)
let next = 0
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, flips.length) }, async () => {
  while (next < flips.length) {
    const i = next++
    results[i] = await runOne(flips[i])
    const x = results[i]
    console.log(`${String(i + 1).padStart(2)}. ${x.address.padEnd(44)} sold ${usd(x.sell).padStart(10)}  ARV ${usd(x.arv).padStart(10)}  ${x.errPct == null ? x.status : `${x.errPct > 0 ? '+' : ''}${x.errPct}%`}  ${x.secs ?? '-'}s`)
  }
}))

const scored = results.filter((x) => x.errPct != null)
const abs = scored.map((x) => Math.abs(x.errPct)).sort((a, b) => a - b)
const median = (a) => (a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null)
const summary = {
  picked: flips.length,
  scored: scored.length,
  failed: results.length - scored.length,
  medianAbsErrPct: median(abs),
  meanErrPct: scored.length ? Math.round((scored.reduce((s, x) => s + x.errPct, 0) / scored.length) * 10) / 10 : null,
  within5: scored.filter((x) => Math.abs(x.errPct) <= 5).length,
  within10: scored.filter((x) => Math.abs(x.errPct) <= 10).length,
  within15: scored.filter((x) => Math.abs(x.errPct) <= 15).length,
  selfCompRuns: results.filter((x) => x.selfComp).length,
  runsWithPostSaleDrivers: results.filter((x) => x.postSaleDrivers > 0).length,
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify({ ranAt: new Date().toISOString(), options: { PER_STATE, SINCE, MIN_PRICE }, summary, results }, null, 1))
console.log(summary)
console.log(`saved ${OUT}`)
