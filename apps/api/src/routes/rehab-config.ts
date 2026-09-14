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
import { getSession } from '../lib/session'
import { rehabConfig } from '../db'
import { DEFAULT_REHAB_TABLE } from '../services/valuation'
import { invalidateUserSettingsCache } from '../services/user-settings'
import { withDbRetry } from '../lib/db-retry'
import type { ArvTier, RehabEstimate } from '../services/valuation'
import { DEFAULT_TIER_RANGES, type TierRangeDefinition } from '@flowstate-api/shared/valuation'

const rehabConfigRoute = new Hono<{ Bindings: Env }>()

// ─── Types ────────────────────────────────────────────────────────────────────

type RehabTable = Record<ArvTier, RehabEstimate[]>

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validateRehabTable(table: unknown, tierKeys: string[]): table is RehabTable {
  if (typeof table !== 'object' || table === null) return false
  for (const tier of tierKeys) {
    const arr = (table as Record<string, unknown>)[tier]
    if (!Array.isArray(arr) || arr.length === 0) return false
    for (const item of arr) {
      if (typeof (item as any)?.perSqft !== 'number' || typeof (item as any)?.minProfit !== 'number') return false
    }
  }
  return true
}

function validateTierRanges(ranges: unknown): ranges is TierRangeDefinition[] {
  if (!Array.isArray(ranges) || ranges.length === 0) return false
  for (const r of ranges) {
    if (typeof r !== 'object' || r === null) return false
    if (typeof r.key !== 'string' || !r.key) return false
    if (typeof r.label !== 'string' || !r.label) return false
    if (r.minValue !== null && typeof r.minValue !== 'number') return false
    if (r.maxValue !== null && typeof r.maxValue !== 'number') return false
  }
  if (ranges[0].minValue !== null) return false
  if (ranges[ranges.length - 1].maxValue !== null) return false
  const keys = new Set(ranges.map((r: TierRangeDefinition) => r.key))
  if (keys.size !== ranges.length) return false
  return true
}

// ─── GET /rehab-config/defaults ──────────────────────────────────────────────

rehabConfigRoute.get('/defaults', (c) => {
  return c.json({ config: DEFAULT_REHAB_TABLE, tierRanges: DEFAULT_TIER_RANGES })
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
    return c.json({ config: DEFAULT_REHAB_TABLE, tierRanges: DEFAULT_TIER_RANGES, isCustom: false })
  }

  const tierRanges = row.tierRangesJson ? JSON.parse(row.tierRangesJson) : DEFAULT_TIER_RANGES

  return c.json({
    config: JSON.parse(row.configJson) as RehabTable,
    tierRanges,
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

  // Determine tier keys for validation
  const tierRanges: TierRangeDefinition[] | undefined = body?.tierRanges
  if (tierRanges !== undefined && !validateTierRanges(tierRanges)) {
    return c.json({ error: 'Invalid tier ranges: must be non-empty array with unique keys, first min null, last max null' }, 400)
  }
  const tierKeys = (tierRanges ?? DEFAULT_TIER_RANGES).map((t: TierRangeDefinition) => t.key)

  if (!body?.config || !validateRehabTable(body.config, tierKeys)) {
    return c.json(
      { error: `Invalid rehab config: must have tiers [${tierKeys.join(', ')}] each with at least 1 entry containing perSqft and minProfit` },
      400
    )
  }

  const db = drizzle(c.env.DB)
  const now = new Date().toISOString()
  const configJson = JSON.stringify(body.config)
  const tierRangesJson = tierRanges ? JSON.stringify(tierRanges) : null

  const [existing] = await withDbRetry(() => db
    .select({ id: rehabConfig.id })
    .from(rehabConfig)
    .where(eq(rehabConfig.userId, session.user.id))
    .limit(1))

  if (existing) {
    await withDbRetry(() => db
      .update(rehabConfig)
      .set({ configJson, tierRangesJson, updatedAt: now })
      .where(eq(rehabConfig.userId, session.user.id)))
  } else {
    await withDbRetry(() => db.insert(rehabConfig).values({
      userId: session.user.id,
      configJson,
      tierRangesJson,
      createdAt: now,
      updatedAt: now,
    }))
  }

  // Invalidate cached user settings
  await invalidateUserSettingsCache(c.env.API_CACHE, session.user.id)

  return c.json({ success: true, config: body.config as RehabTable, tierRanges: tierRanges ?? DEFAULT_TIER_RANGES, isCustom: true, updatedAt: now })
})

// ─── DELETE /rehab-config ─────────────────────────────────────────────────────

rehabConfigRoute.delete('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const db = drizzle(c.env.DB)
  await withDbRetry(() => db.delete(rehabConfig).where(eq(rehabConfig.userId, session.user.id)))

  // Invalidate cached user settings
  await invalidateUserSettingsCache(c.env.API_CACHE, session.user.id)

  return c.json({ config: DEFAULT_REHAB_TABLE, isCustom: false })
})

export default rehabConfigRoute
