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

// Baseline A production rule: strict argmax BOTH ways — arvTruth must be
// strictly greater for the ARV bucket AND investmentTruth strictly greater
// for the investment bucket, so an exact tie enters NEITHER pool (isEnabled
// stays false; production does not force a class on a tie).
const aClass = (item) =>
  typeof item.jevArvTruth === 'number' && typeof item.jevInvestmentTruth === 'number'
    ? (item.jevArvTruth > item.jevInvestmentTruth ? 'ARV'
      : item.jevInvestmentTruth > item.jevArvTruth ? 'AS_IS'
      : 'NEITHER')
    : null

const bClass = (item) => item.jevPriceClassification?.class ?? null

/**
 * Decisiveness stats for a B classification. Newer reports persist top1/top2/
 * margin; older ones only have probabilities — derive from either.
 */
const bStats = (item) => {
  const c = item.jevPriceClassification
  if (!c) return { confidence: null, top1: null, top2: null, margin: null }
  let { top1, top2, margin } = c
  if (top1 == null && c.probabilities) {
    const ranked = Object.values(c.probabilities).sort((a, b) => b - a)
    top1 = ranked[0] ?? null
    top2 = ranked[1] ?? null
  }
  if (margin == null && top1 != null && top2 != null) margin = Math.round((top1 - top2) * 1000) / 1000
  return { confidence: c.confidence ?? null, top1, top2, margin }
}

// ARV = mean(adjustedPrice ?? salePrice) over the pool, then the production
// arv_condition_gate mirror: comps verified below ARV spec (the stored
// curbAppeal summary carries the exclusion note) are pruned when ≥3 remain.
const arvEstimate = (items, ids) => {
  const pool = items.filter((c) => ids.has(c.id))
  const kept = pool.filter((c) => !(c.curbAppeal?.summary ?? '').includes('excluded from ARV'))
  const effective = kept.length >= 3 ? kept : pool
  return mean(effective.map((c) => c.adjustedPrice ?? c.salePrice).filter((p) => p > 0))
}

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
    // Agreement = same routing outcome. A's NEITHER (argmax tie) and B's
    // UNIDENTIFIED both keep the comp out of every pool → agree.
    const aRouted = a === 'ARV' || a === 'AS_IS' ? a : 'UNROUTED'
    const bRouted = b === 'ARV' || b === 'AS_IS' ? b : (b === 'UNIDENTIFIED' ? 'UNROUTED' : null)
    if (aRouted && bRouted && aRouted === bRouted) agree++
    else if (a && b) {
      disagreements.push({
        report: basename(path), compId: c.id, address: c.address,
        salePrice: c.salePrice, adjustedPrice: c.adjustedPrice,
        distanceMiles: c.distanceMiles, flip: c.flip ?? null,
        a: { class: a, arvTruth: c.jevArvTruth, investmentTruth: c.jevInvestmentTruth },
        b: { class: b, probabilities: c.jevPriceClassification?.probabilities ?? null, ...bStats(c) },
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
const PRED_CLASSES_A = ['ARV', 'AS_IS', 'NEITHER'] // A can't emit UNIDENTIFIED; ties → NEITHER
const confusion = (which) => {
  const preds = which === 'a' ? PRED_CLASSES_A : CLASSES
  const m = Object.fromEntries(preds.map((p) => [p, Object.fromEntries(CLASSES.map((t) => [t, 0]))]))
  for (const c of labeled) if (c[which] && m[c[which]]) m[c[which]][c.label]++
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
    // Fraction of eligible comps A forces into a pool (exact ties abstain)
    forcedClassificationRate: total ? allComps.filter((c) => c.a === 'ARV' || c.a === 'AS_IS').length / total : null,
    arvPoolSize: allComps.filter((c) => c.a === 'ARV').length,
    asIsPoolSize: allComps.filter((c) => c.a === 'AS_IS').length,
    neither: allComps.filter((c) => c.a === 'NEITHER').length,
  },
  candidateB: {
    coverage: bRan.length ? (bRan.filter((c) => c.b === 'ARV' || c.b === 'AS_IS').length) / bRan.length : null,
    unidentifiedRate: bRan.length ? bRan.filter((c) => c.b === 'UNIDENTIFIED').length / bRan.length : null,
    arvPoolSize: bRan.filter((c) => c.b === 'ARV').length,
    asIsPoolSize: bRan.filter((c) => c.b === 'AS_IS').length,
    unidentified: bRan.filter((c) => c.b === 'UNIDENTIFIED').length,
  },
  // Agreement = same routing outcome (A NEITHER ≈ B UNIDENTIFIED — both unrouted)
  agreement: bRan.length ? bRan.filter((c) =>
    (c.a === 'ARV' || c.a === 'AS_IS' ? c.a : 'UNROUTED') ===
    (c.b === 'ARV' || c.b === 'AS_IS' ? c.b : 'UNROUTED')).length / bRan.length : null,
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

// ─── Abstention analysis (shadow-only; no threshold is selected) ─────────────
//
// Candidate rule under study — NEVER applied to routing here:
//   if B picks ARV/AS_IS with confidence < t (or top1−top2 margin < t)
//   → treat as UNIDENTIFIED.
// We measure coverage/contamination trade-offs across candidate thresholds so
// a labeled dataset can pick t; nothing is hard-coded.

const bPicked = bRan.filter((c) => c.b === 'ARV' || c.b === 'AS_IS')
const CONF_THRESHOLDS = [0.2, 0.3, 0.4, 0.5, 0.6]
const MARGIN_THRESHOLDS = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3]

metrics.abstention = {
  // 1. Low-confidence forced classification rate (ARV/AS_IS picks below each
  //    candidate confidence threshold)
  lowConfidenceForced: Object.fromEntries(CONF_THRESHOLDS.map((t) => [t, {
    count: bPicked.filter((c) => (bStats(c.item).confidence ?? 1) < t).length,
    rate: bPicked.length ? bPicked.filter((c) => (bStats(c.item).confidence ?? 1) < t).length / bPicked.length : null,
  }])),
  // 2. Top-two margin distribution across all B classifications
  marginDistribution: (() => {
    const edges = [[0, 0.05], [0.05, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.5], [0.5, 2]]
    const buckets = edges.map(([lo, hi]) => ({
      range: `${lo}–${hi === 2 ? '≥0.5' : hi}`,
      n: bRan.filter((c) => { const m = bStats(c.item).margin; return m != null && m >= lo && m < hi }).length,
      byClass: Object.fromEntries(CLASSES.map((cls) => [cls, bRan.filter((c) => {
        const m = bStats(c.item).margin; return c.b === cls && m != null && m >= lo && m < hi
      }).length])),
    }))
    return { buckets, missing: bRan.filter((c) => bStats(c.item).margin == null).length }
  })(),
  // Per-comp decisiveness table for forensics
  perComp: allComps.filter((c) => c.b != null).map((c) => ({
    report: c.report, compId: c.item.id, address: c.item.address,
    salePrice: c.item.salePrice, a: c.a, b: c.b, label: c.label,
    probabilities: c.item.jevPriceClassification?.probabilities ?? null,
    ...bStats(c.item),
  })),
  // 5–6. Contamination vs coverage under candidate abstention thresholds.
  //    At each threshold, ARV/AS_IS picks below it are hypothetically
  //    abstained to UNIDENTIFIED — report resulting coverage and (with
  //    labels) pool contamination.
  sweep: {
    byConfidence: CONF_THRESHOLDS.map((t) => {
      const kept = bPicked.filter((c) => (bStats(c.item).confidence ?? 0) >= t)
      const keptArv = kept.filter((c) => c.b === 'ARV')
      const keptAsIs = kept.filter((c) => c.b === 'AS_IS')
      const contam = (pool, cls) => {
        const l = pool.filter((c) => c.label != null)
        return l.length ? l.filter((c) => c.label !== cls).length / l.length : null
      }
      return {
        threshold: t,
        coverage: bPicked.length ? kept.length / bPicked.length : null,
        arvPoolSize: keptArv.length, asIsPoolSize: keptAsIs.length,
        arvContamination: contam(keptArv, 'ARV'),
        asIsContamination: contam(keptAsIs, 'AS_IS'),
        arvLabeled: keptArv.filter((c) => c.label != null).length,
        asIsLabeled: keptAsIs.filter((c) => c.label != null).length,
      }
    }),
    byMargin: MARGIN_THRESHOLDS.map((t) => {
      const kept = bPicked.filter((c) => (bStats(c.item).margin ?? 0) >= t)
      const keptArv = kept.filter((c) => c.b === 'ARV')
      const keptAsIs = kept.filter((c) => c.b === 'AS_IS')
      const contam = (pool, cls) => {
        const l = pool.filter((c) => c.label != null)
        return l.length ? l.filter((c) => c.label !== cls).length / l.length : null
      }
      return {
        threshold: t,
        coverage: bPicked.length ? kept.length / bPicked.length : null,
        arvPoolSize: keptArv.length, asIsPoolSize: keptAsIs.length,
        arvContamination: contam(keptArv, 'ARV'),
        asIsContamination: contam(keptAsIs, 'AS_IS'),
        arvLabeled: keptArv.filter((c) => c.label != null).length,
        asIsLabeled: keptAsIs.filter((c) => c.label != null).length,
      }
    }),
  },
}

// ─── Labeled metrics (only with --labels) ────────────────────────────────────

if (labeled.length) {
  const mA = confusion('a'), mB = confusion('b')
  // Accuracy compares routing outcomes: A's NEITHER and B's UNIDENTIFIED both
  // mean "not in a pool" — correct only when the label is UNIDENTIFIED.
  const routed = (cls) => cls === 'ARV' || cls === 'AS_IS' ? cls : 'UNROUTED'
  const acc = (which) => labeled.filter((c) =>
    c[which] != null && routed(c[which]) === routed(c.label)).length / labeled.length
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
    // 3–4. Accuracy by confidence band and by top-two-margin band
    accuracyByConfidenceBand: [[0, 0.3], [0.3, 0.5], [0.5, 0.7], [0.7, 0.9], [0.9, 1.01]].map(([lo, hi]) => {
      const inB = labeled.filter((c) => c.b != null && (bStats(c.item).confidence ?? 0) >= lo && (bStats(c.item).confidence ?? 0) < hi)
      return { band: `${lo}–${hi === 1.01 ? 1.0 : hi}`, n: inB.length, accuracy: inB.length ? inB.filter((c) => c.b === c.label).length / inB.length : null }
    }),
    accuracyByMarginBand: [[0, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.5], [0.5, 2]].map(([lo, hi]) => {
      const inB = labeled.filter((c) => c.b != null && (bStats(c.item).margin ?? -1) >= lo && (bStats(c.item).margin ?? -1) < hi)
      return { band: `${lo}–${hi === 2 ? '≥0.5' : hi}`, n: inB.length, accuracy: inB.length ? inB.filter((c) => c.b === c.label).length / inB.length : null }
    }),
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
console.log(`  UNROUTED (tie/unid.) ${fmt(metrics.baselineA.neither)} ${fmt(metrics.candidateB.unidentified)}`)
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

// ── Abstention analysis (candidate rules — none selected) ──
const AB = metrics.abstention
console.log(`\nabstention analysis (candidate rules only — nothing applied to routing)`)
console.log(`  low-confidence forced rate (ARV/AS_IS picks below t):`)
for (const [t, s] of Object.entries(AB.lowConfidenceForced)) console.log(`    conf < ${t}: ${s.count} comp(s)  rate=${s.rate == null ? 'n/a' : s.rate.toFixed(3)}`)
console.log(`  top-two margin distribution:`)
for (const b of AB.marginDistribution.buckets) console.log(`    ${b.range}: n=${b.n}  (ARV ${b.byClass.ARV} / AS_IS ${b.byClass.AS_IS} / UNIDENTIFIED ${b.byClass.UNIDENTIFIED})`)
if (AB.marginDistribution.missing) console.log(`    (no probs): n=${AB.marginDistribution.missing}`)
console.log(`  coverage/contamination sweep — byConfidence:`)
console.log(`    t      coverage  arvPool  arvContam  asIsPool  asIsContam`)
for (const s of AB.sweep.byConfidence) console.log(`    ${s.threshold}   ${s.coverage == null ? ' n/a ' : s.coverage.toFixed(3)}   ${String(s.arvPoolSize).padStart(3)}  ${s.arvContamination == null ? ` n/a(${s.arvLabeled}L)` : s.arvContamination.toFixed(3)}   ${String(s.asIsPoolSize).padStart(3)}    ${s.asIsContamination == null ? ` n/a(${s.asIsLabeled}L)` : s.asIsContamination.toFixed(3)}`)
console.log(`  coverage/contamination sweep — byMargin:`)
console.log(`    t      coverage  arvPool  arvContam  asIsPool  asIsContam`)
for (const s of AB.sweep.byMargin) console.log(`    ${s.threshold}  ${s.coverage == null ? ' n/a ' : s.coverage.toFixed(3)}   ${String(s.arvPoolSize).padStart(3)}  ${s.arvContamination == null ? ` n/a(${s.arvLabeled}L)` : s.arvContamination.toFixed(3)}   ${String(s.asIsPoolSize).padStart(3)}    ${s.asIsContamination == null ? ` n/a(${s.asIsLabeled}L)` : s.asIsContamination.toFixed(3)}`)
console.log(`  per-comp decisiveness:`)
for (const c of AB.perComp) {
  console.log(`    ${c.address?.slice(0, 38) ?? c.compId}  $${c.salePrice}  A=${c.a} B=${c.b}${c.label ? ` label=${c.label}` : ''}  conf=${c.confidence ?? 'n/a'} top1=${c.top1 ?? 'n/a'} top2=${c.top2 ?? 'n/a'} margin=${c.margin ?? 'n/a'}`)
}

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
  console.log(`  accuracy by confidence band:`)
  for (const b of L.accuracyByConfidenceBand) console.log(`    ${b.band}: n=${b.n} acc=${b.accuracy == null ? 'n/a' : b.accuracy.toFixed(3)}`)
  console.log(`  accuracy by margin band:`)
  for (const b of L.accuracyByMarginBand) console.log(`    ${b.band}: n=${b.n} acc=${b.accuracy == null ? 'n/a' : b.accuracy.toFixed(3)}`)
} else {
  console.log(`\nno labels supplied — accuracy/contamination/calibration skipped (pass --labels)`)
}

if (disagreements.length) {
  console.log(`\ndisagreements (${disagreements.length}):`)
  for (const d of disagreements.slice(0, 25)) {
    console.log(`  ${d.report} ${d.address}  $${d.salePrice} adj=$${d.adjustedPrice} ${d.distanceMiles}mi${d.flip ? ` flip(prior $${d.flip.priorSalePrice})` : ''}`)
    console.log(`    A=${d.a.class} (arv ${d.a.arvTruth} / inv ${d.a.investmentTruth})   B=${d.b.class} ${JSON.stringify(d.b.probabilities)} conf=${d.b.confidence} margin=${d.b.margin ?? 'n/a'}${d.label ? `   label=${d.label}` : ''}`)
  }
  if (disagreements.length > 25) console.log(`  … and ${disagreements.length - 25} more`)
}

if (jsonOut) {
  const out = { generatedAt: new Date().toISOString(), metrics, perReport }
  const fs = await import('node:fs')
  fs.writeFileSync(resolve(jsonOut), JSON.stringify(out, null, 2))
  console.log(`\nwrote ${jsonOut}`)
}
