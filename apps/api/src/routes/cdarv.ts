/**
 * CDARV Routes — session-auth gateway to the CDARV learning service.
 *
 * The dashboard calls /cdarv/* with normal session cookies. This route is
 * the single trust boundary: it injects the service-to-service bearer
 * token (CDARV_INTERNAL_API_TOKEN) so service credentials never reach the
 * browser, and it scopes report submission to the caller's own reports.
 *
 * Failure isolation: when CDARV_API_URL is unset or the service is down,
 * these routes return 503 — production analysis never calls CDARV, so a
 * CDARV outage cannot affect underwriting.
 *
 * Also exported: cdarvInternal — POST /internal/cdarv/recalculate, called
 * back by the CDARV worker to run the real recalculateReport() for shadow
 * ARV. CDARV never reimplements valuation math.
 */

import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { Env } from '../types'
import { getSession } from '../lib/session'
import { recalculateReport } from '../services/evaluation/recalculate'

export const cdarv = new Hono<{ Bindings: Env }>()
export const cdarvInternal = new Hono<{ Bindings: Env }>()

const MAX_REPORTS_PER_SUBMIT = 50
const SERVICE_TIMEOUT_MS = 15_000

function cdarvConfig(c: { env: Env }): { base: string; token: string } | null {
  const base = c.env.CDARV_API_URL?.replace(/\/+$/, '')
  const token = c.env.CDARV_INTERNAL_API_TOKEN
  if (!base || !token) return null
  return { base, token }
}

async function serviceFetch(
  c: { env: Env },
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const cfg = cdarvConfig(c)
  if (!cfg) {
    return new Response(
      JSON.stringify({ success: false, error: 'cdarv_unavailable', message: 'CDARV service is not configured' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )
  }
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${cfg.token}`)
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  try {
    return await fetch(`${cfg.base}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
    })
  } catch {
    return new Response(
      JSON.stringify({ success: false, error: 'cdarv_unreachable', message: 'CDARV service request failed' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    )
  }
}

/**
 * Submit saved reports to the CDARV review queue. Idempotent upstream —
 * sending twice returns the existing snapshot.
 */
cdarv.post('/submissions', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const body = await c.req.json<{ reportIds?: string[]; jobIds?: string[] }>().catch(() => null)
  const reportIds = Array.isArray(body?.reportIds)
    ? body.reportIds.filter((v): v is string => typeof v === 'string')
    : []
  const jobIds = Array.isArray(body?.jobIds)
    ? body.jobIds.filter((v): v is string => typeof v === 'string')
    : []
  const ids = [...new Set([...reportIds, ...jobIds])].slice(0, MAX_REPORTS_PER_SUBMIT)
  if (ids.length === 0) {
    return c.json({ success: false, error: 'reportIds or jobIds is required (non-empty array)' }, 400)
  }

  const placeholders = ids.map(() => '?').join(',')
  const rows = await c.env.DB.prepare(
    `SELECT id, user_id, job_id, property_address, property_city, property_state,
            created_at, full_response_json
     FROM saved_reports
     WHERE (id IN (${placeholders}) OR job_id IN (${placeholders})) AND user_id = ?`
  )
    .bind(...ids, ...ids, session.user.id)
    .all<{
      id: string
      user_id: string
      job_id: string | null
      property_address: string
      property_city: string
      property_state: string
      created_at: string
      full_response_json: string | null
    }>()

  const found = new Map<string, (typeof rows.results)[number]>()
  for (const r of rows.results ?? []) {
    found.set(r.id, r)
    if (r.job_id) found.set(r.job_id, r)
  }
  const results: Array<{ reportId: string; outcome: string; snapshotId?: string; error?: string }> = []

  for (const reportId of ids) {
    const row = found.get(reportId)
    if (!row) {
      results.push({ reportId, outcome: 'error', error: 'report not found' })
      continue
    }
    if (!row.full_response_json) {
      results.push({ reportId, outcome: 'error', error: 'report has no stored analysis' })
      continue
    }
    let reportJson: unknown
    try {
      reportJson = JSON.parse(row.full_response_json)
    } catch {
      results.push({ reportId, outcome: 'error', error: 'stored analysis is not valid JSON' })
      continue
    }

    const resp = await serviceFetch(c, '/v1/submissions', {
      method: 'POST',
      body: JSON.stringify({
        report_id: row.id,
        user_id: row.user_id,
        created_at: row.created_at,
        job_id: row.job_id,
        address: [row.property_address, row.property_city, row.property_state]
          .filter(Boolean)
          .join(', '),
        report_json: reportJson,
        submitted_by: session.user.id,
      }),
    })
    if (!resp.ok) {
      const err = await resp.json().catch(() => null)
      results.push({
        reportId,
        outcome: 'error',
        error: (err as { message?: string } | null)?.message ?? `cdarv returned ${resp.status}`,
      })
      continue
    }
    const payload = (await resp.json()) as {
      outcome?: string
      snapshot?: { id?: string; status?: string; completeness?: string }
    }
    results.push({
      reportId,
      outcome: payload.outcome ?? 'unknown',
      snapshotId: payload.snapshot?.id,
    })
  }

  return c.json({ success: true, results })
})

/**
 * Transparent proxy for the rest of the CDARV API:
 *   GET  /cdarv/queue            → GET  {service}/v1/queue
 *   GET  /cdarv/snapshots/:id    → GET  {service}/v1/snapshots/:id
 *   POST /cdarv/reviews/…        → POST {service}/v1/reviews/…
 *   etc.
 */
cdarv.all('/proxy/*', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const suffix = c.req.path.replace(/^\/cdarv\/proxy/, '')
  const url = new URL(c.req.url)
  const hasBody = !['GET', 'HEAD'].includes(c.req.method)
  const resp = await serviceFetch(c, `/v1${suffix}${url.search}`, {
    method: c.req.method,
    body: hasBody ? await c.req.raw.arrayBuffer() : undefined,
  })
  // Pass the service response through verbatim.
  return new Response(resp.body, {
    status: resp.status,
    headers: { 'Content-Type': resp.headers.get('Content-Type') ?? 'application/json' },
  })
})

/**
 * Internal callback: the CDARV worker asks production to run the real
 * recalculateReport() so the shadow ARV uses identical math. Bearer is
 * the same shared token the proxy uses outbound.
 */
cdarvInternal.post(
  '/recalculate',
  bodyLimit({ maxSize: 20_000 }),
  async (c) => {
    const token = c.env.CDARV_INTERNAL_API_TOKEN
    const header = c.req.header('X-CDARV-Internal-Secret')
    const bearer = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '')
    if (!token || (header !== token && bearer !== token)) {
      return c.json({ success: false, error: 'Unauthorized' }, 401)
    }

    const body = await c.req.json<{ reportId?: string; selectedCompIds?: string[] }>().catch(() => null)
    if (!body?.reportId || !Array.isArray(body.selectedCompIds)) {
      return c.json({ success: false, error: 'reportId and selectedCompIds are required' }, 400)
    }

    const row = await c.env.DB.prepare(
      `SELECT id, job_id, full_response_json FROM saved_reports WHERE id = ?`
    )
      .bind(body.reportId)
      .first<{ id: string; job_id: string | null; full_response_json: string | null }>()
    if (!row?.full_response_json) {
      return c.json({ success: false, error: 'report not found' }, 404)
    }

    let saved: Parameters<typeof recalculateReport>[0]
    try {
      saved = JSON.parse(row.full_response_json)
    } catch {
      return c.json({ success: false, error: 'stored analysis is not valid JSON' }, 422)
    }

    try {
      const recalculated = await recalculateReport(saved, row.job_id ?? '', body.selectedCompIds, c.env)
      return c.json({ success: true, report: recalculated, valuation: recalculated.valuation ?? null })
    } catch (err) {
      const status = (err as { status?: number }).status ?? 422
      return c.json({ success: false, error: err instanceof Error ? err.message : 'recalculate failed' }, status as 400)
    }
  }
)
