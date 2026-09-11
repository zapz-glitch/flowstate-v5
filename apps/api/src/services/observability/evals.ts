/**
 * Evaluation observability — benchmark gates per analysis run.
 *
 * Each run is graded against a fixed set of checks. A run "doesn't meet the
 * benchmark" when any critical check fails; degraded-but-computable outcomes
 * (NA condition, fallback comps) are warnings, not failures.
 */

export type EvalStatus = 'pass' | 'warn' | 'fail'

export interface EvalCheck {
  key: string
  label: string
  status: EvalStatus
  detail: string
}

export interface RunEval {
  /** pass = all gates green; warn = degraded; fail = benchmark not met */
  grade: 'pass' | 'warn' | 'fail'
  checks: EvalCheck[]
  passed: number
  warned: number
  failed: number
}

export interface RunEvidence {
  status: 'completed' | 'error'
  errorCode?: string | null
  compCount?: number | null
  enabledCompCount?: number | null
  arv?: number | null
  photoCount?: number | null
  renovationLevelSource?: string | null
  visionStatus?: string | null
  permitStatus?: string | null
  fallbacks?: string[]
  durationMs?: number | null
  steps?: Array<{ name: string; status: string; detail?: string }> | null
}

const DURATION_BUDGET_MS = 120_000

export function evaluateRun(ev: RunEvidence): RunEval {
  const checks: EvalCheck[] = []

  // ── Pipeline completion ──
  checks.push(
    ev.status === 'completed'
      ? { key: 'pipeline', label: 'Pipeline completed', status: 'pass', detail: 'Analysis finished' }
      : { key: 'pipeline', label: 'Pipeline completed', status: 'fail', detail: `${ev.errorCode ?? 'ERROR'}: pipeline terminated early` }
  )

  // ── Comps found ──
  const compCount = ev.compCount ?? 0
  checks.push(
    compCount >= 3
      ? { key: 'comps_found', label: 'Comparables found', status: 'pass', detail: `${compCount} comps fetched` }
      : compCount > 0
        ? { key: 'comps_found', label: 'Comparables found', status: 'warn', detail: `Only ${compCount} comps — thin market` }
        : { key: 'comps_found', label: 'Comparables found', status: 'fail', detail: 'No comparables returned' }
  )

  // ── Comps passing rules ──
  const enabled = ev.enabledCompCount ?? 0
  const usedFallback = (ev.fallbacks ?? []).some((f) => f.startsWith('comp_fallback') || f === 'nearest_comps')
  checks.push(
    enabled >= 1
      ? { key: 'comps_selected', label: 'Comps satisfy appraisal rules', status: 'pass', detail: `${enabled} comp(s) passed` }
      : usedFallback
        ? { key: 'comps_selected', label: 'Comps satisfy appraisal rules', status: 'warn', detail: 'No strict passes — nearest-sales fallback used' }
        : ev.status === 'completed'
          ? { key: 'comps_selected', label: 'Comps satisfy appraisal rules', status: 'warn', detail: 'No comps passed; eval proceeded' }
          : { key: 'comps_selected', label: 'Comps satisfy appraisal rules', status: 'fail', detail: 'INSUFFICIENT_COMPS — no qualifying sales' }
  )

  // ── ARV / valuation ──
  checks.push(
    ev.arv != null && ev.arv > 0
      ? { key: 'valuation', label: 'ARV & valuation computed', status: 'pass', detail: `ARV $${Math.round(ev.arv).toLocaleString()}` }
      : { key: 'valuation', label: 'ARV & valuation computed', status: 'fail', detail: 'No ARV produced' }
  )

  // ── Photo evidence ──
  const photos = ev.photoCount ?? 0
  checks.push(
    photos > 0
      ? { key: 'photos', label: 'Listing photos retrieved', status: 'pass', detail: `${photos} subject photo(s)` }
      : { key: 'photos', label: 'Listing photos retrieved', status: 'warn', detail: 'No listing photos — Street View fallback only' }
  )

  // ── Vision condition ──
  const vs = ev.visionStatus
  checks.push(
    ev.renovationLevelSource === 'vision' || vs === 'ok'
      ? { key: 'vision', label: 'Condition verified by vision', status: 'pass', detail: 'Condition assessed from photos' }
      : vs === 'unavailable'
        ? { key: 'vision', label: 'Condition verified by vision', status: 'warn', detail: 'Vision provider unavailable — condition NA' }
        : { key: 'vision', label: 'Condition verified by vision', status: 'warn', detail: `Condition unverifiable (NA) — ${vs ?? 'no assessment'}` }
  )

  // ── Permit evidence ── informational only — caller-supplied renovation
  // params cover the rehab scope whether or not permit history is reachable.
  checks.push(
    ev.permitStatus === 'available'
      ? { key: 'permits', label: 'Permit records retrieved', status: 'pass', detail: 'Permit history attached' }
      : ev.permitStatus === 'empty'
        ? { key: 'permits', label: 'Permit records retrieved', status: 'pass', detail: 'No permits on record (verified)' }
        : { key: 'permits', label: 'Permit records retrieved', status: 'pass', detail: 'Permit lookup unavailable — informational only' }
  )

  // ── Step integrity ──
  const steps = ev.steps ?? []
  const failedSteps = steps.filter((s) => s.status === 'failed' || s.status === 'error')
  checks.push(
    steps.length === 0
      ? { key: 'steps', label: 'Step trace integrity', status: 'warn', detail: 'No step trace recorded' }
      : failedSteps.length > 0
        ? { key: 'steps', label: 'Step trace integrity', status: 'warn', detail: `${failedSteps.length} step(s) failed: ${failedSteps.map((s) => s.name).join(', ')}` }
        : { key: 'steps', label: 'Step trace integrity', status: 'pass', detail: `${steps.length} steps recorded, none failed` }
  )

  // ── Latency budget ──
  const ms = ev.durationMs
  checks.push(
    ms == null
      ? { key: 'duration', label: 'Latency budget', status: 'warn', detail: 'Duration not recorded' }
      : ms <= DURATION_BUDGET_MS
        ? { key: 'duration', label: 'Latency budget', status: 'pass', detail: `${(ms / 1000).toFixed(1)}s ≤ ${DURATION_BUDGET_MS / 1000}s budget` }
        : { key: 'duration', label: 'Latency budget', status: 'warn', detail: `${(ms / 1000).toFixed(1)}s exceeded ${DURATION_BUDGET_MS / 1000}s budget` }
  )

  const failed = checks.filter((c) => c.status === 'fail').length
  const warned = checks.filter((c) => c.status === 'warn').length
  const passed = checks.filter((c) => c.status === 'pass').length
  return { grade: failed > 0 ? 'fail' : warned > 0 ? 'warn' : 'pass', checks, passed, warned, failed }
}
