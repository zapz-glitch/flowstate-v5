/**
 * Deal Params Routes (Dashboard / Session Auth)
 *
 * Per-user valuation defaults: closing costs %, carrying costs %, wholesale fee, desired profit.
 */

import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import type { Env } from '../types'
import { createAuth } from '../lib/auth'
import { dealParams } from '../db'

const dealParamsRoute = new Hono<{ Bindings: Env }>()

export const DEAL_PARAMS_DEFAULTS = {
  closingCostsPercent: 10,
  carryingCostsPercent: 5,
  wholesaleFee: 10000,
  desiredProfit: null as number | null,
}

export type DealParamsConfig = typeof DEAL_PARAMS_DEFAULTS

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
      desiredProfit: row.desiredProfit ?? null,
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
  const desiredProfit = typeof body.desiredProfit === 'number' ? body.desiredProfit : null

  if (closingCostsPercent < 0 || closingCostsPercent > 100) return c.json({ error: 'closingCostsPercent must be 0–100' }, 400)
  if (carryingCostsPercent < 0 || carryingCostsPercent > 100) return c.json({ error: 'carryingCostsPercent must be 0–100' }, 400)
  if (wholesaleFee < 0) return c.json({ error: 'wholesaleFee must be >= 0' }, 400)

  const db = drizzle(c.env.DB)
  const now = new Date().toISOString()

  const [existing] = await db.select().from(dealParams).where(eq(dealParams.userId, session.user.id)).limit(1)

  if (existing) {
    await db.update(dealParams).set({ closingCostsPercent, carryingCostsPercent, wholesaleFee, desiredProfit, updatedAt: now }).where(eq(dealParams.userId, session.user.id))
  } else {
    await db.insert(dealParams).values({ userId: session.user.id, closingCostsPercent, carryingCostsPercent, wholesaleFee, desiredProfit, createdAt: now, updatedAt: now })
  }

  return c.json({ config: { closingCostsPercent, carryingCostsPercent, wholesaleFee, desiredProfit }, isCustom: true, updatedAt: now })
})

// ─── DELETE /deal-params ──────────────────────────────────────────────────────

dealParamsRoute.delete('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const db = drizzle(c.env.DB)
  await db.delete(dealParams).where(eq(dealParams.userId, session.user.id))

  return c.json({ config: DEAL_PARAMS_DEFAULTS, isCustom: false })
})

export default dealParamsRoute
