/**
 * Golden-dataset evaluation harness
 *
 * Runs a set of addresses through the deployed analysis pipeline and reports:
 *   - decision accuracy (ARV in expected range, recommendation match)
 *   - rules applied (which filters were active + their thresholds)
 *   - confidence levels + per-comp rule verdicts
 *   - speed consistency (mean / p50 / p95 / min / max)
 *   - what would raise each report's confidence
 *
 * Usage:
 *   FS_API_KEY=fs_... npx tsx src/scripts/golden-eval.ts [dataset.json] [--runs N] [--base URL]
 *
 * Dataset format:
 *   {
 *     "addresses": [
 *       {
 *         "address": "5802 Misty Gln", "city": "San Antonio", "state": "TX", "zipCode": "78247",
 *         "expected": { "arvMin": 300000, "arvMax": 400000, "recommendation": "buy" },  // optional
 *         "notes": "known good deal"
 *       }
 *     ]
 *   }
 *
 * --runs N repeats each address N times (skipCache) for speed consistency.
 * Results written to golden-eval-results-<timestamp>.json
 */

import { writeFileSync } from 'fs'

// ─── Args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const positional = args.filter((a) => !a.startsWith('--'))
const flag = (name: string, dflt?: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}

const DATASET_PATH = positional[0] ?? 'golden-dataset.json'
const BASE_URL = flag('base', 'https://api.flowstate.homes')!
const RUNS = parseInt(flag('runs', '1')!, 10)
const API_KEY = process.env.FS_API_KEY
const TIMEOUT_MS = parseInt(flag('timeout', '300000')!, 10) // 5 min per analysis

if (!API_KEY) {
  console.error('FS_API_KEY env var required (fs_... API key for the target environment)')
  process.exit(1)
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface DatasetEntry {
  address: string
  city?: string
  state?: string
  zipCode?: string
  expected?: { arvMin?: number; arvMax?: number; recommendation?: string }
  notes?: string
}

interface CompSummary {
  address: string
  selectedForArv: boolean
  isEnabled: boolean
  passedFilters: boolean
  failedRules: string[]
  notVerifiedRules: string[]
  yearBuilt?: number | null
  saleDate?: string | null
  adjustedPrice?: number | null
}

interface RunResult {
  entry: DatasetEntry
  run: number
  ok: boolean
  durationMs: number
  jobId?: string
  error?: string
  // decision
  arv?: number | null
  buyPrice?: number | null
  recommendation?: string
  confidence?: string
  confidenceReasons?: string[]
  requiresHumanReview?: boolean
  // rules
  rulesApplied?: Array<{ type: string; enabled: boolean; value: number; priority: string }>
  fallbacksUsed?: string[]
  // comps
  comps?: CompSummary[]
  // accuracy (when expected provided)
  arvInRange?: boolean
  recommendationMatch?: boolean
}

// ─── SSE reader ──────────────────────────────────────────────────────────────

async function streamResult(streamUrl: string, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${streamUrl}?token=${encodeURIComponent(token)}`, {
    headers: { Accept: 'text/event-stream' },
  })
  if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finalResult: Record<string, unknown> | null = null
  let lastError: string | null = null
  const deadline = Date.now() + TIMEOUT_MS

  while (Date.now() < deadline) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // Parse complete SSE frames (event: X\ndata: {...}\n\n)
    let idx
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const eventMatch = frame.match(/^event: (.+)$/m)
      const dataMatch = frame.match(/^data: ([\s\S]+)$/m)
      if (!eventMatch || !dataMatch) continue
      const event = eventMatch[1].trim()
      let data: Record<string, unknown> = {}
      try { data = JSON.parse(dataMatch[1]) } catch { /* keep raw */ }

      if (event === 'evaluation_complete' && data.updatedResult) {
        finalResult = data.updatedResult as Record<string, unknown>
      }
      if (event === 'error') {
        lastError = `${data.step ?? 'unknown'}: ${data.message ?? 'unknown error'}`
      }
      if (event === 'enrichment_done') {
        if (finalResult) return finalResult
        if (lastError) throw new Error(lastError)
      }
    }
  }
  if (finalResult) return finalResult
  throw new Error(lastError ?? `Timed out after ${TIMEOUT_MS}ms waiting for evaluation_complete`)
}

// ─── Single analysis run ─────────────────────────────────────────────────────

async function runAnalysis(entry: DatasetEntry, runNo: number): Promise<RunResult> {
  const t0 = Date.now()
  const out: RunResult = { entry, run: runNo, ok: false, durationMs: 0 }

  try {
    const res = await fetch(`${BASE_URL}/v1/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        streetAddress: entry.address,
        city: entry.city,
        state: entry.state,
        zipCode: entry.zipCode,
        skipCache: true,
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`POST /v1/analyze → ${res.status}: ${text.slice(0, 200)}`)
    }
    const payload = (await res.json()) as {
      success?: boolean
      data?: {
        jobId: string
        result?: Record<string, unknown> | null
        enrichment?: { streamUrl: string; token: string }
      }
      error?: string
    }
    const queued = payload.data
    if (!queued?.jobId) throw new Error(`Unexpected response: ${JSON.stringify(payload).slice(0, 200)}`)

    // Cached path returns result inline
    let result: Record<string, unknown>
    if (queued.result) {
      result = queued.result
    } else {
      const streamUrl = queued.enrichment!.streamUrl.startsWith('http')
        ? queued.enrichment!.streamUrl
        : `${BASE_URL}${queued.enrichment!.streamUrl}`
      result = await streamResult(streamUrl, queued.enrichment!.token)
    }

    out.jobId = queued.jobId
    out.ok = true
    out.durationMs = Date.now() - t0

    // ── Decision ──
    const valuation = (result.valuation ?? {}) as Record<string, unknown>
    const report = (result.report ?? {}) as Record<string, unknown>
    out.arv = (valuation.arv ?? null) as number | null
    out.buyPrice = (valuation.buyPrice ?? null) as number | null
    out.recommendation = (valuation.recommendation
      ?? (report.outcome as Record<string, unknown> | undefined)?.recommendation) as string | undefined
    out.confidence = (valuation.confidence ?? report.confidence) as string | undefined
    out.confidenceReasons = (valuation.confidenceReasons ?? report.confidenceReasons) as string[] | undefined
    out.requiresHumanReview = (valuation.requiresHumanReview ?? report.requiresHumanReview) as boolean | undefined

    // ── Rules applied ──
    const applied = (result.appliedSettings ?? {}) as { filters?: Array<{ type: string; enabled: boolean; value: number; priority?: string | null }> }
    out.rulesApplied = (applied.filters ?? []).map((f) => ({
      type: f.type, enabled: f.enabled, value: f.value, priority: f.priority ?? 'default',
    }))

    out.fallbacksUsed = (result.fallbacksUsed ?? []) as string[]

    // ── Comps ──
    const compItems = (((result.comps as Record<string, unknown>)?.items) ?? []) as Array<Record<string, unknown>>
    out.comps = compItems.map((c) => {
      const rules = ((c.appraisalRules as Record<string, unknown>)?.filters ?? []) as Array<{ type: string; passed: boolean; status?: string }>
      return {
        address: (c.address ?? c.id ?? '?') as string,
        selectedForArv: c.arvStatus === 'selected' || c.compGroup === 'arv',
        isEnabled: c.isEnabled === true,
        passedFilters: c.passedFilters !== false,
        failedRules: rules.filter((r) => r.passed === false || r.status === 'failed').map((r) => r.type),
        notVerifiedRules: rules.filter((r) => r.status === 'not_verified').map((r) => r.type),
        yearBuilt: (c.yearBuilt ?? null) as number | null,
        saleDate: (c.saleDate ?? c.closeDate ?? null) as string | null,
        adjustedPrice: (c.adjustedPrice ?? null) as number | null,
      }
    })

    // ── Accuracy vs expected ──
    if (entry.expected) {
      const { arvMin, arvMax, recommendation } = entry.expected
      if (arvMin != null && arvMax != null && out.arv != null) {
        out.arvInRange = out.arv >= arvMin && out.arv <= arvMax
      }
      if (recommendation && out.recommendation) {
        out.recommendationMatch = out.recommendation === recommendation
      }
    }
  } catch (e) {
    out.durationMs = Date.now() - t0
    out.error = e instanceof Error ? e.message : String(e)
  }
  return out
}

// ─── Reporting ───────────────────────────────────────────────────────────────

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

function printRun(r: RunResult): void {
  const label = `${r.entry.address}${r.entry.city ? `, ${r.entry.city}` : ''}${r.entry.state ? `, ${r.entry.state}` : ''}`
  if (!r.ok) {
    console.log(`\n✗ ${label} — FAILED (${fmtMs(r.durationMs)}): ${r.error}`)
    return
  }
  const conf = r.confidence?.toUpperCase() ?? '?'
  console.log(`\n${label} — ${fmtMs(r.durationMs)}`)
  console.log(`   ARV $${r.arv?.toLocaleString() ?? '?'} | Buy $${r.buyPrice?.toLocaleString() ?? '?'} | ${r.recommendation ?? '?'} | confidence: ${conf}`)
  if (r.confidenceReasons?.length) {
    for (const reason of r.confidenceReasons.slice(0, 5)) console.log(`     · ${reason}`)
  }
  if (r.fallbacksUsed?.length) console.log(`   fallbacks: ${r.fallbacksUsed.join(', ')}`)
  const selected = (r.comps ?? []).filter((c) => c.selectedForArv)
  console.log(`   comps: ${r.comps?.length ?? 0} returned, ${selected.length} selected for ARV`)
  for (const c of selected) {
    const fails = c.failedRules.length ? `  ✗ ${c.failedRules.join(',')}` : ''
    const nv = c.notVerifiedRules.length ? `  ? ${c.notVerifiedRules.join(',')}` : ''
    console.log(`     - ${c.address} (yr ${c.yearBuilt ?? '?'}, sold ${c.saleDate ?? '?'}, adj $${c.adjustedPrice?.toLocaleString() ?? '?'})${fails}${nv}`)
  }
  if (r.arvInRange !== undefined) console.log(`   expected ARV ${r.entry.expected!.arvMin}–${r.entry.expected!.arvMax}: ${r.arvInRange ? 'IN RANGE ✓' : 'OUT OF RANGE ✗'}`)
  if (r.recommendationMatch !== undefined) console.log(`   expected recommendation ${r.entry.expected!.recommendation}: ${r.recommendationMatch ? 'MATCH ✓' : 'MISMATCH ✗'}`)
}

function printSummary(results: RunResult[]): void {
  const ok = results.filter((r) => r.ok)
  console.log('\n════════════════ SUMMARY ════════════════')
  console.log(`${results.length} runs: ${ok.length} ok, ${results.length - ok.length} failed`)

  if (ok.length) {
    const times = ok.map((r) => r.durationMs).sort((a, b) => a - b)
    const mean = times.reduce((a, b) => a + b, 0) / times.length
    const p50 = times[Math.floor(times.length * 0.5)]
    const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))]
    console.log(`speed: mean ${fmtMs(Math.round(mean))} | p50 ${fmtMs(p50)} | p95 ${fmtMs(p95)} | min ${fmtMs(times[0])} | max ${fmtMs(times[times.length - 1])}`)

    const conf = { high: 0, medium: 0, low: 0, unknown: 0 }
    for (const r of ok) conf[(r.confidence as keyof typeof conf) ?? 'unknown']++
    console.log(`confidence: high ${conf.high} | medium ${conf.medium} | low ${conf.low} | unknown ${conf.unknown}`)

    const recs = new Map<string, number>()
    for (const r of ok) recs.set(r.recommendation ?? '?', (recs.get(r.recommendation ?? '?') ?? 0) + 1)
    console.log(`decisions: ${Array.from(recs.entries()).map(([k, v]) => `${k}×${v}`).join(', ')}`)

    // Rules applied (union across runs)
    const ruleMap = new Map<string, { enabled: boolean; value: number; priority: string }>()
    for (const r of ok) for (const f of r.rulesApplied ?? []) ruleMap.set(f.type, f)
    if (ruleMap.size) {
      console.log(`\nrules applied (${ruleMap.size}):`)
      for (const [type, f] of Array.from(ruleMap.entries())) {
        const v = f.value === 1 ? 'must match' : `${f.value}`
        console.log(`   ${f.enabled ? 'on ' : 'off'}  ${type}: ${v} [${f.priority}]`)
      }
    }

    // Accuracy
    const labeled = ok.filter((r) => r.arvInRange !== undefined || r.recommendationMatch !== undefined)
    if (labeled.length) {
      const arvOk = labeled.filter((r) => r.arvInRange).length
      const recOk = labeled.filter((r) => r.recommendationMatch).length
      console.log(`\naccuracy (${labeled.length} labeled runs): ARV in range ${arvOk} | recommendation match ${recOk}`)
    }

    // What would raise confidence — aggregate low/medium reasons
    const reasons = new Map<string, number>()
    for (const r of ok.filter((r) => r.confidence !== 'high')) {
      for (const reason of r.confidenceReasons ?? []) {
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
      }
    }
    if (reasons.size) {
      console.log('\nwhat would raise confidence (reason frequencies):')
      for (const [reason, n] of Array.from(reasons.entries()).sort((a, b) => b[1] - a[1])) {
        console.log(`   ${n}× ${reason}`)
      }
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { readFileSync } = await import('fs')
  const dataset: { addresses: DatasetEntry[] } = JSON.parse(readFileSync(DATASET_PATH, 'utf-8'))
  const results: RunResult[] = []

  for (const entry of dataset.addresses) {
    for (let run = 1; run <= RUNS; run++) {
      const r = await runAnalysis(entry, run)
      results.push(r)
      printRun(r)
    }
  }

  printSummary(results)

  const outPath = `golden-eval-results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  writeFileSync(outPath, JSON.stringify(results, null, 2))
  console.log(`\nResults written to ${outPath}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
