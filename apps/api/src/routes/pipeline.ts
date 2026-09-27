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
 * (subject.listPrice / valuation.listPrice), keyed by the jobId inside
 * evalReportUrl. Runs once per cache refresh, not per request. */
async function enrichQueueListPrices(env: Env, body: unknown): Promise<unknown> {
  const items = (body as { items?: Array<{ evalReportUrl?: string | null; listPrice?: number | null }> })?.items
  if (!Array.isArray(items) || items.length === 0) return body
  const jobIdOf = (item: { evalReportUrl?: string | null }) =>
    item.evalReportUrl?.match(/\/reports\/(job_[^/?#]+)/)?.[1] ?? null
  const jobIds = [...new Set(items.map(jobIdOf).filter((x): x is string => x != null))]
  if (jobIds.length === 0) return body

  const rows = await env.DB.prepare(
    `SELECT job_id, full_response_json FROM saved_reports WHERE job_id IN (${jobIds.map(() => '?').join(',')})`,
  ).bind(...jobIds).all<{ job_id: string; full_response_json: string | null }>()
    .catch((e) => {
      console.error('[Pipeline] listPrice enrichment failed:', e)
      return null
    })

  const priceByJob = new Map<string, number>()
  for (const r of rows?.results ?? []) {
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
  }
  return body
}

export const pipelineReads = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

// GET /v1/pipeline/queue → GET /engine/queue (KV-cached, SWR, listPrice-enriched)
pipelineReads.get('/queue', async (c) => {
  const r = await engineJsonCached(c, '/engine/queue', enrichQueueListPrices)
  if (!r) return c.json({ ok: false, error: 'Engine unavailable' }, 502)
  if (!r.ok) return c.json({ ok: false, error: 'Engine fetch failed' }, 502)
  return c.json(r.body)
})

// GET /v1/pipeline/metrics → GET /engine/dashboard (KV-cached, SWR)
pipelineReads.get('/metrics', async (c) => {
  const r = await engineJsonCached(c, '/engine/dashboard')
  if (!r) return c.json({ ok: false, error: 'Engine unavailable' }, 502)
  if (!r.ok) return c.json({ ok: false, error: 'Engine fetch failed' }, 502)
  return c.json(r.body)
})

export default pipelineReads
