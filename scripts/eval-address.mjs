#!/usr/bin/env node
/**
 * Run one address through the local API and print a short card.
 *
 *   npm run eval -- "2184 Dunseath Ave NW, Atlanta, GA 30318"
 *   npm run eval -- "addr one" "addr two"        # several, one after another
 *   npm run eval -- --job job_123...             # re-print a finished run
 *
 * Read-only against the harness: it starts a normal evaluation and prints
 * what came back. Full results are saved under .data/evals/.
 * Needs the local API (wrangler dev) and the local test login.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const API = process.env.EVAL_API_URL ?? 'http://localhost:8790'
const vars = Object.fromEntries(readFileSync('apps/api/.dev.vars', 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')] }))
const login = JSON.parse(readFileSync('.data/local-candidate/login.json', 'utf8'))

const signIn = await fetch(`${API}/auth/sign-in/email`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
  body: JSON.stringify({ email: login.email, password: login.password }),
})
const userId = (await signIn.json().catch(() => null))?.user?.id
if (!userId) { console.error(`Sign-in failed (${signIn.status}). Is the local API running on ${API}?`); process.exit(1) }
const headers = { 'Content-Type': 'application/json', 'X-Dashboard-User-Id': userId, 'X-Dashboard-Secret': vars.DASHBOARD_INTERNAL_SECRET }

const usd = (n) => (n == null ? '-' : `$${Math.round(n).toLocaleString('en-US')}`)
const DONE = ['complete', 'completed', 'failed', 'error']

async function fetchJob(jobId) {
  return (await (await fetch(`${API}/v1/analyze/jobs/${jobId}`, { headers })).json())?.data
}

async function run(address) {
  const t0 = Date.now()
  const queued = await (await fetch(`${API}/v1/analyze`, { method: 'POST', headers, body: JSON.stringify({ address, skipCache: true }) })).json()
  const jobId = queued?.data?.jobId
  if (!jobId) throw new Error(`could not start: ${JSON.stringify(queued).slice(0, 200)}`)
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500))
    const job = await fetchJob(jobId)
    if (DONE.includes(job?.status)) return { job, jobId, seconds: Math.round((Date.now() - t0) / 1000) }
    if (Date.now() - t0 > 300_000) throw new Error(`timed out after 300s (job ${jobId})`)
  }
}

function card({ job, jobId, seconds }, label) {
  const r = job?.result ?? {}
  const v = r.valuation ?? {}, c = r.comps ?? {}, s = r.subject ?? {}
  const items = c.items ?? []
  const ladder = c.retrieval?.paramFlex
  const classOf = (x) => ({ after_renovation: 'ARV', as_is: 'Investor' })[x.classification?.type] ?? 'Median'
  const count = (k) => items.filter((x) => classOf(x) === k).length
  const line = '─'.repeat(78)
  console.log(`\n${line}\n${label}\n${line}`)
  if (job?.status !== 'complete' && job?.status !== 'completed') {
    console.log(`Status: ${job?.status}   ${job?.error ?? ''}`); return
  }
  console.log(`Time ${seconds != null ? seconds + 's' : '-'}   Job ${jobId}   Harness ${v.bMechanics?.harnessVersion ?? '-'}`)
  console.log(`Subject  ${s.squareFeet ?? '-'} sf · built ${s.yearBuilt ?? '-'} · tract ${s.censusTract ?? '-'} · AVM ${usd(s.avm?.value ?? s.avmValue)} · list ${usd(s.listPrice)}`)
  console.log(`\nARV ${usd(v.arv)}   Buy ${usd(v.buyPrice)}   Rehab ${usd(v.rehabCost)}   Profit ${usd(v.projectedProfit)}`)
  console.log(`Grade ${v.resultGrade ?? '-'} / ${v.processGrade ?? '-'}   ${v.statusReason ?? ''}`)
  console.log(`Anchor ${v.bMechanics?.anchorAddress ?? '-'}   Source ${v.bMechanics?.source ?? '-'}`)
  if (ladder) {
    const l = ladder.limits ?? {}
    console.log(`\nLadder  step ${ladder.extensions} · area ${ladder.scope ?? '-'} · ARV comp found ${ladder.arvEvidenceFound ? 'yes' : 'NO'}`)
    console.log(`        limits  ±${Math.round(l.sqft ?? 0)} sf · ±${Math.round(l.year ?? 0)} yrs · ${Math.round(l.saleAge ?? 0)} days`)
  }
  console.log(`\nPool ${items.length} sales   ARV ${count('ARV')} · Median ${count('Median')} · Investor ${count('Investor')}   passing rules ${items.filter((x) => x.isEnabled).length}`)
  const shown = items.filter((x) => x.isEnabled || classOf(x) === 'ARV')
    .sort((a, b) => (b.isEnabled ? 1 : 0) - (a.isEnabled ? 1 : 0) || (b.salePrice ?? 0) - (a.salePrice ?? 0)).slice(0, 12)
  if (shown.length) console.log(`\n  ${'use'.padEnd(4)}${'role'.padEnd(9)}${'class'.padEnd(9)}${'cond'.padEnd(11)}${'price'.padStart(10)}  ${'sf'.padStart(5)}  ${'yr'.padStart(4)}  ${'sold'.padEnd(10)}  ${'$/sf'.padStart(5)}  address`)
  for (const x of shown) {
    const ppsf = x.salePrice && x.squareFeet ? Math.round(x.salePrice / x.squareFeet) : null
    console.log(`  ${(x.isEnabled ? 'yes' : 'no').padEnd(4)}${String(x.bRole ?? '-').padEnd(9)}${classOf(x).padEnd(9)}${String(x.badges?.condition ?? '-').padEnd(11)}${usd(x.salePrice).padStart(10)}  ${String(x.squareFeet ?? '-').padStart(5)}  ${String(x.yearBuilt ?? '-').padStart(4)}  ${String(x.saleDate ?? '-').slice(0, 10).padEnd(10)}  ${String(ppsf ?? '-').padStart(5)}  ${(x.address ?? '').slice(0, 34)}`)
  }
  const flags = (v.bMechanics?.flags ?? []).filter((f) => /anchored|ceiling|outlier|capped|bracketing|uplift|withheld|self-heal/.test(f))
  if (flags.length) { console.log('\nNotes'); for (const f of flags.slice(0, 6)) console.log(`  · ${f.slice(0, 150)}`) }
  const trail = v.bMechanics?.attemptTrail ?? []
  if (trail.length > 1) console.log(`Trail  ${trail.join('  →  ').slice(0, 220)}`)
}

const args = process.argv.slice(2)
if (!args.length) { console.error('Usage: npm run eval -- "<address>" ["<address>" ...]   |   npm run eval -- --job <jobId>'); process.exit(1) }
mkdirSync('.data/evals', { recursive: true })
if (args[0] === '--job') {
  const job = await fetchJob(args[1])
  card({ job, jobId: args[1], seconds: null }, `Job ${args[1]}`)
} else {
  for (const address of args) {
    try {
      const out = await run(address)
      const slug = address.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
      writeFileSync(`.data/evals/${slug}.json`, JSON.stringify(out.job, null, 1))
      card(out, address)
      console.log(`\nSaved .data/evals/${slug}.json`)
    } catch (e) {
      console.log(`\n${address}\n  FAILED: ${e.message}`)
    }
  }
}
