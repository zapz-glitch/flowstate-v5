/**
 * Activity events — conversation-intelligence engine telemetry.
 *
 * POST /v1/activity (mounted before the v1 group so its own Bearer auth
 * applies, not the API-key middleware): the CI engine pushes
 * {kind, value, leadId?, propertyAddress?, ts?, meta?} on every funnel
 * event — SMS, stage moves, offer sends, eval completions, intake sends.
 * Authenticated with Bearer CI_INGEST_KEY.
 *
 * GET /v1/activity + GET /v1/activity/summary (inside the v1 group):
 * dashboard-internal reads for the Analytics page — rows for drill-downs
 * and per-kind counts for the metric tiles.
 */
import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import { activityEvents } from '../db'
import type { Env } from '../types'
import type { AuthContext } from '../middleware/auth'

interface ActivityEventBody {
  kind?: unknown
  value?: unknown
  leadId?: unknown
  propertyAddress?: unknown
  ts?: unknown
  meta?: unknown
}

const MAX_ROWS = 500

function asString(v: unknown, max = 500): string | null {
  if (typeof v !== 'string') return null
  const s = v.slice(0, max)
  return s || null
}

function asIso(v: unknown): string | null {
  const s = asString(v, 64)
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

// ─── Ingest (own Bearer auth — mounted ahead of the v1 auth middleware) ────────
export const activityIngest = new Hono<{ Bindings: Env }>()

activityIngest.post('/', async (c) => {
  const expected = c.env.CI_INGEST_KEY
  if (!expected) return c.json({ ok: false, error: 'Ingest not configured' }, 503)
  const token = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  if (token !== expected) return c.json({ ok: false, error: 'Unauthorized' }, 401)

  let body: ActivityEventBody
  try {
    body = await c.req.json()
  } catch {
    return c.json({ ok: false, error: 'Invalid JSON' }, 400)
  }

  const kind = asString(body.kind, 64)
  if (!kind) return c.json({ ok: false, error: 'kind is required' }, 400)

  const ts = asIso(body.ts) ?? new Date().toISOString()
  const meta =
    body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta)
      ? JSON.stringify(body.meta).slice(0, 8000)
      : null

  const db = drizzle(c.env.DB)
  const [row] = await db
    .insert(activityEvents)
    .values({
      kind,
      value: asString(body.value, 500),
      leadId: asString(body.leadId, 128),
      propertyAddress: asString(body.propertyAddress, 300),
      ts,
      meta,
    })
    .returning({ id: activityEvents.id })
  return c.json({ ok: true, id: row.id })
})

// ─── Reads (inside v1 — dashboard-internal auth via authMiddleware) ────────────
export const activityReads = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>()

// GET /v1/activity?kind=a,b&since=<ISO>&until=<ISO>&limit=<n>
// Rows newest-first for metric drill-downs.
activityReads.get('/', async (c) => {
  const kinds = (c.req.query('kind') ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
  const since = asIso(c.req.query('since'))
  const until = asIso(c.req.query('until'))
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '200', 10) || 0, 1), MAX_ROWS)

  const where = and(
    kinds.length ? inArray(activityEvents.kind, kinds) : undefined,
    since ? gte(activityEvents.ts, since) : undefined,
    until ? lte(activityEvents.ts, until) : undefined,
  )

  const db = drizzle(c.env.DB)
  const rows = await db
    .select({
      id: activityEvents.id,
      kind: activityEvents.kind,
      value: activityEvents.value,
      leadId: activityEvents.leadId,
      propertyAddress: activityEvents.propertyAddress,
      ts: activityEvents.ts,
      meta: activityEvents.meta,
    })
    .from(activityEvents)
    .where(where)
    .orderBy(desc(activityEvents.ts))
    .limit(limit)

  return c.json({ ok: true, rows })
})

// GET /v1/activity/summary?since=<ISO>&until=<ISO>
// Per-kind counts for the Analytics metric tiles.
activityReads.get('/summary', async (c) => {
  const since = asIso(c.req.query('since'))
  const until = asIso(c.req.query('until'))

  const db = drizzle(c.env.DB)
  const rows = await db
    .select({ kind: activityEvents.kind, n: sql<number>`count(*)` })
    .from(activityEvents)
    .where(
      and(
        since ? gte(activityEvents.ts, since) : undefined,
        until ? lte(activityEvents.ts, until) : undefined,
      ),
    )
    .groupBy(activityEvents.kind)

  const counts: Record<string, number> = {}
  for (const r of rows) counts[r.kind] = r.n
  return c.json({ ok: true, counts })
})

export default activityIngest
