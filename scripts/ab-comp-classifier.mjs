#!/usr/bin/env node
/**
 * A/B measurement: Baseline A (dual-noul argmax) vs Candidate B (structured
 * ARV/AS_IS/UNIDENTIFIED choice) over saved analysis reports.
 *
 * Usage:
 *   node scripts/ab-comp-classifier.mjs --reports <dir-or-file...> [--labels labels.json] [--json out.json]
 *
 * --reports: AnalysisResponse JSON files (export fullResponseJson from saved
 *   reports). Reports must come from shadow-mode runs — each comp item needs
 *   jevArvTruth/jevInvestmentTruth (Baseline A) AND jevPriceClassification
 *   (Candidate B). The eligible set is the comps B classified — by
 *   construction those are exactly the gate-passed comps.
 *
 * --labels (optional): { "<compId or comp address prefix>": "ARV"|"AS_IS"|"UNIDENTIFIED" }
 *   Human-reviewed ground truth. Without it, only agreement/coverage/
 *   downstream/cost metrics are produced — accuracy, contamination, and
 *   calibration require labels and are NOT fabricated.
 *
 * Downstream effects are recomputed with the production formulas:
 *   ARV = mean(adjustedPrice ?? salePrice) over the ARV pool
 *   As-is = sqft-scaled mean salePrice over the AS_IS pool plus verified
 *           flip priorSale prices over the whole evaluated pool
 *           (mirrors summarizeGroupB; uses item.squareFeet/subject.squareFeet)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, basename } from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? null : args[i + 1]
}
const flagAll = (name) => {
  const out = []
  for (let i = 0; i < args.length; i++) if (args[i] === `--${name}`) out.push(args[i + 1])
  return out
}

const reportPaths = flagAll('reports').flatMap((p) => {
  const s = statSync(resolve(p))
  if (s.isDirectory()) return readdirSync(resolve(p)).filter((f) => f.endsWith('.json')).map((f) => resolve(p, f))
  return [resolve(p)]
})
if (!reportPaths.length) {
  console.error('usage: ab-comp-classifier.mjs --reports <dir-or-file...> [--labels labels.json] [--json out.json]')
  process.exit(1)
}
const labelsPath = flag('labels')
const labels = labelsPath ? JSON.parse(readFileSync(resolve(labelsPath), 'utf8')) : null
const jsonOut = flag('json')

const CLASSES = ['ARV', 'AS_IS', 'UNIDENTIFIED']
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null

// Baseline A production rule: strict argmax, ties fall to AS_IS.
const aClass = (item) =>
  typeof item.jevArvTruth === 'number' && typeof item.jevInvestmentTruth === 'number'
    ? (item.jevArvTruth > item.jevInvestmentTruth ? 'ARV' : 'AS_IS')
    : null

const bClass = (item) => item.jevPriceClassification?.class ?? null

const arvEstimate = (items, ids) =>
  mean(items.filter((c) => ids.has(c.id)).map((c) => c.adjustedPrice ?? c.salePrice).filter((p) => p > 0))

// Mirrors summarizeGroupB: sqft-scale each pool sale to the subject's sqft;
// verified flip priorSales across the whole pool fold in too.
function asIsEstimate(items, poolIds, subjectSqft) {
  const scaled = []
  const add = (price, compSqft) => {
    if (compSqft > 0 && subjectSqft > 0) scaled.push((price / compSqft) * subjectSqft)
    else scaled.push(price)
  }
  for (const c of items) if (poolIds.has(c.id) && c.salePrice > 0) add(c.salePrice, c.squareFeet)
  for (const c of items) if (c.flip?.priorSalePrice > 0) add(c.flip.priorSalePrice, c.squareFeet)
  return scaled.length ? Math.round(mean(scaled)) : null
}

const labelFor = (item) =>
  labels ? (labels[item.id] ?? labels[item.address?.split(',')[0]?.trim()] ?? null) : null

const perReport = []
const disagreements = []
const allComps = [] // { report, item, a, b, label }

for (const path of reportPaths) {
  const response = JSON.parse(readFileSync(path, 'utf8'))
  const items = response?.comps?.items ?? []
  const ranB = items.some((c) => c.jevPriceClassification != null)
  // The eligible set is the gate-passed pool. When B ran, jevPriceClassification
  // presence is exactly that set (B only sees gate-passed comps). For A-only
  // reports, approximate the gate: distance ≤0.5mi AND no recorded disable
  // reasons (shouldDisable's projection) AND truth scores present.
  const eligible = ranB
    ? items.filter((c) => c.jevPriceClassification != null)
    : items.filter((c) => c.jevArvTruth != null && c.jevInvestmentTruth != null &&
        (c.distanceMiles ?? 99) <= 0.5 && !(c.disableReasons ?? []).length)
  if (!eligible.length) { console.warn(`${basename(path)}: no Jev comp classification data — skipped`); continue }

  const arvA = new Set(), asIsA = new Set(), arvB = new Set(), asIsB = new Set()
  let agree = 0
  for (const c of eligible) {
    const a = aClass(c), b = bClass(c), label = labelFor(c)
    if (a === 'ARV') arvA.add(c.id); else if (a === 'AS_IS') asIsA.add(c.id)
    if (b === 'ARV') arvB.add(c.id); else if (b === 'AS_IS') asIsB.add(c.id)
    if (a && b && a === b) agree++
    else if (a && b) {
      disagreements.push({
        report: basename(path), compId: c.id, address: c.address,
        salePrice: c.salePrice, adjustedPrice: c.adjustedPrice,
        distanceMiles: c.distanceMiles, flip: c.flip ?? null,
        a: { class: a, arvTruth: c.jevArvTruth, investmentTruth: c.jevInvestmentTruth },
        b: { class: b, probabilities: c.jevPriceClassification?.probabilities ?? null, confidence: c.jevPriceClassification?.confidence ?? null },
        label,
      })
    }
    allComps.push({ report: basename(path), item: c, a, b, label })
  }

  const subjectSqft = response?.subject?.squareFeet ?? 0
  const rec = {
    report: basename(path),
    eligible: eligible.length,
    a: { arv: arvA.size, asIs: asIsA.size },
    b: { arv: arvB.size, asIs: asIsB.size, unidentified: eligible.length - arvB.size - asIsB.size },
    coverageB: ranB ? (arvB.size + asIsB.size) / eligible.length : null,
    disagreementRate: ranB ? disagreements.filter((d) => d.report === basename(path)).length / eligible.length : null,
    arvEstimateA: arvEstimate(items, arvA),
    arvEstimateB: ranB ? arvEstimate(items, arvB) : null,
    asIsEstimateA: asIsEstimate(items, asIsA, subjectSqft),
    asIsEstimateB: ranB ? asIsEstimate(items, asIsB, subjectSqft) : null,
    productionArv: response?.valuation?.arv ?? null,
    productionAsIs: response?.valuation?.asIsMarketIntel?.asIsMarketPrice ?? null,
    ops: {
      a: response?.jevCompTruth ?? null,
      b: response?.jevCompClassification ?? null,
    },
  }
  rec.arvDelta = rec.arvEstimateA != null && rec.arvEstimateB != null ? rec.arvEstimateB - rec.arvEstimateA : null
  rec.asIsDelta = rec.asIsEstimateA != null && rec.asIsEstimateB != null ? rec.asIsEstimateB - rec.asIsEstimateA : null
  perReport.push(rec)
}

// ─── Aggregate ────────────────────────────────────────────────────────────────

const total = allComps.length
const bRan = allComps.filter((c) => c.b != null)
const labeled = allComps.filter((c) => c.label != null)

const inPool = (c, cls, which) => which === 'a' ? c.a === cls : c.b === cls
const confusion = (which) => {
  const m = Object.fromEntries(CLASSES.map((p) => [p, Object.fromEntries(CLASSES.map((t) => [t, 0]))]))
  for (const c of labeled) if (c[which]) m[c[which]][c.label]++
  return m
}
const precision = (m, cls) => {
  const tp = m[cls][cls]; const fp = CLASSES.reduce((s, t) => s + (t === cls ? 0 : m[cls][t]), 0)
  return tp + fp ? tp / (tp + fp) : null
}
const recall = (m, cls) => {
  const tp = m[cls][cls]; const fn = CLASSES.reduce((s, p) => s + (p === cls ? 0 : m[p][cls]), 0)
  return tp + fn ? tp / (tp + fn) : null
}

const metrics = {
  reports: perReport.length,
  eligibleComps: total,
  baselineA: {
    forcedClassificationRate: total ? allComps.filter((c) => c.a).length / total : null,
    arvPoolSize: allComps.filter((c) => c.a === 'ARV').length,
    asIsPoolSize: allComps.filter((c) => c.a === 'AS_IS').length,
  },
  candidateB: {
    coverage: bRan.length ? (bRan.filter((c) => c.b === 'ARV' || c.b === 'AS_IS').length) / bRan.length : null,
    unidentifiedRate: bRan.length ? bRan.filter((c) => c.b === 'UNIDENTIFIED').length / bRan.length : null,
    arvPoolSize: bRan.filter((c) => c.b === 'ARV').length,
    asIsPoolSize: bRan.filter((c) => c.b === 'AS_IS').length,
    unidentified: bRan.filter((c) => c.b === 'UNIDENTIFIED').length,
  },
  agreement: bRan.length ? bRan.filter((c) => c.a === c.b).length / bRan.length : null,
  disagreements,
  downstream: {
    arvDeltas: perReport.filter((r) => r.arvDelta != null).map((r) => ({ report: r.report, a: r.arvEstimateA, b: r.arvEstimateB, delta: r.arvDelta })),
    asIsDeltas: perReport.filter((r) => r.asIsDelta != null).map((r) => ({ report: r.report, a: r.asIsEstimateA, b: r.asIsEstimateB, delta: r.asIsDelta })),
    materiallyChanged: perReport.filter((r) => Math.abs(r.arvDelta ?? 0) > 5000).length,
  },
  operational: {
    aLatencyMs: perReport.map((r) => r.ops.a?.latencyMs).filter((n) => n != null),
    bLatencyMs: perReport.map((r) => r.ops.b?.latencyMs).filter((n) => n != null),
    aInputTokens: perReport.map((r) => r.ops.a?.inputTokens).filter((n) => n != null),
    bInputTokens: perReport.map((r) => r.ops.b?.inputTokens).filter((n) => n != null),
    aQuestionsPerComp: 2, bQuestionsPerComp: 1,
  },
}

// Percentiles
const pct = (xs, p) => xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : null
metrics.operational.aLatencyP50 = pct(metrics.operational.aLatencyMs, 0.5)
metrics.operational.aLatencyP95 = pct(metrics.operational.aLatencyMs, 0.95)
metrics.operational.bLatencyP50 = pct(metrics.operational.bLatencyMs, 0.5)
metrics.operational.bLatencyP95 = pct(metrics.operational.bLatencyMs, 0.95)

// ─── Labeled metrics (only with --labels) ────────────────────────────────────

if (labeled.length) {
  const mA = confusion('a'), mB = confusion('b')
  const acc = (which) => labeled.filter((c) => c[which] === c.label).length / labeled.length
  metrics.labeled = {
    count: labeled.length,
    accuracy: { a: acc('a'), b: acc('b') },
    precision: {
      a: { arv: precision(mA, 'ARV'), asIs: precision(mA, 'AS_IS') },
      b: { arv: precision(mB, 'ARV'), asIs: precision(mB, 'AS_IS'), unidentified: precision(mB, 'UNIDENTIFIED') },
    },
    recall: {
      a: { arv: recall(mA, 'ARV'), asIs: recall(mA, 'AS_IS') },
      b: { arv: recall(mB, 'ARV'), asIs: recall(mB, 'AS_IS'), unidentified: recall(mB, 'UNIDENTIFIED') },
    },
    // % of pool members a human would NOT approve for that pool
    contamination: {
      a: {
        arv: precision(mA, 'ARV') != null ? 1 - precision(mA, 'ARV') : null,
        asIs: precision(mA, 'AS_IS') != null ? 1 - precision(mA, 'AS_IS') : null,
      },
      b: {
        arv: precision(mB, 'ARV') != null ? 1 - precision(mB, 'ARV') : null,
        asIs: precision(mB, 'AS_IS') != null ? 1 - precision(mB, 'AS_IS') : null,
      },
    },
    // % of human-UNIDENTIFIED comps forced into a valuation pool
    falseInclusion: {
      a: (() => { const u = labeled.filter((c) => c.label === 'UNIDENTIFIED'); return u.length ? u.filter((c) => c.a === 'ARV' || c.a === 'AS_IS').length / u.length : null })(),
      b: (() => { const u = labeled.filter((c) => c.label === 'UNIDENTIFIED'); return u.length ? u.filter((c) => c.b === 'ARV' || c.b === 'AS_IS').length / u.length : null })(),
    },
    calibration: (() => {
      // Brier score + confidence buckets for B (needs probabilities).
      const scored = labeled.filter((c) => c.b && c.item.jevPriceClassification?.probabilities)
      const brier = scored.length
        ? mean(scored.map((c) => CLASSES.reduce((s, cls) => s + ((c.item.jevPriceClassification.probabilities[cls] ?? 0) - (c.label === cls ? 1 : 0)) ** 2, 0)))
        : null
      const buckets = [0.5, 0.7, 0.9].map((lo, i) => {
        const hi = i === 2 ? 1.01 : [0.7, 0.9][i]
        const inB = scored.filter((c) => (c.item.jevPriceClassification.confidence ?? 0) >= lo && (c.item.jevPriceClassification.confidence ?? 0) < hi)
        return { range: `${lo}-${i === 2 ? 1.0 : hi}`, n: inB.length, accuracy: inB.length ? inB.filter((c) => c.b === c.label).length / inB.length : null }
      })
      const highConf = scored.filter((c) => (c.item.jevPriceClassification.confidence ?? 0) >= 0.8)
      return {
        brierB: brier, buckets,
        highConfidenceErrorRate: highConf.length ? highConf.filter((c) => c.b !== c.label).length / highConf.length : null,
      }
    })(),
  }
}

// ─── Output ───────────────────────────────────────────────────────────────────

const fmt = (n) => n == null ? '  n/a' : typeof n === 'number' ? (Number.isInteger(n) ? String(n) : n.toFixed(3)).padStart(6) : String(n)
console.log('\n=== A/B: Baseline A (dual noul) vs Candidate B (choice) ===\n')
console.log(`reports: ${metrics.reports}   eligible comps: ${total}   labeled: ${labeled.length}`)
console.log(`\ncoverage/forcing          A       B`)
console.log(`  forced rate          ${fmt(metrics.baselineA.forcedClassificationRate)} ${fmt(1 - (metrics.candidateB.unidentifiedRate ?? 0))}`)
console.log(`  ARV pool             ${fmt(metrics.baselineA.arvPoolSize)} ${fmt(metrics.candidateB.arvPoolSize)}`)
console.log(`  AS_IS pool           ${fmt(metrics.baselineA.asIsPoolSize)} ${fmt(metrics.candidateB.asIsPoolSize)}`)
console.log(`  UNIDENTIFIED         ${fmt(0)} ${fmt(metrics.candidateB.unidentified)}`)
console.log(`  A↔B agreement        ${fmt(metrics.agreement)}`)
console.log(`\ndownstream`)
console.log(`  ARV delta reports    ${metrics.downstream.arvDeltas.length ? metrics.downstream.arvDeltas.map((d) => `${d.report}: ${d.a}→${d.b} (${d.delta > 0 ? '+' : ''}${d.delta})`).join('; ') : 'none changed'}`)
console.log(`  AS-IS delta reports  ${metrics.downstream.asIsDeltas.length ? metrics.downstream.asIsDeltas.map((d) => `${d.report}: ${d.a}→${d.b} (${d.delta > 0 ? '+' : ''}${d.delta})`).join('; ') : 'none changed'}`)
console.log(`  materially changed   ${metrics.downstream.materiallyChanged} report(s) with |ΔARV| > $5k`)
console.log(`\noperational`)
console.log(`  latency p50          ${fmt(metrics.operational.aLatencyP50)} ${fmt(metrics.operational.bLatencyP50)}`)
console.log(`  latency p95          ${fmt(metrics.operational.aLatencyP95)} ${fmt(metrics.operational.bLatencyP95)}`)
console.log(`  input tokens/run     ${fmt(mean(metrics.operational.aInputTokens))} ${fmt(mean(metrics.operational.bInputTokens))}`)
console.log(`  questions/comp       ${metrics.operational.aQuestionsPerComp}      ${metrics.operational.bQuestionsPerComp}`)

if (metrics.labeled) {
  const L = metrics.labeled
  console.log(`\nlabeled metrics (n=${L.count})          A       B`)
  console.log(`  accuracy             ${fmt(L.accuracy.a)} ${fmt(L.accuracy.b)}`)
  console.log(`  ARV precision        ${fmt(L.precision.a.arv)} ${fmt(L.precision.b.arv)}`)
  console.log(`  AS_IS precision      ${fmt(L.precision.a.asIs)} ${fmt(L.precision.b.asIs)}`)
  console.log(`  ARV recall           ${fmt(L.recall.a.arv)} ${fmt(L.recall.b.arv)}`)
  console.log(`  AS_IS recall         ${fmt(L.recall.a.asIs)} ${fmt(L.recall.b.asIs)}`)
  console.log(`  ARV contamination    ${fmt(L.contamination.a.arv)} ${fmt(L.contamination.b.arv)}`)
  console.log(`  AS_IS contamination  ${fmt(L.contamination.a.asIs)} ${fmt(L.contamination.b.asIs)}`)
  console.log(`  false inclusion      ${fmt(L.falseInclusion.a)} ${fmt(L.falseInclusion.b)}`)
  console.log(`  Brier (B)            ${fmt(L.calibration.brierB)}`)
  console.log(`  high-conf err (B)    ${fmt(L.calibration.highConfidenceErrorRate)}`)
  for (const b of L.calibration.buckets) console.log(`  conf ${b.range}: n=${b.n} acc=${b.accuracy == null ? 'n/a' : b.accuracy.toFixed(2)}`)
} else {
  console.log(`\nno labels supplied — accuracy/contamination/calibration skipped (pass --labels)`)
}

if (disagreements.length) {
  console.log(`\ndisagreements (${disagreements.length}):`)
  for (const d of disagreements.slice(0, 25)) {
    console.log(`  ${d.report} ${d.address}  $${d.salePrice} adj=$${d.adjustedPrice} ${d.distanceMiles}mi${d.flip ? ` flip(prior $${d.flip.priorSalePrice})` : ''}`)
    console.log(`    A=${d.a.class} (arv ${d.a.arvTruth} / inv ${d.a.investmentTruth})   B=${d.b.class} ${JSON.stringify(d.b.probabilities)} conf=${d.b.confidence}${d.label ? `   label=${d.label}` : ''}`)
  }
  if (disagreements.length > 25) console.log(`  … and ${disagreements.length - 25} more`)
}

if (jsonOut) {
  const out = { generatedAt: new Date().toISOString(), metrics, perReport }
  const fs = await import('node:fs')
  fs.writeFileSync(resolve(jsonOut), JSON.stringify(out, null, 2))
  console.log(`\nwrote ${jsonOut}`)
}
