/**
 * Immutable run record — one canonical evidence payload per evaluation.
 *
 * saved_reports is the current property view and can be overwritten on a
 * rerun. run_records is the audit trail: request, effective rules,
 * subject/comp evidence, every Set-B attempt, and the terminal result.
 */

import { HARNESS_VERSION } from '@flowstate-api/shared/appraisal'
import { EVALUATION_PIPELINE_VERSION } from './report'

export type RunRecordStatus = 'completed' | 'error' | 'cached' | 'persistence_error'

export interface RunRecordPayload {
  recordVersion: 'run-record.v1'
  jobId: string
  userId: string
  status: RunRecordStatus
  recordedAt: string
  request: {
    search: unknown
    searchOptions: unknown
    enrichment: unknown
    evalParams: unknown
    skipCache: boolean
    isRefresh: boolean
    cachedJobId?: string | null
  }
  property: {
    address: string | null
    city: string | null
    state: string | null
    zipCode: string | null
    clip: string | null
  }
  rules: {
    harnessVersion: string
    pipelineVersion: string
  }
  evidence: unknown
  attempts: unknown[]
  result: {
    response?: unknown
    errorCode?: string | null
    errorMessage?: string | null
  }
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

function canonicalValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (typeof value === 'object') {
    const out: Record<string, JsonValue> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key]
      if (typeof item === 'function' || typeof item === 'symbol') continue
      out[key] = canonicalValue(item)
    }
    return out
  }
  return null
}

/** Stable JSON: sorted object keys, undefined/functions normalized away. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value))
}

export async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === 'string' && value.length) return value
  return null
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

function subjectOf(response: unknown): Record<string, unknown> | null {
  const subject = (response as { subject?: unknown } | null | undefined)?.subject
  return subject && typeof subject === 'object' && !Array.isArray(subject)
    ? subject as Record<string, unknown>
    : null
}

export function buildRunRecordPayload(input: {
  jobId: string
  userId: string
  status: RunRecordStatus
  request: {
    search?: unknown
    searchOptions?: unknown
    enrichment?: unknown
    evalParams?: unknown
    skipCache?: boolean
    isRefresh?: boolean
    cachedJobId?: string | null
  }
  evidence?: unknown
  attempts?: unknown[]
  response?: unknown
  errorCode?: string | null
  errorMessage?: string | null
  recordedAt?: string
}): RunRecordPayload {
  const subject = subjectOf(input.response)
  const request = input.request
  const search = request.search as Record<string, unknown> | null | undefined
  return {
    recordVersion: 'run-record.v1',
    jobId: input.jobId,
    userId: input.userId,
    status: input.status,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    request: {
      search: request.search ?? null,
      searchOptions: request.searchOptions ?? null,
      enrichment: request.enrichment ?? null,
      evalParams: request.evalParams ?? null,
      skipCache: request.skipCache === true,
      isRefresh: request.isRefresh === true,
      cachedJobId: request.cachedJobId ?? null,
    },
    property: {
      address: firstString(subject?.address, search?.address, search?.streetAddress),
      city: firstString(subject?.city, search?.city),
      state: firstString(subject?.state, search?.state),
      zipCode: firstString(subject?.zipCode, search?.zipCode),
      clip: firstString(subject?.id, subject?.clip, search?.propertyId),
    },
    rules: {
      harnessVersion: HARNESS_VERSION,
      pipelineVersion: EVALUATION_PIPELINE_VERSION,
    },
    evidence: input.evidence ?? null,
    attempts: input.attempts ?? [],
    result: {
      response: input.response,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
    },
  }
}

export function runRecordSummary(payload: RunRecordPayload, payloadJson = canonicalJson(payload)) {
  const response = payload.result.response as Record<string, unknown> | null | undefined
  const valuation = response?.valuation as Record<string, unknown> | null | undefined
  const mechanics = valuation?.bMechanics as Record<string, unknown> | null | undefined
  const comps = response?.comps as Record<string, unknown> | null | undefined
  const evidence = payload.evidence as Record<string, unknown> | null | undefined
  return {
    arv: firstNumber(valuation?.arv, valuation?.arvB),
    resultGrade: firstString(valuation?.resultGrade),
    processGrade: firstString(valuation?.processGrade),
    harnessVersion: firstString(mechanics?.harnessVersion, payload.rules.harnessVersion),
    pipelineVersion: payload.rules.pipelineVersion,
    requestHashSource: canonicalJson(payload.request),
    evidenceHashSource: canonicalJson(payload.evidence),
    payloadJson,
    attemptCount: payload.attempts.length,
    compCount: firstNumber(comps?.total, (evidence?.compPool as { length?: number } | undefined)?.length),
    enabledCompCount: firstNumber(comps?.enabledCount),
  }
}

/**
 * Insert the immutable record. report_id is patched after saved_reports
 * resolves its property row — the evidence write must happen before the
 * current report can be overwritten.
 */
export async function insertRunRecord(
  db: D1Database,
  payload: RunRecordPayload,
): Promise<{ id: string; payloadHash: string }> {
  const payloadJson = canonicalJson(payload)
  const summary = runRecordSummary(payload, payloadJson)
  const id = crypto.randomUUID()
  const [requestHash, evidenceHash, payloadHash] = await Promise.all([
    sha256Text(summary.requestHashSource),
    sha256Text(summary.evidenceHashSource),
    sha256Text(payloadJson),
  ])
  const property = payload.property

  await db.prepare(`
    INSERT INTO run_records (
      id, job_id, user_id, report_id,
      property_address, property_city, property_state, property_zip, property_clip,
      status, error_code, error_message, arv, result_grade, process_grade,
      harness_version, pipeline_version, request_hash, evidence_hash, payload_hash,
      attempt_count, comp_count, enabled_comp_count, payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    payload.jobId,
    payload.userId,
    null,
    property.address,
    property.city,
    property.state,
    property.zipCode,
    property.clip,
    payload.status,
    payload.result.errorCode,
    payload.result.errorMessage,
    summary.arv,
    summary.resultGrade,
    summary.processGrade,
    summary.harnessVersion,
    summary.pipelineVersion,
    requestHash,
    evidenceHash,
    payloadHash,
    summary.attemptCount,
    summary.compCount,
    summary.enabledCompCount,
    payloadJson,
    payload.recordedAt,
  ).run()

  return { id, payloadHash }
}

export async function linkRunRecordToReport(
  db: D1Database,
  recordId: string,
  jobId: string,
  userId: string,
): Promise<void> {
  const row = await db.prepare('SELECT id FROM saved_reports WHERE job_id = ? AND user_id = ? LIMIT 1')
    .bind(jobId, userId)
    .first<{ id: string }>()
  if (!row?.id) return
  await db.prepare('UPDATE run_records SET report_id = ? WHERE id = ? AND report_id IS NULL')
    .bind(row.id, recordId)
    .run()
}
