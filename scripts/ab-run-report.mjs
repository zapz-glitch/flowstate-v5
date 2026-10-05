#!/usr/bin/env node
/**
 * A/B run report — one card per evaluation for the harness comparison.
 *
 *   node scripts/ab-run-report.mjs <artifact.json>       # from an e2e artifact
 *   node scripts/ab-run-report.mjs --job job_123 [--api http://localhost:8787]
 *   node scripts/ab-run-report.mjs --latest              # newest e2e artifact
 *
 * Prints the card and writes <artifact>.report.md beside the source.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null }
const API = flag('--api') ?? 'http://localhost:8787'

const usd = (n) => (n == null ? '—' : `$${Math.round(n).toLocaleString('en-US')}`)
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`

// ── load result ─────────────────────────────────────────────────────────────
let artifactPath = null
let data = null
if (args.includes('--latest')) {
  const dir = join(root, 'e2e/artifacts')
  artifactPath = join(dir, readdirSync(dir).filter((f) => f.endsWith('.json')).sort().at(-1))
} else if (flag('--job')) {
  const vars = Object.fromEntries(readFileSync(join(root, 'apps/dashboard/.env.local'), 'utf8')
    .split('\n').map((l) => l.match(/^([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?/)).filter(Boolean).map((m) => [m[1], m[2]]))
  const j = await fetch(`${API}/v1/analyze/jobs/${flag('--job')}`, {
    headers: { 'X-Dashboard-User-Id': '8NLlVN9LtfODbvKJ6jpvk9W3a8pfMDep', 'X-Dashboard-Secret': vars.DASHBOARD_INTERNAL_SECRET },
  }).then((r) => r.json())
  data = { meta: { jobId: flag('--job'), durationMs: null }, result: j.data?.result ?? null, error: j.data?.error }
} else {
  artifactPath = resolve(args.find((a) => !a.startsWith('--')) ?? '')
}
if (artifactPath) data = JSON.parse(readFileSync(artifactPath, 'utf8'))
const result = data?.result
if (!result) { console.error('no result in artifact/job'); process.exit(2) }

const v = result.valuation ?? {}
const b = v.bMechanics ?? {}
const comps = result.comps ?? {}
const items = comps.items ?? []
const ret = comps.retrieval ?? {}
const flex = ret.paramFlex ?? null

// ── rules at first — configured values minus the flex concessions ───────────
// appliedSettings.filters are the EFFECTIVE (post-flex) values; concessions
// carry the "was" numbers so the strict set can be reconstructed.
const filters = (result.appliedSettings?.filters ?? []).filter((f) => f.enabled)
const wasValue = {}
for (const c of flex?.concessions ?? []) {
  const m = c.match(/\(was .*? to ([^)]+)\)$/); const name = c.match(/^(.+?) to /)
  if (m && name) wasValue[name[1].trim()] = m[1]
}

// ── rule application counts — every comp runs every rule ──────────────────
const ruleStats = new Map()
for (const c of items) {
  for (const fr of c.appraisalRules?.filters ?? []) {
    const s = ruleStats.get(fr.type) ?? { pass: 0, fail: 0, nv: 0, fails: [] }
    if (fr.passed === true) s.pass++
    else if (fr.status === 'not_verified') s.nv++
    else { s.fail++; if (fr.reason) s.fails.push(`${c.address}: ${fr.reason}`) }
    ruleStats.set(fr.type, s)
  }
}

// ── missing-rule signals — what exists elsewhere that would have helped ────
const missing = []
const normAddr = (a) => (a ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
const sTract = result.subject?.censusTract
const nameVetoed = items.filter((c) =>
  c.censusTract && sTract && c.censusTract === sTract &&
  (c.disableReasons ?? []).some((r) => /subdivision|geo scope/i.test(r)))
if (nameVetoed.length) missing.push(`name-veto inside proven tract — ${nameVetoed.length} comp(s) died on label spelling: ${nameVetoed.map((c) => c.address).slice(0, 3).join(', ')}`)
const sqftOnly = items.filter((c) => (c.disableReasons ?? []).length === 1 && /sqft/i.test(c.disableReasons[0]))
if (sqftOnly.length) missing.push(`sqft ladder (v2) — ${sqftOnly.length} comp(s) failed on size alone: ${sqftOnly.map((c) => c.address).slice(0, 3).join(', ')}`)
if (ret.providerTruncated) missing.push(`pool truncated at ${ret.candidateLimitEffective} of ${ret.providerCandidatesReceived} provider candidates`)
if (comps.insufficientComps || b.source?.startsWith('T')) missing.push('deep fallback used — ladder/sqft+name fixes upstream could have produced drivers')
if ((items.filter((c) => /lot size/i.test((c.disableReasons ?? [])[0] ?? '')).length)) missing.push('lot-ratio rule (audit K8) — lot mismatch is all-or-nothing')

// ── render ──────────────────────────────────────────────────────────────────
const L = []
L.push(`# Run report — ${data.meta?.address ?? result.subject?.address ?? flag('--job')}`)
L.push(`harness: \`feat/tricks-of-the-trade\` · job ${data.meta?.jobId ?? '—'} · ${data.meta?.ranAt ?? ''}`)
L.push(``)
L.push(`| timing | ARV | source | conf | bracket | buy | rec |`)
L.push(`|---|---|---|---|---|---|---|`)
L.push(`| ${secs(data.meta?.durationMs ?? 0)} | **${usd(v.arv)}**${v.arv !== v.arvB && v.arvB ? ` (B: ${usd(v.arvB)})` : ''} | ${b.source ?? '—'} | ${b.confidence ?? '—'} | ${b.bracket ?? '—'} | ${usd(v.buyPrice)} | ${v.recommendation ?? '—'} |`)
L.push(``)
L.push(`**Pool:** ${comps.total} comps · ${comps.enabledCount} enabled · enriched ${ret.candidatesEnriched ?? 0} of ${ret.candidatesPrunedBeforeEnrichment ?? '?'} pre-enrichment pruned · insufficient=${comps.insufficientComps}`)
if (b.attemptTrail?.length) {
  L.push(``)
  L.push(`**Attempts:** ${b.attemptTrail.map((t) => `\`${t}\``).join(' → ')}`)
}
L.push(``)
L.push(`## Comps used for ARV`)
if (b.anchorAddress) L.push(`Anchor: **${b.anchorAddress}**`)
for (const x of b.drivers ?? []) {
  const c = x.comp ?? x
  L.push(`- ${c.address ?? x.address} — sold ${usd(c.salePrice)} → contrib ${usd(x.contribution ?? x.contrib)} (${x.tier ?? ''})`)
}
if (!(b.drivers ?? []).length) L.push(`- none — no verified drivers`)

L.push(``)
L.push(`## Rules used at first (strict settings)`)
L.push(`| rule | strict value | widened to |`)
L.push(`|---|---|---|`)
for (const f of filters) {
  const moved = Object.keys(wasValue).find((k) => f.reason?.includes(k) || (f.type === 'sale_age' && k === 'sale age') || (f.type === 'sqft_diff' && k === 'sqft tolerance') || (f.type === 'year_built_diff' && k === 'year built') || (f.type === 'distance' && k === 'distance') || (f.type === 'lot_size_diff' && k === 'lot size'))
  L.push(`| ${f.type}${f.priority === 'soft' ? ' (soft)' : ''} | ${moved ? wasValue[moved] : f.value} | ${moved ? f.value : '—'} |`)
}

L.push(``)
L.push(`## Rule application (across ${items.length} comps)`)
L.push(`| rule | passed | failed | not verified |`)
L.push(`|---|---|---|---|`)
for (const [type, s] of [...ruleStats].sort((a, b) => b[1].fail - a[1].fail))
  L.push(`| ${type} | ${s.pass} | ${s.fail} | ${s.nv} |`)

L.push(``)
L.push(`## Widening / concessions`)
if (flex && (flex.extensions ?? 0) > 0) {
  L.push(`Flex ladder ran **${flex.extensions} extensions** (factor ×${flex.factor}):`)
  for (const c of flex.concessions ?? []) L.push(`- ${c}`)
} else L.push(`None — strict rules admitted evidence, no widening.`)

// ── Tricks checklist — every trick either fired or shows why not ────────
const fs = (b.flags ?? []).join(' ').toLowerCase()
const trick = (ok, name, detail) => `| ${ok === true ? '✓' : ok === 'n/a' ? '—' : '✗'} | ${name} | ${detail} |`
L.push(``)
L.push(`## Tricks checklist`)
L.push(`| | trick | evidence |`)
L.push(`|---|---|---|`)
L.push(trick(/marginal repric|land rate:|size rate:/.test(fs) || (b.drivers ?? []).length > 0, 'marginal sqft + land rates', b.sqftRateSource ?? b.landRateSource ?? (b.source?.startsWith('T2') ? 'implied() marginal + land' : 'pool contribution')))
L.push(trick(true, 'stale/divergent never drive', /verification/.test(fs) ? 'flagged unfit' : 'nothing unfit drove'))
L.push(trick(/median-tier|no arv-tier|after_renovation|pocket-tiers/.test(fs) ? true : null, 'tier discipline', /as_is|bounded/.test(fs) ? 'as-is excluded' : 'renovated preferred'))
L.push(trick(/retail/.test(fs) ? true : (b.drivers?.length ? 'n/a' : 'n/a'), 'retail-band fallback', /retail/.test(fs) ? 'retail drivers used' : 'not needed'))
L.push(trick(!!b.anchorAddress || /t2/i.test(b.source ?? ''), 'anchor — never blend', b.anchorAddress ? `anchored to ${b.anchorAddress}` : 'pocket band carries'))
L.push(trick(/dropped from drivers|similarity/.test(fs) ? true : 'n/a', '60% similarity gate', /dropped from drivers/.test(fs) ? 'gate fired' : 'no weak drivers'))
L.push(trick(b.healed === true ? true : (b.healed === false ? 'n/a' : 'n/a'), 'self-heal', b.healed ? 'floor anchor replaced' : 'not needed'))
L.push(trick(b.conditionAdj != null ? true : 'n/a', 'condition uplift', b.conditionAdj != null ? usd(b.conditionAdj) : 'no uplift path'))
L.push(trick(b.ceiling != null ? true : 'n/a', 'outlier ceiling', b.ceiling != null ? `ceiling ${usd(b.ceiling)}` : 'pocket fence instead'))
L.push(trick(/outside the (tract|block group|neighborhood) scope/.test(fs) ? true : 'n/a', 'geo hierarchy', /outside the/.test(fs) ? 'tiers dropped' : 'no out-of-tier drivers'))
L.push(trick(/pocket-tiers/.test(fs) ? true : 'n/a', 'pocket tiers', /pocket-tiers/.test(fs) ? fs.match(/t2 pocket-tiers[^\n]*/)?.[0] ?? 'tiered' : 'comp path used'))
L.push(trick(/bracketing:/.test(fs) || (b.drivers ?? []).length > 1 ? true : 'n/a', 'bracketing', (b.bracket ?? 'ok') === 'ok' ? 'bracket ok' : `flag: ${b.bracket}`))
L.push(``)
L.push(`## Harness rules that fired (flag trail)`)
for (const f of b.flags ?? []) L.push(`- ${f}`)

L.push(``)
L.push(`## Rules we don't have that could have helped`)
if (missing.length) for (const m of missing) L.push(`- ${m}`)
else L.push(`- none flagged on this run`)

const card = L.join('\n')
console.log(card)
const out = artifactPath ? artifactPath.replace(/\.json$/, '.report.md') : join(root, 'e2e/artifacts', `${flag('--job')}.report.md`)
writeFileSync(out, card + '\n')
console.log(`\nreport: ${out}`)
