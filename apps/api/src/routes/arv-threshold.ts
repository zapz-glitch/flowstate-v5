/**
 * ARV Threshold Routes (Dashboard / Session Auth)
 *
 * Per-user ARV comp threshold: top % of comps by sale price used for ARV calculation.
 */

import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import type { Env } from '../types'
import { getSession } from '../lib/session'
import { arvThreshold } from '../db'
import { invalidateUserSettingsCache } from '../services/user-settings'

const arvThresholdRoute = new Hono<{ Bindings: Env }>()

export const ARV_THRESHOLD_DEFAULTS = {
  percent: 10,
}

export type ArvThresholdConfig = typeof ARV_THRESHOLD_DEFAULTS

// ─── GET /arv-threshold ──────────────────────────────────────────────────────

arvThresholdRoute.get('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const db = drizzle(c.env.DB)
  const [row] = await db.select().from(arvThreshold).where(eq(arvThreshold.userId, session.user.id)).limit(1)

  if (!row) {
    return c.json({ config: ARV_THRESHOLD_DEFAULTS, isCustom: false })
  }

  return c.json({
    config: { percent: row.percent },
    isCustom: true,
    updatedAt: row.updatedAt,
  })
})

// ─── PUT /arv-threshold ──────────────────────────────────────────────────────

arvThresholdRoute.put('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const body = await c.req.json().catch(() => ({})) as Partial<ArvThresholdConfig>

  const percent = typeof body.percent === 'number' ? body.percent : ARV_THRESHOLD_DEFAULTS.percent

  if (percent < 1 || percent > 100) return c.json({ error: 'percent must be 1–100' }, 400)

  const db = drizzle(c.env.DB)
  const now = new Date().toISOString()

  const [existing] = await db.select().from(arvThreshold).where(eq(arvThreshold.userId, session.user.id)).limit(1)

  if (existing) {
    await db.update(arvThreshold).set({ percent, updatedAt: now }).where(eq(arvThreshold.userId, session.user.id))
  } else {
    await db.insert(arvThreshold).values({ userId: session.user.id, percent, createdAt: now, updatedAt: now })
  }

  await invalidateUserSettingsCache(c.env.API_CACHE, session.user.id)

  return c.json({ config: { percent }, isCustom: true, updatedAt: now })
})

// ─── DELETE /arv-threshold ───────────────────────────────────────────────────

arvThresholdRoute.delete('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const db = drizzle(c.env.DB)
  await db.delete(arvThreshold).where(eq(arvThreshold.userId, session.user.id))

  await invalidateUserSettingsCache(c.env.API_CACHE, session.user.id)

  return c.json({ config: ARV_THRESHOLD_DEFAULTS, isCustom: false })
})

export default arvThresholdRoute
