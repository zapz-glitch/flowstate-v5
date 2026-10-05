#!/usr/bin/env tsx
/**
 * Replay — run frozen evidence through the CURRENT harness and score the
 * result. New runs use run_records; old saved reports remain as legacy
 * fallback evidence so their gaps are visible instead of silently skipped.
 *
 *   npx tsx scripts/replay.mts <report-or-run-record.json> [...]
 *   npx tsx scripts/replay.mts --all
 *   npx tsx scripts/replay.mts --all --strict --report replay-report.json
 *   npx tsx scripts/replay.mts --all --snapshot-out fixtures/snapshots
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, resolve } from 'node:path'
import { evaluateB, HARNESS_VERSION } from '@flowstate-api/shared/appraisal'
import { gradeResult } from '../apps/api/src/services/analysis/result-grade'
import { ruleIdForFlag } from '../apps/api/src/services/analysis/rule-registry'
import { savedToBComps, savedToBSubject } from '../apps/api/src/services/evaluation/saved-pool'
import { canonicalJson, sha256Text } from '../apps/api/src/services/evaluation/run-record'
import { createValuationService } from '../apps/api/src/services/valuation'

const usd = (n: number | null | undefined) =>
  n == null ? '—' : `$${Math.round(n).toLocaleString('en-US')}`
const root = resolve(process.cwd())

interface ReplayCase {
  label: string
  kind: 'run_record' | 'saved_report'
  payload: Record<string, unknown>
  storedHash?: string | null
  recordId?: string | null
  jobId?: string | null
}

interface Diff {
  field: string
  expected: unknown
  actual: unknown
  kind: 'drift' | 'missing' | 'integrity'
}

interface ReplayResult {
  label: string
  kind: ReplayCase['kind']
  record: 'canonical' | 'legacy'
  status: 'pass' | 'drift' | 'integrity_failed' | 'missing_evidence'
  storedHash?: string | null
  hashOk?: boolean
  storedVersion: string
  replayVersion: string
  storedArv: number | null
  replayArv: number | null
  diffs: Diff[]
}

function d1(query: string): Record<string, unknown>[] {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'flowstate-api-db', '--local', '--json', '--command', query],
    { cwd: resolve(root, 'apps/api'), maxBuffer: 512 * 1024 * 1024 },
  ).toString()
  return (JSON.parse(out)[0]?.results ?? []) as Record<string, unknown>[]
}

function loadCorpus(): ReplayCase[] {
  let runRows: Record<string, unknown>[] = []
  try {
    runRows = d1(`
      SELECT id, job_id, property_address, payload_hash, payload_json, created_at
      FROM run_records
      WHERE payload_json IS NOT NULL
      ORDER BY job_id, created_at
    `)
  } catch {
    // Older local DBs may not have the migration yet; saved reports still
    // provide the legacy replay path.
  }

  const cases: ReplayCase[] = runRows.map((r) => ({
    label: `${r.property_address ?? r.job_id} · ${String(r.created_at ?? '').slice(0, 10)}`,
    kind: 'run_record',
    payload: JSON.parse(String(r.payload_json)),
    storedHash: String(r.payload_hash ?? ''),
    recordId: String(r.id),
    jobId: String(r.job_id ?? ''),
  }))
  const recordedJobs = new Set(cases.map((c) => c.jobId).filter(Boolean))

  const savedRows = d1(`
    SELECT id, job_id, property_address, full_response_json
    FROM saved_reports
    WHERE full_response_json IS NOT NULL
  `)
  for (const r of savedRows) {
    const jobId = typeof r.job_id === 'string' ? r.job_id : null
    if (jobId && recordedJobs.has(jobId)) continue
    cases.push({
      label: String(r.property_address ?? r.id),
      kind: 'saved_report',
      payload: JSON.parse(String(r.full_response_json)),
      recordId: String(r.id),
      jobId,
    })
  }
  return cases
}

function loadFiles(files: string[]): ReplayCase[] {
  return files.map((file) => {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const wrapped = raw?.payload?.recordVersion === 'run-record.v1' ? raw.payload : null
    const payload = wrapped ?? raw?.data?.result ?? raw?.result ?? raw
    const isRecord = payload?.recordVersion === 'run-record.v1'
    const response = isRecord ? payload.result?.response : payload
    return {
      label: response?.subject?.address ?? payload?.property?.address ?? basename(file),
      kind: isRecord ? 'run_record' : 'saved_report',
      payload,
      storedHash: raw?.payloadHash ?? raw?.payload_hash ?? (wrapped ? raw?.payloadHash : null) ?? null,
      recordId: raw?.recordId ?? raw?.id ?? null,
      jobId: raw?.jobId ?? (isRecord ? payload.jobId ?? null : payload.analysisId ?? null),
    }
  })
}

function responseOf(c: ReplayCase): Record<string, unknown> {
  return c.kind === 'run_record'
    ? ((c.payload.result as { response?: Record<string, unknown> } | undefined)?.response ?? {})
    : c.payload
}

function evidenceOf(c: ReplayCase): Record<string, unknown> | null {
  return c.kind === 'run_record'
    ? ((c.payload.evidence as Record<string, unknown> | null | undefined) ?? null)
    : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function sameNumber(a: number | null, b: number | null, tolerance = 0.5): boolean {
  if (a == null || b == null) return a === b
  return Math.abs(a - b) <= tolerance
}

function sameArv(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return a === b
  return Math.abs(a - b) <= Math.max(1, Math.abs(a) * 0.02)
}

function pushDiff(diffs: Diff[], field: string, expected: unknown, actual: unknown, equal: boolean) {
  if (!equal) diffs.push({ field, expected, actual, kind: expected == null ? 'missing' : 'drift' })
}

function compEvidenceSet(c: ReplayCase): {
  subject: Parameters<typeof evaluateB>[0]
  comps: Parameters<typeof evaluateB>[1]
  options: Parameters<typeof evaluateB>[2]
  source: string
} | null {
  const evidence = evidenceOf(c)
  const attempts = Array.isArray(evidence?.attempts) ? evidence.attempts as Array<Record<string, unknown>> : []
  const last = attempts[attempts.length - 1]
  if (last?.subject && Array.isArray(last.comps)) {
    return {
      subject: last.subject as Parameters<typeof evaluateB>[0],
      comps: last.comps as Parameters<typeof evaluateB>[1],
      options: (last.options as Parameters<typeof evaluateB>[2] | undefined) ?? {},
      source: 'run_record.attempt',
    }
  }

  const response = responseOf(c)
  const items = (response.comps as { items?: unknown[] } | undefined)?.items ?? []
  if (!items.length) return null
  return {
    subject: savedToBSubject(response),
    comps: savedToBComps(items as never, null),
    options: { rehabCost: numberOrNull((response.valuation as Record<string, unknown> | undefined)?.rehabCost) },
    source: 'saved_report.comps',
  }
}

function expectedMechanics(c: ReplayCase, attempt: Record<string, unknown> | null) {
  const response = responseOf(c)
  const valuation = response.valuation as Record<string, unknown> | null | undefined
  const mechanics = valuation?.bMechanics as Record<string, unknown> | null | undefined
  return {
    /** Last Set-B candidate, even when the terminal floor is AVM/assessed. */
    arv: numberOrNull((attempt?.result as Record<string, unknown> | undefined)?.arv)
      ?? numberOrNull(valuation?.arvB)
      ?? numberOrNull(valuation?.arv),
    /** Number the saved valuation/offer math actually used. */
    terminalArv: numberOrNull(valuation?.arv),
    source: (attempt?.result as Record<string, unknown> | undefined)?.source ?? mechanics?.source,
    confidence: (attempt?.result as Record<string, unknown> | undefined)?.conf ?? mechanics?.confidence,
    anchorAddress: (attempt?.result as Record<string, unknown> | undefined)?.anchorAddress ?? mechanics?.anchorAddress,
    drivers: (attempt?.result as Record<string, unknown> | undefined)?.drivers ?? mechanics?.drivers,
    flags: (attempt?.result as Record<string, unknown> | undefined)?.flags ?? mechanics?.flags,
    checks: (attempt as Record<string, unknown> | null)?.checks ?? mechanics?.checks,
    resultGrade: valuation?.resultGrade,
    processGrade: valuation?.processGrade,
    buyPrice: numberOrNull(valuation?.buyPrice),
    rehabCost: numberOrNull(valuation?.rehabCost),
    projectedROI: numberOrNull(valuation?.projectedROI),
    recommendation: valuation?.recommendation,
  }
}

function driverSignature(drivers: unknown): unknown[] {
  if (!Array.isArray(drivers)) return []
  return drivers.map((driver) => {
    const d = driver as Record<string, unknown>
    const comp = d.comp as Record<string, unknown> | undefined
    return {
      address: comp?.address ?? d.address ?? null,
      contribution: Math.round(numberOrNull(d.contrib ?? d.contribution) ?? 0),
      tier: d.tier ?? null,
    }
  })
}

function replayValuation(c: ReplayCase, arv: number | null) {
  if (arv == null) return null
  const response = responseOf(c)
  const evidence = evidenceOf(c)
  const applied = (evidence?.appliedSettings ?? response.appliedSettings) as Record<string, unknown> | undefined
  if (!applied) return null
  const subject = ((evidence?.subject ?? response.subject) ?? {}) as Record<string, unknown>
  const valuation = (response.valuation ?? {}) as Record<string, unknown>
  const items = ((response.comps as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [])
  const eligible = items.filter((item) => {
    const rules = item.appraisalRules as { passedFilters?: boolean } | undefined
    const price = numberOrNull(item.adjustedPrice) ?? numberOrNull(item.salePrice)
    return rules?.passedFilters !== false && price != null && price > 0
  })
  const arvComps = [...eligible]
    .sort((a, b) => ((numberOrNull(b.adjustedPrice) ?? numberOrNull(b.salePrice)) ?? 0)
      - ((numberOrNull(a.adjustedPrice) ?? numberOrNull(a.salePrice)) ?? 0))
    .slice(0, 3)
  const subjectSqft = numberOrNull(subject.squareFeet) ?? 0
  const compAvgSqft = arvComps.length
    ? arvComps.reduce((sum, item) => sum + (numberOrNull(item.squareFeet) ?? 0), 0) / arvComps.length
    : subjectSqft
  const dealParams = applied.dealParams as Record<string, unknown> | undefined
  const service = createValuationService(applied.rehabTable as never)
  return service.calculateValuation({
    arv,
    subjectSqft,
    compAvgSqft,
    rehabLevelIndex: numberOrNull(applied.rehabLevelIndex) ?? 2,
    skipBaseRehab: valuation.rehabLevel === 'Renovated',
    majorItems: (applied.majorItems as never) ?? [],
    additionPlay: numberOrNull(applied.additionPlay) ?? 0,
    closingCostsPercent: numberOrNull(dealParams?.closingCostsPercent) ?? 8,
    carryingCostsPercent: numberOrNull(dealParams?.carryingCostsPercent) ?? 2,
    wholesaleFee: numberOrNull(dealParams?.wholesaleFee) ?? 10000,
    locationPenaltyAmount: numberOrNull(valuation.locationPenalty) ?? undefined,
    locationPenaltyPercent: numberOrNull(valuation.locationPenaltyPercent) ?? undefined,
  })
}

async function replayCase(c: ReplayCase): Promise<ReplayResult> {
  const response = responseOf(c)
  const valuation = response.valuation as Record<string, unknown> | null | undefined
  const evidence = evidenceOf(c)
  const attempts = Array.isArray(evidence?.attempts) ? evidence.attempts as Array<Record<string, unknown>> : []
  const lastAttempt = attempts[attempts.length - 1] ?? null
  const storedVersion = String((valuation?.bMechanics as Record<string, unknown> | undefined)?.harnessVersion
    ?? (c.payload.rules as Record<string, unknown> | undefined)?.harnessVersion
    ?? 'unstamped')

  const diffs: Diff[] = []
  let hashOk: boolean | undefined
  if (c.kind === 'run_record' && c.storedHash) {
    hashOk = await sha256Text(canonicalJson(c.payload)) === c.storedHash
    if (!hashOk) diffs.push({ field: 'payload_hash', expected: c.storedHash, actual: 'payload mismatch', kind: 'integrity' })
  }

  const input = compEvidenceSet(c)
  if (!input) {
    diffs.push({ field: 'comp_evidence', expected: 'Set-B inputs', actual: null, kind: 'missing' })
    return {
      label: c.label,
      kind: c.kind,
      record: c.kind === 'run_record' ? 'canonical' : 'legacy',
      status: diffs.some((d) => d.kind === 'integrity') ? 'integrity_failed' : 'missing_evidence',
      storedHash: c.storedHash,
      hashOk,
      storedVersion,
      replayVersion: HARNESS_VERSION,
      storedArv: numberOrNull(valuation?.arvB) ?? numberOrNull(valuation?.arv),
      replayArv: null,
      diffs,
    }
  }

  const replay = evaluateB(input.subject, input.comps, input.options)
  const expected = expectedMechanics(c, lastAttempt)
  const expectedTrail = Array.isArray(evidence?.bAttemptTrail)
    ? evidence.bAttemptTrail as string[]
    : Array.isArray((valuation?.bMechanics as Record<string, unknown> | undefined)?.attemptTrail)
      ? (valuation!.bMechanics as Record<string, unknown>).attemptTrail as string[]
      : []
  const fallbackUsed = String((evidence?.fallbackUsed ?? (valuation?.bMechanics as Record<string, unknown> | undefined)?.fallbackUsed) ?? '') || null
  const grades = gradeResult(replay, fallbackUsed, expectedTrail)
  const attemptSubject = (lastAttempt?.subject ?? {}) as Record<string, unknown>
  const responseSubject = (response.subject ?? {}) as Record<string, unknown>
  const subjectAvm = numberOrNull(attemptSubject.avmValue)
    ?? numberOrNull((responseSubject.avm as Record<string, unknown> | undefined)?.value)
  const assessed = numberOrNull(attemptSubject.assessedValue) ?? numberOrNull(responseSubject.assessedValue)
  const terminalReplayArv = (valuation?.arvSource === 'avm' ? subjectAvm
    : valuation?.arvSource === 'assessed' ? assessed
    : replay.arv)
  const valuationReplay = replayValuation(c, terminalReplayArv)

  pushDiff(diffs, 'arv', expected.arv, replay.arv, sameArv(expected.arv, replay.arv))
  pushDiff(diffs, 'terminalArv', expected.terminalArv, terminalReplayArv, sameArv(expected.terminalArv, terminalReplayArv))
  pushDiff(diffs, 'arv.source', expected.source, replay.source, expected.source === replay.source)
  pushDiff(diffs, 'arv.confidence', expected.confidence, replay.conf, expected.confidence === replay.conf)
  pushDiff(diffs, 'arv.anchorAddress', expected.anchorAddress ?? null, replay.anchorAddress ?? null,
    (expected.anchorAddress ?? null) === (replay.anchorAddress ?? null))
  pushDiff(diffs, 'arv.flags', expected.flags ?? null, replay.flags,
    canonicalJson(expected.flags ?? null) === canonicalJson(replay.flags))
  const expectedCheckIds = Array.isArray(expected.checks)
    ? (expected.checks as Array<Record<string, unknown>>).map((check) => check.ruleId)
    : null
  const replayCheckIds = replay.flags.map(ruleIdForFlag)
  pushDiff(diffs, 'arv.checks', expectedCheckIds, replayCheckIds,
    expectedCheckIds == null ? true : canonicalJson(expectedCheckIds) === canonicalJson(replayCheckIds))
  pushDiff(diffs, 'arv.drivers', driverSignature(expected.drivers), driverSignature(replay.drivers),
    canonicalJson(driverSignature(expected.drivers)) === canonicalJson(driverSignature(replay.drivers)))
  pushDiff(diffs, 'resultGrade', expected.resultGrade, grades.resultGrade, expected.resultGrade === grades.resultGrade)
  pushDiff(diffs, 'processGrade', expected.processGrade, grades.processGrade, expected.processGrade === grades.processGrade)
  pushDiff(diffs, 'buyPrice', expected.buyPrice, valuationReplay?.buyPrice ?? null,
    sameNumber(expected.buyPrice, numberOrNull(valuationReplay?.buyPrice)))
  pushDiff(diffs, 'rehabCost', expected.rehabCost, valuationReplay?.totalRehabCost ?? null,
    sameNumber(expected.rehabCost, numberOrNull(valuationReplay?.totalRehabCost)))
  pushDiff(diffs, 'projectedROI', expected.projectedROI, valuationReplay?.projectedROI ?? null,
    sameNumber(expected.projectedROI, numberOrNull(valuationReplay?.projectedROI)))
  pushDiff(diffs, 'recommendation', expected.recommendation, valuationReplay?.recommendation ?? null,
    expected.recommendation === valuationReplay?.recommendation)

  const status = diffs.some((d) => d.kind === 'integrity')
    ? 'integrity_failed'
    : diffs.some((d) => d.kind === 'drift')
      ? 'drift'
      : diffs.length || c.kind === 'saved_report'
        ? 'missing_evidence'
        : 'pass'

  return {
    label: c.label,
    kind: c.kind,
    record: c.kind === 'run_record' ? 'canonical' : 'legacy',
    status,
    storedHash: c.storedHash,
    hashOk,
    storedVersion,
    replayVersion: HARNESS_VERSION,
    storedArv: expected.arv,
    replayArv: replay.arv,
    diffs,
  }
}

const args = process.argv.slice(2)
const strict = args.includes('--strict')
const optionValue = (name: string) =>
  args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1)
  ?? (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const reportPath = optionValue('--report')
const snapshotOut = optionValue('--snapshot-out')
const optionValues = new Set([reportPath, snapshotOut].filter(Boolean))
const files = args.filter((a) => !a.startsWith('--') && !optionValues.has(a))
const corpus = args.includes('--all') ? loadCorpus() : loadFiles(files)
if (!corpus.length) {
  console.error('usage: npx tsx scripts/replay.mts <report-or-run-record.json> [...] | --all [--strict] [--report <file>] [--snapshot-out <dir>]')
  process.exit(2)
}

const results: ReplayResult[] = []
for (const c of corpus) {
  const result = await replayCase(c)
  results.push(result)
  const icon = result.status === 'pass' ? '✓' : result.status === 'integrity_failed' ? '✗' : '⚠'
  console.log(
    `${icon} ${result.label}\n` +
    `    ${result.kind} · ${result.record} · stored ${usd(result.storedArv)} (${result.storedVersion}) → replay ${usd(result.replayArv)} (${result.replayVersion})`,
  )
  for (const diff of result.diffs.slice(0, 8)) {
    console.log(`    ${diff.kind.toUpperCase()} ${diff.field}: ${JSON.stringify(diff.expected)} → ${JSON.stringify(diff.actual)}`)
  }
  if (result.diffs.length > 8) console.log(`    … ${result.diffs.length - 8} more diff(s)`)
}

const counts = {
  pass: results.filter((r) => r.status === 'pass').length,
  drift: results.filter((r) => r.status === 'drift').length,
  missing: results.filter((r) => r.status === 'missing_evidence').length,
  integrity: results.filter((r) => r.status === 'integrity_failed').length,
}
console.log(`\n${results.length} replayed under ${HARNESS_VERSION} — ${counts.pass} pass, ${counts.drift} drift, ${counts.missing} missing evidence, ${counts.integrity} integrity failures`)

if (reportPath) {
  writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), harnessVersion: HARNESS_VERSION, strict, counts, results }, null, 2))
  console.log(`report: ${reportPath}`)
}
if (snapshotOut) {
  const dir = resolve(root, snapshotOut)
  mkdirSync(dir, { recursive: true })
  for (const c of corpus) {
    const safe = `${c.recordId ?? c.jobId ?? c.label}`.replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 120)
    writeFileSync(resolve(dir, `${safe}-${c.kind}.json`), `${canonicalJson({
      recordId: c.recordId,
      jobId: c.jobId,
      payloadHash: c.storedHash,
      exportedAt: new Date().toISOString(),
      payload: c.payload,
    })}\n`)
  }
  console.log(`snapshots: ${corpus.length} file(s) → ${dir}`)
}

const failed = strict
  ? results.some((r) => r.status !== 'pass')
  : results.some((r) => r.status === 'drift' || r.status === 'integrity_failed')
process.exit(failed ? 1 : 0)
