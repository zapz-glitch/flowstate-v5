/**
 * Rehab Config Routes (Dashboard / Session Auth)
 *
 * Endpoints for reading and updating per-user rehab cost configuration.
 * All routes use session authentication via Better Auth cookies.
 * The config is stored as a single JSON blob per user.
 */

import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import type { Env } from '../types'
import { createAuth } from '../lib/auth'
import { rehabConfig } from '../db'
import { DEFAULT_REHAB_TABLE } from '../services/valuation'
import type { ArvTier, RehabEstimate } from '../services/valuation'

const rehabConfigRoute = new Hono<{ Bindings: Env }>()

// ─── Types ────────────────────────────────────────────────────────────────────

type RehabTable = Record<ArvTier, RehabEstimate[]>

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getSession(c: any) {
  const url = new URL(c.req.url)
  const baseURL = `${url.protocol}//${url.host}/auth`
  const auth = createAuth(c.env.DB, c.env.BETTER_AUTH_SECRET, baseURL)
  try {
    return await auth.api.getSession({ headers: c.req.raw.headers })
  } catch {
    return null
  }
}

function validateRehabTable(table: unknown): table is RehabTable {
  const tiers: ArvTier[] = ['under501k', '501kTo999k', '1mTo3m', 'over3m']
  if (typeof table !== 'object' || table === null) return false
  for (const tier of tiers) {
    const arr = (table as Record<string, unknown>)[tier]
    if (!Array.isArray(arr) || arr.length !== 7) return false
    for (const item of arr) {
      if (typeof (item as any)?.perSqft !== 'number' || typeof (item as any)?.minProfit !== 'number') return false
    }
  }
  return true
}

// ─── GET /rehab-config/defaults ──────────────────────────────────────────────

rehabConfigRoute.get('/defaults', (c) => {
  return c.json({ config: DEFAULT_REHAB_TABLE })
})

// ─── GET /rehab-config ────────────────────────────────────────────────────────

rehabConfigRoute.get('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const db = drizzle(c.env.DB)
  const [row] = await db
    .select()
    .from(rehabConfig)
    .where(eq(rehabConfig.userId, session.user.id))
    .limit(1)

  if (!row) {
    return c.json({ config: DEFAULT_REHAB_TABLE, isCustom: false })
  }

  return c.json({
    config: JSON.parse(row.configJson) as RehabTable,
    isCustom: true,
    updatedAt: row.updatedAt,
  })
})

// ─── PUT /rehab-config ────────────────────────────────────────────────────────

rehabConfigRoute.put('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const body = await c.req.json().catch(() => null)
  if (!body?.config || !validateRehabTable(body.config)) {
    return c.json(
      { error: 'Invalid rehab config: must have 4 tiers (under501k, 501kTo999k, 1mTo3m, over3m) each with 7 entries containing perSqft and minProfit' },
      400
    )
  }

  const db = drizzle(c.env.DB)
  const now = new Date().toISOString()
  const configJson = JSON.stringify(body.config)

  const [existing] = await db
    .select({ id: rehabConfig.id })
    .from(rehabConfig)
    .where(eq(rehabConfig.userId, session.user.id))
    .limit(1)

  if (existing) {
    await db
      .update(rehabConfig)
      .set({ configJson, updatedAt: now })
      .where(eq(rehabConfig.userId, session.user.id))
  } else {
    await db.insert(rehabConfig).values({
      userId: session.user.id,
      configJson,
      createdAt: now,
      updatedAt: now,
    })
  }

  return c.json({ success: true, config: body.config as RehabTable, isCustom: true, updatedAt: now })
})

// ─── DELETE /rehab-config ─────────────────────────────────────────────────────

rehabConfigRoute.delete('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const db = drizzle(c.env.DB)
  await db.delete(rehabConfig).where(eq(rehabConfig.userId, session.user.id))

  return c.json({ config: DEFAULT_REHAB_TABLE, isCustom: false })
})

export default rehabConfigRoute
