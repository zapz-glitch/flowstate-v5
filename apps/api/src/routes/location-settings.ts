/**
 * Location Settings Routes (Dashboard / Session Auth)
 *
 * Per-location overrides for appraisal preset, rehab config, deal params, and major item costs.
 * When /v1/analyze is called, the most specific matching location setting wins:
 * zip > city+state > state > user default > system default
 *
 * Appraisal overrides: pass `appraisalFilters` + `appraisalAdjustments` directly — the backend
 * upserts a hidden preset (named `__loc_<id>`) and stores its ID in `appraisalPresetId`.
 * On GET, the hidden preset's filters/adjustments are resolved and returned inline.
 */

import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq, and } from 'drizzle-orm'
import type { Env } from '../types'
import { getSession } from '../lib/session'
import {
  locationSettings,
  appraisalRulePreset,
  appraisalRuleFilter,
  appraisalRuleAdjustment,
} from '../db'
import type { FilterType, AdjustmentType } from '../services/appraisal/types'
import { invalidateUserSettingsCache } from '../services/user-settings'

const locationSettingsRoute = new Hono<{ Bindings: Env }>()

interface FilterInput {
  filterType: FilterType
  enabled: boolean
  value: number
  /** 'hard' = required | 'soft' = preferred | null/omitted = system default */
  priority?: 'hard' | 'soft' | null
}

interface AdjustmentInput {
  adjustmentType: AdjustmentType
  enabled: boolean
  amount: number
  percentage: number
}

type SettingType = 'appraisal' | 'rehab' | 'deal' | 'major'
const VALID_SETTING_TYPES: SettingType[] = ['appraisal', 'rehab', 'deal', 'major']

interface LocationSettingInput {
  settingType?: SettingType
  isEnabled?: boolean
  state?: string
  city?: string
  zipCode?: string
  appraisalPresetId?: string | null
  appraisalFilters?: FilterInput[] | null
  appraisalAdjustments?: AdjustmentInput[] | null
  rehabConfigJson?: Record<string, unknown> | null
  tierRangesJson?: unknown[] | null
  dealParamsJson?: Record<string, unknown> | null
  majorItemCostsJson?: Record<string, number> | null
  arvThresholdJson?: { percent: number; enabled: boolean } | null
  proximityConfigJson?: Record<string, unknown> | null
}

function validateInput(body: LocationSettingInput): string | null {
  const hasState = !!body.state
  const hasCity = !!body.city
  const hasZip = !!body.zipCode

  if (hasZip && (hasState || hasCity)) return 'zipCode cannot be combined with state or city'
  if (hasCity && !hasState) return 'state is required when specifying a city'
  if (!hasState && !hasCity && !hasZip) return 'At least one of state, city+state, or zipCode must be provided'

  if (hasState && !/^[A-Z]{2}$/.test(body.state!)) {
    return 'state must be a 2-letter uppercase code (e.g. "FL")'
  }
  if (hasZip && !/^\d{5}$/.test(body.zipCode!)) {
    return 'zipCode must be a 5-digit string'
  }
  return null
}

/**
 * Upsert a hidden appraisal preset for a location override.
 * Returns the preset ID.
 */
async function upsertLocationPreset(
  db: ReturnType<typeof drizzle>,
  userId: string,
  locationId: string,
  filters: FilterInput[],
  adjustments: AdjustmentInput[]
): Promise<string> {
  const hiddenName = `__loc_${locationId}`
  const now = new Date().toISOString()

  // Find existing hidden preset
  const [existing] = await db
    .select({ id: appraisalRulePreset.id })
    .from(appraisalRulePreset)
    .where(and(eq(appraisalRulePreset.userId, userId), eq(appraisalRulePreset.name, hiddenName)))
    .limit(1)

  let presetId: string
  if (existing) {
    presetId = existing.id
    // Replace filters and adjustments
    await db.delete(appraisalRuleFilter).where(eq(appraisalRuleFilter.presetId, presetId))
    await db.delete(appraisalRuleAdjustment).where(eq(appraisalRuleAdjustment.presetId, presetId))
    await db.update(appraisalRulePreset).set({ updatedAt: now }).where(eq(appraisalRulePreset.id, presetId))
  } else {
    presetId = crypto.randomUUID()
    await db.insert(appraisalRulePreset).values({
      id: presetId,
      userId,
      name: hiddenName,
      description: null,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    })
  }

  if (filters.length > 0) {
    await db.insert(appraisalRuleFilter).values(
      filters.map((f) => ({
        id: crypto.randomUUID(),
        presetId,
        filterType: f.filterType,
        enabled: f.enabled,
        value: f.value,
        priority: f.priority ?? null,
        createdAt: now,
      }))
    )
  }

  if (adjustments.length > 0) {
    await db.insert(appraisalRuleAdjustment).values(
      adjustments.map((a) => ({
        id: crypto.randomUUID(),
        presetId,
        adjustmentType: a.adjustmentType,
        enabled: a.enabled,
        amount: a.amount,
        percentage: a.percentage,
        createdAt: now,
      }))
    )
  }

  return presetId
}

/**
 * Delete hidden appraisal preset for a location (if it is a __loc_ preset).
 */
async function deleteLocationPreset(
  db: ReturnType<typeof drizzle>,
  userId: string,
  presetId: string
): Promise<void> {
  const [preset] = await db
    .select({ id: appraisalRulePreset.id, name: appraisalRulePreset.name })
    .from(appraisalRulePreset)
    .where(and(eq(appraisalRulePreset.id, presetId), eq(appraisalRulePreset.userId, userId)))
    .limit(1)
  if (preset && preset.name.startsWith('__loc_')) {
    await db.delete(appraisalRulePreset).where(eq(appraisalRulePreset.id, presetId))
  }
}

/**
 * Resolve appraisal filters/adjustments for a location preset ID (if it's a hidden one).
 * Returns null if no preset or preset is not a hidden location preset.
 */
async function resolveLocationAppraisalRules(
  db: ReturnType<typeof drizzle>,
  userId: string,
  presetId: string | null
): Promise<{ appraisalFilters: FilterInput[]; appraisalAdjustments: AdjustmentInput[] } | null> {
  if (!presetId) return null

  const [preset] = await db
    .select({ id: appraisalRulePreset.id, name: appraisalRulePreset.name })
    .from(appraisalRulePreset)
    .where(and(eq(appraisalRulePreset.id, presetId), eq(appraisalRulePreset.userId, userId)))
    .limit(1)

  if (!preset || !preset.name.startsWith('__loc_')) return null

  const [filters, adjustments] = await Promise.all([
    db.select().from(appraisalRuleFilter).where(eq(appraisalRuleFilter.presetId, presetId)),
    db.select().from(appraisalRuleAdjustment).where(eq(appraisalRuleAdjustment.presetId, presetId)),
  ])

  return {
    appraisalFilters: filters.map((f) => ({
      filterType: f.filterType as FilterType,
      enabled: f.enabled,
      value: f.value,
      priority: f.priority === 'hard' || f.priority === 'soft' ? f.priority : null,
    })),
    appraisalAdjustments: adjustments.map((a) => ({
      adjustmentType: a.adjustmentType as AdjustmentType,
      enabled: a.enabled,
      amount: a.amount,
      percentage: a.percentage,
    })),
  }
}

function serializeRow(r: typeof locationSettings.$inferSelect) {
  return {
    id: r.id,
    settingType: r.settingType as SettingType,
    isEnabled: r.isEnabled,
    state: r.state,
    city: r.city,
    zipCode: r.zipCode,
    appraisalPresetId: r.appraisalPresetId,
    rehabConfigJson: r.rehabConfigJson ? JSON.parse(r.rehabConfigJson) : null,
    tierRangesJson: r.tierRangesJson ? JSON.parse(r.tierRangesJson) : null,
    dealParamsJson: r.dealParamsJson ? JSON.parse(r.dealParamsJson) : null,
    majorItemCostsJson: r.majorItemCostsJson ? JSON.parse(r.majorItemCostsJson) : null,
    arvThresholdJson: r.arvThresholdJson ? JSON.parse(r.arvThresholdJson) : null,
    proximityConfigJson: r.proximityConfigJson ? JSON.parse(r.proximityConfigJson) : null,
    hasRehabConfig: r.rehabConfigJson !== null,
    hasTierRanges: r.tierRangesJson !== null,
    hasDealParams: r.dealParamsJson !== null,
    hasMajorItemCosts: r.majorItemCostsJson !== null,
    hasArvThreshold: r.arvThresholdJson !== null,
    hasProximityConfig: r.proximityConfigJson !== null,
  }
}

// ─── GET /location-settings ───────────────────────────────────────────────────

locationSettingsRoute.get('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const typeParam = c.req.query('type') as SettingType | undefined
  const db = drizzle(c.env.DB)

  const rows = await db
    .select()
    .from(locationSettings)
    .where(
      typeParam && VALID_SETTING_TYPES.includes(typeParam)
        ? and(eq(locationSettings.userId, session.user.id), eq(locationSettings.settingType, typeParam))
        : eq(locationSettings.userId, session.user.id)
    )
    .orderBy(locationSettings.createdAt)

  // Resolve inline appraisal rules for hidden presets
  const settings = await Promise.all(
    rows.map(async (r) => {
      const appraisalRules = await resolveLocationAppraisalRules(db, session.user.id, r.appraisalPresetId)
      return {
        ...serializeRow(r),
        appraisalFilters: appraisalRules?.appraisalFilters ?? null,
        appraisalAdjustments: appraisalRules?.appraisalAdjustments ?? null,
        hasAppraisalOverride: appraisalRules !== null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }
    })
  )

  return c.json({ settings })
})

// ─── POST /location-settings ──────────────────────────────────────────────────

locationSettingsRoute.post('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const body = await c.req.json().catch(() => ({})) as LocationSettingInput

  const validationError = validateInput(body)
  if (validationError) return c.json({ error: validationError }, 400)

  const settingType: SettingType = body.settingType && VALID_SETTING_TYPES.includes(body.settingType)
    ? body.settingType
    : 'appraisal'

  if (body.appraisalPresetId) {
    const db = drizzle(c.env.DB)
    const [preset] = await db
      .select({ id: appraisalRulePreset.id })
      .from(appraisalRulePreset)
      .where(and(eq(appraisalRulePreset.id, body.appraisalPresetId), eq(appraisalRulePreset.userId, session.user.id)))
      .limit(1)
    if (!preset) return c.json({ error: 'Appraisal preset not found' }, 404)
  }

  const db = drizzle(c.env.DB)
  const now = new Date().toISOString()

  const [row] = await db
    .insert(locationSettings)
    .values({
      userId: session.user.id,
      settingType,
      isEnabled: body.isEnabled !== false,
      state: body.state?.toUpperCase() ?? null,
      city: body.city?.toLowerCase() ?? null,
      zipCode: body.zipCode ?? null,
      appraisalPresetId: body.appraisalPresetId ?? null,
      rehabConfigJson: body.rehabConfigJson ? JSON.stringify(body.rehabConfigJson) : null,
      tierRangesJson: body.tierRangesJson ? JSON.stringify(body.tierRangesJson) : null,
      dealParamsJson: body.dealParamsJson ? JSON.stringify(body.dealParamsJson) : null,
      majorItemCostsJson: body.majorItemCostsJson ? JSON.stringify(body.majorItemCostsJson) : null,
      arvThresholdJson: body.arvThresholdJson ? JSON.stringify(body.arvThresholdJson) : null,
      proximityConfigJson: body.proximityConfigJson ? JSON.stringify(body.proximityConfigJson) : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()

  // If appraisalFilters provided, upsert hidden preset now that we have the row ID
  let finalRow = row
  if (body.appraisalFilters && body.appraisalFilters.length > 0) {
    const presetId = await upsertLocationPreset(
      db,
      session.user.id,
      row.id,
      body.appraisalFilters,
      body.appraisalAdjustments ?? []
    )
    const [updated] = await db
      .update(locationSettings)
      .set({ appraisalPresetId: presetId, updatedAt: now })
      .where(eq(locationSettings.id, row.id))
      .returning()
    finalRow = updated
  }

  // Invalidate cached user settings
  await invalidateUserSettingsCache(c.env.API_CACHE, session.user.id)

  const appraisalRules = await resolveLocationAppraisalRules(db, session.user.id, finalRow.appraisalPresetId)
  return c.json({
    setting: {
      ...serializeRow(finalRow),
      appraisalFilters: appraisalRules?.appraisalFilters ?? null,
      appraisalAdjustments: appraisalRules?.appraisalAdjustments ?? null,
      hasAppraisalOverride: appraisalRules !== null,
      createdAt: finalRow.createdAt,
      updatedAt: finalRow.updatedAt,
    },
  }, 201)
})

// ─── PATCH /location-settings/:id ─────────────────────────────────────────────

locationSettingsRoute.patch('/:id', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const id = c.req.param('id')
  const db = drizzle(c.env.DB)

  const [existing] = await db
    .select()
    .from(locationSettings)
    .where(and(eq(locationSettings.id, id), eq(locationSettings.userId, session.user.id)))
    .limit(1)
  if (!existing) return c.json({ error: 'Location setting not found' }, 404)

  const body = await c.req.json().catch(() => ({})) as Partial<LocationSettingInput>

  const hasLocationChange = body.state !== undefined || body.city !== undefined || body.zipCode !== undefined
  if (hasLocationChange) {
    const merged: LocationSettingInput = {
      state: body.state ?? existing.state ?? undefined,
      city: body.city ?? existing.city ?? undefined,
      zipCode: body.zipCode ?? existing.zipCode ?? undefined,
    }
    const validationError = validateInput(merged)
    if (validationError) return c.json({ error: validationError }, 400)
  }

  if (body.appraisalPresetId) {
    const [preset] = await db
      .select({ id: appraisalRulePreset.id })
      .from(appraisalRulePreset)
      .where(and(eq(appraisalRulePreset.id, body.appraisalPresetId), eq(appraisalRulePreset.userId, session.user.id)))
      .limit(1)
    if (!preset) return c.json({ error: 'Appraisal preset not found' }, 404)
  }

  const now = new Date().toISOString()
  const updates: Record<string, unknown> = { updatedAt: now }

  if (body.isEnabled !== undefined) updates.isEnabled = body.isEnabled
  if (body.state !== undefined) updates.state = body.state?.toUpperCase() ?? null
  if (body.city !== undefined) updates.city = body.city?.toLowerCase() ?? null
  if (body.zipCode !== undefined) updates.zipCode = body.zipCode ?? null
  if (body.appraisalPresetId !== undefined) updates.appraisalPresetId = body.appraisalPresetId ?? null
  if (body.rehabConfigJson !== undefined) updates.rehabConfigJson = body.rehabConfigJson ? JSON.stringify(body.rehabConfigJson) : null
  if (body.tierRangesJson !== undefined) updates.tierRangesJson = body.tierRangesJson ? JSON.stringify(body.tierRangesJson) : null
  if (body.dealParamsJson !== undefined) updates.dealParamsJson = body.dealParamsJson ? JSON.stringify(body.dealParamsJson) : null
  if (body.majorItemCostsJson !== undefined) updates.majorItemCostsJson = body.majorItemCostsJson ? JSON.stringify(body.majorItemCostsJson) : null
  if (body.arvThresholdJson !== undefined) updates.arvThresholdJson = body.arvThresholdJson ? JSON.stringify(body.arvThresholdJson) : null
  if (body.proximityConfigJson !== undefined) updates.proximityConfigJson = body.proximityConfigJson ? JSON.stringify(body.proximityConfigJson) : null

  // Handle inline appraisal override
  if (body.appraisalFilters !== undefined) {
    if (body.appraisalFilters === null) {
      // Clear override — delete hidden preset if present
      if (existing.appraisalPresetId) {
        await deleteLocationPreset(db, session.user.id, existing.appraisalPresetId)
      }
      updates.appraisalPresetId = null
    } else {
      // Upsert hidden preset
      const presetId = await upsertLocationPreset(
        db,
        session.user.id,
        id,
        body.appraisalFilters,
        body.appraisalAdjustments ?? []
      )
      updates.appraisalPresetId = presetId
    }
  }

  await db.update(locationSettings).set(updates).where(eq(locationSettings.id, id))

  // Invalidate cached user settings
  await invalidateUserSettingsCache(c.env.API_CACHE, session.user.id)

  const [updated] = await db.select().from(locationSettings).where(eq(locationSettings.id, id)).limit(1)
  const appraisalRules = await resolveLocationAppraisalRules(db, session.user.id, updated.appraisalPresetId)

  return c.json({
    setting: {
      ...serializeRow(updated),
      appraisalFilters: appraisalRules?.appraisalFilters ?? null,
      appraisalAdjustments: appraisalRules?.appraisalAdjustments ?? null,
      hasAppraisalOverride: appraisalRules !== null,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    },
  })
})

// ─── DELETE /location-settings/:id ────────────────────────────────────────────

locationSettingsRoute.delete('/:id', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const id = c.req.param('id')
  const db = drizzle(c.env.DB)

  const [existing] = await db
    .select()
    .from(locationSettings)
    .where(and(eq(locationSettings.id, id), eq(locationSettings.userId, session.user.id)))
    .limit(1)
  if (!existing) return c.json({ error: 'Location setting not found' }, 404)

  // Clean up hidden appraisal preset if present
  if (existing.appraisalPresetId) {
    await deleteLocationPreset(db, session.user.id, existing.appraisalPresetId)
  }

  await db.delete(locationSettings).where(eq(locationSettings.id, id))

  // Invalidate cached user settings
  await invalidateUserSettingsCache(c.env.API_CACHE, session.user.id)

  return c.json({ success: true })
})

export default locationSettingsRoute
