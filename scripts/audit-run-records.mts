#!/usr/bin/env tsx
/**
 * Independent run-record audit.
 *
 * Replay answers "does the same evidence reproduce the same result?" This
 * audit answers "does the saved result obey the current evidence contract?"
 * It intentionally does not call evaluateB: it inspects the canonical record.
 */

import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { canonicalJson, sha256Text } from '../apps/api/src/services/evaluation/run-record'
import { ruleIdForFlag } from '../apps/api/src/services/analysis/rule-registry'
import { gradeResult } from '../apps/api/src/services/analysis/result-grade'

interface Violation { rule: string; message: string }
interface AuditCase {
  file: string
  label: string
  violations: Violation[]
  warnings: Violation[]
}

const args = process.argv.slice(2)
const strict = args.includes('--strict')
const files = args.filter((a) => !a.startsWith('-'))

const obj = (v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
const arr = (v: unknown) => Array.isArray(v) ? v as Record<string, unknown>[] : []
const str = (v: unknown) => typeof v === 'string' ? v : null
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null
const sameMoney = (a: unknown, b: unknown) => {
  const x = num(a); const y = num(b)
  return x == null || y == null ? x === y : Math.abs(x - y) <= Math.max(1, Math.abs(x) * 0.02)
}

function check(record: Record<string, unknown>, storedHash: string | null, file: string): AuditCase {
  const violations: Violation[] = []
  const warnings: Violation[] = []
  const fail = (rule: string, message: string) => violations.push({ rule, message })
  const warn = (rule: string, message: string) => warnings.push({ rule, message })

  const response = obj(obj(record.result)?.response)
  const subject = obj(response?.subject)
  const evidence = obj(record.evidence)
  const attempts = arr(record.attempts)
  const rules = obj(record.rules)
  const valuation = obj(response?.valuation)
  const mechanics = obj(valuation?.bMechanics)
  const lastAttempt = attempts[attempts.length - 1]
  const result = obj(lastAttempt?.result)
  const drivers = arr(result?.drivers)
  const trail = Array.isArray(evidence?.bAttemptTrail) ? evidence.bAttemptTrail.map(String) : []
  const recordedAt = str(record.recordedAt)

  if (record.recordVersion !== 'run-record.v1') fail('record.version', 'recordVersion is not run-record.v1')
  if (!str(record.jobId)) fail('record.job', 'missing jobId')
  if (!str(record.userId)) fail('record.user', 'missing userId')
  if (!recordedAt || Number.isNaN(Date.parse(recordedAt))) fail('record.time', 'missing/invalid recordedAt')
  if (!str(record.status)) fail('record.status', 'missing terminal status')
  if (!obj(record.request)) fail('record.request', 'missing request block')
  if (!obj(record.evidence)) fail('record.evidence', 'missing evidence block')
  if (!rules?.harnessVersion || !rules.pipelineVersion) fail('record.rules', 'missing harness/pipeline version')
  if (rules?.valuationDate && recordedAt && rules.valuationDate !== recordedAt.slice(0, 10)) {
    fail('record.valuation_date', `valuationDate ${rules.valuationDate} != recordedAt ${recordedAt.slice(0, 10)}`)
  }
  if (String(rules?.harnessVersion ?? '') >= 'og-2026.10.05.1') {
    if (!obj(rules.models)) fail('record.runtime', 'missing model pins')
    if (!obj(rules.providers)) fail('record.runtime', 'missing provider pins')
  }
  if (!subject?.address) fail('record.subject', 'missing subject address')
  if (!Array.isArray(evidence?.compPool)) fail('record.evidence.pool', 'missing compPool evidence')
  if (attempts.length === 0) fail('record.attempts', 'no Set-B attempts recorded')
  if (!result) fail('record.attempts', 'last attempt has no result')
  if (!Array.isArray(lastAttempt?.checks)) fail('record.checks', 'last attempt has no stable check IDs')

  const flags = Array.isArray(result?.flags) ? result.flags.map(String) : []
  const checks = arr(lastAttempt?.checks)
  const expectedCheckIds = flags.map(ruleIdForFlag)
  const actualCheckIds = checks.map((c) => str(c.ruleId))
  if (actualCheckIds.length !== expectedCheckIds.length || actualCheckIds.some((id, i) => id !== expectedCheckIds[i])) {
    fail('record.checks', 'check IDs do not match the recorded result flags')
  }

  for (const driver of drivers) {
    const comp = obj(driver.comp)
    const verification = obj(comp?.evidenceVerification)
    const label = str(comp?.address) ?? 'unknown comp'
    if (!comp?.salePrice || !comp.squareFeet) fail('driver.evidence', `${label}: driver lacks sale price or size`)
    if (verification?.staleness === 'stale') fail('driver.sale_age', `${label}: stale sale drove ARV`)
    if (['package_deed', 'nominal_sale', 'extreme_outlier'].includes(String(verification?.transactionCheck))) {
      fail('driver.transaction', `${label}: transaction noise drove ARV`)
    }
    if (verification?.priceCheck === 'divergent') fail('driver.price', `${label}: divergent sale drove ARV`)
    if (verification?.marketFit === 'below_pocket') fail('driver.market_fit', `${label}: below-pocket sale drove ARV`)
    const condition = String(obj(comp?.curbAppeal)?.condition ?? '').toLowerCase()
    if (condition === 'distressed' || condition === 'needs_work') fail('driver.condition', `${label}: distressed evidence drove ARV`)
  }

  if (result && valuation) {
    const expectedArv = num(result.arv)
    const reportedArv = num(valuation.arvB) ?? num(valuation.arv)
    if (!sameMoney(expectedArv, reportedArv)) fail('result.arv', `reported ARV ${reportedArv} != attempt ARV ${expectedArv}`)
    const grades = gradeResult({
      source: String(result.source ?? ''),
      conf: String(result.conf ?? 'none') as never,
      drivers,
      flags,
      arv: expectedArv,
    }, str(evidence?.fallbackUsed), trail)
    if (valuation.resultGrade !== grades.resultGrade) fail('result.grade', `resultGrade ${valuation.resultGrade} != ${grades.resultGrade}`)
    if (valuation.processGrade !== grades.processGrade) fail('process.grade', `processGrade ${valuation.processGrade} != ${grades.processGrade}`)
    if (mechanics?.harnessVersion && rules?.harnessVersion && mechanics.harnessVersion !== rules.harnessVersion) {
      fail('result.version', 'response mechanics version differs from rules version')
    }
  }

  if (record.status === 'completed' && !response) fail('record.result', 'completed record has no response')
  if (record.status === 'completed' && evidence && Array.isArray(evidence.attempts)
      && canonicalJson(evidence.attempts) !== canonicalJson(record.attempts)) {
    warn('record.attempts', 'evidence.attempts differs from top-level attempts')
  }

  return { file, label: str(subject?.address) ?? basename(file), violations, warnings }
}

const cases: AuditCase[] = []
for (const file of files) {
  const raw = JSON.parse(readFileSync(resolve(file), 'utf8'))
  const payload = raw?.payload?.recordVersion === 'run-record.v1' ? raw.payload : raw
  const storedHash = raw?.payloadHash ?? raw?.payload_hash ?? null
  const audit = check(payload, storedHash, file)
  if (storedHash) {
    const ok = await sha256Text(canonicalJson(payload)) === String(storedHash)
    if (!ok) audit.violations.push({ rule: 'record.hash', message: 'payload hash mismatch' })
  } else {
    audit.warnings.push({ rule: 'record.hash', message: 'no stored payload hash' })
  }
  cases.push(audit)
}

for (const c of cases) {
  const icon = c.violations.length ? '✗' : c.warnings.length ? '!' : '✓'
  console.log(`${icon} ${c.label} — ${basename(c.file)}`)
  for (const v of c.violations) console.log(`    ${v.rule}: ${v.message}`)
  for (const w of c.warnings) console.log(`    warning ${w.rule}: ${w.message}`)
}
const bad = cases.filter((c) => c.violations.length)
console.log(`\n${cases.length} audited — ${cases.length - bad.length} pass, ${bad.length} fail, ${cases.reduce((n, c) => n + c.warnings.length, 0)} warnings`)
if (strict && bad.length) process.exit(1)
