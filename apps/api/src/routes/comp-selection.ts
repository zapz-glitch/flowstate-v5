/**
 * Comp Selection Route — Lightweight LLM-only comp analysis
 *
 * Takes existing analysis data (subject + comps) and runs ONLY the AI
 * comp selection. No property re-fetch, no workflow, no SSE — just a
 * regular POST that returns the AI selection result.
 *
 * Used when user clicks "AI Analysis" button on an already-analyzed property.
 */

import { Hono } from 'hono'
import type { Env } from '../types'
import { analyzeComps } from '../services/comp-analysis'
import type { CompAnalysisContext, CompEvalContext } from '../services/comp-analysis'
import type { NormalizedProperty, NormalizedComparable, PropertyBundle, EnrichmentData } from '../services/property-api/types'
import { getSession } from '../lib/session'

const app = new Hono<{ Bindings: Env }>()

// ─── Types for request body ────────────────────────────────────────────────

interface CompSelectionRequest {
  /** Subject property from analysis result */
  subject: Record<string, unknown>
  /** Comps from analysis result (with appraisalRules, isEnabled, etc.) */
  comps: {
    items: Array<Record<string, unknown>>
    count?: number
    enabledCount?: number
    disabledCount?: number
  }
  /** Risk flags from analysis */
  riskFlags?: string[]
  /** User's evaluation settings */
  settings?: {
    filters?: Array<{ type: string; enabled: boolean; value: number; priority?: 'hard' | 'soft' }>
    adjustments?: Array<{ type: string; enabled: boolean; amount: number; percent?: number }>
    dealParams?: { closingCostsPercent: number; carryingCostsPercent: number; wholesaleFee: number }
    rehabLevelIndex?: number
    arvThresholdPercent?: number
    asIsThresholdPercent?: number
  }
}

// ─── Helpers: reconstruct internal types from API response ─────────────────

function toNormalizedProperty(s: Record<string, unknown>): NormalizedProperty {
  return {
    id: (s.id as string) || (s.clip as string) || '',
    provider: 'corelogic',
    address: (s.address as string) || '',
    city: (s.city as string) || '',
    state: (s.state as string) || '',
    zipCode: (s.zipCode as string) || (s.zip as string) || '',
    county: s.county as string | undefined,
    latitude: (s.latitude as number) ?? null,
    longitude: (s.longitude as number) ?? null,
    bedrooms: (s.bedrooms as number) ?? null,
    bathrooms: (s.bathrooms as number) ?? null,
    squareFeet: (s.squareFeet as number) ?? (s.sqft as number) ?? null,
    lotSizeAcres: (s.lotSizeAcres as number) ?? null,
    yearBuilt: (s.yearBuilt as number) ?? null,
    propertyType: (s.propertyType as string) ?? null,
    stories: (s.stories as number) ?? null,
    lastSalePrice: (s.lastSalePrice as number) ?? null,
    lastSaleDate: (s.lastSaleDate as string) ?? null,
    assessedValue: (s.assessedValue as number) ?? null,
    marketValue: (s.marketValue as number) ?? null,
    taxAmount: (s.taxAmount as number) ?? null,
    avmValue: (s.avmValue as number) ?? null,
    avmConfidence: (s.avmConfidence as number) ?? null,
    construction: s.construction as NormalizedProperty['construction'],
    features: s.features as NormalizedProperty['features'],
    ownership: s.ownership as NormalizedProperty['ownership'],
    transaction: s.transaction as NormalizedProperty['transaction'],
    subdivision: s.subdivision as string | undefined,
  }
}

function toNormalizedComparable(c: Record<string, unknown>): NormalizedComparable {
  return {
    id: (c.id as string) || '',
    provider: 'corelogic',
    address: (c.address as string) || '',
    city: (c.city as string) || '',
    state: (c.state as string) || '',
    zipCode: (c.zipCode as string) || '',
    latitude: (c.latitude as number) ?? null,
    longitude: (c.longitude as number) ?? null,
    distanceMiles: (c.distanceMiles as number) ?? null,
    bedrooms: (c.bedrooms as number) ?? null,
    bathrooms: (c.bathrooms as number) ?? null,
    squareFeet: (c.squareFeet as number) ?? (c.sqft as number) ?? null,
    lotSizeAcres: (c.lotSizeAcres as number) ?? null,
    yearBuilt: (c.yearBuilt as number) ?? null,
    propertyType: (c.propertyType as string) ?? null,
    salePrice: (c.salePrice as number) ?? null,
    saleDate: (c.saleDate as string) ?? null,
    pricePerSqft: (c.pricePerSqft as number) ?? null,
    subdivision: (c.subdivision as string) ?? null,
    construction: c.construction as NormalizedComparable['construction'],
    transaction: c.transaction as NormalizedComparable['transaction'],
    features: c.features as NormalizedComparable['features'],
  }
}

function buildEvalContexts(items: Array<Record<string, unknown>>): CompEvalContext[] {
  return items.map((comp) => {
    const rules = comp.appraisalRules as Record<string, unknown> | undefined
    return {
      compId: (comp.id as string) || '',
      isEnabled: (comp.isEnabled as boolean) ?? false,
      compGroup: (comp.compGroup as 'arv' | 'as_is' | null) ?? null,
      filterResults: (rules?.filters as CompEvalContext['filterResults']) ?? [],
      adjustmentResults: (rules?.adjustments as CompEvalContext['adjustmentResults']) ?? [],
      adjustedPrice: (comp.adjustedPrice as number) ?? null,
    }
  })
}

// ─── Route ─────────────────────────────────────────────────────────────────

app.post('/analyze', async (c) => {
  const session = await getSession(c)
  if (!session?.user) return c.json({ error: 'Not authenticated' }, 401)

  const body = await c.req.json<CompSelectionRequest>()

  if (!body.subject || !body.comps?.items?.length) {
    return c.json({ error: 'Missing subject or comps data' }, 400)
  }

  const startTime = Date.now()

  // Reconstruct internal types from the analysis response data
  const subject = toNormalizedProperty(body.subject)
  const comparables = body.comps.items.map(toNormalizedComparable)
  const evalContexts = buildEvalContexts(body.comps.items)

  const bundle: PropertyBundle = {
    property: subject,
    comparables,
    enrichment: {} as EnrichmentData,
    metadata: {
      fetchedAt: new Date().toISOString(),
      provider: 'corelogic',
      searchParams: { address: subject.address },
      comparablesParams: { propertyId: subject.id },
      enrichmentOptions: {},
    },
  }

  const settings = body.settings ?? {}

  const compAnalysisCtx: CompAnalysisContext = {
    bundle,
    evalContexts,
    analysisResult: { subject: body.subject, comps: body.comps },
    filters: (settings.filters ?? []).map((f) => ({
      type: f.type as 'subdivision_match' | 'sale_age' | 'sqft_diff' | 'year_built_diff' | 'distance',
      enabled: f.enabled,
      value: f.value,
      priority: f.priority,
    })),
    adjustments: (settings.adjustments ?? []).map((a) => ({
      type: a.type as 'old_comp_discount' | 'bedroom' | 'bathroom' | 'pool' | 'garage',
      enabled: a.enabled,
      amount: a.amount,
      percent: a.percent,
    })),
    dealParams: settings.dealParams ?? { closingCostsPercent: 8, carryingCostsPercent: 2, wholesaleFee: 10000 },
    rehabLevelIndex: settings.rehabLevelIndex ?? 2,
    arvThresholdPercent: settings.arvThresholdPercent ?? 15,
    asIsThresholdPercent: settings.asIsThresholdPercent ?? 70,
    riskFlags: body.riskFlags ?? [],
  }

  try {
    const llmResult = await analyzeComps(
      compAnalysisCtx,
      c.env,
      {},
    )

    if (!llmResult || llmResult.selectedForArv.length === 0) {
      return c.json({
        success: false,
        error: llmResult ? 'No comps selected by AI' : 'LLM provider not available',
        latencyMs: Date.now() - startTime,
      }, 422)
    }

    // Build updated comps with AI selection applied
    const selectedSet = new Set(llmResult.selectedForArv)
    const asIsSet = new Set(llmResult.asIsComps ?? [])
    const updatedItems = body.comps.items.map((comp) => {
      const compId = comp.id as string
      const ranking = llmResult.rankings.find((r) => r.compId === compId)
      const isSelected = selectedSet.has(compId)
      const isAsIs = asIsSet.has(compId)
      return {
        ...comp,
        isEnabled: isSelected,
        compGroup: isSelected ? 'arv' : isAsIs ? 'as_is' : null,
        selectionReason: ranking?.reasoning || null,
        qualityScore: ranking?.score ?? null,
        keyFeatures: ranking?.keyFeatures?.length ? ranking.keyFeatures : null,
        disableReasons: isSelected ? [] : [ranking?.reasoning || 'Not selected by AI analysis'],
      }
    })

    const enabledCount = updatedItems.filter((c) => c.isEnabled).length

    return c.json({
      success: true,
      updatedComps: {
        ...body.comps,
        items: updatedItems,
        enabledCount,
        disabledCount: updatedItems.length - enabledCount,
      },
      llmAnalysis: {
        model: llmResult.model,
        latencyMs: llmResult.latencyMs,
        tokenUsage: llmResult.tokenUsage,
        compCount: llmResult.rankings.length,
        summary: llmResult.summary,
        selectedForArv: llmResult.selectedForArv,
        confidenceLevel: llmResult.confidenceLevel,
      },
      rankings: llmResult.rankings,
      latencyMs: Date.now() - startTime,
    })
  } catch (error) {
    console.error('[CompSelection] Error:', error)
    return c.json({
      success: false,
      error: error instanceof Error ? error.message : 'AI analysis failed',
      latencyMs: Date.now() - startTime,
    }, 500)
  }
})

export default app
