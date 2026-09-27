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

export const pipelineReads = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

// GET /v1/pipeline/queue → GET /engine/queue
pipelineReads.get('/queue', async (c) => {
  const res = await engineGet(c.env, '/engine/queue')
  if (!res) return c.json({ ok: false, error: 'Engine unavailable' }, 502)
  if (!res.ok) return c.json({ ok: false, error: `Engine ${res.status}` }, res.status as 502)
  return c.json(await res.json())
})

// GET /v1/pipeline/metrics → GET /engine/dashboard
pipelineReads.get('/metrics', async (c) => {
  const res = await engineGet(c.env, '/engine/dashboard')
  if (!res) return c.json({ ok: false, error: 'Engine unavailable' }, 502)
  if (!res.ok) return c.json({ ok: false, error: `Engine ${res.status}` }, res.status as 502)
  return c.json(await res.json())
})

export default pipelineReads
