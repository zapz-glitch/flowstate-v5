/**
 * Pipeline routes — Give Offer queue + funnel metrics.
 *
 * The conversation-intelligence engine owns canonical funnel state
 * (it observes reach-outs/responses at webhook receipt). These
 * endpoints proxy its reads so the dashboard keeps the standard
 * internal auth and ENGINE_API_KEY never leaves the worker.
 */

import { Hono } from 'hono'
import type { Env } from '../types'
import type { AuthContext } from '../middleware/auth'

const ENGINE_BASE = 'https://conversation-intelligence.weareflowstate1.workers.dev'

async function engineGet(env: Env, path: string): Promise<Response | null> {
  if (!env.ENGINE_API_KEY) return null
  return fetch(`${ENGINE_BASE}${path}`, {
    signal: AbortSignal.timeout(10000),
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

async function refreshProxy(env: Env, path: string, transform?: ProxyTransform): Promise<void> {
  const res = await engineGet(env, path)
  if (!res?.ok) return
  let body = await res.json().catch(() => null)
  if (body == null) return
  if (transform) body = await transform(env, body)
  await env.API_CACHE.put(proxyKey(path), JSON.stringify({ t: Date.now(), body }))
}

async function engineJsonCached(
  c: { env: Env; executionCtx: { waitUntil(p: Promise<unknown>): void } },
  path: string,
  transform?: ProxyTransform,
): Promise<{ ok: boolean; body: unknown } | null> {
  const cached = await c.env.API_CACHE.get<{ t: number; body: unknown }>(proxyKey(path), 'json')
  if (cached) {
    if (Date.now() - cached.t >= PROXY_FRESH_MS) {
      c.executionCtx.waitUntil(refreshProxy(c.env, path, transform))
    }
    return { ok: true, body: cached.body }
  }
  const res = await engineGet(c.env, path)
  if (!res) return null
  let body = await res.json().catch(() => null)
  if (res.ok && body != null) {
    if (transform) body = await transform(c.env, body)
    c.executionCtx.waitUntil(
      c.env.API_CACHE.put(proxyKey(path), JSON.stringify({ t: Date.now(), body })),
    )
  }
  return res.ok ? { ok: true, body } : { ok: false, body }
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

  const rows = await env.DB.prepare(
    `SELECT job_id, property_address, full_response_json FROM saved_reports WHERE job_id IN (${jobIds.map(() => '?').join(',')})`,
  ).bind(...jobIds).all<{ job_id: string; property_address: string | null; full_response_json: string | null }>()
    .catch((e) => {
      console.error('[Pipeline] listPrice enrichment failed:', e)
      return null
    })

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
    const lrows = await env.DB.prepare(
      `SELECT json_extract(full_response_json, '$.leadId') AS lead_id,
              COALESCE(json_extract(full_response_json, '$.subject.listPrice'),
                       json_extract(full_response_json, '$.valuation.listPrice')) AS lp
         FROM saved_reports
        WHERE json_extract(full_response_json, '$.leadId') IN (${missingLeads.map(() => '?').join(',')})
          AND COALESCE(json_extract(full_response_json, '$.subject.listPrice'),
                       json_extract(full_response_json, '$.valuation.listPrice')) IS NOT NULL
        ORDER BY created_at DESC`,
    ).bind(...missingLeads).all<{ lead_id: string | null; lp: number | null }>()
      .catch((e) => {
        console.error('[Pipeline] listPrice leadId fallback failed:', e)
        return null
      })

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

// GET /v1/pipeline/queue → GET /engine/queue (KV-cached, SWR, listPrice-enriched,
// hidden items filtered)
pipelineReads.get('/queue', async (c) => {
  const r = await engineJsonCached(c, '/engine/queue', enrichQueueListPrices)
  if (!r) return c.json({ ok: false, error: 'Engine unavailable' }, 502)
  if (!r.ok) return c.json({ ok: false, error: 'Engine fetch failed' }, 502)
  const hidden = await hiddenOpps(c.env)
  const body = r.body as { items?: Array<{ opportunityId?: string }>; count?: number }
  if (Array.isArray(body?.items) && hidden.size) {
    body.items = body.items.filter((i) => !i.opportunityId || !hidden.has(i.opportunityId))
    body.count = body.items.length
  }
  return c.json(body)
})

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
