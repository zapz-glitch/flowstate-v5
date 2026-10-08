#!/usr/bin/env node
/**
 * Local harness smoke test — proves the proto eval pipeline is operational
 * on this machine, not just installed. Run against a live `npm run dev`
 * stack (wrangler dev on :8787):
 *
 *   node scripts/harness-smoke.mjs "1327 Georgia Ave, Dunedin, FL 34698"
 *
 * Env: API_URL (default http://localhost:8787), API_KEY (required — the
 * local dev key). Exits non-zero on the first failed assertion so the
 * failing stage is the one to debug.
 *
 * What it verifies, in order:
 *   1. Probe — /dev/observable-probe returns real Decisions answers
 *      (fails fast when the observable lane is dark: no/mismatched
 *      OPENAI_API_KEY in apps/api/.dev.vars, or stale wrangler).
 *   2. Eval — POST /v1/analyze (harness=agent) completes for a real address.
 *   3. Trace — harness.trace carries appraiser finalDecision + the
 *      observables block (subject + per-comp answers + marketBenchmark).
 *   4. Marks — exactly the picked comps carry compGroup='arv' and each pick
 *      has a bRole (anchor/driver/pool/excluded) from Set-B.
 */

const API_URL = process.env.API_URL ?? 'http://localhost:8787'
const API_KEY = process.env.API_KEY ?? 'fs_devinspecabtest1234567890abcdef'
const ADDRESS = process.argv[2] ?? '1327 Georgia Ave, Dunedin, FL 34698'

let stage = 'startup'
const fail = (msg) => { console.error(`FAIL [${stage}]: ${msg}`); process.exit(1) }
const ok = (msg) => console.log(`  ok [${stage}] ${msg}`)

async function j(path, opts = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

// ── 1. Observable-lane probe ─────────────────────────────────────────────
stage = 'probe'
{
  const { status, body } = await j('/dev/observable-probe', { method: 'POST', body: '{}' })
  if (status === 404) fail('probe route missing — ENVIRONMENT=development not set in apps/api/.dev.vars?')
  if (status !== 200) fail(`probe status ${status}`)
  const comp = body?.comp ?? {}
  const subject = body?.subject ?? {}
  if (comp.compError || subject.subjectError) {
    fail(`lane errored — comp: ${comp.compError ?? 'ok'}, subject: ${subject.subjectError ?? 'ok'} (check OPENAI_API_KEY is a direct sk- key, not sk-or-)`)
  }
  if (!comp.priceSupport || comp.codePosition == null) fail('probe returned no answers — observable lane dark (OPENAI_API_KEY missing or wrangler stale)')
  if (!body?.benchmark?.scope) fail('probe benchmark missing — pocket percentile math not running')
  console.log('probe: lane live —', JSON.stringify({ benchmark: body.benchmark.scope, compTier: comp.codePosition, premium: comp.premiumAttributes }))
}

// ── 2. Fire a real eval ──────────────────────────────────────────────────
stage = 'eval dispatch'
{
  const { status, body } = await j('/v1/analyze', {
    method: 'POST',
    body: JSON.stringify({ address: ADDRESS, harness: 'agent' }),
  })
  if (status !== 200 || !body?.data?.jobId) fail(`analyze dispatch failed: ${status} ${JSON.stringify(body).slice(0, 200)}`)
  globalThis.__jobId = body.data.jobId
  console.log(`dispatched ${__jobId}`)
}

// ── 3. Poll to terminal state ────────────────────────────────────────────
stage = 'eval poll'
let result = null
{
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    const { body } = await j(`/v1/analyze/jobs/${__jobId}`)
    const st = body?.data?.status
    if (st === 'error') fail(`job errored: ${body.data.error}`)
    if (st === 'complete' || body?.data?.result) { result = body.data.result; break }
    await new Promise((r) => setTimeout(r, 5000))
  }
  if (!result) fail('job did not complete within 4m')
  console.log(`complete — ARV ${result?.valuation?.arv ?? '?'}, wholesale ${result?.valuation?.wholesalePrice ?? '?'}`)
}

// ── 4. Harness trace shape ───────────────────────────────────────────────
stage = 'trace'
{
  const h = result.harness
  if (h?.source !== 'agent') fail(`harness.source=${h?.source} — agent harness did not run`)
  const tr = h.trace ?? {}
  const decision = tr.gate?.finalDecision ?? tr.appraiser?.finalDecision
  if (!decision) fail('trace.gate.finalDecision missing — gate never graded')
  ok(`gate finalDecision=${decision}, model=${tr.opus?.model ?? tr.gate?.model ?? '?'}`)
  const obs = tr.observables
  if (!obs) fail('trace.observables missing — lane ran but results were not persisted')
  const nComps = Object.keys(obs.comps ?? {}).length
  if (nComps === 0) fail('trace.observables.comps empty — comp lane produced no answers')
  if (!obs.marketBenchmark?.scope) fail('trace.observables.marketBenchmark missing')
  ok(`observables persisted — ${nComps} comps, benchmark ${obs.marketBenchmark.scope} n=${obs.marketBenchmark.n}`)
}

// ── 5. Selection marks ───────────────────────────────────────────────────
stage = 'selection marks'
{
  const items = result.comps?.items ?? []
  const arvMarked = items.filter((c) => c.compGroup === 'arv')
  if (arvMarked.length === 0) fail('no compGroup=arv marks — selection never stamped onto the report')
  for (const c of arvMarked) {
    if (!['anchor', 'driver', 'pool', 'excluded'].includes(c.bRole ?? '')) {
      fail(`picked comp ${c.id} has no bRole — Set-B verification did not stamp it`)
    }
  }
  const enabled = items.filter((c) => c.isEnabled !== false)
  ok(`${arvMarked.length} arv-marked picks (${arvMarked.filter((c) => c.bRole !== 'excluded').length} used) out of ${enabled.length} enabled / ${items.length} pool`)
}

console.log(`\nHARNESS SMOKE PASS — ${ADDRESS}`)
console.log(`  ARV ${result.valuation?.arv} | wholesale ${result.valuation?.wholesalePrice} | conf ${result.valuation?.confidence} | rec ${result.valuation?.recommendation}`)
