/**
 * Pipeline routes — Give Offer queue + funnel metrics.
 *
 * The conversation-intelligence engine owns canonical funnel state
 * (it observes reach-outs/responses at webhook receipt). These
 * endpoints proxy its reads so the dashboard keeps the standard
 * internal auth and ENGINE_API_KEY never leaves the worker.
 */

import { Hono } from 'hono'
import { pocketFromPayload, deterministicInputs, provisionalScore, scorePocket, metroGuess } from '../services/pocket-score'
import type { Env } from '../types'
import type { AuthContext } from '../middleware/auth'

const ENGINE_BASE = 'https://flowstate-workers.weareflowstate1.workers.dev'

async function engineGet(env: Env, path: string, timeoutMs = 10_000): Promise<Response | null> {
  if (!env.ENGINE_API_KEY) return null
  return fetch(`${ENGINE_BASE}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Authorization: `Bearer ${env.ENGINE_API_KEY}` },
  }).catch((e) => {
    console.error('[Pipeline] engine fetch failed:', path, e)
    return null
  })
}

/** The engine's /engine/queue + /engine/dashboard calls are expensive —
 * they fan out one Close API request per queued lead (≈4s for 24 items)
 * while the dashboard polls every 5s. Serve a shared KV copy
 * stale-while-revalidate: instant reads, one engine call per FRESH_MS.
 */
const PROXY_FRESH_MS = 30_000
const proxyKey = (path: string) => `engine-proxy:${path}`

type ProxyTransform = (env: Env, body: unknown) => Promise<unknown>

/** The queue refresh runs in waitUntil against a fan-out that scales with
 *  queue depth (one Close call per lead) — 10s starves it past ~50 items
 *  and the stale snapshot serves forever. Give the background refresh room. */
const REFRESH_TIMEOUT_MS = 120_000

/** Single-flight marker — one engine fan-out at a time per path. Without it
 *  a ~60s cold read lets every dashboard poll (5s) spawn its own engine call
 *  (thundering herd on Close), and if a background refresh dies mid-flight
 *  the lock's expiry lets the next poll retry instead of wedging forever. */
const REFRESH_LOCK_MS = 150_000
const refreshLockKey = (path: string) => `engine-proxy-refresh:${path}`

async function refreshProxy(env: Env, path: string, transform?: ProxyTransform): Promise<void> {
  try {
    const res = await engineGet(env, path, REFRESH_TIMEOUT_MS)
    if (!res?.ok) return
    let body = await res.json().catch(() => null)
    if (body == null) return
    if (transform) body = await transform(env, body)
    await env.API_CACHE.put(proxyKey(path), JSON.stringify({ t: Date.now(), body }))
  } finally {
    await env.API_CACHE.delete(refreshLockKey(path)).catch(() => {})
  }
}

/** Non-blocking lock acquire — true when this caller owns the refresh. */
async function acquireRefresh(env: Env, path: string): Promise<boolean> {
  const held = await env.API_CACHE.get(refreshLockKey(path)).catch(() => null)
  if (held) return false
  await env.API_CACHE.put(refreshLockKey(path), '1', { expirationTtl: Math.ceil(REFRESH_LOCK_MS / 1000) }).catch(() => {})
  return true
}

async function engineJsonCached(
  c: { env: Env; executionCtx: { waitUntil(p: Promise<unknown>): void } },
  path: string,
  transform?: ProxyTransform,
): Promise<{ ok: boolean; body: unknown } | null> {
  const cached = await c.env.API_CACHE.get<{ t: number; body: unknown }>(proxyKey(path), 'json')
  if (cached) {
    if (Date.now() - cached.t >= PROXY_FRESH_MS && await acquireRefresh(c.env, path)) {
      c.executionCtx.waitUntil(refreshProxy(c.env, path, transform))
    }
    return { ok: true, body: cached.body }
  }
  // Cold path: no cached body to fall back on — a slow-but-successful read
  // beats a 502, and this is a once-per-30s caller anyway. When another
  // request already holds the refresh, fail fast and let the poll retry.
  if (!await acquireRefresh(c.env, path)) return { ok: false, body: null }
  try {
    const res = await engineGet(c.env, path, 60_000)
    if (!res) return null
    let body = await res.json().catch(() => null)
    if (res.ok && body != null) {
      if (transform) body = await transform(c.env, body)
      c.executionCtx.waitUntil(
        c.env.API_CACHE.put(proxyKey(path), JSON.stringify({ t: Date.now(), body })),
      )
    }
    return res.ok ? { ok: true, body } : { ok: false, body }
  } finally {
    c.executionCtx.waitUntil(c.env.API_CACHE.delete(refreshLockKey(path)).catch(() => {}))
  }
}

/** Attach each queue item's asking price — the engine only sends
 * wholesalePrice; listPrice lives in our saved report's analysis JSON
 * (subject.listPrice / valuation.listPrice). Primary key is the jobId
 * inside evalReportUrl; when that yields nothing (the queued re-eval's
 * report never persisted, or points at another env), fall back to the
 * newest saved report carrying the item's leadId — the engine passes
 * leadId into the eval so sibling reports share it. */
async function enrichQueueListPrices(env: Env, body: unknown): Promise<unknown> {
  const items = (body as { items?: Array<{ evalReportUrl?: string | null; leadId?: string | null; listPrice?: number | null }> })?.items
  if (!Array.isArray(items) || items.length === 0) return body
  const jobIdOf = (item: { evalReportUrl?: string | null }) =>
    item.evalReportUrl?.match(/\/reports\/(job_[^/?#]+)/)?.[1] ?? null
  const jobIds = [...new Set(items.map(jobIdOf).filter((x): x is string => x != null))]
  if (jobIds.length === 0) return body

  // D1 caps ~100 binds per query — chunk like attachPockets.
  const rows: { results: Array<{ job_id: string; property_address: string | null; full_response_json: string | null }> } = { results: [] }
  for (let i = 0; i < jobIds.length; i += 90) {
    const chunk = jobIds.slice(i, i + 90)
    const r = await env.DB.prepare(
      `SELECT job_id, property_address, full_response_json FROM saved_reports WHERE job_id IN (${chunk.map(() => '?').join(',')})`,
    ).bind(...chunk).all<{ job_id: string; property_address: string | null; full_response_json: string | null }>()
      .catch((e) => {
        console.error('[Pipeline] listPrice enrichment failed:', e)
        return null
      })
    if (r?.results) rows.results.push(...r.results)
  }

  const priceByJob = new Map<string, number>()
  const addrByJob = new Map<string, string>()
  for (const r of rows?.results ?? []) {
    if (r.property_address) addrByJob.set(r.job_id, r.property_address)
    try {
      const a = JSON.parse(r.full_response_json ?? '{}') as {
        subject?: { listPrice?: number | null }
        valuation?: { listPrice?: number | null }
      }
      const lp = a.subject?.listPrice ?? a.valuation?.listPrice
      if (typeof lp === 'number' && lp > 0) priceByJob.set(r.job_id, lp)
    } catch { /* corrupted row — skip */ }
  }

  for (const item of items) {
    const jobId = jobIdOf(item)
    item.listPrice = jobId ? (priceByJob.get(jobId) ?? null) : null
    // Engine queue addresses are street-only — the saved report carries the
    // full resolved address incl. ZIP; surface it for display.
    const addr = jobId ? addrByJob.get(jobId) : undefined
    if (addr) (item as { fullAddress?: string }).fullAddress = addr
  }

  // LeadId fallback for items still null — a sibling report under the
  // same lead may carry the ask (queue jobIds occasionally reference
  // evals that never persisted a saved report).
  const missingLeads = [...new Set(
    items.filter((i) => i.listPrice == null && i.leadId).map((i) => i.leadId as string),
  )]
  if (missingLeads.length > 0) {
    const lrows: { results: Array<{ lead_id: string | null; lp: number | null }> } = { results: [] }
    for (let i = 0; i < missingLeads.length; i += 90) {
      const chunk = missingLeads.slice(i, i + 90)
      const r = await env.DB.prepare(
        `SELECT json_extract(full_response_json, '$.leadId') AS lead_id,
                COALESCE(json_extract(full_response_json, '$.subject.listPrice'),
                         json_extract(full_response_json, '$.valuation.listPrice')) AS lp
           FROM saved_reports
          WHERE json_extract(full_response_json, '$.leadId') IN (${chunk.map(() => '?').join(',')})
            AND COALESCE(json_extract(full_response_json, '$.subject.listPrice'),
                         json_extract(full_response_json, '$.valuation.listPrice')) IS NOT NULL
          ORDER BY created_at DESC`,
      ).bind(...chunk).all<{ lead_id: string | null; lp: number | null }>()
        .catch((e) => {
          console.error('[Pipeline] listPrice leadId fallback failed:', e)
          return null
        })
      if (r?.results) lrows.results.push(...r.results)
    }

    const priceByLead = new Map<string, number>()
    for (const r of lrows?.results ?? []) {
      // Rows arrive newest-first — keep the first hit per lead.
      if (r.lead_id && typeof r.lp === 'number' && r.lp > 0 && !priceByLead.has(r.lead_id)) {
        priceByLead.set(r.lead_id, r.lp)
      }
    }
    for (const item of items) {
      if (item.listPrice == null && item.leadId) {
        item.listPrice = priceByLead.get(item.leadId) ?? null
      }
    }
  }
  return body
}

export const pipelineReads = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

// ── Queue hide-list — dismissed items filtered from every queue read ─────
// Reversible, never writes to Close: the engine keeps the opp at "Give
// offer"; it just stops showing to us. DELETE adds; the list key holds a
// JSON set of opportunityIds.
const HIDE_KEY = 'pipeline-hidden-opps'

async function hiddenOpps(env: Env): Promise<Set<string>> {
  const list = await env.API_CACHE.get(HIDE_KEY, 'json').catch(() => null)
  return new Set(Array.isArray(list) ? (list as string[]) : [])
}

/** Loose street-level dedupe key — engine items and saved reports spell the
 * same address differently ("800 40th St S" vs "800 40TH ST S …"). */
function addrKey(a?: string | null): string {
  return (a ?? '').toLowerCase().split(',')[0].replace(/[^a-z0-9]/g, '')
}

/** In-flight evals for this user — KV markers written by AnalysisJobDO at
 * run start and cleared on finish. These render as "Evaluating" rows. */
async function inflightEvalItems(env: Env, userId: string | undefined): Promise<Array<Record<string, unknown>>> {
  if (!userId) return []
  const list = await env.API_CACHE.list({ prefix: `eval-active:${userId}:` }).catch(() => null)
  const items: Array<Record<string, unknown>> = []
  for (const k of list?.keys ?? []) {
    const v = await env.API_CACHE.get(k.name, 'json').catch(() => null) as
      { jobId?: string; address?: string; startedAt?: string } | null
    if (!v?.jobId) continue
    items.push({
      leadId: `inflight_${v.jobId}`,
      opportunityId: null,
      displayName: v.address ?? v.jobId,
      address: v.address ?? 'Evaluating…',
      wholesalePrice: null,
      listPrice: null,
      fullAddress: v.address ?? null,
      evalReportUrl: null,
      evalSummary: null,
      conditionNotes: [],
      draft: null,
      queuedAt: v.startedAt ?? new Date().toISOString(),
      offer_stage: 'evaluating',
      source: 'api',
    })
  }
  return items
}

/** Today's completed evals as synthetic queue items — the engine queue only
 * carries engine-tracked leads; direct /v1/analyze runs land here. */
async function apiEvalQueueItems(env: Env, userId: string | undefined): Promise<Array<Record<string, unknown>>> {
  if (!userId) return []
  const rows = await env.DB.prepare(
    `SELECT r.job_id, r.property_address, r.property_city, r.property_state,
            r.property_zip, r.status, r.arv, r.created_at, r.report_id
       FROM run_records r
      WHERE r.user_id = ? AND r.created_at >= datetime('now', '-24 hours')
      ORDER BY r.created_at DESC`,
  ).bind(userId).all<{
    job_id: string; property_address: string | null; property_city: string | null
    property_state: string | null; property_zip: string | null
    status: string; arv: number | null; created_at: string; report_id: string | null
  }>().catch((e) => {
    console.error('[Pipeline] api-eval merge failed:', e)
    return null
  })

  const items: Array<Record<string, unknown>> = []
  for (const r of rows?.results ?? []) {
    if (!r.job_id || r.status === 'error') continue
    const address = [r.property_address, r.property_city, r.property_state]
      .filter(Boolean).join(', ') || r.job_id
    items.push({
      leadId: `eval_${r.job_id}`,
      opportunityId: null,
      displayName: address,
      address,
      wholesalePrice: r.arv ?? null,
      listPrice: null,
      fullAddress: [r.property_address, r.property_city, r.property_state, r.property_zip].filter(Boolean).join(', '),
      evalReportUrl: `/dashboard/reports/${r.job_id}`,
      evalSummary: r.arv ? { arv: r.arv } : null,
      conditionNotes: [],
      draft: null,
      queuedAt: r.created_at,
      offer_stage: 'waiting_for_offers',
      source: 'api',
    })
  }
  return items
}

// GET /v1/pipeline/queue → GET /engine/queue (KV-cached, SWR, listPrice-enriched,
// hidden items filtered) + today's API evals merged in
pipelineReads.get('/queue', async (c) => {
  const r = await engineJsonCached(c, '/engine/queue', enrichQueueListPrices)
  if (!r) return c.json({ ok: false, error: 'Engine unavailable' }, 502)
  if (!r.ok) return c.json({ ok: false, error: 'Engine fetch failed' }, 502)
  const hidden = await hiddenOpps(c.env)
  const body = r.body as { items?: Array<{ opportunityId?: string; address?: string }>; count?: number }
  if (Array.isArray(body?.items) && hidden.size) {
    body.items = body.items.filter((i) =>
      (!i.opportunityId || !hidden.has(i.opportunityId)) && !hidden.has((i as { leadId?: string }).leadId ?? ''))
  }
  const auth = c.get('auth') as AuthContext | undefined
  const [apiItems, inflight] = await Promise.all([
    apiEvalQueueItems(c.env, auth?.userId),
    inflightEvalItems(c.env, auth?.userId),
  ])
  if (apiItems.length || inflight.length) {
    const seen = new Set((body.items ?? []).flatMap((i) => [addrKey(i.address)]).filter(Boolean))
    const fresh = [...apiItems, ...inflight].filter((i) => !seen.has(addrKey(i.address as string)))
    body.items = [...(body.items ?? []), ...fresh]
  }
  await attachPockets(c, body.items ?? [])
  body.count = body.items?.length ?? 0
  return c.json(body)
})

/** Resolve each item's pocket from its run_records payload → join
 *  pocket_scores → attach metro/pocketScore/pocketName. Misses get a
 *  provisional score now and a full Serper+Luna scoring job in waitUntil. */
async function attachPockets(
  c: { env: Env; executionCtx: { waitUntil(p: Promise<unknown>): void } },
  items: Array<Record<string, unknown>>,
): Promise<void> {
  if (!items.length) return
  const jobIdOf = (i: Record<string, unknown>) =>
    (i.evalReportUrl as string | undefined)?.match(/\/reports\/(job_[^/?#]+)/)?.[1] ?? null
  const jobIds = [...new Set(items.map(jobIdOf).filter((x): x is string => x != null))]
  if (!jobIds.length) return

  // D1 caps ~100 binds per query — chunk; and pull only the subtrees
  // scoring reads (evidence + report), not the full payload.
  const payloadByJob = new Map<string, string>()
  for (let i = 0; i < jobIds.length; i += 90) {
    const chunk = jobIds.slice(i, i + 90)
    const rows = await c.env.DB.prepare(
      `SELECT job_id,
              json_extract(payload_json, '$.evidence') AS evidence,
              json_extract(payload_json, '$.result.response.report') AS report
         FROM run_records WHERE job_id IN (${chunk.map(() => '?').join(',')})`,
    ).bind(...chunk).all<{ job_id: string; evidence: string | null; report: string | null }>().catch(() => null)
    for (const r of rows?.results ?? []) {
      payloadByJob.set(r.job_id, JSON.stringify({ evidence: JSON.parse(r.evidence ?? 'null'), result: { response: { report: JSON.parse(r.report ?? 'null') } } }))
    }
  }

  // Pass 1 — derive pocket identity + deterministic inputs per item.
  const resolved = new Map<string, { id: ReturnType<typeof pocketFromPayload> & object; inputs: ReturnType<typeof deterministicInputs> }>()
  const pockets = new Map<string, { id: NonNullable<ReturnType<typeof pocketFromPayload>>; inputs: ReturnType<typeof deterministicInputs> }>()
  for (const item of items) {
    const jobId = jobIdOf(item)
    const payloadRaw = jobId ? payloadByJob.get(jobId) : undefined
    if (!payloadRaw) continue
    let payload: unknown = null
    try { payload = JSON.parse(payloadRaw) } catch { continue }
    const id = pocketFromPayload(payload)
    if (!id) continue
    item.pocketKey = id.pocketKey
    item.pocketName = id.displayName
    const inputs = deterministicInputs(payload, item.listPrice as number | null)
    resolved.set(jobId as string, { id, inputs })
    if (!pockets.has(id.pocketKey)) pockets.set(id.pocketKey, { id, inputs })
  }
  if (!pockets.size) return

  // Pass 2 — one batch fetch for cached pocket scores.
  const keys = [...pockets.keys()]
  const cached = await c.env.DB.prepare(
    `SELECT pocket_key, score, metro FROM pocket_scores WHERE pocket_key IN (${keys.map(() => '?').join(',')})`,
  ).bind(...keys).all<{ pocket_key: string; score: number | null; metro: string | null }>().catch(() => null)
  const scoreByPocket = new Map((cached?.results ?? []).map((r) => [r.pocket_key, r]))

  // Pass 3 — attach; queue one scoring job per uncached pocket.
  const pending: Promise<unknown>[] = []
  for (const [jobId, { id, inputs }] of resolved) {
    const item = items.find((i) => jobIdOf(i) === jobId)
    if (!item) continue
    const hit = scoreByPocket.get(id.pocketKey)
    item.pocketScore = hit?.score ?? provisionalScore(inputs)
    item.metro = hit?.metro ?? metroGuess(id.state)
  }
  for (const [key, { id, inputs }] of pockets) {
    if (scoreByPocket.has(key)) continue
    pending.push(scorePocket(c.env, id, inputs, null))
  }
  if (pending.length) c.executionCtx.waitUntil(Promise.allSettled(pending))
}

// DELETE /v1/pipeline/queue/:opportunityId — hide a stale item from the
// waiting queue. Reversible via POST .../unhide; Close untouched.
pipelineReads.delete('/queue/:opportunityId', async (c) => {
  const oppId = c.req.param('opportunityId')
  const hidden = await hiddenOpps(c.env)
  hidden.add(oppId)
  await c.env.API_CACHE.put(HIDE_KEY, JSON.stringify([...hidden]))
  return c.json({ ok: true, hidden: oppId })
})

pipelineReads.post('/queue/:opportunityId/unhide', async (c) => {
  const oppId = c.req.param('opportunityId')
  const hidden = await hiddenOpps(c.env)
  hidden.delete(oppId)
  await c.env.API_CACHE.put(HIDE_KEY, JSON.stringify([...hidden]))
  return c.json({ ok: true, unhidden: oppId })
})

// GET /v1/pipeline/metrics?since=<ISO> → GET /engine/dashboard (KV-cached, SWR)
pipelineReads.get('/metrics', async (c) => {
  const since = c.req.query('since')
  const path = `/engine/dashboard${since ? `?since=${encodeURIComponent(since)}` : ''}`
  const r = await engineJsonCached(c, path)
  if (!r) return c.json({ ok: false, error: 'Engine unavailable' }, 502)
  if (!r.ok) return c.json({ ok: false, error: 'Engine fetch failed' }, 502)
  return c.json(r.body)
})

export default pipelineReads
