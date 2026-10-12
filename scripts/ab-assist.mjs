#!/usr/bin/env node
/**
 * Assist-model A/B test.
 *
 *   node scripts/ab-assist.mjs "addr one" "addr two" ...
 *   node scripts/ab-assist.mjs --file addresses.txt
 *
 * Runs every address twice through the local API on the `agent` harness
 * (the appraiser model selects comps, the gate verifies):
 *
 *   arm A — assist model claude-haiku-5-5
 *   arm B — assist model deepseek/deepseek-v4.1-flash (OpenRouter)
 *
 * The assist model is the backup reader behind the decision model and the
 * reasoning sub-agent the appraiser may consult. Everything else is the
 * same in both arms. Arm B replays arm A's call log, so identical calls
 * (provider data, listing pages, decision-model reads) are answered from
 * arm A's responses — the two arms judge the same evidence.
 *
 * Prints one comparison row per address and saves the full results and
 * both call-log summaries under .data/ab-assist/. Read-only against the
 * harness. Needs the local API (wrangler dev) and the local test login.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const API = process.env.EVAL_API_URL ?? 'http://localhost:8787'
const args = process.argv.slice(2)
const fileAt = args.indexOf('--file')
const addresses = fileAt >= 0
  ? readFileSync(args[fileAt + 1], 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  : args.filter((a) => !a.startsWith('--'))
if (!addresses.length) { console.error('Usage: node scripts/ab-assist.mjs "<address>" ... | --file <list.txt>'); process.exit(1) }

const vars = Object.fromEntries(readFileSync('apps/api/.dev.vars', 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')] }))
const login = JSON.parse(readFileSync('.data/local-candidate/login.json', 'utf8'))
const signIn = await fetch(`${API}/auth/sign-in/email`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: vars.DASHBOARD_URL ?? 'http://localhost:3000' },
  body: JSON.stringify({ email: login.email, password: login.password }),
})
const userId = (await signIn.json().catch(() => null))?.user?.id
if (!userId) { console.error(`Sign-in failed (${signIn.status}). Is the local API running on ${API}?`); process.exit(1) }
const headers = { 'Content-Type': 'application/json', 'X-Dashboard-User-Id': userId, 'X-Dashboard-Secret': vars.DASHBOARD_INTERNAL_SECRET }

const DONE = ['complete', 'completed', 'failed', 'error']
const usd = (n) => (n == null ? '-' : `$${Math.round(n).toLocaleString('en-US')}`)
const get = async (path) => (await (await fetch(`${API}${path}`, { headers })).json().catch(() => null))?.data ?? null

async function run(address, arm, replayCallsFrom) {
  const t0 = Date.now()
  const queued = await (await fetch(`${API}/v1/analyze`, {
    method: 'POST', headers,
    body: JSON.stringify({ address, skipCache: true, harness: 'agent', arm, ...(replayCallsFrom ? { replayCallsFrom } : {}) }),
  })).json()
  const jobId = queued?.data?.jobId
  if (!jobId) return { arm, error: queued?.error ?? 'did not queue' }
  for (let i = 0; i < 400; i++) {
    const job = await get(`/v1/analyze/jobs/${jobId}`)
    if (DONE.includes(job?.status)) {
      // The call log is written just after the run finishes.
      let calls = null
      for (let k = 0; k < 10 && !calls; k++) { calls = await get(`/v1/analyze/jobs/${jobId}/calls?summary=1`); if (!calls) await new Promise((r) => setTimeout(r, 1000)) }
      return { arm, jobId, seconds: Math.round((Date.now() - t0) / 1000), job, calls }
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  return { arm, jobId, error: 'timed out' }
}

/** The fields the comparison rests on, pulled from one finished run. */
function digest(r) {
  if (r.error) return { arm: r.arm, error: r.error }
  const res = r.job?.result ?? {}
  const trace = res.harness?.trace ?? {}
  const v = res.visionAssessment ?? {}
  const attempts = trace.opus?.attempts ?? []
  const clar = trace.opus?.clarifications ?? []
  const comps = Object.values(trace.observables?.comps ?? {})
  return {
    arm: r.arm,
    jobId: r.jobId,
    seconds: r.seconds,
    status: r.job?.status,
    assistModel: trace.abTest?.assistModel ?? null,
    appraiserModel: trace.opus?.model ?? null,
    arv: res.valuation?.arv ?? res.arv ?? null,
    buyPrice: res.valuation?.buyPrice ?? null,
    rehab: res.valuation?.totalRehab ?? res.valuation?.rehabCost ?? null,
    subjectTier: v.renovationLevel ?? null,
    subjectTierBy: v.model ?? null,
    subjectTierConfidence: v.confidence ?? null,
    gate: trace.gate?.finalDecision ?? null,
    attempts: attempts.length,
    selectedCompIds: trace.opus?.selection?.selectedCompIds ?? [],
    drivers: trace.opus?.selection?.drivers ?? [],
    conf: trace.opus?.selection?.conf ?? null,
    decisionsQuestions: clar.filter((c) => c.source !== 'assist').length,
    assistQuestions: clar.filter((c) => c.source === 'assist').length,
    assistFindings: clar.filter((c) => c.source === 'assist').map((c) => ({ compId: c.compId, question: c.question, answer: c.answer, confidence: c.confidence })),
    compsRead: comps.length,
    compsWithTier: comps.filter((c) => c.conditionTier && c.conditionTier !== 'UNVERIFIED').length,
    // The arm model's own selection on the same evidence — recorded, not applied.
    shadow: trace.abTest?.shadowSelection
      ? {
          model: trace.abTest.shadowSelection.model,
          seconds: Math.round(trace.abTest.shadowSelection.durationMs / 100) / 10,
          accepted: trace.abTest.shadowSelection.gate?.accepted ?? null,
          score: trace.abTest.shadowSelection.gate?.score ?? null,
          gateFails: trace.abTest.shadowSelection.gate?.gateFails ?? [],
          failures: trace.abTest.shadowSelection.gate?.failures ?? [],
          arv: trace.abTest.shadowSelection.selection?.arv ?? null,
          conf: trace.abTest.shadowSelection.selection?.conf ?? null,
          selectedCompIds: trace.abTest.shadowSelection.selection?.selectedCompIds ?? [],
          drivers: trace.abTest.shadowSelection.selection?.drivers ?? [],
          notes: trace.abTest.shadowSelection.selection?.notes ?? null,
          error: trace.abTest.shadowSelection.error ?? null,
        }
      : null,
    appraiserScore: (trace.gate?.attempts ?? []).at(-1)?.score ?? null,
    models: r.calls?.models ?? null,
    calls: r.calls?.summary ?? null,
    callsTotal: r.calls?.calls ?? null,
    replayedFrom: r.calls?.replayedFrom ?? null,
  }
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join()
const overlap = (a, b) => `${a.filter((x) => b.includes(x)).length}/${a.length}`
/** One line on how the arm's own model decided, on the same evidence. */
function shadowLine(d) {
  const s = d.shadow
  if (!s) return '     own selection: not run'
  if (!s.selectedCompIds.length) return `     own selection: ${s.model} gave no usable selection in ${s.seconds}s (${s.error ?? 'unknown'})`
  return `     own selection: ${s.seconds}s  ARV ${usd(s.arv)}  gate ${s.accepted ? 'ACCEPT' : 'REJECT ' + s.gateFails.join(',')}  score ${s.score}  picks ${s.selectedCompIds.length} (${overlap(s.selectedCompIds, d.selectedCompIds)} also picked by appraiser)`
}
const replayed = (d) => Object.values(d.calls ?? {}).reduce((n, k) => n + (k.replayed ?? 0), 0)

mkdirSync('.data/ab-assist', { recursive: true })
const rows = []
for (const address of addresses) {
  console.log(`\n${'─'.repeat(78)}\n${address}\n${'─'.repeat(78)}`)
  const a = digest(await run(address, 'A'))
  console.log(a.error ? `  A  FAILED — ${a.error}` : `  A  ${a.assistModel}  ${a.seconds}s  ARV ${usd(a.arv)}  gate ${a.gate} (${a.attempts} attempt)  picks ${a.selectedCompIds.length}  asked assist ${a.assistQuestions}×  subject ${a.subjectTier} by ${a.subjectTierBy}`)
  if (!a.error) console.log(shadowLine(a))
  const b = a.error ? { arm: 'B', error: 'skipped — arm A failed' } : digest(await run(address, 'B', a.jobId))
  console.log(b.error ? `  B  FAILED — ${b.error}` : `  B  ${b.assistModel}  ${b.seconds}s  ARV ${usd(b.arv)}  gate ${b.gate} (${b.attempts} attempt)  picks ${b.selectedCompIds.length}  asked assist ${b.assistQuestions}×  subject ${b.subjectTier} by ${b.subjectTierBy}  (${replayed(b)}/${b.callsTotal} calls replayed from A)`)
  if (!b.error) console.log(shadowLine(b))
  const row = { address, A: a, B: b }
  if (!a.error && !b.error) {
    row.diff = {
      arvDelta: a.arv != null && b.arv != null ? b.arv - a.arv : null,
      arvDeltaPct: a.arv ? Math.round(((b.arv - a.arv) / a.arv) * 1000) / 10 : null,
      samePicks: sameSet(a.selectedCompIds, b.selectedCompIds),
      sameDrivers: sameSet(a.drivers, b.drivers),
      sameSubjectTier: a.subjectTier === b.subjectTier,
      secondsDelta: b.seconds - a.seconds,
    }
    console.log(`  Δ  ARV ${row.diff.arvDelta == null ? '-' : (row.diff.arvDelta >= 0 ? '+' : '') + usd(row.diff.arvDelta).replace('$-', '-$')} (${row.diff.arvDeltaPct ?? '-'}%)  picks ${row.diff.samePicks ? 'same' : 'DIFFER'}  drivers ${row.diff.sameDrivers ? 'same' : 'DIFFER'}  subject tier ${row.diff.sameSubjectTier ? 'same' : 'DIFFER'}  time ${row.diff.secondsDelta >= 0 ? '+' : ''}${row.diff.secondsDelta}s`)
  }
  rows.push(row)
  writeFileSync(`.data/ab-assist/${address.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.json`, JSON.stringify(row, null, 2))
}

const done = rows.filter((r) => r.diff)
console.log(`\n${'═'.repeat(78)}\nSummary — ${done.length}/${rows.length} addresses completed in both arms`)
if (done.length) {
  const avg = (f) => Math.round(done.reduce((n, r) => n + f(r), 0) / done.length)
  console.log(`  same picks ${done.filter((r) => r.diff.samePicks).length}/${done.length} · same drivers ${done.filter((r) => r.diff.sameDrivers).length}/${done.length} · same subject tier ${done.filter((r) => r.diff.sameSubjectTier).length}/${done.length}`)
  console.log(`  gate accepted   A ${done.filter((r) => r.A.gate === 'accepted').length}/${done.length}   B ${done.filter((r) => r.B.gate === 'accepted').length}/${done.length}`)
  console.log(`  avg time        A ${avg((r) => r.A.seconds)}s   B ${avg((r) => r.B.seconds)}s`)
  console.log(`  assist asked    A ${done.reduce((n, r) => n + r.A.assistQuestions, 0)}×   B ${done.reduce((n, r) => n + r.B.assistQuestions, 0)}×`)
  console.log(`  avg |ARV Δ|     ${avg((r) => Math.abs(r.diff.arvDeltaPct ?? 0) * 10) / 10}%`)
  const own = (arm) => done.map((r) => r[arm].shadow).filter((s) => s && s.selectedCompIds.length)
  for (const arm of ['A', 'B']) {
    const o = own(arm)
    if (!o.length) { console.log(`  own selection ${arm}: none usable`); continue }
    const mean = (f) => Math.round((o.reduce((n, s) => n + f(s), 0) / o.length) * 10) / 10
    console.log(`  own selection ${arm} (${o[0].model}): gate accepted ${o.filter((s) => s.accepted).length}/${o.length} · avg score ${mean((s) => s.score ?? 0)} · avg ${mean((s) => s.seconds)}s · usable ${o.length}/${done.length}`)
  }
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
writeFileSync(`.data/ab-assist/summary-${stamp}.json`, JSON.stringify(rows, null, 2))
console.log(`\nSaved .data/ab-assist/summary-${stamp}.json`)
