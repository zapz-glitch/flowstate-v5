/**
 * GoHighLevel Webhook Endpoint
 *
 * Receives webhooks from GHL workflows to trigger property analysis.
 * Authenticated via URL-based webhook secret + optional X-API-Key header.
 *
 * Flow:
 * 1. GHL workflow sends POST /webhooks/ghl/:webhookSecret with X-API-Key header
 * 2. Look up user by webhookSecret in ghl_settings table
 * 3. Verify X-API-Key matches one of the user's Flowstate API keys
 * 4. Parse property address from GHL payload
 * 5. Load user's analysis settings
 * 6. Start analysis workflow with GHL params for result push-back
 * 7. Return 202 Accepted with jobId
 */

import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq, and } from 'drizzle-orm'
import type { Env } from '../../types'
import { ghlSettings, apiKeys } from '../../db'
import { loadUserAnalysisSettings } from '../../services/user-settings'
import type { AnalysisWorkflowParams } from '../../workflows/types'

const ghlWebhook = new Hono<{ Bindings: Env }>()

// ─── GHL Webhook Payload ─────────────────────────────────────────────────────

interface GHLWebhookPayload {
  // Contact standard fields
  first_name?: string
  last_name?: string
  full_name?: string
  email?: string
  phone?: string
  address1?: string
  city?: string
  state?: string
  postal_code?: string
  full_address?: string

  // Opportunity fields (root level when triggered by pipeline/opportunity events)
  id?: string // Opportunity ID
  opportunity_name?: string
  status?: string
  lead_value?: string | number
  pipeline_id?: string
  pipeline_name?: string

  // Location (nested object)
  location?: {
    id?: string
    name?: string
    address?: string
    city?: string
    state?: string
    postalCode?: string
    fullAddress?: string
  }

  // Allow any other custom fields from GHL
  [key: string]: unknown
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`
}

/**
 * Parse a full address string like "123 Main St, Dallas, TX 75201"
 * into street, city, state, zip components.
 */
function parseAddress(fullAddress: string): { street: string; city: string; state: string; zip: string } {
  const parts = fullAddress.split(',').map((p) => p.trim())

  if (parts.length >= 3) {
    // "123 Main St, Dallas, TX 75201"
    const street = parts[0]
    const city = parts[1]
    // Last part might be "TX 75201" or "TX" + "75201"
    const stateZip = parts.slice(2).join(' ').trim()
    const stateZipMatch = stateZip.match(/^([A-Z]{2})\s*(\d{5}(?:-\d{4})?)?$/)
    if (stateZipMatch) {
      return { street, city, state: stateZipMatch[1], zip: stateZipMatch[2] || '' }
    }
    return { street, city, state: stateZip, zip: '' }
  }

  if (parts.length === 2) {
    // "123 Main St, Dallas TX 75201"
    const street = parts[0]
    const rest = parts[1]
    const match = rest.match(/^(.+?)\s+([A-Z]{2})\s*(\d{5}(?:-\d{4})?)?$/)
    if (match) {
      return { street, city: match[1], state: match[2], zip: match[3] || '' }
    }
    return { street, city: rest, state: '', zip: '' }
  }

  // Single string — use as full address, let the analysis pipeline handle it
  return { street: fullAddress, city: '', state: '', zip: '' }
}

function normalizePropertyKey(address: string, city: string, state: string, zipCode: string): string {
  const addressParts = [address, city, state, zipCode]
    .map((s) => s.toLowerCase().trim())
    .join('|')

  let hash = 0
  for (let i = 0; i < addressParts.length; i++) {
    const char = addressParts.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash
  }
  return `addr:${Math.abs(hash).toString(36)}`
}

// ─── GHL API Helpers ─────────────────────────────────────────────────────────

const GHL_BASE_URL = 'https://services.leadconnectorhq.com'
const GHL_API_VERSION = '2021-07-28'

interface GHLOpportunityData {
  id: string
  name?: string
  customFields?: Array<{ id: string; fieldValue?: unknown }>
  contact?: { id?: string }
  [key: string]: unknown
}

/**
 * Fetch full opportunity details from GHL API (includes custom fields)
 */
async function fetchOpportunityDetails(
  apiToken: string,
  opportunityId: string
): Promise<GHLOpportunityData | null> {
  try {
    const response = await fetch(`${GHL_BASE_URL}/opportunities/${opportunityId}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Version: GHL_API_VERSION,
      },
    })

    if (!response.ok) {
      console.error(`[GHL Webhook] Failed to fetch opportunity ${opportunityId}: ${response.status}`)
      return null
    }

    const data = await response.json() as { opportunity?: GHLOpportunityData }
    return data.opportunity ?? null
  } catch (error) {
    console.error(`[GHL Webhook] Error fetching opportunity:`, error)
    return null
  }
}

/**
 * Extract property address from opportunity custom fields.
 * Matches by field ID if provided, otherwise takes the first non-empty string field.
 */
function extractPropertyAddress(
  opportunity: GHLOpportunityData,
  propertyFieldId?: string
): string | null {
  if (!opportunity.customFields) return null

  for (const field of opportunity.customFields) {
    // If a specific field ID is configured, match on it
    if (propertyFieldId && field.id === propertyFieldId) {
      const val = typeof field.fieldValue === 'string' ? field.fieldValue.trim() : ''
      if (val) return val
    }

    // Otherwise, take the first field that looks like an address
    if (!propertyFieldId && typeof field.fieldValue === 'string') {
      const val = field.fieldValue.trim()
      if (val) return val
    }
  }

  return null
}

// ─── POST /webhooks/ghl/:webhookSecret ───────────────────────────────────────

ghlWebhook.post('/:webhookSecret', async (c) => {
  const webhookSecret = c.req.param('webhookSecret')

  try {
    const db = drizzle(c.env.DB)

    // Look up user by webhook secret
    const [settings] = await db
      .select()
      .from(ghlSettings)
      .where(eq(ghlSettings.webhookSecret, webhookSecret))
      .limit(1)

    if (!settings) {
      return c.json({ success: false, error: 'Invalid webhook' }, 404)
    }

    if (!settings.isEnabled) {
      return c.json({ success: false, error: 'Integration disabled' }, 403)
    }

    // Verify API key header
    const apiKey = c.req.header('X-API-Key')
    if (!apiKey) {
      return c.json({ success: false, error: 'Missing X-API-Key header' }, 401)
    }

    // Hash and verify against user's API keys
    const encoder = new TextEncoder()
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(apiKey))
    const keyHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')

    const apiKeyRow = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.keyHash, keyHash),
          eq(apiKeys.userId, settings.userId),
          eq(apiKeys.isActive, true)
        )
      )
      .limit(1)
      .then((r) => r[0])

    if (!apiKeyRow) {
      return c.json({ success: false, error: 'Invalid API key' }, 401)
    }

    // Parse GHL webhook payload
    const body = await c.req.json<GHLWebhookPayload>().catch(() => ({} as GHLWebhookPayload))

    // Log full payload for observability
    console.log(`[GHL Webhook] Received payload:`, JSON.stringify(body))

    // Validate opportunity ID (GHL sends it as `id` at root level)
    const opportunityId = body.id
    if (!opportunityId) {
      return c.json({ success: false, error: 'Opportunity ID (id) is required. Ensure workflow has an opportunity trigger.' }, 400)
    }

    // Validate location.id matches (defense-in-depth)
    const payloadLocationId = body.location?.id
    if (payloadLocationId && payloadLocationId !== settings.locationId) {
      console.warn(`[GHL Webhook] Location mismatch: payload=${payloadLocationId} settings=${settings.locationId}`)
      return c.json({ success: false, error: 'Location mismatch' }, 403)
    }

    // Parse field mappings early (needed for property address extraction)
    let fieldMappings: Record<string, string> = {}
    if (settings.fieldMappings) {
      try {
        fieldMappings = JSON.parse(settings.fieldMappings)
      } catch {}
    }

    // Fetch opportunity details from GHL API to get custom fields
    // The standard webhook payload doesn't include opportunity custom fields,
    // so we need to fetch them via API using the opportunity ID.
    const opportunityData = await fetchOpportunityDetails(settings.apiToken, opportunityId)
    if (!opportunityData) {
      return c.json({ success: false, error: 'Failed to fetch opportunity details from GHL' }, 502)
    }

    console.log(`[GHL Webhook] Opportunity custom fields:`, JSON.stringify(opportunityData.customFields ?? []))

    // Extract property address from opportunity custom fields
    // Look for a custom field named "property_details" (or similar)
    // Use the propertyAddress field ID from field mappings if configured
    const propertyFieldId = fieldMappings['propertyAddress'] || undefined
    const propertyAddress = extractPropertyAddress(opportunityData, propertyFieldId)
    if (!propertyAddress) {
      return c.json(
        { success: false, error: 'Property address not found. Add a "property_details" custom field on the opportunity, or set the contact full_address.' },
        400
      )
    }

    const fullAddress = propertyAddress.trim()
    const parsed = parseAddress(fullAddress)
    const streetAddress = parsed.street
    const city = parsed.city
    const state = parsed.state
    const zipCode = parsed.zip

    const jobId = generateJobId()
    const propertyKey = normalizePropertyKey(streetAddress, city, state, zipCode)
    const userId = settings.userId

    // Initialize job state in Durable Object
    const doId = c.env.ANALYSIS_JOB.idFromName(`${userId}:${propertyKey}`)
    const jobDO = c.env.ANALYSIS_JOB.get(doId)

    const initResponse = await jobDO.fetch(
      new Request('http://internal/init', {
        method: 'POST',
        body: JSON.stringify({
          jobId,
          userId,
          propertyKey,
          request: { address: streetAddress, city, state, zipCode, source: 'ghl_webhook' },
        }),
      })
    )

    if (!initResponse.ok) {
      const error = (await initResponse.json()) as { error?: string }
      return c.json({ success: false, error: error.error || 'Failed to initialize job' }, 500)
    }
    // Consume response body to properly dispose RPC result
    await initResponse.text()

    // Load user's analysis settings
    const userSettings = await loadUserAnalysisSettings(c.env.DB, {
      userId,
      address: { city, state, zipCode },
    })

    // Build workflow params
    const workflowParams: AnalysisWorkflowParams = {
      jobId,
      userId,
      propertyKey,
      address: fullAddress || `${streetAddress}, ${city}, ${state} ${zipCode}`.trim(),
      streetAddress,
      city,
      state,
      zipCode,
      appraisalRules: userSettings.appraisalRules,
      buybox: userSettings.mergedBuybox,
      customRehabTable: userSettings.customRehabTable,
      customMajorItemCosts: userSettings.customMajorItemCosts,
      // GHL-specific params for Step 7 push-back
      ghl: {
        opportunityId,
        locationId: settings.locationId,
        apiToken: settings.apiToken,
        fieldMappings,
        monetaryValueField: settings.monetaryValueField ?? 'arv',
      },
    }

    // Start the workflow
    const workflow = await c.env.ANALYSIS_WORKFLOW.create({
      id: jobId,
      params: workflowParams,
    })

    console.log(`[GHL Webhook] Job ${jobId} started for opportunity ${opportunityId} (workflow: ${workflow.id})`)

    const baseUrl = new URL(c.req.url).origin
    return c.json(
      {
        success: true,
        data: {
          jobId,
          propertyKey,
          opportunityId,
          status: 'queued',
          pollUrl: `${baseUrl}/v1/analyze/jobs/${jobId}?propertyKey=${encodeURIComponent(propertyKey)}`,
        },
      },
      202
    )
  } catch (error) {
    console.error('[GHL Webhook] Error:', error)
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Internal error',
      },
      500
    )
  }
})

export default ghlWebhook
