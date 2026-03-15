/**
 * GHL Integration Settings Routes (Dashboard / Session Auth)
 *
 * Per-user GoHighLevel CRM integration configuration:
 * API token, location ID, custom field mappings, webhook URL.
 */

import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import type { Env } from '../types'
import { getSession } from '../lib/session'
import { ghlSettings } from '../db'
import { GHL_MAPPABLE_FIELDS, testGHLConnection } from '../services/ghl'

const ghlSettingsRoute = new Hono<{ Bindings: Env }>()

// ─── GET /ghl-settings/fields ────────────────────────────────────────────────

ghlSettingsRoute.get('/fields', (c) => {
  return c.json({ fields: GHL_MAPPABLE_FIELDS })
})

// ─── GET /ghl-settings ───────────────────────────────────────────────────────

ghlSettingsRoute.get('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const db = drizzle(c.env.DB)
  const [row] = await db
    .select()
    .from(ghlSettings)
    .where(eq(ghlSettings.userId, session.user.id))
    .limit(1)

  if (!row) {
    return c.json({ settings: null, isConfigured: false })
  }

  let fieldMappings: Record<string, string> = {}
  if (row.fieldMappings) {
    try {
      fieldMappings = JSON.parse(row.fieldMappings)
    } catch {}
  }

  const url = new URL(c.req.url)
  const webhookUrl = `${url.protocol}//${url.host}/webhooks/ghl/${row.webhookSecret}`

  return c.json({
    settings: {
      locationId: row.locationId,
      isEnabled: row.isEnabled,
      fieldMappings,
      monetaryValueField: row.monetaryValueField ?? 'arv',
      webhookUrl,
      webhookSecret: row.webhookSecret,
      updatedAt: row.updatedAt,
      // Don't expose full API token — show masked version
      hasApiToken: !!row.apiToken,
      apiTokenMasked: row.apiToken ? `${row.apiToken.slice(0, 8)}...${row.apiToken.slice(-4)}` : null,
    },
    isConfigured: true,
  })
})

// ─── PUT /ghl-settings ───────────────────────────────────────────────────────

interface GHLSettingsBody {
  apiToken?: string
  locationId?: string
  isEnabled?: boolean
  fieldMappings?: Record<string, string>
  monetaryValueField?: string
}

ghlSettingsRoute.put('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const body = (await c.req.json().catch(() => ({}))) as GHLSettingsBody

  const db = drizzle(c.env.DB)
  const now = new Date().toISOString()

  const [existing] = await db
    .select()
    .from(ghlSettings)
    .where(eq(ghlSettings.userId, session.user.id))
    .limit(1)

  // Validate field mappings keys
  if (body.fieldMappings) {
    const validKeys = Object.keys(GHL_MAPPABLE_FIELDS)
    for (const key of Object.keys(body.fieldMappings)) {
      if (!validKeys.includes(key)) {
        return c.json({ error: `Invalid field mapping key: ${key}. Valid keys: ${validKeys.join(', ')}` }, 400)
      }
    }
  }

  if (existing) {
    // Update — only set fields that were provided
    const updates: Record<string, unknown> = { updatedAt: now }
    if (body.apiToken !== undefined) updates.apiToken = body.apiToken
    if (body.locationId !== undefined) updates.locationId = body.locationId
    if (body.isEnabled !== undefined) updates.isEnabled = body.isEnabled
    if (body.fieldMappings !== undefined) updates.fieldMappings = JSON.stringify(body.fieldMappings)
    if (body.monetaryValueField !== undefined) updates.monetaryValueField = body.monetaryValueField

    await db
      .update(ghlSettings)
      .set(updates)
      .where(eq(ghlSettings.userId, session.user.id))

    // Re-fetch to return updated data
    const [updated] = await db
      .select()
      .from(ghlSettings)
      .where(eq(ghlSettings.userId, session.user.id))
      .limit(1)

    const url = new URL(c.req.url)
    return c.json({
      settings: {
        locationId: updated.locationId,
        isEnabled: updated.isEnabled,
        fieldMappings: updated.fieldMappings ? JSON.parse(updated.fieldMappings) : {},
        monetaryValueField: updated.monetaryValueField ?? 'arv',
        webhookUrl: `${url.protocol}//${url.host}/webhooks/ghl/${updated.webhookSecret}`,
        webhookSecret: updated.webhookSecret,
        updatedAt: updated.updatedAt,
        hasApiToken: !!updated.apiToken,
        apiTokenMasked: updated.apiToken ? `${updated.apiToken.slice(0, 8)}...${updated.apiToken.slice(-4)}` : null,
      },
      isConfigured: true,
    })
  } else {
    // Create — apiToken and locationId are required for initial setup
    if (!body.apiToken) return c.json({ error: 'apiToken is required' }, 400)
    if (!body.locationId) return c.json({ error: 'locationId is required' }, 400)

    const [created] = await db
      .insert(ghlSettings)
      .values({
        userId: session.user.id,
        apiToken: body.apiToken,
        locationId: body.locationId,
        isEnabled: body.isEnabled ?? true,
        fieldMappings: body.fieldMappings ? JSON.stringify(body.fieldMappings) : null,
        monetaryValueField: body.monetaryValueField ?? 'arv',
        createdAt: now,
        updatedAt: now,
      })
      .returning()

    const url = new URL(c.req.url)
    return c.json({
      settings: {
        locationId: created.locationId,
        isEnabled: created.isEnabled,
        fieldMappings: created.fieldMappings ? JSON.parse(created.fieldMappings) : {},
        monetaryValueField: created.monetaryValueField ?? 'arv',
        webhookUrl: `${url.protocol}//${url.host}/webhooks/ghl/${created.webhookSecret}`,
        webhookSecret: created.webhookSecret,
        updatedAt: created.updatedAt,
        hasApiToken: true,
        apiTokenMasked: `${created.apiToken.slice(0, 8)}...${created.apiToken.slice(-4)}`,
      },
      isConfigured: true,
    })
  }
})

// ─── DELETE /ghl-settings ────────────────────────────────────────────────────

ghlSettingsRoute.delete('/', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const db = drizzle(c.env.DB)
  await db.delete(ghlSettings).where(eq(ghlSettings.userId, session.user.id))

  return c.json({ settings: null, isConfigured: false })
})

// ─── POST /ghl-settings/test ─────────────────────────────────────────────────

ghlSettingsRoute.post('/test', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const db = drizzle(c.env.DB)
  const [row] = await db
    .select()
    .from(ghlSettings)
    .where(eq(ghlSettings.userId, session.user.id))
    .limit(1)

  if (!row) {
    return c.json({ success: false, error: 'GHL integration not configured' }, 400)
  }

  const result = await testGHLConnection({
    apiToken: row.apiToken,
    locationId: row.locationId,
  })

  return c.json(result)
})

export default ghlSettingsRoute
