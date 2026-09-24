#!/usr/bin/env node
/**
 * E2E: fire a real address at a running API and validate the report.
 *
 *   node scripts/e2e-analyze.mjs "4014 22nd Ave N, St Petersburg, FL 33713"
 *   node scripts/e2e-analyze.mjs <address> --api http://localhost:8788 --skip-cache
 *
 * Auth: dashboard-internal headers. Secret resolves from
 * DASHBOARD_INTERNAL_SECRET env or apps/dashboard/.env.local. User id from
 * E2E_USER_ID (defaults to the staging user).
 *
 * Artifact: writes e2e/artifacts/<timestamp>-<slug>.json — the full report
 * plus every assertion's pass/fail, so a run is verifiable after the fact.
 * Exit code 0 = all assertions passed, 1 = any failure.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ── args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
const address = args.find((a) => !a.startsWith('--'))
const API = flag('--api') ?? process.env.E2E_API_URL ?? 'http://localhost:8788'
const SKIP_CACHE = args.includes('--skip-cache')
const TIMEOUT_MS = Number(flag('--timeout') ?? 300_000)
const USER_ID = flag('--user') ?? process.env.E2E_USER_ID ?? 'V7yMtWoR4tAHQo1b9D71Nb9KEb90bdXP' // staging@flowstate.test

if (!address) {
  console.error('usage: node scripts/e2e-analyze.mjs "<full address>" [--api url] [--skip-cache] [--timeout ms]')
  process.exit(2)
}

function readEnvFile(path) {
  if (!existsSync(path)) return {}
  return Object.fromEntries(
    readFileSync(path, 'utf8').split('\n')
      .map((l) => l.match(/^([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?/))
      .filter(Boolean).map((m) => [m[1], m[2]])
  )
}
const SECRET = process.env.DASHBOARD_INTERNAL_SECRET
  ?? readEnvFile(resolve(root, 'apps/dashboard/.env.local')).DASHBOARD_INTERNAL_SECRET
if (!SECRET) { console.error('No DASHBOARD_INTERNAL_SECRET in env or apps/dashboard/.env.local'); process.exit(2) }

const headers = {
  'Content-Type': 'application/json',
  'X-Dashboard-User-Id': USER_ID,
  'X-Dashboard-Secret': SECRET,
}

// ── assertions ──────────────────────────────────────────────────────────────
const assertions = []
const check = (name, pass, detail = '') => {
  assertions.push({ name, pass: !!pass, detail: String(detail) })
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function validate(result) {
  const comps = result?.comps?.items ?? result?.comparables ?? []
  check('report returned', result != null)
  check('comparables present', comps.length > 0, `${comps.length} comps`)

  const arv = result?.valuation?.arv ?? result?.arv?.value ?? result?.arv
  check('ARV is a positive number', typeof arv === 'number' && arv > 0, `arv=${arv}`)

  const jev = result?.jevHybrid
  check('Jev evaluation ran', jev?.status === 'completed' || jev?.counts != null, `status=${jev?.status}`)

  const c = jev?.counts
  if (c) {
    check('count consistency', (c.test1Passed ?? 0) + (c.test1Failed ?? 0) + (c.ineligible ?? 0) === c.pool,
      `pool=${c.pool} t1+=${c.test1Passed} t1-=${c.test1Failed} inelig=${c.ineligible}`)
  }

  const selected = comps.filter((x) => x.isEnabled === true || x.arvStatus === 'selected')
  check('selected comps exist', selected.length > 0, `${selected.length} selected`)

  // Jev's ARV set — comps the funnel marked selected:'core' (ARV-tier
  // test-2 passers). In a human-handoff run this set is empty by design;
  // whatever the rules engine enabled is reference, not Jev's ARV.
  const jevSelected = comps.filter((x) => x.jevHybrid?.selected === 'core')

  // Spec invariants for the swe-2-eval funnel:
  //   · nothing in the ARV set may have failed test 1 or test 2 (no fill)
  //   · every ARV comp is a priceTier 'arv' test-2 passer
  //   · zero test-2 passers → humanHandoff flag on the report
  const failedT1 = jevSelected.filter((x) => (x.jevHybrid?.test1?.failedFields?.length ?? 0) > 0)
  check('no test-1 failure feeds ARV', failedT1.length === 0,
    failedT1.length ? `${failedT1.length} ARV comp(s) failed test 1` : 'clean')

  const failedT2 = jevSelected.filter((x) => x.jevHybrid?.test2?.passed !== true)
  check('no test-2 failure feeds ARV (no fill)', failedT2.length === 0,
    failedT2.length ? `${failedT2.length} ARV comp(s) failed test 2` : 'clean')

  const wrongTier = jevSelected.filter((x) => x.jevHybrid?.priceTier !== 'arv')
  check('every ARV comp is in the arv price tier', wrongTier.length === 0,
    wrongTier.length ? `${wrongTier.length} ARV comp(s) missing arv tier` : 'clean')

  // ── Test-1 score: passers carry a 90–100 proximity score ──────────────────
  const t1Passers = comps.filter((x) => x.jevHybrid?.test1?.passed === true)
  const badT1 = t1Passers.filter((x) => {
    const s = x.jevHybrid.test1.score
    return typeof s !== 'number' || s < 90 || s > 100
  })
  check('test-1 passers score 90–100 (proximity)', badT1.length === 0,
    badT1.length ? `${badT1.length} passer(s) out of range` : `${t1Passers.length} passers in range`)

  // Enrichment = the highest test-1 scores (top-10 cap) — since the score
  // ranks pure proximity this is the ten nearest passers.
  const enriched = t1Passers.filter((x) => x.jevHybrid?.enriched === true)
  const skipped = t1Passers.filter((x) => x.jevHybrid?.enriched !== true)
  const minEnriched = enriched.length ? Math.min(...enriched.map((x) => x.jevHybrid.test1.score ?? -1)) : Infinity
  const maxSkipped = skipped.length ? Math.max(...skipped.map((x) => x.jevHybrid.test1.score ?? -1)) : -Infinity
  check('enrichment = top test-1 scores (≤10)', enriched.length <= 10 && minEnriched >= maxSkipped,
    `enriched=${enriched.length} minEnriched=${minEnriched} maxSkipped=${maxSkipped}`)

  // ── Test-2 score: fresh two-tier score — subdivision-match on the same
  // side of road barriers scores 95–100; neighborhood-only or road-crossing
  // scores 90–95; fails sit below 90. Test-1 score never carries forward.
  const t2Passers = comps.filter((x) => x.jevHybrid?.test2?.passed === true)
  const t2Fails = comps.filter((x) => x.jevHybrid?.test2 != null && x.jevHybrid.test2.passed === false)
  const NOUL_GATE = 0.5
  const crosses = (x) => (x.jevHybrid?.crossesMajorRoad ?? x.crossesMajorRoad) === true
  const subTier = t2Passers.filter((x) => x.jevHybrid.test2.nouls?.subdivision >= NOUL_GATE && !crosses(x))
  const lowerTier = t2Passers.filter((x) => !(x.jevHybrid.test2.nouls?.subdivision >= NOUL_GATE && !crosses(x)))
  check('subdivision+same-side passers score 95–100',
    subTier.every((x) => x.jevHybrid.test2.score >= 95 && x.jevHybrid.test2.score <= 100),
    `${subTier.length} comp(s) in premium tier`)
  check('hood-only/crossing passers score 90–95',
    lowerTier.every((x) => x.jevHybrid.test2.score >= 90 && x.jevHybrid.test2.score <= 95),
    `${lowerTier.length} comp(s) in lower tier`)
  check('test-2 fails score below 90',
    t2Fails.every((x) => x.jevHybrid.test2.score < 90),
    `${t2Fails.length} fail(s) checked`)
  check('test-2 passers outscore test-2 fails',
    t2Fails.length === 0 || t2Passers.length === 0 ||
    Math.min(...t2Passers.map((x) => x.jevHybrid.test2.score)) > Math.max(...t2Fails.map((x) => x.jevHybrid.test2.score)),
    `minPass=${t2Passers.length ? Math.min(...t2Passers.map((x) => x.jevHybrid.test2.score)) : '-'} maxFail=${t2Fails.length ? Math.max(...t2Fails.map((x) => x.jevHybrid.test2.score)) : '-'}`)

  // ── Classification: top 10% of test-2 passers by adjusted price = ARV ──────
  const priceOf = (x) => x.jevHybrid?.adjustedPrice ?? x.adjustedSalePrice ?? x.salePrice ?? 0
  const expectedArv = t2Passers.length > 0 ? Math.max(1, Math.ceil(t2Passers.length * 0.10)) : 0
  check('ARV count = top 10% of test-2 passers', jevSelected.length === expectedArv,
    `passers=${t2Passers.length} arv=${jevSelected.length} expected=${expectedArv}`)
  if (jevSelected.length > 0) {
    const arvIds = new Set(jevSelected.map((x) => x.id ?? x.compId))
    const minArvPrice = Math.min(...jevSelected.map(priceOf))
    const nonArv = t2Passers.filter((x) => !arvIds.has(x.id ?? x.compId))
    const maxNonArv = nonArv.length ? Math.max(...nonArv.map(priceOf)) : -Infinity
    check('ARV comps are the highest-priced passers', minArvPrice >= maxNonArv,
      `minArv=${Math.round(minArvPrice)} maxNonArv=${maxNonArv === -Infinity ? '-' : Math.round(maxNonArv)}`)
  }

  // ARV = mean of Jev's ARV comps' adjusted price when the funnel produced
  // them; otherwise the number is the rules fallback (handoff run).
  const adjusted = jevSelected.map((x) => x.jevHybrid?.adjustedPrice ?? x.adjustedPrice ?? x.adjustedSalePrice ?? x.salePrice).filter((v) => typeof v === 'number' && v > 0)
  if (adjusted.length > 0 && typeof arv === 'number') {
    const mean = adjusted.reduce((a, b) => a + b, 0) / adjusted.length
    check('ARV = mean of ARV-tier adjusted prices', Math.abs(mean - arv) < Math.max(1, arv * 0.01),
      `mean=${Math.round(mean)} arv=${Math.round(arv)}`)
  }

  // Human-handoff contract: when zero comps pass test 2 the report must
  // carry the flag (not silently fill).
  const t2passed = c?.test2Passed ?? null
  if (t2passed === 0) {
    check('zero test-2 passers → humanHandoff flag', result?.humanHandoff === true || result?.report?.humanHandoff === true,
      `test2Passed=0 humanHandoff=${result?.humanHandoff ?? result?.report?.humanHandoff}`)
  }
}

// ── run ─────────────────────────────────────────────────────────────────────
const t0 = Date.now()
const slug = address.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)

console.log(`E2E analyze → ${API}`)
console.log(`address: ${address}${SKIP_CACHE ? ' (skipCache)' : ''}`)

const health = await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)
check('api health', health, API)
if (!health) finish(1)

const resp = await fetch(`${API}/v1/analyze`, {
  method: 'POST', headers, body: JSON.stringify({ address, skipCache: SKIP_CACHE }),
}).then((r) => r.json()).catch((e) => ({ success: false, error: e.message }))
check('job queued', resp?.success === true && !!resp?.data?.jobId, resp?.error ?? resp?.data?.jobId)
const jobId = resp?.data?.jobId
if (!jobId) finish(1)

let data = null
while (Date.now() - t0 < TIMEOUT_MS) {
  await new Promise((r) => setTimeout(r, 3000))
  const j = await fetch(`${API}/v1/analyze/jobs/${jobId}`, { headers }).then((r) => r.json()).catch(() => null)
  const status = j?.data?.status
  if (status === 'complete' || status === 'error') { data = j.data; break }
}
check('job reached terminal state', data != null, `status=${data?.status ?? 'timeout'}`)
if (data?.status === 'error') check('job completed', false, data.error ?? 'evaluation error')
if (data?.result) validate(data.result)

// ── Manual comp-tier override round-trip ────────────────────────────────────
// Assign ARV to a comp via the API, reload the job, and verify the override
// lands on the comp card data and inside the report's jev block.
if (data?.result) {
  const comps = data.result?.comps?.items ?? data.result?.comparables ?? []
  const target = comps[0]
  const compId = target?.id ?? target?.compId
  if (compId) {
    const put = await fetch(`${API}/v1/analyze/jobs/${jobId}/comp-tier`, {
      method: 'PUT', headers, body: JSON.stringify({ compId, tier: 'arv' }),
    }).then((r) => r.json()).catch((e) => ({ success: false, error: e.message }))
    check('comp-tier override accepted', put?.success === true, put?.error ?? `comp=${compId}`)

    const j = await fetch(`${API}/v1/analyze/jobs/${jobId}`, { headers }).then((r) => r.json()).catch(() => null)
    const rcomps = j?.data?.result?.comps?.items ?? j?.data?.result?.comparables ?? []
    const hit = rcomps.find((x) => (x.id ?? x.compId) === compId)
    check('override visible on comp', hit?.userTier === 'arv', `userTier=${hit?.userTier}`)
    const ov = j?.data?.result?.report?.jev?.userOverrides ?? []
    check('override visible in report', ov.some((o) => o.compId === compId && o.tier === 'arv'),
      `${ov.length} override(s) in report`)
  } else {
    check('override round-trip target exists', false, 'no comp id on first comp')
  }
}

finish(0)

function finish() {
  const verdict = assertions.every((a) => a.pass) ? 'PASS' : 'FAIL'
  const artifact = {
    meta: { address, api: API, jobId: jobId ?? null, durationMs: Date.now() - t0, ranAt: new Date().toISOString(), skipCache: SKIP_CACHE },
    verdict,
    assertions,
    result: data?.result ?? null,
    error: data?.error ?? null,
  }
  const dir = resolve(root, 'e2e/artifacts')
  mkdirSync(dir, { recursive: true })
  const file = resolve(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${slug}.json`)
  writeFileSync(file, JSON.stringify(artifact, null, 2))
  console.log(`\n${verdict} — ${assertions.filter((a) => a.pass).length}/${assertions.length} assertions · artifact: ${file}`)
  process.exit(verdict === 'PASS' ? 0 : 1)
}
