/**
 * Proximity Adjustment Config Routes (Dashboard / Session Auth)
 *
 * Per-user defaults for traffic/commercial proximity deductions.
 * Positions: siding (beside), backing (behind), fronting (in front).
 * ARV < threshold → flat dollar amount; ARV >= threshold → percentage.
 */

import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import type { Env } from '../types'
import { getSession } from '../lib/session'
import { proximityConfig } from '../db'
import { invalidateUserSettingsCache } from '../services/user-settings'
import { withDbRetry } from '../lib/db-retry'

const proximityConfigRoute = new Hono<{ Bindings: Env }>()

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ProximityPosition {
  flat: number    // Dollar amount for ARV < threshold
  percent: number // Percentage of ARV for ARV >= threshold
}

export interface ProximityConfig {
  arvThreshold: number // ARV cutoff — below=flat, above=percent (default: 500000)
  siding: ProximityPosition
  backing: ProximityPosition
  fronting: ProximityPosition
}

export const PROXIMITY_DEFAULTS: ProximityConfig = {
  arvThreshold: 500000,
  siding:   { flat: 10000, percent: 10 },
  backing:  { flat: 10000, percent: 15 },
  fronting: { flat: 10000, percent: 20 },
}

// ─── GET /proximity-config ──────────────────────────────────────────────────

proximityConfigRoute.get('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const db = drizzle(c.env.DB)
  const [row] = await db.select().from(proximityConfig).where(eq(proximityConfig.userId, session.user.id)).limit(1)

  if (!row) {
    return c.json({ config: PROXIMITY_DEFAULTS, isCustom: false })
  }

  try {
    const config = JSON.parse(row.configJson) as ProximityConfig
    return c.json({ config, isCustom: true, updatedAt: row.updatedAt })
  } catch {
    return c.json({ config: PROXIMITY_DEFAULTS, isCustom: false })
  }
})

// ─── PUT /proximity-config ──────────────────────────────────────────────────

proximityConfigRoute.put('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const body = await c.req.json().catch(() => ({})) as Partial<ProximityConfig>

  // Merge with defaults for any missing fields
  const config: ProximityConfig = {
    arvThreshold: typeof body.arvThreshold === 'number' && body.arvThreshold > 0 ? body.arvThreshold : PROXIMITY_DEFAULTS.arvThreshold,
    siding: {
      flat: typeof body.siding?.flat === 'number' ? body.siding.flat : PROXIMITY_DEFAULTS.siding.flat,
      percent: typeof body.siding?.percent === 'number' ? body.siding.percent : PROXIMITY_DEFAULTS.siding.percent,
    },
    backing: {
      flat: typeof body.backing?.flat === 'number' ? body.backing.flat : PROXIMITY_DEFAULTS.backing.flat,
      percent: typeof body.backing?.percent === 'number' ? body.backing.percent : PROXIMITY_DEFAULTS.backing.percent,
    },
    fronting: {
      flat: typeof body.fronting?.flat === 'number' ? body.fronting.flat : PROXIMITY_DEFAULTS.fronting.flat,
      percent: typeof body.fronting?.percent === 'number' ? body.fronting.percent : PROXIMITY_DEFAULTS.fronting.percent,
    },
  }

  const db = drizzle(c.env.DB)
  const now = new Date().toISOString()
  const configJson = JSON.stringify(config)

  const [existing] = await withDbRetry(() => db.select().from(proximityConfig).where(eq(proximityConfig.userId, session.user.id)).limit(1))

  if (existing) {
    await withDbRetry(() => db.update(proximityConfig).set({ configJson, updatedAt: now }).where(eq(proximityConfig.userId, session.user.id)))
  } else {
    await withDbRetry(() => db.insert(proximityConfig).values({ userId: session.user.id, configJson, createdAt: now, updatedAt: now }))
  }

  await invalidateUserSettingsCache(c.env.API_CACHE, session.user.id)

  return c.json({ config, isCustom: true, updatedAt: now })
})

// ─── DELETE /proximity-config ───────────────────────────────────────────────

proximityConfigRoute.delete('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const db = drizzle(c.env.DB)
  await withDbRetry(() => db.delete(proximityConfig).where(eq(proximityConfig.userId, session.user.id)))

  await invalidateUserSettingsCache(c.env.API_CACHE, session.user.id)

  return c.json({ config: PROXIMITY_DEFAULTS, isCustom: false })
})

export default proximityConfigRoute
