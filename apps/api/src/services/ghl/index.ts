/**
 * GoHighLevel CRM Integration Service
 *
 * Handles pushing analysis results to GHL opportunities via their API.
 * - Builds custom field arrays from analysis responses
 * - Generates human-readable summaries
 * - Makes authenticated API calls to update opportunities
 */

import type { AnalysisResponse } from '../analysis'

// ─── Constants ───────────────────────────────────────────────────────────────

const GHL_BASE_URL = 'https://services.leadconnectorhq.com'
const GHL_API_VERSION = '2021-07-28'

/** Analysis fields that can be mapped to GHL custom fields */
export const GHL_MAPPABLE_FIELDS = {
  arv: { label: 'ARV (After Repair Value)', type: 'number' as const },
  buyPrice: { label: 'Max Buy Price', type: 'number' as const },
  rehabCost: { label: 'Rehab Cost', type: 'number' as const },
  projectedProfit: { label: 'Projected Profit', type: 'number' as const },
  projectedROI: { label: 'Projected ROI (%)', type: 'number' as const },
  wholesalePrice: { label: 'Wholesale Price', type: 'number' as const },
  rehabLevel: { label: 'Rehab Level', type: 'string' as const },
  recommendation: { label: 'Recommendation', type: 'string' as const },
  spread: { label: 'Spread (As-Is to ARV)', type: 'number' as const },
  classification: { label: 'Property Classification', type: 'string' as const },
  compsUsed: { label: 'Number of Comps Used', type: 'number' as const },
  arvPerSqft: { label: 'ARV Per Sqft', type: 'number' as const },
  topComps: { label: 'Top 3 Comps', type: 'string' as const },
  fullSummary: { label: 'Full Analysis Summary', type: 'string' as const },
  reportUrl: { label: 'Report URL', type: 'string' as const },
  propertyAddress: { label: 'Property Address (Input)', type: 'string' as const },
} as const

export type GHLMappableField = keyof typeof GHL_MAPPABLE_FIELDS

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GHLCustomField {
  id: string
  field_value: string
}

export interface GHLUpdateResult {
  success: boolean
  opportunityId: string
  updatedFields: string[]
  error?: string
}

// ─── Field Extraction ────────────────────────────────────────────────────────

/**
 * Extract a specific field value from an analysis response
 */
export function extractAnalysisFieldValue(
  response: AnalysisResponse,
  field: string
): string | number | null {
  switch (field) {
    case 'arv':
      return response.valuation.arv
    case 'buyPrice':
      return response.valuation.buyPrice
    case 'rehabCost':
      return response.valuation.rehabCost
    case 'projectedProfit':
      return response.valuation.projectedProfit
    case 'projectedROI':
      return Math.round(response.valuation.projectedROI * 100) / 100
    case 'wholesalePrice':
      return response.valuation.wholesalePrice
    case 'rehabLevel':
      return response.valuation.rehabLevel
    case 'recommendation':
      return deriveRecommendation(response)
    case 'spread':
      return response.valuation.spread
    case 'classification':
      return response.subject.classification?.type ?? null
    case 'compsUsed':
      return response.comps.enabledCount
    case 'arvPerSqft':
      return response.valuation.arvPerSqft
    case 'topComps':
      return formatTopComps(response)
    case 'fullSummary':
      return buildAnalysisSummary(response)
    default:
      return null
  }
}

/**
 * Derive recommendation from valuation data
 */
function deriveRecommendation(response: AnalysisResponse): string {
  const roi = response.valuation.projectedROI
  if (roi >= 30) return 'Strong Buy'
  if (roi >= 15) return 'Buy'
  if (roi >= 5) return 'Hold'
  return 'Pass'
}

// ─── Summary Builders ────────────────────────────────────────────────────────

/**
 * Format top 3 enabled comps as a text summary
 */
export function formatTopComps(response: AnalysisResponse): string {
  const enabledComps = response.comps.items
    .filter((c) => c.isEnabled && c.salePrice)
    .slice(0, 3)

  if (enabledComps.length === 0) return 'No comps available'

  return enabledComps
    .map((c, i) => `${i + 1}. ${c.address} - $${(c.salePrice ?? 0).toLocaleString()}`)
    .join('\n')
}

/**
 * Build a comprehensive human-readable summary of the analysis
 */
export function buildAnalysisSummary(response: AnalysisResponse): string {
  const v = response.valuation
  const s = response.subject
  const lines: string[] = []

  lines.push(`Property: ${s.address}`)
  if (s.classification?.type) {
    lines.push(`Classification: ${s.classification.type.replace('_', ' ')}`)
  }
  lines.push('')
  lines.push(`ARV: $${v.arv.toLocaleString()} ($${v.arvPerSqft}/sqft)`)
  lines.push(`Buy Price: $${v.buyPrice.toLocaleString()}`)
  lines.push(`Rehab: $${v.rehabCost.toLocaleString()} (${v.rehabLevel})`)
  lines.push(`Profit: $${v.projectedProfit.toLocaleString()} (${Math.round(v.projectedROI)}% ROI)`)
  lines.push(`Wholesale: $${v.wholesalePrice.toLocaleString()}`)

  if (v.spread != null) {
    lines.push(`Spread: $${v.spread.toLocaleString()}`)
  }

  lines.push('')
  lines.push(`Recommendation: ${deriveRecommendation(response)}`)
  lines.push(`Comps Used: ${response.comps.enabledCount} of ${response.comps.total}`)

  const topComps = formatTopComps(response)
  if (topComps !== 'No comps available') {
    lines.push('')
    lines.push('Top Comps:')
    lines.push(topComps)
  }

  return lines.join('\n')
}

// ─── Custom Field Builder ────────────────────────────────────────────────────

const DASHBOARD_BASE_URL = 'https://app.flowstate.homes'

/**
 * Build GHL custom fields array from an analysis response and field mappings
 */
export function buildGHLCustomFields(
  response: AnalysisResponse,
  fieldMappings: Record<string, string>,
  jobId?: string
): GHLCustomField[] {
  const fields: GHLCustomField[] = []

  for (const [analysisField, ghlFieldId] of Object.entries(fieldMappings)) {
    if (!ghlFieldId) continue

    // Special handling for report URL (dashboard web report)
    if (analysisField === 'reportUrl') {
      if (jobId) {
        fields.push({ id: ghlFieldId, field_value: `${DASHBOARD_BASE_URL}/report/${jobId}` })
      }
      continue
    }

    const value = extractAnalysisFieldValue(response, analysisField)
    if (value !== null && value !== undefined) {
      fields.push({ id: ghlFieldId, field_value: String(value) })
    }
  }

  return fields
}

// ─── GHL API Client ──────────────────────────────────────────────────────────

/**
 * Update a GoHighLevel opportunity with analysis results
 */
export async function updateGHLOpportunity(params: {
  apiToken: string
  opportunityId: string
  customFields?: GHLCustomField[]
  monetaryValue?: number
  pipelineStageId?: string
}): Promise<GHLUpdateResult> {
  const body: Record<string, unknown> = {}

  if (params.customFields && params.customFields.length > 0) {
    body.customFields = params.customFields
  }
  if (params.monetaryValue !== undefined) {
    body.monetaryValue = params.monetaryValue
  }
  if (params.pipelineStageId) {
    body.pipelineStageId = params.pipelineStageId
  }

  // Nothing to update
  if (Object.keys(body).length === 0) {
    return {
      success: true,
      opportunityId: params.opportunityId,
      updatedFields: [],
    }
  }

  const response = await fetch(
    `${GHL_BASE_URL}/opportunities/${params.opportunityId}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${params.apiToken}`,
        'Content-Type': 'application/json',
        Version: GHL_API_VERSION,
      },
      body: JSON.stringify(body),
    }
  )

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error')
    console.error(`[GHL] Failed to update opportunity ${params.opportunityId}: ${response.status} ${errorText}`)
    return {
      success: false,
      opportunityId: params.opportunityId,
      updatedFields: [],
      error: `GHL API error ${response.status}: ${errorText}`,
    }
  }

  const updatedFields: string[] = []
  if (params.customFields) updatedFields.push(...params.customFields.map((f) => f.id))
  if (params.monetaryValue !== undefined) updatedFields.push('monetaryValue')

  console.log(`[GHL] Updated opportunity ${params.opportunityId}: ${updatedFields.length} fields`)
  return {
    success: true,
    opportunityId: params.opportunityId,
    updatedFields,
  }
}

/**
 * Test GHL API connection by searching opportunities
 */
export async function testGHLConnection(params: {
  apiToken: string
  locationId: string
}): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(
      `${GHL_BASE_URL}/opportunities/search?location_id=${encodeURIComponent(params.locationId)}&limit=1`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${params.apiToken}`,
          Version: GHL_API_VERSION,
        },
      }
    )

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error')
      return { success: false, error: `GHL API error ${response.status}: ${errorText}` }
    }

    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Connection failed' }
  }
}
