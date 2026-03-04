/**
 * Rehab Config Routes (Public API / Bearer Token Auth)
 *
 * Endpoints for reading and updating per-user rehab cost configuration
 * via API key authentication. Mounted under /v1/rehab-config.
 */

import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import type { Env } from '../types'
import type { AuthContext } from '../middleware/auth'
import { rehabConfig } from '../db'
import { DEFAULT_REHAB_TABLE } from '../services/valuation'
import type { ArvTier, RehabEstimate } from '../services/valuation'

type Variables = { auth: AuthContext }

const rehabConfigV1 = new Hono<{ Bindings: Env; Variables: Variables }>()

// ─── Types ────────────────────────────────────────────────────────────────────

type RehabTable = Record<ArvTier, RehabEstimate[]>

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── GET /v1/rehab-config/defaults ───────────────────────────────────────────

rehabConfigV1.get('/defaults', (c) => {
  return c.json({ config: DEFAULT_REHAB_TABLE })
})

// ─── GET /v1/rehab-config ─────────────────────────────────────────────────────

rehabConfigV1.get('/', async (c) => {
  const auth = c.get('auth')
  const db = drizzle(c.env.DB)

  const [row] = await db
    .select()
    .from(rehabConfig)
    .where(eq(rehabConfig.userId, auth.userId))
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

// ─── PUT /v1/rehab-config ─────────────────────────────────────────────────────

rehabConfigV1.put('/', async (c) => {
  const auth = c.get('auth')

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
    .where(eq(rehabConfig.userId, auth.userId))
    .limit(1)

  if (existing) {
    await db
      .update(rehabConfig)
      .set({ configJson, updatedAt: now })
      .where(eq(rehabConfig.userId, auth.userId))
  } else {
    await db.insert(rehabConfig).values({
      userId: auth.userId,
      configJson,
      createdAt: now,
      updatedAt: now,
    })
  }

  return c.json({ success: true, config: body.config as RehabTable, isCustom: true, updatedAt: now })
})

// ─── DELETE /v1/rehab-config ──────────────────────────────────────────────────

rehabConfigV1.delete('/', async (c) => {
  const auth = c.get('auth')
  const db = drizzle(c.env.DB)

  await db.delete(rehabConfig).where(eq(rehabConfig.userId, auth.userId))

  return c.json({ config: DEFAULT_REHAB_TABLE, isCustom: false })
})

export default rehabConfigV1
