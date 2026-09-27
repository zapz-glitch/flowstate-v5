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

async function refreshProxy(env: Env, path: string): Promise<void> {
  const res = await engineGet(env, path)
  if (!res?.ok) return
  const body = await res.json().catch(() => null)
  if (body == null) return
  await env.API_CACHE.put(proxyKey(path), JSON.stringify({ t: Date.now(), body }))
}

async function engineJsonCached(
  c: { env: Env; executionCtx: { waitUntil(p: Promise<unknown>): void } },
  path: string,
): Promise<{ ok: boolean; body: unknown } | null> {
  const cached = await c.env.API_CACHE.get<{ t: number; body: unknown }>(proxyKey(path), 'json')
  if (cached) {
    if (Date.now() - cached.t >= PROXY_FRESH_MS) {
      c.executionCtx.waitUntil(refreshProxy(c.env, path))
    }
    return { ok: true, body: cached.body }
  }
  const res = await engineGet(c.env, path)
  if (!res) return null
  const body = await res.json().catch(() => null)
  if (res.ok && body != null) {
    c.executionCtx.waitUntil(
      c.env.API_CACHE.put(proxyKey(path), JSON.stringify({ t: Date.now(), body })),
    )
  }
  return res.ok ? { ok: true, body } : { ok: false, body }
}

export const pipelineReads = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

// GET /v1/pipeline/queue → GET /engine/queue (KV-cached, SWR)
pipelineReads.get('/queue', async (c) => {
  const r = await engineJsonCached(c, '/engine/queue')
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
