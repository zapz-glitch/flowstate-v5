/**
 * Deal Params Routes (Dashboard / Session Auth)
 *
 * Per-user valuation defaults: closing costs %, carrying costs %, wholesale fee.
 */

import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import type { Env } from '../types'
import { getSession } from '../lib/session'
import { dealParams } from '../db'
import { invalidateUserSettingsCache } from '../services/user-settings'

const dealParamsRoute = new Hono<{ Bindings: Env }>()

export const DEAL_PARAMS_DEFAULTS = {
  closingCostsPercent: 8,
  carryingCostsPercent: 2,
  wholesaleFee: 10000,
  asIsThresholdPercent: 70,
}

export type DealParamsConfig = typeof DEAL_PARAMS_DEFAULTS

// ─── GET /deal-params/defaults ────────────────────────────────────────────────

dealParamsRoute.get('/defaults', (c) => {
  return c.json({ config: DEAL_PARAMS_DEFAULTS })
})

// ─── GET /deal-params ─────────────────────────────────────────────────────────

dealParamsRoute.get('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const db = drizzle(c.env.DB)
  const [row] = await db.select().from(dealParams).where(eq(dealParams.userId, session.user.id)).limit(1)

  if (!row) {
    return c.json({ config: DEAL_PARAMS_DEFAULTS, isCustom: false })
  }

  return c.json({
    config: {
      closingCostsPercent: row.closingCostsPercent,
      carryingCostsPercent: row.carryingCostsPercent,
      wholesaleFee: row.wholesaleFee,
      asIsThresholdPercent: row.asIsThresholdPercent,
    },
    isCustom: true,
    updatedAt: row.updatedAt,
  })
})

// ─── PUT /deal-params ─────────────────────────────────────────────────────────

dealParamsRoute.put('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const body = await c.req.json().catch(() => ({})) as Partial<DealParamsConfig>

  const closingCostsPercent = typeof body.closingCostsPercent === 'number' ? body.closingCostsPercent : DEAL_PARAMS_DEFAULTS.closingCostsPercent
  const carryingCostsPercent = typeof body.carryingCostsPercent === 'number' ? body.carryingCostsPercent : DEAL_PARAMS_DEFAULTS.carryingCostsPercent
  const wholesaleFee = typeof body.wholesaleFee === 'number' ? body.wholesaleFee : DEAL_PARAMS_DEFAULTS.wholesaleFee
  const asIsThresholdPercent = typeof body.asIsThresholdPercent === 'number' ? body.asIsThresholdPercent : DEAL_PARAMS_DEFAULTS.asIsThresholdPercent

  if (closingCostsPercent < 0 || closingCostsPercent > 100) return c.json({ error: 'closingCostsPercent must be 0–100' }, 400)
  if (carryingCostsPercent < 0 || carryingCostsPercent > 100) return c.json({ error: 'carryingCostsPercent must be 0–100' }, 400)
  if (wholesaleFee < 0) return c.json({ error: 'wholesaleFee must be >= 0' }, 400)
  if (asIsThresholdPercent < 0 || asIsThresholdPercent > 100) return c.json({ error: 'asIsThresholdPercent must be 0–100' }, 400)

  const db = drizzle(c.env.DB)
  const now = new Date().toISOString()

  const [existing] = await db.select().from(dealParams).where(eq(dealParams.userId, session.user.id)).limit(1)

  if (existing) {
    await db.update(dealParams).set({ closingCostsPercent, carryingCostsPercent, wholesaleFee, asIsThresholdPercent, updatedAt: now }).where(eq(dealParams.userId, session.user.id))
  } else {
    await db.insert(dealParams).values({ userId: session.user.id, closingCostsPercent, carryingCostsPercent, wholesaleFee, asIsThresholdPercent, createdAt: now, updatedAt: now })
  }

  // Invalidate cached user settings
  await invalidateUserSettingsCache(c.env.API_CACHE, session.user.id)

  return c.json({ config: { closingCostsPercent, carryingCostsPercent, wholesaleFee, asIsThresholdPercent }, isCustom: true, updatedAt: now })
})

// ─── DELETE /deal-params ──────────────────────────────────────────────────────

dealParamsRoute.delete('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const db = drizzle(c.env.DB)
  await db.delete(dealParams).where(eq(dealParams.userId, session.user.id))

  // Invalidate cached user settings
  await invalidateUserSettingsCache(c.env.API_CACHE, session.user.id)

  return c.json({ config: DEAL_PARAMS_DEFAULTS, isCustom: false })
})

export default dealParamsRoute
