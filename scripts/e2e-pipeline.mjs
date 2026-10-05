#!/usr/bin/env node
/**
 * e2e-pipeline.mjs — run a real address through the localhost analyze
 * pipeline and assert the hardened Set-B mechanics. Produces a verifiable
 * artifact at .data/e2e/<slug>.json.
 *
 *   node scripts/e2e-pipeline.mjs "4234 Long Branch Ct NE, Brookhaven, GA 30319"
 *   node scripts/e2e-pipeline.mjs --job <existingJobId>
 *
 * Env: API_URL (default http://localhost:8787), FS_API_KEY (required).
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const API = process.env.API_URL ?? 'http://localhost:8787'
const KEY = process.env.FS_API_KEY ?? 'fs_35fd82dfcc3849c37a4e42347ee79bf0350503117d46cc8d'
const args = process.argv.slice(2)
const jobArg = args.indexOf('--job')
const existingJob = jobArg >= 0 ? args[jobArg + 1] : null
const ADDRESS = existingJob ? null : args[0]

if (!ADDRESS && !existingJob) {
  console.error('usage: e2e-pipeline.mjs "<address>" | --job <jobId>')
  process.exit(1)
}

const auth = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

let jobId = existingJob
if (!jobId) {
  const resp = await fetch(`${API}/v1/analyze`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ address: ADDRESS, skipCache: true }),
  })
  const data = await resp.json()
  jobId = data?.data?.jobId
  if (!jobId) { console.error('no jobId', JSON.stringify(data).slice(0, 300)); process.exit(1) }
  console.log(`job: ${jobId}`)
}
for (let i = 0; i < 90; i++) {
  const j = await fetch(`${API}/v1/analyze/jobs/${jobId}`, { headers: auth }).then((r) => r.json())
  const s = j?.data?.status
  if (s === 'complete' || s === 'error') { var job = j; break }
  await new Promise((r) => setTimeout(r, 5000))
}
if (!job?.data?.result) { console.error('job did not complete', JSON.stringify(job).slice(0, 300)); process.exit(1) }
const r = job.data.result
const v = r.valuation ?? {}
const m = v.bMechanics ?? {}
const comps = (r.comps ?? {}).items ?? []
const flags = r.riskFlags ?? []

console.log(`\nsubject: ${r.subject?.address} | ${r.subject?.squareFeet}sf | AVM $${r.subject?.avm?.value}`)
console.log(`ARV: $${v.arv} | source: ${m.source} | anchor: ${m.anchorAddress} | conf: ${m.confidence}\n`)

check('ARV produced', v.arv != null && v.arv > 0, `$${v.arv}`)
check('B mechanics serialized', m.source != null && (m.source !== 'T0 anchor' || m.anchorAddress != null), m.source)
check('attempt trail recorded', Array.isArray(m.attemptTrail) && m.attemptTrail.length >= 1, (m.attemptTrail ?? []).join(' | '))

const ids = comps.map((c) => c.id)
check('no duplicate comp ids', new Set(ids).size === ids.length, `${ids.length} comps / ${new Set(ids).size} unique`)

const drivers = m.drivers ?? []
const distressedDrivers = drivers.filter((d) => d.conditionTier === 'distressed' || d.tier === 'as_is')
check('no distressed/as-is drivers', distressedDrivers.length === 0, `${drivers.length} drivers`)

const verifiedOrNone = comps.filter((c) => c.evidenceVerification == null)
check('verification stamps present', verifiedOrNone.length <= Math.ceil(comps.length * 0.1), `${comps.length - verifiedOrNone.length}/${comps.length} stamped`)

if (v.arv != null && r.subject?.avm?.value != null) {
  const ratio = v.arv / r.subject.avm.value
  check('ARV within sane band vs AVM', ratio >= 0.5 && ratio <= 2.5, `${(ratio * 100 - 100).toFixed(0)}% ${ratio >= 1 ? 'above' : 'below'} AVM`)
  if (v.arv < r.subject.avm.value) {
    check('below-AVM underwriter flag', flags.some((f) => /below the .*as-is estimate/i.test(f)))
  }
}

const slug = (ADDRESS ?? jobId).replace(/[^a-z0-9]+/gi, '-').slice(0, 60)
mkdirSync('.data/e2e', { recursive: true })
const artifact = {
  address: ADDRESS, jobId, ranAt: new Date().toISOString(),
  arv: v.arv, avm: r.subject?.avm?.value, source: m.source, confidence: m.confidence,
  anchor: m.anchorAddress, drivers: drivers.map((d) => ({ address: d.address, contribution: d.contribution, tier: d.tier, conditionTier: d.conditionTier })),
  attemptTrail: m.attemptTrail, riskFlags: flags, checks: results,
}
writeFileSync(join('.data/e2e', `${slug}.json`), JSON.stringify(artifact, null, 2))
const failed = results.filter((c) => !c.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed → .data/e2e/${slug}.json`)
process.exit(failed.length ? 1 : 0)
