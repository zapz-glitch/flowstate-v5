/**
 * Appraisal Rules Routes
 *
 * Endpoints for managing appraisal rule presets (filters and adjustments).
 * All routes require session authentication via Better Auth cookies.
 */

import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq, and, desc } from 'drizzle-orm'
import type { Env } from '../types'
import { getSession } from '../lib/session'
import {
  appraisalRulePreset,
  appraisalRuleFilter,
  appraisalRuleAdjustment,
} from '../db'
import {
  DEFAULT_FILTERS,
  DEFAULT_ADJUSTMENTS,
  FILTER_LABELS,
  ADJUSTMENT_LABELS,
  defaultFilterPriority,
  type FilterType,
  type AdjustmentType,
} from '../services/appraisal/types'
import { invalidateUserSettingsCache } from '../services/user-settings'

const appraisalRules = new Hono<{ Bindings: Env }>()

// ─── Types ────────────────────────────────────────────────────────────────────

interface FilterInput {
  filterType: FilterType
  enabled: boolean
  value: number
  /** 'hard' = required (disqualifies on verified failure) | 'soft' = preferred (ranks only) */
  priority?: 'hard' | 'soft' | null
}

interface AdjustmentInput {
  adjustmentType: AdjustmentType
  enabled: boolean
  amount: number
  percentage: number
}

interface CreatePresetInput {
  name: string
  description?: string
  isDefault?: boolean
  filters?: FilterInput[]
  adjustments?: AdjustmentInput[]
}

interface UpdatePresetInput {
  name?: string
  description?: string
  isDefault?: boolean
  filters?: FilterInput[]
  adjustments?: AdjustmentInput[]
}

// ─── Helper Functions ─────────────────────────────────────────────────────────

function convertToAppraisalFilter(filter: FilterInput) {
  return {
    type: filter.filterType,
    enabled: filter.enabled,
    value: filter.value,
    priority: filter.priority ?? null,
  }
}

/** Serialize a filter row for API responses — NULL priority resolves to the system default. */
function serializeFilter<F extends { filterType: string; priority: string | null }>(f: F) {
  return {
    ...f,
    filterType: f.filterType as FilterType,
    priority:
      f.priority === 'hard' || f.priority === 'soft'
        ? (f.priority as 'hard' | 'soft')
        : defaultFilterPriority(f.filterType as FilterType),
  }
}

function convertToAppraisalAdjustment(adjustment: AdjustmentInput) {
  return {
    type: adjustment.adjustmentType,
    enabled: adjustment.enabled,
    amount: adjustment.amount,
    percent: adjustment.percentage,
  }
}

// ─── GET /appraisal-presets ─────────────────────────────────────────────────────

appraisalRules.get('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const db = drizzle(c.env.DB)

  const presets = await db
    .select()
    .from(appraisalRulePreset)
    .where(eq(appraisalRulePreset.userId, session.user.id))
    .orderBy(desc(appraisalRulePreset.createdAt))

  // Fetch filters and adjustments for each preset
  const presetsWithRules = await Promise.all(
    presets.map(async (preset) => {
      const filters = await db
        .select()
        .from(appraisalRuleFilter)
        .where(eq(appraisalRuleFilter.presetId, preset.id))

      const adjustments = await db
        .select()
        .from(appraisalRuleAdjustment)
        .where(eq(appraisalRuleAdjustment.presetId, preset.id))

      return {
        ...preset,
        filters: filters.map(serializeFilter),
        adjustments: adjustments.map((a) => ({
          ...a,
          adjustmentType: a.adjustmentType as AdjustmentType,
        })),
      }
    })
  )

  return c.json({ presets: presetsWithRules })
})

// ─── GET /appraisal-presets/defaults ─────────────────────────────────────────

appraisalRules.get('/defaults', async (c) => {
  return c.json({
    filters: DEFAULT_FILTERS,
    adjustments: DEFAULT_ADJUSTMENTS,
    filterLabels: FILTER_LABELS,
    adjustmentLabels: ADJUSTMENT_LABELS,
  })
})

// ─── GET /appraisal-presets/mine ─────────────────────────────────────────────
// Returns the user's single default preset, auto-creating it if it doesn't exist.

appraisalRules.get('/mine', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const db = drizzle(c.env.DB)
  const now = new Date().toISOString()

  // Find or create the user's default preset
  let [preset] = await db
    .select()
    .from(appraisalRulePreset)
    .where(
      and(
        eq(appraisalRulePreset.userId, session.user.id),
        eq(appraisalRulePreset.isDefault, true)
      )
    )
    .limit(1)

  if (!preset) {
    // Auto-create default preset seeded from system defaults
    const presetId = crypto.randomUUID()
    ;[preset] = await db
      .insert(appraisalRulePreset)
      .values({
        id: presetId,
        userId: session.user.id,
        name: 'Default',
        description: null,
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning()

    await db.insert(appraisalRuleFilter).values(
      DEFAULT_FILTERS.map((f) => ({
        id: crypto.randomUUID(),
        presetId,
        filterType: f.type,
        enabled: f.enabled,
        value: f.value,
        priority: f.priority ?? null,
        createdAt: now,
      }))
    )

    await db.insert(appraisalRuleAdjustment).values(
      DEFAULT_ADJUSTMENTS.map((a) => ({
        id: crypto.randomUUID(),
        presetId,
        adjustmentType: a.type,
        enabled: a.enabled,
        amount: a.amount,
        percentage: a.percent ?? 0,
        createdAt: now,
      }))
    )
  }

  const filters = await db
    .select()
    .from(appraisalRuleFilter)
    .where(eq(appraisalRuleFilter.presetId, preset.id))

  const adjustments = await db
    .select()
    .from(appraisalRuleAdjustment)
    .where(eq(appraisalRuleAdjustment.presetId, preset.id))

  return c.json({
    preset: {
      ...preset,
      filters: filters.map((f) => ({ ...f, filterType: f.filterType as FilterType })),
      adjustments: adjustments.map((a) => ({ ...a, adjustmentType: a.adjustmentType as AdjustmentType })),
    },
  })
})

// ─── GET /appraisal-presets/default ─────────────────────────────────────────

appraisalRules.get('/default', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const db = drizzle(c.env.DB)

  const [preset] = await db
    .select()
    .from(appraisalRulePreset)
    .where(
      and(
        eq(appraisalRulePreset.userId, session.user.id),
        eq(appraisalRulePreset.isDefault, true)
      )
    )
    .limit(1)

  if (!preset) {
    return c.json({ preset: null })
  }

  const filters = await db
    .select()
    .from(appraisalRuleFilter)
    .where(eq(appraisalRuleFilter.presetId, preset.id))

  const adjustments = await db
    .select()
    .from(appraisalRuleAdjustment)
    .where(eq(appraisalRuleAdjustment.presetId, preset.id))

  return c.json({
    preset: {
      ...preset,
      filters: filters.map(serializeFilter),
      adjustments: adjustments.map((a) => ({
        ...a,
        adjustmentType: a.adjustmentType as AdjustmentType,
      })),
    },
  })
})

// ─── GET /appraisal-presets/:id ─────────────────────────────────────────────

appraisalRules.get('/:id', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const presetId = c.req.param('id')
  const db = drizzle(c.env.DB)

  const [preset] = await db
    .select()
    .from(appraisalRulePreset)
    .where(
      and(
        eq(appraisalRulePreset.id, presetId),
        eq(appraisalRulePreset.userId, session.user.id)
      )
    )
    .limit(1)

  if (!preset) {
    return c.json({ error: 'Preset not found' }, 404)
  }

  const filters = await db
    .select()
    .from(appraisalRuleFilter)
    .where(eq(appraisalRuleFilter.presetId, presetId))

  const adjustments = await db
    .select()
    .from(appraisalRuleAdjustment)
    .where(eq(appraisalRuleAdjustment.presetId, presetId))

  return c.json({
    preset: {
      ...preset,
      filters: filters.map(serializeFilter),
      adjustments: adjustments.map((a) => ({
        ...a,
        adjustmentType: a.adjustmentType as AdjustmentType,
      })),
    },
  })
})

// ─── POST /appraisal-presets ─────────────────────────────────────────────────

appraisalRules.post('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const body = (await c.req.json().catch(() => ({}))) as CreatePresetInput
  if (!body.name) {
    return c.json({ error: 'Name is required' }, 400)
  }

  const db = drizzle(c.env.DB)
  const now = new Date().toISOString()
  const presetId = crypto.randomUUID()

  // If this is set as default, unset other defaults first
  if (body.isDefault) {
    await db
      .update(appraisalRulePreset)
      .set({ isDefault: false, updatedAt: now })
      .where(eq(appraisalRulePreset.userId, session.user.id))
  }

  // Insert preset
  const [created] = await db
    .insert(appraisalRulePreset)
    .values({
      id: presetId,
      userId: session.user.id,
      name: body.name,
      description: body.description ?? null,
      isDefault: body.isDefault ?? false,
      createdAt: now,
      updatedAt: now,
    })
    .returning()

  // Insert filters (use input if provided, else defaults)
  const filtersToInsert = body.filters ?? DEFAULT_FILTERS.map((f) => ({
    filterType: f.type,
    enabled: f.enabled,
    value: f.value,
    priority: f.priority ?? null,
  }))

  if (filtersToInsert.length > 0) {
    await db.insert(appraisalRuleFilter).values(
      filtersToInsert.map((f) => ({
        id: crypto.randomUUID(),
        presetId: presetId,
        filterType: f.filterType,
        enabled: f.enabled,
        value: f.value,
        priority: f.priority ?? null,
        createdAt: now,
      }))
    )
  }

  // Insert adjustments (use input if provided, else defaults)
  const adjustmentsToInsert = body.adjustments ?? DEFAULT_ADJUSTMENTS.map((a) => ({
    adjustmentType: a.type,
    enabled: a.enabled,
    amount: a.amount,
    percentage: a.percent ?? 0,
  }))

  if (adjustmentsToInsert.length > 0) {
    await db.insert(appraisalRuleAdjustment).values(
      adjustmentsToInsert.map((a) => ({
        id: crypto.randomUUID(),
        presetId: presetId,
        adjustmentType: a.adjustmentType,
        enabled: a.enabled,
        amount: a.amount,
        percentage: a.percentage,
        createdAt: now,
      }))
    )
  }

  // Invalidate cached user settings
  await invalidateUserSettingsCache(c.env.API_CACHE, session.user.id)

  // Fetch created preset with rules
  const filters = await db
    .select()
    .from(appraisalRuleFilter)
    .where(eq(appraisalRuleFilter.presetId, presetId))

  const adjustments = await db
    .select()
    .from(appraisalRuleAdjustment)
    .where(eq(appraisalRuleAdjustment.presetId, presetId))

  return c.json({
    preset: {
      ...created,
      filters: filters.map(serializeFilter),
      adjustments: adjustments.map((a) => ({
        ...a,
        adjustmentType: a.adjustmentType as AdjustmentType,
      })),
    },
  })
})

// ─── PATCH /appraisal-presets/:id ────────────────────────────────────────────

appraisalRules.patch('/:id', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const presetId = c.req.param('id')
  const body = (await c.req.json().catch(() => ({}))) as UpdatePresetInput
  const db = drizzle(c.env.DB)

  // Verify ownership
  const [existing] = await db
    .select()
    .from(appraisalRulePreset)
    .where(
      and(
        eq(appraisalRulePreset.id, presetId),
        eq(appraisalRulePreset.userId, session.user.id)
      )
    )
    .limit(1)

  if (!existing) {
    return c.json({ error: 'Preset not found' }, 404)
  }

  const now = new Date().toISOString()

  // If this is set as default, unset other defaults first
  if (body.isDefault) {
    await db
      .update(appraisalRulePreset)
      .set({ isDefault: false, updatedAt: now })
      .where(eq(appraisalRulePreset.userId, session.user.id))
  }

  // Update preset fields
  const updates: Record<string, unknown> = { updatedAt: now }
  if (body.name !== undefined) updates.name = body.name
  if (body.description !== undefined) updates.description = body.description
  if (body.isDefault !== undefined) updates.isDefault = body.isDefault

  await db
    .update(appraisalRulePreset)
    .set(updates)
    .where(eq(appraisalRulePreset.id, presetId))

  // Update filters if provided (replace all)
  if (body.filters !== undefined) {
    await db
      .delete(appraisalRuleFilter)
      .where(eq(appraisalRuleFilter.presetId, presetId))

    if (body.filters.length > 0) {
      await db.insert(appraisalRuleFilter).values(
        body.filters.map((f) => ({
          id: crypto.randomUUID(),
          presetId: presetId,
          filterType: f.filterType,
          enabled: f.enabled,
          value: f.value,
          priority: f.priority ?? null,
          createdAt: now,
        }))
      )
    }
  }

  // Update adjustments if provided (replace all)
  if (body.adjustments !== undefined) {
    await db
      .delete(appraisalRuleAdjustment)
      .where(eq(appraisalRuleAdjustment.presetId, presetId))

    if (body.adjustments.length > 0) {
      await db.insert(appraisalRuleAdjustment).values(
        body.adjustments.map((a) => ({
          id: crypto.randomUUID(),
          presetId: presetId,
          adjustmentType: a.adjustmentType,
          enabled: a.enabled,
          amount: a.amount,
          percentage: a.percentage,
          createdAt: now,
        }))
      )
    }
  }

  // Invalidate cached user settings
  await invalidateUserSettingsCache(c.env.API_CACHE, session.user.id)

  // Fetch updated preset with rules
  const filters = await db
    .select()
    .from(appraisalRuleFilter)
    .where(eq(appraisalRuleFilter.presetId, presetId))

  const adjustments = await db
    .select()
    .from(appraisalRuleAdjustment)
    .where(eq(appraisalRuleAdjustment.presetId, presetId))

  return c.json({
    preset: {
      ...existing,
      ...updates,
      filters: filters.map(serializeFilter),
      adjustments: adjustments.map((a) => ({
        ...a,
        adjustmentType: a.adjustmentType as AdjustmentType,
      })),
    },
  })
})

// ─── POST /appraisal-presets/:id/set-default ─────────────────────────────────

appraisalRules.post('/:id/set-default', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const presetId = c.req.param('id')
  const db = drizzle(c.env.DB)
  const now = new Date().toISOString()

  // Verify ownership
  const [existing] = await db
    .select()
    .from(appraisalRulePreset)
    .where(
      and(
        eq(appraisalRulePreset.id, presetId),
        eq(appraisalRulePreset.userId, session.user.id)
      )
    )
    .limit(1)

  if (!existing) {
    return c.json({ error: 'Preset not found' }, 404)
  }

  // Unset all other defaults for this user
  await db
    .update(appraisalRulePreset)
    .set({ isDefault: false, updatedAt: now })
    .where(eq(appraisalRulePreset.userId, session.user.id))

  // Set this preset as default
  await db
    .update(appraisalRulePreset)
    .set({ isDefault: true, updatedAt: now })
    .where(eq(appraisalRulePreset.id, presetId))

  // Invalidate cached user settings
  await invalidateUserSettingsCache(c.env.API_CACHE, session.user.id)

  return c.json({ success: true })
})

// ─── DELETE /appraisal-presets/:id ───────────────────────────────────────────

appraisalRules.delete('/:id', async (c) => {
  const session = await getSession(c)
  if (!session?.user) {
    return c.json({ error: 'Not authenticated' }, 401)
  }

  const presetId = c.req.param('id')
  const db = drizzle(c.env.DB)

  const result = await db
    .delete(appraisalRulePreset)
    .where(
      and(
        eq(appraisalRulePreset.id, presetId),
        eq(appraisalRulePreset.userId, session.user.id)
      )
    )
    .returning()

  if (result.length === 0) {
    return c.json({ error: 'Preset not found' }, 404)
  }

  // Invalidate cached user settings
  await invalidateUserSettingsCache(c.env.API_CACHE, session.user.id)

  return c.json({ success: true })
})

export default appraisalRules
