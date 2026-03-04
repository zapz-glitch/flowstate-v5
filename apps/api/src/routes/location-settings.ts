/**
 * Location Settings Routes (Dashboard / Session Auth)
 *
 * Per-location overrides for appraisal preset, rehab config, deal params, and major item costs.
 * When /v1/analyze is called, the most specific matching location setting wins:
 * zip > city+state > state > user default > system default
 */

import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq, and } from 'drizzle-orm'
import type { Env } from '../types'
import { createAuth } from '../lib/auth'
import { locationSettings, appraisalRulePreset } from '../db'

const locationSettingsRoute = new Hono<{ Bindings: Env }>()

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

interface LocationSettingInput {
  state?: string
  city?: string
  zipCode?: string
  appraisalPresetId?: string | null
  rehabConfigJson?: Record<string, unknown> | null
  dealParamsJson?: Record<string, unknown> | null
  majorItemCostsJson?: Record<string, number> | null
}

function validateInput(body: LocationSettingInput): string | null {
  // Valid scopes: state only | city + state (state required) | zip only
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

function serializeRow(r: typeof locationSettings.$inferSelect) {
  return {
    id: r.id,
    state: r.state,
    city: r.city,
    zipCode: r.zipCode,
    appraisalPresetId: r.appraisalPresetId,
    rehabConfigJson: r.rehabConfigJson ? JSON.parse(r.rehabConfigJson) : null,
    dealParamsJson: r.dealParamsJson ? JSON.parse(r.dealParamsJson) : null,
    majorItemCostsJson: r.majorItemCostsJson ? JSON.parse(r.majorItemCostsJson) : null,
    hasRehabConfig: r.rehabConfigJson !== null,
    hasDealParams: r.dealParamsJson !== null,
    hasMajorItemCosts: r.majorItemCostsJson !== null,
  }
}

// ─── GET /location-settings ───────────────────────────────────────────────────

locationSettingsRoute.get('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const db = drizzle(c.env.DB)
  const rows = await db
    .select()
    .from(locationSettings)
    .where(eq(locationSettings.userId, session.user.id))
    .orderBy(locationSettings.createdAt)

  // Resolve preset names
  const presetIds = [...new Set(rows.map((r) => r.appraisalPresetId).filter(Boolean))] as string[]
  const presetMap = new Map<string, string>()
  if (presetIds.length > 0) {
    const presets = await db
      .select({ id: appraisalRulePreset.id, name: appraisalRulePreset.name })
      .from(appraisalRulePreset)
      .where(eq(appraisalRulePreset.userId, session.user.id))
    for (const p of presets) presetMap.set(p.id, p.name)
  }

  const settings = rows.map((r) => ({
    ...serializeRow(r),
    appraisalPresetName: r.appraisalPresetId ? (presetMap.get(r.appraisalPresetId) ?? null) : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }))

  return c.json({ settings })
})

// ─── POST /location-settings ──────────────────────────────────────────────────

locationSettingsRoute.post('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const body = await c.req.json().catch(() => ({})) as LocationSettingInput

  const validationError = validateInput(body)
  if (validationError) return c.json({ error: validationError }, 400)

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
      state: body.state?.toUpperCase() ?? null,
      city: body.city?.toLowerCase() ?? null,
      zipCode: body.zipCode ?? null,
      appraisalPresetId: body.appraisalPresetId ?? null,
      rehabConfigJson: body.rehabConfigJson ? JSON.stringify(body.rehabConfigJson) : null,
      dealParamsJson: body.dealParamsJson ? JSON.stringify(body.dealParamsJson) : null,
      majorItemCostsJson: body.majorItemCostsJson ? JSON.stringify(body.majorItemCostsJson) : null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()

  return c.json({ setting: { ...serializeRow(row), createdAt: row.createdAt, updatedAt: row.updatedAt } }, 201)
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

  if (body.state !== undefined) updates.state = body.state?.toUpperCase() ?? null
  if (body.city !== undefined) updates.city = body.city?.toLowerCase() ?? null
  if (body.zipCode !== undefined) updates.zipCode = body.zipCode ?? null
  if (body.appraisalPresetId !== undefined) updates.appraisalPresetId = body.appraisalPresetId ?? null
  if (body.rehabConfigJson !== undefined) updates.rehabConfigJson = body.rehabConfigJson ? JSON.stringify(body.rehabConfigJson) : null
  if (body.dealParamsJson !== undefined) updates.dealParamsJson = body.dealParamsJson ? JSON.stringify(body.dealParamsJson) : null
  if (body.majorItemCostsJson !== undefined) updates.majorItemCostsJson = body.majorItemCostsJson ? JSON.stringify(body.majorItemCostsJson) : null

  await db.update(locationSettings).set(updates).where(eq(locationSettings.id, id))

  const [updated] = await db.select().from(locationSettings).where(eq(locationSettings.id, id)).limit(1)

  return c.json({ setting: { ...serializeRow(updated), createdAt: updated.createdAt, updatedAt: updated.updatedAt } })
})

// ─── DELETE /location-settings/:id ────────────────────────────────────────────

locationSettingsRoute.delete('/:id', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const id = c.req.param('id')
  const db = drizzle(c.env.DB)

  const [existing] = await db
    .select({ id: locationSettings.id })
    .from(locationSettings)
    .where(and(eq(locationSettings.id, id), eq(locationSettings.userId, session.user.id)))
    .limit(1)
  if (!existing) return c.json({ error: 'Location setting not found' }, 404)

  await db.delete(locationSettings).where(eq(locationSettings.id, id))

  return c.json({ success: true })
})

export default locationSettingsRoute
