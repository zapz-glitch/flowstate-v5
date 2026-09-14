/**
 * Major Item Costs Routes (Dashboard / Session Auth)
 *
 * Per-user default costs for major repair items (roof, hvac, foundation, etc.).
 * These defaults are used when /v1/analyze auto-detects items from permits/age.
 * Callers can always override individual items in the buybox.majorItems array.
 */

import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import type { Env } from '../types'
import { getSession } from '../lib/session'
import { majorItemCosts } from '../db'
import { MAJOR_ITEMS } from '../services/valuation'
import { invalidateUserSettingsCache } from '../services/user-settings'
import { withDbRetry } from '../lib/db-retry'

const majorItemCostsRoute = new Hono<{ Bindings: Env }>()

export type MajorItemCostsMap = Partial<Record<string, number>>

/** Build the full list merging user overrides on top of system defaults */
function buildItemList(customCosts: MajorItemCostsMap) {
  return MAJOR_ITEMS.map((item) => ({
    id: item.id,
    name: item.name,
    defaultCost: item.defaultCost,
    customCost: customCosts[item.id] ?? null,
    effectiveCost: customCosts[item.id] ?? item.defaultCost,
    ageThreshold: item.ageThreshold,
  }))
}

// ─── GET /major-item-costs/defaults ───────────────────────────────────────────

majorItemCostsRoute.get('/defaults', (c) => {
  return c.json({ items: buildItemList({}) })
})

// ─── GET /major-item-costs ─────────────────────────────────────────────────────

majorItemCostsRoute.get('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const db = drizzle(c.env.DB)
  const [row] = await db.select().from(majorItemCosts).where(eq(majorItemCosts.userId, session.user.id)).limit(1)

  const customCosts: MajorItemCostsMap = row ? JSON.parse(row.costsJson) : {}
  return c.json({ items: buildItemList(customCosts), isCustom: !!row, updatedAt: row?.updatedAt ?? null })
})

// ─── PUT /major-item-costs ─────────────────────────────────────────────────────
// Body: { costs: Record<string, number> } — only include items being overridden.
// Pass null or omit an id to reset that item to the system default.

majorItemCostsRoute.put('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const body = await c.req.json().catch(() => ({})) as { costs?: Record<string, unknown> }
  if (!body.costs || typeof body.costs !== 'object') {
    return c.json({ error: 'costs object is required' }, 400)
  }

  // Validate: only accept known item ids, values must be non-negative numbers
  const validIds = new Set(MAJOR_ITEMS.map((m) => m.id))
  const sanitized: MajorItemCostsMap = {}
  for (const [id, val] of Object.entries(body.costs)) {
    if (!validIds.has(id as any)) return c.json({ error: `Unknown item id: ${id}` }, 400)
    if (val === null || val === undefined) continue // null = use default, skip
    if (typeof val !== 'number' || val < 0) return c.json({ error: `Cost for "${id}" must be a non-negative number` }, 400)
    sanitized[id] = val
  }

  const db = drizzle(c.env.DB)
  const now = new Date().toISOString()
  const costsJson = JSON.stringify(sanitized)

  const [existing] = await withDbRetry(() => db.select().from(majorItemCosts).where(eq(majorItemCosts.userId, session.user.id)).limit(1))

  if (existing) {
    await withDbRetry(() => db.update(majorItemCosts).set({ costsJson, updatedAt: now }).where(eq(majorItemCosts.userId, session.user.id)))
  } else {
    await withDbRetry(() => db.insert(majorItemCosts).values({ userId: session.user.id, costsJson, createdAt: now, updatedAt: now }))
  }

  // Invalidate cached user settings
  await invalidateUserSettingsCache(c.env.API_CACHE, session.user.id)

  return c.json({ items: buildItemList(sanitized), isCustom: true, updatedAt: now })
})

// ─── DELETE /major-item-costs ──────────────────────────────────────────────────

majorItemCostsRoute.delete('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const db = drizzle(c.env.DB)
  await withDbRetry(() => db.delete(majorItemCosts).where(eq(majorItemCosts.userId, session.user.id)))

  // Invalidate cached user settings
  await invalidateUserSettingsCache(c.env.API_CACHE, session.user.id)

  return c.json({ items: buildItemList({}), isCustom: false })
})

export default majorItemCostsRoute
