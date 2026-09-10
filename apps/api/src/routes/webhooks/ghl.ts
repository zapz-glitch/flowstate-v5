/**
 * GoHighLevel Webhook Endpoint
 *
 * Receives webhooks from GHL workflows to trigger property analysis.
 * Authenticated via URL-based webhook secret + X-API-Key header.
 *
 * Flow:
 * 1. Validate webhook secret + API key
 * 2. Fetch opportunity details from GHL to extract property address
 * 3. Fetch property bundle from CoreLogic
 * 4. Run evaluation (appraisal + price classification + valuation)
 * 5. Push results back to GHL opportunity (inline, 3 retries)
 * 6. Save report to DB (background via waitUntil)
 * 7. Return 200 with jobId and result
 */

import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1'
import { eq, and } from 'drizzle-orm'
import type { Env } from '../../types'
import { ghlSettings, apiKeys, savedReports, reportHistory } from '../../db'
import { loadUserAnalysisSettings } from '../../services/user-settings'
import { createPropertyApi } from '../../services/property-api'
import { DEFAULT_FILTERS } from '../../services/appraisal'
import { filtersToApiParams } from '../../services/appraisal/types'
import { evaluateConfigured } from '../../services/evaluation/python'
import {
  buildGHLCustomFields,
  updateGHLOpportunity,
  extractAnalysisFieldValue,
} from '../../services/ghl'

const ghlWebhook = new Hono<{ Bindings: Env }>()

// ─── GHL Webhook Payload ─────────────────────────────────────────────────────

interface GHLWebhookPayload {
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
  id?: string
  opportunity_name?: string
  status?: string
  lead_value?: string | number
  pipeline_id?: string
  pipeline_name?: string
  location?: {
    id?: string
    name?: string
    address?: string
    city?: string
    state?: string
    postalCode?: string
    fullAddress?: string
  }
  [key: string]: unknown
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`
}

function parseAddress(fullAddress: string): { street: string; city: string; state: string; zip: string } {
  const parts = fullAddress.split(',').map((p) => p.trim())

  if (parts.length >= 3) {
    const street = parts[0]
    const city = parts[1]
    const stateZip = parts.slice(2).join(' ').trim()
    const stateZipMatch = stateZip.match(/^([A-Z]{2})\s*(\d{5}(?:-\d{4})?)?$/)
    if (stateZipMatch) {
      return { street, city, state: stateZipMatch[1], zip: stateZipMatch[2] || '' }
    }
    return { street, city, state: stateZip, zip: '' }
  }

  if (parts.length === 2) {
    const street = parts[0]
    const rest = parts[1]
    const match = rest.match(/^(.+?)\s+([A-Z]{2})\s*(\d{5}(?:-\d{4})?)?$/)
    if (match) {
      return { street, city: match[1], state: match[2], zip: match[3] || '' }
    }
    return { street, city: rest, state: '', zip: '' }
  }

  return { street: fullAddress, city: '', state: '', zip: '' }
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

function extractPropertyAddress(
  opportunity: GHLOpportunityData,
  propertyFieldId?: string
): string | null {
  if (!opportunity.customFields) return null

  for (const field of opportunity.customFields) {
    if (propertyFieldId && field.id === propertyFieldId) {
      const val = typeof field.fieldValue === 'string' ? field.fieldValue.trim() : ''
      if (val) return val
    }
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
  const routeStart = Date.now()

  try {
    const db = drizzle(c.env.DB)

    // ── 1. Look up user by webhook secret ────────────────────────────────────
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

    // ── 2. Verify API key header ──────────────────────────────────────────────
    const apiKey = c.req.header('X-API-Key')
    if (!apiKey) {
      return c.json({ success: false, error: 'Missing X-API-Key header' }, 401)
    }

    const encoder = new TextEncoder()
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(apiKey))
    const keyHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')

    const apiKeyRow = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.userId, settings.userId), eq(apiKeys.isActive, true)))
      .limit(1)
      .then((r) => r[0])

    if (!apiKeyRow) {
      return c.json({ success: false, error: 'Invalid API key' }, 401)
    }

    // ── 3. Parse GHL webhook payload ──────────────────────────────────────────
    const body = await c.req.json<GHLWebhookPayload>().catch(() => ({} as GHLWebhookPayload))
    console.log(`[GHL Webhook] Received payload:`, JSON.stringify(body))

    const opportunityId = body.id
    if (!opportunityId) {
      return c.json({ success: false, error: 'Opportunity ID (id) is required in payload.' }, 400)
    }

    const payloadLocationId = body.location?.id
    if (payloadLocationId && payloadLocationId !== settings.locationId) {
      console.warn(`[GHL Webhook] Location mismatch: payload=${payloadLocationId} settings=${settings.locationId}`)
      return c.json({ success: false, error: 'Location mismatch' }, 403)
    }

    let fieldMappings: Record<string, string> = {}
    if (settings.fieldMappings) {
      try { fieldMappings = JSON.parse(settings.fieldMappings) } catch {}
    }

    // ── 4. Fetch opportunity details to get property address ──────────────────
    const opportunityData = await fetchOpportunityDetails(settings.apiToken, opportunityId)
    if (!opportunityData) {
      return c.json({ success: false, error: 'Failed to fetch opportunity details from GHL' }, 502)
    }

    console.log(`[GHL Webhook] Opportunity custom fields:`, JSON.stringify(opportunityData.customFields ?? []))

    const propertyFieldId = fieldMappings['propertyAddress'] || undefined
    const propertyAddress = extractPropertyAddress(opportunityData, propertyFieldId)
    if (!propertyAddress) {
      return c.json(
        { success: false, error: 'Property address not found in opportunity custom fields.' },
        400
      )
    }

    const parsed = parseAddress(propertyAddress.trim())
    const { street: streetAddress, city, state, zip: zipCode } = parsed
    const fullAddress = `${streetAddress}, ${city}, ${state} ${zipCode}`.trim()
    const jobId = generateJobId()
    const userId = settings.userId

    console.log(`[GHL Webhook] Job ${jobId} — analyzing: ${fullAddress}`)

    // ── 5. Load user settings ─────────────────────────────────────────────────
    const userSettings = await loadUserAnalysisSettings(c.env.DB, {
      userId,
      address: { city, state, zipCode },
    }, c.env.API_CACHE)

    // ── 6. Fetch property bundle from CoreLogic ───────────────────────────────
    const bundleFetchStart = Date.now()
    const propertyApi = createPropertyApi(c.env)
    propertyApi.resetCallStats()
    const filters = userSettings.appraisalRules?.filters ?? DEFAULT_FILTERS
    const apiFilterParams = filtersToApiParams(filters)

    const bundleResult = await propertyApi.getPropertyBundle({
      address: fullAddress,
      streetAddress,
      city,
      state,
      zipCode,
      comparables: {
        radiusMiles: apiFilterParams.radiusMiles ?? 1,
        maxComps: 10,
        monthsBack: apiFilterParams.monthsBack ?? 12,
        sqftVariance: apiFilterParams.sqftVariance,
      },
      enrichment: {
        permits: true,
        floodZone: true,
        weatherRisk: false,
        neighbourhood: false,
      },
    })

    console.log(`[GHL Webhook][Timing] CoreLogic fetch: ${Date.now() - bundleFetchStart}ms`)

    if (!bundleResult.success) {
      return c.json(
        { success: false, error: bundleResult.error || 'Failed to fetch property data' },
        400
      )
    }

    // ── 7. Evaluate: appraisal + price classification + valuation ─────────────
    const evalStart = Date.now()
    const propertyCallStats = propertyApi.getCallStats()

    const { response: analysisResult } = await evaluateConfigured({
      jobId,
      userId,
      bundle: bundleResult.data,
      appraisalRules: userSettings.appraisalRules,
      buybox: userSettings.mergedBuybox,
      customRehabTable: userSettings.customRehabTable,
      customTierRanges: userSettings.customTierRanges,
      customMajorItemCosts: userSettings.customMajorItemCosts,
      arvThreshold: userSettings.arvThreshold,
      apiCallStats: {
        corelogic: {
          total: propertyCallStats.total,
          cached: propertyCallStats.cached,
          endpoints: propertyCallStats.endpoints,
        },
        totalExternalCalls: propertyCallStats.total,
      },
    }, c.env)

    console.log(`[GHL Webhook][Timing] Evaluation: ${Date.now() - evalStart}ms`)

    // ── 8. Push results to GHL opportunity (inline, up to 3 attempts) ─────────
    const ghlStart = Date.now()
    let ghlSuccess = false
    let ghlError: string | undefined

    const customFields = buildGHLCustomFields(analysisResult, fieldMappings, jobId)
    let monetaryValue: number | undefined
    const monetaryField = settings.monetaryValueField ?? 'arv'
    const monetaryVal = extractAnalysisFieldValue(analysisResult, monetaryField)
    if (typeof monetaryVal === 'number') monetaryValue = monetaryVal

    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await updateGHLOpportunity({
        apiToken: settings.apiToken,
        opportunityId,
        customFields,
        monetaryValue,
      })

      if (result.success) {
        ghlSuccess = true
        console.log(`[GHL Webhook][Timing] GHL push: ${Date.now() - ghlStart}ms (attempt ${attempt})`)
        break
      }

      ghlError = result.error
      console.warn(`[GHL Webhook] GHL push attempt ${attempt}/3 failed: ${result.error}`)
    }

    if (!ghlSuccess) {
      // Return 5xx so GHL retries the webhook if configured
      console.error(`[GHL Webhook] GHL push failed after 3 attempts: ${ghlError}`)
      return c.json({ success: false, error: `Failed to update GHL opportunity: ${ghlError}` }, 502)
    }

    // ── 9. Save report to DB (background, non-blocking) ───────────────────────
    c.executionCtx.waitUntil((async () => {
      try {
        const reportDb = drizzle(c.env.DB)
        const [inserted] = await reportDb.insert(savedReports).values({
          userId,
          jobId,
          propertyAddress: analysisResult.subject.address,
          propertyCity: city,
          propertyState: state,
          propertyZip: zipCode,
          fullResponseJson: JSON.stringify(analysisResult),
          arv: analysisResult.valuation.arv,
          asIsValue: analysisResult.valuation.asIsValue ?? null,
          maxAllowableOffer: analysisResult.valuation.buyPrice,
          estimatedRepairs: analysisResult.valuation.rehabCost,
        }).returning({ id: savedReports.id })
        await reportDb.insert(reportHistory).values({
          reportId: inserted.id,
          userId,
          action: 'created',
          description: 'Report created from GHL webhook',
          changesJson: JSON.stringify({
            arv: analysisResult.valuation.arv,
            buyPrice: analysisResult.valuation.buyPrice,
            rehabCost: analysisResult.valuation.rehabCost,
          }),
        })
        console.log(`[GHL Webhook] Report saved for job ${jobId}`)
      } catch (error) {
        console.warn(`[GHL Webhook] Failed to save report (non-fatal):`, error instanceof Error ? error.message : error)
      }
    })())

    console.log(`[GHL Webhook][Timing] Total: ${Date.now() - routeStart}ms`)

    return c.json({
      success: true,
      data: {
        jobId,
        opportunityId,
        address: fullAddress,
        arv: analysisResult.valuation.arv,
        buyPrice: analysisResult.valuation.buyPrice,
        projectedROI: analysisResult.valuation.projectedROI,
      },
    })
  } catch (error) {
    console.error('[GHL Webhook] Error:', error)
    const message = error instanceof Error ? error.message : 'Internal error'
    const isBadDeal = message.startsWith('BAD_DEAL:')
    return c.json(
      { success: false, error: isBadDeal ? message.replace('BAD_DEAL: ', '') : message },
      isBadDeal ? 400 : 500
    )
  }
})

export default ghlWebhook
