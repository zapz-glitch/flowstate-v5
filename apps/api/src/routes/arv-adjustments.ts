/**
 * ARV Adjustment Rules (Dashboard / Session Auth)
 *
 * Per-user global rule defaults for characteristic-based ARV additions and
 * deductions. Rules match subject physical characteristics (foundation type,
 * pool, garage presence, ...) and apply a signed percent to ARV. Per-report
 * application/direction/value overrides live in the report's appliedSettings —
 * this route only manages the global defaults.
 */

import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { Env } from '../types'
import { getSession } from '../lib/session'
import { arvAdjustments } from '../db'
import { invalidateUserSettingsCache } from '../services/user-settings'
import { withDbRetry } from '../lib/db-retry'

const arvAdjustmentsRoute = new Hono<{ Bindings: Env }>()

// ─── Types ─────────────────────────────────────────────────────────────────

export type ArvAdjustmentField =
  | 'foundationType' | 'pool' | 'garage' | 'carport' | 'storiesType'
  | 'propertyType' | 'condition' | 'bedrooms' | 'bathrooms'
  | 'squareFeet' | 'yearBuilt' | 'lotSizeAcres'

export type ArvAdjustmentOp = 'eq' | 'neq' | 'contains' | 'missing' | 'present' | 'lt' | 'gt'

export interface ArvAdjustmentRule {
  id: string
  label: string
  field: ArvAdjustmentField
  op: ArvAdjustmentOp
  value?: string | number | null
  /** Magnitude as a percent of ARV */
  percent: number
  /** Global default direction — 'deduction' unless flipped per-report */
  direction: 'deduction' | 'addition'
}

export const ARV_ADJUSTMENT_DEFAULTS: ArvAdjustmentRule[] = [
  { id: 'foundation_slab', label: 'Slab foundation', field: 'foundationType', op: 'eq', value: 'Slab', percent: 3, direction: 'deduction' },
  { id: 'no_garage', label: 'No garage', field: 'garage', op: 'missing', percent: 4, direction: 'deduction' },
  { id: 'carport_only', label: 'Carport (no garage)', field: 'carport', op: 'present', percent: 2, direction: 'deduction' },
  { id: 'pool_present', label: 'Pool', field: 'pool', op: 'present', percent: 5, direction: 'addition' },
]

const ruleSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(120),
  field: z.enum(['foundationType', 'pool', 'garage', 'carport', 'storiesType', 'propertyType', 'condition', 'bedrooms', 'bathrooms', 'squareFeet', 'yearBuilt', 'lotSizeAcres']),
  op: z.enum(['eq', 'neq', 'contains', 'missing', 'present', 'lt', 'gt']),
  value: z.union([z.string().max(80), z.number()]).nullish(),
  percent: z.number().min(0).max(100),
  direction: z.enum(['deduction', 'addition']),
})

// ─── GET /arv-adjustments ───────────────────────────────────────────────────

arvAdjustmentsRoute.get('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const db = drizzle(c.env.DB)
  const [row] = await db.select().from(arvAdjustments).where(eq(arvAdjustments.userId, session.user.id)).limit(1)

  if (!row) return c.json({ rules: ARV_ADJUSTMENT_DEFAULTS, isCustom: false })

  try {
    const rules = JSON.parse(row.configJson) as ArvAdjustmentRule[]
    return c.json({ rules: Array.isArray(rules) ? rules : ARV_ADJUSTMENT_DEFAULTS, isCustom: true, updatedAt: row.updatedAt })
  } catch {
    return c.json({ rules: ARV_ADJUSTMENT_DEFAULTS, isCustom: false })
  }
})

// ─── PUT /arv-adjustments ───────────────────────────────────────────────────

arvAdjustmentsRoute.put('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const body = await c.req.json().catch(() => ({})) as { rules?: unknown }
  const parsed = z.array(ruleSchema).max(50).safeParse(body.rules)
  if (!parsed.success) return c.json({ error: 'Invalid rules', details: parsed.error.issues }, 400)

  const rules = parsed.data
  const db = drizzle(c.env.DB)
  const now = new Date().toISOString()
  const configJson = JSON.stringify(rules)

  const [existing] = await withDbRetry(() => db.select().from(arvAdjustments).where(eq(arvAdjustments.userId, session.user.id)).limit(1))
  if (existing) {
    await withDbRetry(() => db.update(arvAdjustments).set({ configJson, updatedAt: now }).where(eq(arvAdjustments.userId, session.user.id)))
  } else {
    await withDbRetry(() => db.insert(arvAdjustments).values({ userId: session.user.id, configJson, createdAt: now, updatedAt: now }))
  }

  await invalidateUserSettingsCache(c.env.API_CACHE, session.user.id)
  return c.json({ rules, isCustom: true, updatedAt: now })
})

// ─── DELETE /arv-adjustments — restore defaults ─────────────────────────────

arvAdjustmentsRoute.delete('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)
  const db = drizzle(c.env.DB)
  await withDbRetry(() => db.delete(arvAdjustments).where(eq(arvAdjustments.userId, session.user.id)))
  await invalidateUserSettingsCache(c.env.API_CACHE, session.user.id)
  return c.json({ rules: ARV_ADJUSTMENT_DEFAULTS, isCustom: false })
})

export default arvAdjustmentsRoute
