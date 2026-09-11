/**
 * Analysis Job Durable Object
 *
 * Manages async enrichment for a single analysis job.
 * Runs Zillow scraping + LLM analysis inside the DO (persistent execution context).
 * Broadcasts SSE events to connected dashboard clients in real-time.
 *
 * Endpoints:
 *   POST /start      — Start enrichment (receives config, runs processing internally)
 *   POST /event      — Push an external event
 *   GET  /sse        — SSE stream for clients
 *   GET  /state      — Current job state
 */

import { analyzeComps, type CompEvalContext } from '../services/comp-analysis'
import { fetchMarketContext, type MarketContext } from '../services/market-context'
import { type EvaluationParams } from '../services/evaluation'
import { performAnalysis } from '../services/evaluation'
import { detectOsmLocationRisks } from '../services/location-risk'
import { createPropertyApi } from '../services/property-api'
import { DEFAULT_FILTERS, evaluateComparable, type AppraisalFilter } from '../services/appraisal'
import { filtersToApiParams } from '../services/appraisal/types'
import type { Env } from '../types'
import type { NormalizedProperty, NormalizedComparable } from '../services/property-api/types'
import { drizzle } from 'drizzle-orm/d1'
import { eq, and } from 'drizzle-orm'
import { savedReports, reportHistory, analysisRuns } from '../db/schema'
import { evaluateRun } from '../services/observability/evals'

interface JobState {
  jobId: string
  userId: string
  status: 'idle' | 'processing' | 'complete' | 'error'
  pending: string[]
  events: Array<{ event: string; data: unknown; timestamp: number }>
  error?: string
  createdAt: number
}

export interface StartEnrichmentRequest {
  jobId: string
  userId: string
  pending: string[]
  bundle: import('../services/property-api/types').PropertyBundle
  /** Original evaluation params (for re-evaluation after enrichment) */
  evalParams: Omit<EvaluationParams, 'jobId' | 'bundle'>
  /** KV key under which to store this run's report pointer (21-day eval cache) */
  evalResultCacheKey?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  analysisResult: Record<string, any>
  llmOptions?: {
    includePhotos?: boolean
    compSelectionModel?: string
    marketSearchModel?: string
    reasoning?: boolean
  }
}

/** Request type for the streaming analysis flow (everything runs in the DO) */
export interface StartStreamingRequest {
  jobId: string
  userId: string
  /** Address search params */
  search: {
    address?: string
    streetAddress?: string
    city?: string
    state?: string
    zipCode?: string
    propertyId?: string
  }
  /** Comp search options */
  searchOptions: {
    radiusMiles?: number
    maxComps?: number
    monthsBack?: number
  }
  /** Enrichment options */
  enrichment?: {
    permits?: boolean
    floodZone?: boolean
  }
  skipCache?: boolean
  /** KV key under which to store this run's report pointer (21-day eval cache) */
  evalResultCacheKey?: string
  /** Evaluation params (user settings, thresholds, etc.) */
  evalParams: Omit<EvaluationParams, 'jobId' | 'bundle'>
  /** Whether to run LLM comp selection */
  llmEnabled: boolean
  /** Whether this is updating an existing report (refresh) */
  isRefresh?: boolean
  llmOptions?: {
    includePhotos?: boolean
    compSelectionModel?: string
    marketSearchModel?: string
    reasoning?: boolean
  }
}

type DrizzleDb = ReturnType<typeof drizzle>

/**
 * One report per property per user: a completed analysis for an address the
 * user already has a report for overwrites it in place (and records a
 * 'reanalyzed' history entry) rather than stacking a duplicate row.
 */
async function upsertPropertyReport(
  db: DrizzleDb,
  fields: {
    userId: string
    jobId: string
    propertyAddress: string
    propertyCity: string
    propertyState: string
    propertyZip?: string
    propertyClip?: string | null
  },
  reportData: {
    fullResponseJson: string
    arv: number | null
    asIsValue: number | null
    maxAllowableOffer: number | null
    estimatedRepairs: number | null
  },
): Promise<void> {
  const historyChanges = JSON.stringify({
    arv: reportData.arv,
    buyPrice: reportData.maxAllowableOffer,
    rehabCost: reportData.estimatedRepairs,
  })

  const [existing] = await db
    .select({ id: savedReports.id })
    .from(savedReports)
    .where(and(eq(savedReports.userId, fields.userId), eq(savedReports.propertyAddress, fields.propertyAddress)))
    .limit(1)

  if (existing) {
    await db.update(savedReports)
      .set({ ...reportData, jobId: fields.jobId })
      .where(eq(savedReports.id, existing.id))
    await db.insert(reportHistory).values({
      reportId: existing.id,
      userId: fields.userId,
      action: 'reanalyzed',
      description: 'Report overwritten by a new analysis',
      changesJson: historyChanges,
    })
    console.log(`[AnalysisJobDO] Report overwritten for ${fields.propertyAddress} (job ${fields.jobId})`)
    return
  }

  const [inserted] = await db.insert(savedReports).values({
    ...fields,
    propertyZip: fields.propertyZip ?? '',
    ...reportData,
  }).returning({ id: savedReports.id })
  await db.insert(reportHistory).values({
    reportId: inserted.id,
    userId: fields.userId,
    action: 'created',
    description: 'Report created',
    changesJson: historyChanges,
  })
  console.log(`[AnalysisJobDO] Report saved for job ${fields.jobId}`)
}

export class AnalysisJobDO {
  private state: DurableObjectState
  private env: Env
  private sseClients: Set<WritableStreamDefaultWriter<Uint8Array>> = new Set()
  private encoder = new TextEncoder()
  private jobState: JobState | null = null

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    if (request.method === 'POST' && path === '/start-streaming') {
      return this.handleStartStreaming(request)
    }
    if (request.method === 'POST' && path === '/start') {
      return this.handleStart(request)
    }
    if (request.method === 'POST' && path === '/event') {
      return this.handleEvent(request)
    }
    if (request.method === 'GET' && path === '/sse') {
      return this.handleSSE(request)
    }
    if (request.method === 'GET' && path === '/state') {
      return this.handleGetState()
    }

    return new Response('Not found', { status: 404 })
  }

  // ─── Start Streaming Analysis (full pipeline in DO) ────────────────────────

  private async handleStartStreaming(request: Request): Promise<Response> {
    const body = await request.json() as StartStreamingRequest

    const pending = ['property_fetch', 'evaluation']
    if (body.llmEnabled) pending.push('llm')

    this.jobState = {
      jobId: body.jobId,
      userId: body.userId,
      status: 'processing',
      pending,
      events: [],
      createdAt: Date.now(),
    }
    await this.state.storage.put('jobState', this.jobState)

    this.runStreamingAnalysis(body).catch((err) => {
      console.error('[AnalysisJobDO] Streaming analysis fatal error:', err)
      const durationMs = Date.now() - (this.jobState?.createdAt ?? Date.now())
      this.pushEvent('error', { step: 'fatal', message: err instanceof Error ? err.message : 'Unknown error' })
      this.recordRun(body, { status: 'error', durationMs, errorCode: 'FATAL', errorMessage: err instanceof Error ? err.message : 'Unknown error' })
      this.pushEvent('enrichment_done', { totalDurationMs: durationMs })
    })

    return new Response('OK', { status: 200 })
  }

  private async runStreamingAnalysis(config: StartStreamingRequest): Promise<void> {
    const startTime = Date.now()
    await new Promise((r) => setTimeout(r, 300)) // Let SSE clients connect
    console.log(`[AnalysisJobDO] ── Streaming analysis started ──`)

    const propertyApi = createPropertyApi(this.env)
    const filters = (config.evalParams.appraisalRules?.filters ?? DEFAULT_FILTERS) as AppraisalFilter[]
    const apiFilterParams = filtersToApiParams(filters)

    // ── Step 1: Search subject property ─────────────────────────────────────
    await this.pushEvent('property_fetch', { message: 'Searching property...' })

    const searchResult = await propertyApi.searchProperty({
      address: config.search.address,
      streetAddress: config.search.streetAddress,
      city: config.search.city,
      state: config.search.state,
      zipCode: config.search.zipCode,
    })

    if (!searchResult.success) {
      const msg = ('error' in searchResult ? searchResult.error : null) || 'Property not found'
      await this.pushEvent('error', { step: 'property_fetch', message: msg })
      await this.recordRun(config, { status: 'error', durationMs: Date.now() - startTime, errorCode: 'PROPERTY_NOT_FOUND', errorMessage: msg })
      await this.pushEvent('enrichment_done', { totalDurationMs: Date.now() - startTime })
      return
    }

    const property = searchResult.data
    console.log(`[AnalysisJobDO] ✓ Subject found: ${property.address} in ${Date.now() - startTime}ms`)

    // Stream subject immediately → dashboard shows map marker + subject card
    await this.pushEvent('subject_found', {
      subject: {
        id: property.id,
        address: `${property.address}, ${property.city}, ${property.state} ${property.zipCode}`,
        county: property.county,
        latitude: property.latitude,
        longitude: property.longitude,
        bedrooms: property.bedrooms,
        bathrooms: property.bathrooms,
        squareFeet: property.squareFeet,
        yearBuilt: property.yearBuilt,
        subdivision: property.subdivision,
        lotSizeAcres: property.lotSizeAcres,
        propertyType: property.propertyType,
        lastSale: property.lastSalePrice ? {
          price: property.lastSalePrice,
          date: property.lastSaleDate,
          pricePerSqft: property.pricePerSqft,
        } : null,
        buildingStyle: property.construction?.buildingStyle ?? null,
        foundationType: property.construction?.foundationType ?? null,
        pool: property.features?.poolType ?? null,
        garage: property.features?.garageType ?? null,
        carport: property.features?.carportType ?? null,
      },
    })

    // ── Step 2: Fetch comps + permits + flood in parallel ────────────────────
    await this.pushEvent('property_fetch', { message: 'Fetching comparables...' })
    const compsStart = Date.now()

    const comparablesParams = {
        propertyId: property.id,
        radiusMiles: config.searchOptions.radiusMiles ?? apiFilterParams.radiusMiles ?? 1,
        maxComps: config.searchOptions.maxComps ?? 15,
        monthsBack: config.searchOptions.monthsBack ?? apiFilterParams.monthsBack ?? 12,
        sqftVariance: apiFilterParams.sqftVariance,
        subjectSqft: property.squareFeet ?? undefined,
        subjectPropertyType: property.propertyType ?? undefined,
    }
    const [compsResult, permitsResult, floodResult, osmResult] = await Promise.all([
      propertyApi.getComparables(comparablesParams),
      // Permits: preserve the error object — 'unavailable' must mean the call
      // failed, not that the property has no permits on file (that's 'empty')
      (config.enrichment?.permits !== false)
        ? propertyApi.getBuildingPermits(property.id, { address1: property.address, address2: `${property.city}, ${property.state} ${property.zipCode}` })
        : Promise.resolve(null),
      (config.enrichment?.floodZone !== false && property.latitude && property.longitude)
        ? propertyApi.getFloodZone(property.latitude, property.longitude).catch(() => null)
        : Promise.resolve(null),
      // Location risk (major roads, railroads, commercial) — fetched during
      // enrichment so it can deduct from valuation, not just flag post-hoc.
      // The street name lets detection classify fronting/backing/siding.
      property.latitude && property.longitude
        ? detectOsmLocationRisks(property.latitude, property.longitude, 150, {
            streetName: property.address?.replace(/^\d+\s+/, '') ?? undefined,
          }).catch(() => null)
        : Promise.resolve(null),
    ])

    if (!compsResult.success) {
      const msg = ('error' in compsResult ? compsResult.error : null) || 'Failed to fetch comparables'
      await this.pushEvent('error', { step: 'comps_fetch', message: msg })
      await this.recordRun(config, { status: 'error', durationMs: Date.now() - startTime, errorCode: 'COMPS_FETCH_FAILED', errorMessage: msg })
      await this.pushEvent('enrichment_done', { totalDurationMs: Date.now() - startTime })
      return
    }

    const pools = { comparables: compsResult.success ? compsResult.data.comparables : [], conflictIds: [] as string[] }
    const rawComps = pools.comparables
    console.log(`[AnalysisJobDO] ✓ ${rawComps.length} comps found in ${Date.now() - compsStart}ms`)

    // Stream comps immediately → dashboard shows map markers + basic comp cards
    await this.pushEvent('comps_found', {
      compCount: rawComps.length,
      comps: rawComps.map((c) => ({
        id: c.id,
        address: `${c.address}, ${c.city}, ${c.state}`,
        latitude: c.latitude,
        longitude: c.longitude,
        salePrice: c.salePrice,
        saleDate: c.saleDate,
        squareFeet: c.squareFeet,
        bedrooms: c.bedrooms,
        bathrooms: c.bathrooms,
        yearBuilt: c.yearBuilt,
        distanceMiles: c.distanceMiles,
        pricePerSqft: c.pricePerSqft,
      })),
    })

    // ── Step 3: Enrich comps ───────────────────────────────────────────────────
    // No shortcuts: every returned comp gets the property-detail call —
    // subdivision, foundation type, building style, features. The apples-to-
    // apples rules (subdivision_match — the hammer — style, foundation) can
    // only bite with enriched data. Sorted nearest-first so the cap, if ever
    // hit, drops the least relevant.
    await this.pushEvent('property_fetch', { message: 'Enriching comparable details...' })
    const enrichStart = Date.now()

    const toEnrich = [...rawComps]
      .sort((a, b) => (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999))

    const enrichedList = await propertyApi.enrichComparables(toEnrich, { concurrency: 10 })
    const enrichedById = new Map(enrichedList.map((c) => [c.id, c]))
    const enrichedComps = rawComps.map((c) => enrichedById.get(c.id) ?? c)

    // Market context search runs in parallel — doesn't block evaluation or LLM
    // but we track the promise so we can await it before enrichment_done
    let marketContextPromise: Promise<void> = Promise.resolve()
    if (config.llmEnabled) {
      marketContextPromise = fetchMarketContext({
        address: property.address,
        city: property.city,
        state: property.state,
        zipCode: property.zipCode,
        propertyType: property.propertyType,
        subdivision: property.subdivision,
      }, this.env, config.llmOptions?.marketSearchModel)
        .then((mc) => {
          if (mc) {
            this.pushEvent('market_context', { marketContext: mc })
            console.log(`[AnalysisJobDO] ✓ Market context fetched in ${mc.latencyMs}ms`)
          }
        })
        .catch((err) => {
          console.warn('[AnalysisJobDO] Market context error:', err instanceof Error ? err.message : err)
        })
    }

    console.log(`[AnalysisJobDO] ✓ Comps enriched in ${Date.now() - enrichStart}ms`)

    // Build the full property bundle
    const permitsData = permitsResult && 'success' in permitsResult && permitsResult.success ? permitsResult.data : null
    const permitsError = permitsResult && 'success' in permitsResult && !permitsResult.success
      ? ('error' in permitsResult ? permitsResult.error : 'permit fetch failed')
      : null
    const permits = permitsData ? {
      items: permitsData.permits,
      count: permitsData.count,
      status: permitsData.count > 0 ? 'ok' as const : 'empty' as const,
      totalJobValue: permitsData.permits.reduce((sum: number, p: { jobValue?: number | null }) => sum + (p.jobValue ?? 0), 0),
      recentPermitTypes: [...new Set(permitsData.permits.map((p: { projectType?: string | null }) => p.projectType).filter(Boolean) as string[])],
    } : permitsError ? {
      items: [],
      count: 0,
      status: 'unavailable' as const,
      error: String(permitsError),
    } : null

    const floodData = floodResult && 'success' in floodResult && floodResult.success ? floodResult.data : null
    const evidenceLimitations: string[] = []
    for (const id of pools.conflictIds) evidenceLimitations.push(`${id}: Provider comparable pools disagree on the same sale date; price is quarantined from evaluation`)
    if (!permitsData) evidenceLimitations.push(config.enrichment?.permits === false
      ? 'Subject permits were not requested; system replacement evidence is unknown'
      : 'Subject permit lookup failed or is unavailable; this does not mean no permits exist')
    if (!floodData) evidenceLimitations.push(config.enrichment?.floodZone === false
      ? 'Subject flood zone was not requested; flood risk is unknown'
      : 'Subject flood-zone evidence is unavailable; this does not mean the property is outside a flood zone')

    const bundle: import('../services/property-api/types').PropertyBundle = {
      property,
      comparables: enrichedComps,
      metadata: {
        fetchedAt: new Date().toISOString(),
        provider: property.provider,
        searchParams: config.search as import('../services/property-api/types').PropertySearchParams,
        comparablesParams: { ...comparablesParams },
        enrichmentOptions: { permits: config.enrichment?.permits ?? true, floodZone: config.enrichment?.floodZone ?? true, weatherRisk: false, neighbourhood: false },
      },
      enrichment: {
        evidenceLimitations,
        permits,
        floodZone: floodData ?? null,
        locationRisks: osmResult?.risks ?? null,
        weatherRisk: null,
        neighbourhood: null,
      },
    }

    // ── Step 4: Run evaluation (appraisal rules + valuation) ────────────────
    const evalStart = Date.now()
    await this.pushEvent('evaluation_started', { message: 'Evaluating comparables...' })

    const propertyCallStats = propertyApi.getCallStats()
    const evalParams = {
      ...config.evalParams,
      apiCallStats: {
        corelogic: { total: propertyCallStats.total, cached: propertyCallStats.cached, endpoints: propertyCallStats.endpoints },
        totalExternalCalls: propertyCallStats.total,
      },
    }

    let evalResult
    try {
      evalResult = await performAnalysis({ jobId: config.jobId, bundle, ...evalParams, userId: config.userId }, this.env)
    } catch (evalError) {
      const msg = evalError instanceof Error ? evalError.message : 'Evaluation failed'
      const code = (evalError as { code?: string })?.code
      const suggestedFilters = (evalError as { suggestedFilters?: unknown })?.suggestedFilters
      const suggestedArvThreshold = (evalError as { suggestedArvThreshold?: number })?.suggestedArvThreshold
      console.warn(`[AnalysisJobDO] Evaluation error (${code}): ${msg}`)
      await this.pushEvent('error', {
        step: 'evaluation',
        message: msg,
        code,
        suggestedFilters,
        suggestedArvThreshold,
        pythonEvaluation: (evalError as { pythonEvaluation?: unknown })?.pythonEvaluation,
        evidenceRefresh: (evalError as { evidenceRefresh?: unknown })?.evidenceRefresh,
        physicalEvidence: (evalError as { physicalEvidence?: unknown })?.physicalEvidence,
      })
      await this.recordRun(config, { status: 'error', durationMs: Date.now() - startTime, errorCode: code ?? 'EVALUATION_ERROR', errorMessage: msg, compCount: bundle.comparables?.length })
      await this.pushEvent('enrichment_done', { totalDurationMs: Date.now() - startTime })
      return
    }

    let analysisResult = evalResult.response as unknown as Record<string, unknown>

    // Rule-based comp selection stays intact — AI will override later if enabled

    console.log(`[AnalysisJobDO] ✓ Evaluation complete in ${Date.now() - evalStart}ms`)

    // OSM location risks now fetched during enrichment — they're already in
    // the response via bundle.enrichment.locationRisks (and feed valuation)

    // Save/update report in DB
    try {
      const db = drizzle(this.env.DB)
      const subj = analysisResult.subject as Record<string, unknown>
      const val = analysisResult.valuation as Record<string, unknown> | null
      const reportData = {
        fullResponseJson: JSON.stringify(analysisResult),
        arv: (val?.arv as number) ?? null,
        asIsValue: (val?.asIsValue as number) ?? null,
        maxAllowableOffer: (val?.buyPrice as number) ?? null,
        estimatedRepairs: (val?.rehabCost as number) ?? null,
      }

      await upsertPropertyReport(db, {
        userId: config.userId,
        jobId: config.jobId,
        propertyAddress: (subj.address as string) || '',
        propertyCity: property.city || '',
        propertyState: property.state || '',
        propertyZip: property.zipCode || '',
      }, reportData)
      if (config.evalResultCacheKey) {
        await this.env.API_CACHE.put(config.evalResultCacheKey, config.jobId, {
          expirationTtl: 21 * 24 * 60 * 60, // 21 days
        }).catch(() => { /* best-effort */ })
      }
    } catch (dbError) {
      console.warn(`[AnalysisJobDO] Failed to save report:`, dbError instanceof Error ? dbError.message : dbError)
      await this.pushEvent('error', { step: 'persistence', message: 'The evaluation could not be saved. Retry the analysis; no saved report is available for this run.' })
      await this.pushEvent('enrichment_done', { totalDurationMs: Date.now() - startTime })
      return
    }

    // Private image access checks the saved report owner before serving any bytes.
    await this.pushEvent('evaluation_complete', { updatedResult: analysisResult })
    await this.recordRun(config, { status: 'completed', durationMs: Date.now() - startTime, response: analysisResult })

    // ── Step 5: LLM comp selection ──────────────────────────────────────────
    if (config.llmEnabled) {
      const llmStart = Date.now()
      try {
        await this.pushEvent('llm_started', { message: 'AI selecting best comps...', compCount: enrichedComps.length })

        const evalContexts: CompEvalContext[] = ((analysisResult.comps as Record<string, unknown>)?.items as Array<Record<string, unknown>> ?? []).map((comp: Record<string, unknown>) => ({
          compId: comp.id as string,
          isEnabled: comp.isEnabled as boolean,
          compGroup: (comp.compGroup as 'arv' | 'as_is' | null) ?? null,
          filterResults: ((comp.appraisalRules as Record<string, unknown>)?.filters as Array<{ type: string; passed: boolean; reason?: string }>) ?? [],
          adjustmentResults: ((comp.appraisalRules as Record<string, unknown>)?.adjustments as Array<{ type: string; applied: boolean; amount: number }>) ?? [],
          adjustedPrice: (comp.adjustedPrice as number) ?? null,
        }))

        const compAnalysisCtx: import('../services/comp-analysis/types').CompAnalysisContext = {
          bundle,
          evalContexts,
          analysisResult,
          filters: evalParams.appraisalRules?.filters ?? [],
          adjustments: evalParams.appraisalRules?.adjustments ?? [],
          dealParams: {
            closingCostsPercent: evalParams.buybox?.closingCostsPercent ?? 8,
            carryingCostsPercent: evalParams.buybox?.carryingCostsPercent ?? 2,
            wholesaleFee: evalParams.buybox?.wholesaleFee ?? 10000,
          },
          rehabLevelIndex: evalParams.buybox?.rehabLevelIndex ?? 2,
          rehabTable: evalParams.customRehabTable,
          tierRanges: evalParams.customTierRanges,
          arvThresholdPercent: evalParams.arvThreshold?.percent ?? 15,
          asIsThresholdPercent: evalParams.asIsThresholdPercent ?? 70,
          riskFlags: (analysisResult.riskFlags as string[]) ?? [],
        }

        const llmResult = await analyzeComps(compAnalysisCtx, this.env, { includePhotos: config.llmOptions?.includePhotos, modelOverride: config.llmOptions?.compSelectionModel, reasoning: config.llmOptions?.reasoning })

        if (llmResult && llmResult.selectedForArv.length > 0) {
          const selectedSet = new Set(llmResult.selectedForArv)
          const asIsSet = new Set(llmResult.asIsComps ?? [])
          const comps = analysisResult.comps as Record<string, unknown>
          if (comps?.items && Array.isArray(comps.items)) {
            comps.items = (comps.items as Array<Record<string, unknown>>).map((comp) => {
              const compId = comp.id as string
              const ranking = llmResult.rankings.find((r) => r.compId === compId)
              const isSelected = selectedSet.has(compId)
              const isAsIs = asIsSet.has(compId)
              return { ...comp, isEnabled: isSelected, compGroup: isSelected ? 'arv' : isAsIs ? 'as_is' : null, selectionReason: ranking?.reasoning || null, qualityScore: ranking?.score ?? null, keyFeatures: ranking?.keyFeatures?.length ? ranking.keyFeatures : null, disableReasons: isSelected ? [] : [ranking?.reasoning || 'Not selected by AI analysis'] }
            })
            comps.enabledCount = (comps.items as Array<Record<string, unknown>>).filter((c) => c.isEnabled).length
            comps.disabledCount = (comps.items as unknown[]).length - (comps.enabledCount as number)
          }

          await this.pushEvent('llm_complete', {
            llmAnalysis: { model: llmResult.model, latencyMs: llmResult.latencyMs, tokenUsage: llmResult.tokenUsage, compCount: llmResult.rankings.length, summary: llmResult.summary, selectedForArv: llmResult.selectedForArv, reasoning: llmResult.reasoning },
            rankings: llmResult.rankings,
            updatedResult: analysisResult,
          })
          console.log(`[AnalysisJobDO] ✓ LLM: ${llmResult.selectedForArv.length} comps selected in ${Date.now() - llmStart}ms${llmResult.reasoning ? ' (with reasoning)' : ''}`)
        } else {
          await this.pushEvent('llm_complete', { llmAnalysis: null, rankings: [], skipped: true, reason: llmResult ? 'No comps selected' : 'LLM not available' })
        }
      } catch (error) {
        console.warn('[AnalysisJobDO] LLM error:', error instanceof Error ? error.message : error)
        await this.pushEvent('error', { step: 'llm', message: error instanceof Error ? error.message : 'LLM analysis failed' })
      }
    }

    // Wait for parallel tasks before closing SSE (so client receives them)
    await marketContextPromise
    await this.pushEvent('enrichment_done', { totalDurationMs: Date.now() - startTime })
    console.log(`[AnalysisJobDO] ── Streaming analysis complete in ${Date.now() - startTime}ms ──`)
  }

  // ─── Start Enrichment (legacy — used when route returns result synchronously) ─

  private async handleStart(request: Request): Promise<Response> {
    const body = await request.json() as StartEnrichmentRequest

    this.jobState = {
      jobId: body.jobId,
      userId: body.userId,
      status: 'processing',
      pending: body.pending,
      events: [],
      createdAt: Date.now(),
    }
    await this.state.storage.put('jobState', this.jobState)

    // Run enrichment inside the DO — persistent context, no waitUntil needed
    // The DO stays alive as long as there are SSE clients or pending work
    this.runEnrichment(body).catch((err) => {
      console.error('[AnalysisJobDO] Enrichment fatal error:', err)
      this.pushEvent('error', { step: 'fatal', message: err instanceof Error ? err.message : 'Unknown error' })
      this.pushEvent('enrichment_done', { totalDurationMs: Date.now() - (this.jobState?.createdAt ?? Date.now()) })
    })

    // Return immediately — enrichment runs async in the DO
    return new Response('OK', { status: 200 })
  }

  private async runEnrichment(config: StartEnrichmentRequest): Promise<void> {
    const startTime = Date.now()
    let osmPromise: Promise<void> = Promise.resolve()

    // Brief delay to let SSE clients connect before broadcasting
    await new Promise((r) => setTimeout(r, 1000))
    console.log(`[AnalysisJobDO] ── Enrichment started (pending: ${config.pending.join(', ')}) ──`)

    // Step 0: Run evaluation (appraisal rules + classification + valuation + OSM)
    if (config.pending.includes('evaluation')) {
      const evalStart = Date.now()
      try {
        await this.pushEvent('evaluation_started', { message: 'Evaluating comparables...' })

        const evalResult = await performAnalysis({
          jobId: config.jobId,
          bundle: config.bundle,
          ...config.evalParams,
          userId: config.userId,
        }, this.env)

        const updatedResponse = evalResult.response as unknown as Record<string, unknown>

        // If LLM will run, disable all comp selections — LLM decides final selection
        if (config.pending.includes('llm')) {
          const comps = updatedResponse.comps as Record<string, unknown> | undefined
          if (comps?.items && Array.isArray(comps.items)) {
            comps.items = comps.items.map((c: Record<string, unknown>) => ({ ...c, isEnabled: false }))
            comps.enabledCount = 0
            comps.disabledCount = (comps.items as unknown[]).length
          }
        }

        config.analysisResult = updatedResponse
        console.log(`[AnalysisJobDO] ✓ Evaluation complete in ${Date.now() - evalStart}ms`)

        // OSM location risks — fire-and-forget, push update when ready
        osmPromise = (async () => {
          try {
            const prop = config.bundle.property
            if (prop.latitude && prop.longitude) {
              const osmResult = await detectOsmLocationRisks(prop.latitude, prop.longitude)
              if (osmResult.riskFlags.length > 0) {
                const existingFlags = (updatedResponse.riskFlags as string[] | null) ?? []
                updatedResponse.riskFlags = [...existingFlags, ...osmResult.riskFlags]
                await this.pushEvent('risk_flags_updated', { riskFlags: updatedResponse.riskFlags })
              }
            }
          } catch { /* Non-fatal */ }
        })()

        // Save report to DB
        try {
          const db = drizzle(this.env.DB)
          const result = updatedResponse as Record<string, unknown>
          const subject = result.subject as Record<string, unknown>
          const valuation = result.valuation as Record<string, unknown> | null
          await upsertPropertyReport(db, {
            userId: config.userId,
            jobId: config.jobId,
            propertyAddress: (subject.address as string) || '',
            propertyCity: (config.bundle.property.city) || '',
            propertyState: (config.bundle.property.state) || '',
            propertyZip: (config.bundle.property.zipCode) || '',
          }, {
            fullResponseJson: JSON.stringify(updatedResponse),
            arv: (valuation?.arv as number) ?? null,
            asIsValue: (valuation?.asIsValue as number) ?? null,
            maxAllowableOffer: (valuation?.buyPrice as number) ?? null,
            estimatedRepairs: (valuation?.rehabCost as number) ?? null,
          })
          if (config.evalResultCacheKey) {
            await this.env.API_CACHE.put(config.evalResultCacheKey, config.jobId, {
              expirationTtl: 21 * 24 * 60 * 60, // 21 days
            }).catch(() => { /* best-effort */ })
          }
        } catch (dbError) {
          console.warn(`[AnalysisJobDO] Failed to save report:`, dbError instanceof Error ? dbError.message : dbError)
          throw new Error('The evaluation could not be saved. Retry the analysis.')
        }
        await this.pushEvent('evaluation_complete', { updatedResult: updatedResponse })
      } catch (error) {
        console.warn('[AnalysisJobDO] Evaluation error:', error instanceof Error ? error.message : error)
        await this.pushEvent('error', { step: 'evaluation', message: error instanceof Error ? error.message : 'Evaluation failed', pythonEvaluation: (error as { pythonEvaluation?: unknown })?.pythonEvaluation })
      }
    }

    // Note: market_data step (Firecrawl/Zillow scraping) has been removed.
    // Property details are now sourced from CoreLogic enrichment.
    // Step B: LLM comp analysis (uses enriched data if market data ran first)
    if (config.pending.includes('llm')) {
      const llmStart = Date.now()
      try {
        await this.pushEvent('llm_started', { message: 'AI analyzing comparables...', compCount: config.bundle.comparables.length })

        const evalContexts: CompEvalContext[] = (config.analysisResult.comps?.items ?? []).map((comp: Record<string, unknown>) => ({
          compId: comp.id as string,
          isEnabled: comp.isEnabled as boolean,
          compGroup: (comp.compGroup as 'arv' | 'as_is' | null) ?? null,
          filterResults: ((comp.appraisalRules as Record<string, unknown>)?.filters as Array<{ type: string; passed: boolean; reason?: string }>) ?? [],
          adjustmentResults: ((comp.appraisalRules as Record<string, unknown>)?.adjustments as Array<{ type: string; applied: boolean; amount: number }>) ?? [],
          adjustedPrice: (comp.adjustedPrice as number) ?? null,
        }))

        // Build rich context for AI comp selection
        const evalParams = config.evalParams
        const compAnalysisCtx: import('../services/comp-analysis/types').CompAnalysisContext = {
          bundle: config.bundle,
          evalContexts,
          analysisResult: config.analysisResult,
          filters: evalParams.appraisalRules?.filters ?? [],
          adjustments: evalParams.appraisalRules?.adjustments ?? [],
          dealParams: {
            closingCostsPercent: evalParams.buybox?.closingCostsPercent ?? 8,
            carryingCostsPercent: evalParams.buybox?.carryingCostsPercent ?? 2,
            wholesaleFee: evalParams.buybox?.wholesaleFee ?? 10000,
          },
          rehabLevelIndex: evalParams.buybox?.rehabLevelIndex ?? 2,
          rehabTable: evalParams.customRehabTable,
          tierRanges: evalParams.customTierRanges,
          arvThresholdPercent: evalParams.arvThreshold?.percent ?? 15,
          asIsThresholdPercent: evalParams.asIsThresholdPercent ?? 70,
          riskFlags: (config.analysisResult.riskFlags as string[]) ?? [],
          marketContext: null, // Legacy path — no market context
        }

        const llmResult = await analyzeComps(
          compAnalysisCtx,
          this.env, { includePhotos: config.llmOptions?.includePhotos },
        )

        if (llmResult && llmResult.selectedForArv.length > 0) {
          console.log(`[AnalysisJobDO] LLM selected ${llmResult.selectedForArv.length} comps for ARV: ${llmResult.selectedForArv.join(', ')}`)

          // Apply LLM's comp selection: update isEnabled on all comps
          const selectedSet = new Set(llmResult.selectedForArv)
          const asIsSet = new Set(llmResult.asIsComps ?? [])
          const currentResult = config.analysisResult
          if (currentResult.comps?.items && Array.isArray(currentResult.comps.items)) {
            currentResult.comps.items = currentResult.comps.items.map((comp: Record<string, unknown>) => {
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
                disableReasons: isSelected
                  ? []
                  : [ranking?.reasoning || 'Not selected by AI analysis'],
              }
            })

            // Update comp counts
            const enabledCount = currentResult.comps.items.filter((c: Record<string, unknown>) => c.isEnabled).length
            currentResult.comps.enabledCount = enabledCount
            currentResult.comps.disabledCount = currentResult.comps.items.length - enabledCount
          }

          await this.pushEvent('llm_complete', {
            llmAnalysis: {
              model: llmResult.model,
              latencyMs: llmResult.latencyMs,
              tokenUsage: llmResult.tokenUsage,
              compCount: llmResult.rankings.length,
              summary: llmResult.summary,
              selectedForArv: llmResult.selectedForArv,
            },
            rankings: llmResult.rankings,
            updatedResult: currentResult,
          })
          console.log(`[AnalysisJobDO] ✓ LLM: ${llmResult.rankings.length} comps analyzed, ${llmResult.selectedForArv.length} selected for ARV in ${Date.now() - llmStart}ms`)
        } else if (llmResult) {
          // LLM returned rankings but no selection — just enrich without changing selection
          await this.pushEvent('llm_complete', {
            llmAnalysis: { model: llmResult.model, latencyMs: llmResult.latencyMs, tokenUsage: llmResult.tokenUsage, compCount: llmResult.rankings.length, summary: llmResult.summary },
            rankings: llmResult.rankings,
          })
          console.log(`[AnalysisJobDO] ✓ LLM: ${llmResult.rankings.length} comps analyzed (no selection override) in ${Date.now() - llmStart}ms`)
        } else {
          await this.pushEvent('llm_complete', { llmAnalysis: null, rankings: [], skipped: true, reason: 'LLM provider not available' })
        }
      } catch (error) {
        console.warn('[AnalysisJobDO] LLM error:', error instanceof Error ? error.message : error)
        await this.pushEvent('error', { step: 'llm', message: error instanceof Error ? error.message : 'LLM analysis failed' })
      }
    }

    // Wait for OSM risk flags if still running
    await osmPromise
    const totalMs = Date.now() - startTime
    await this.pushEvent('enrichment_done', { totalDurationMs: totalMs })
    console.log(`[AnalysisJobDO] ── Enrichment complete in ${(totalMs / 1000).toFixed(1)}s ──`)
  }

  // ─── Event Management ─────────────────────────────────────────────────────

  // ─── Observability: record every run outcome (success AND failure) ────────

  private async recordRun(
    config: StartStreamingRequest,
    outcome: {
      status: 'completed' | 'error'
      durationMs: number
      response?: Record<string, unknown> | null
      errorCode?: string
      errorMessage?: string
      compCount?: number
    }
  ): Promise<void> {
    try {
      const db = drizzle(this.env.DB)
      const resp = (outcome.response ?? null) as Record<string, unknown> | null
      const subj = (resp?.subject ?? null) as Record<string, unknown> | null
      const val = (resp?.valuation ?? null) as Record<string, unknown> | null
      const comps = (resp?.comps ?? null) as Record<string, unknown> | null
      const report = (resp?.report ?? null) as { steps?: Array<{ name: string; status: string; detail?: string }>; fallbacksUsed?: string[] } | null
      const vision = (resp?.visionAssessment ?? null) as { status?: string } | null
      const permits = (subj?.permits ?? null) as { status?: string } | null

      const evidence = {
        status: outcome.status,
        errorCode: outcome.errorCode ?? null,
        compCount: outcome.compCount ?? (comps?.total as number) ?? null,
        enabledCompCount: (comps?.enabledCount as number) ?? null,
        arv: (val?.arv as number) ?? null,
        photoCount: Array.isArray(subj?.photos) ? (subj.photos as unknown[]).length : 0,
        renovationLevelSource: (resp?.renovationLevelSource as string) ?? null,
        visionStatus: vision?.status ?? null,
        permitStatus: permits?.status ?? null,
        fallbacks: report?.fallbacksUsed ?? [],
        durationMs: outcome.durationMs,
        steps: report?.steps ?? null,
      }
      const runEval = evaluateRun(evidence)

      await db.insert(analysisRuns).values({
        jobId: config.jobId,
        userId: config.userId,
        propertyAddress: (subj?.address as string) ?? config.search.address ?? config.search.streetAddress ?? null,
        propertyCity: (config.search.city as string) ?? null,
        propertyState: (config.search.state as string) ?? null,
        propertyZip: (config.search.zipCode as string) ?? null,
        status: outcome.status,
        errorCode: outcome.errorCode ?? null,
        errorMessage: outcome.errorMessage ?? null,
        durationMs: outcome.durationMs,
        arv: (val?.arv as number) ?? null,
        recommendation: (val?.recommendation as string) ?? null,
        compCount: (comps?.total as number) ?? outcome.compCount ?? null,
        enabledCompCount: (comps?.enabledCount as number) ?? null,
        photoProvider: (resp?.photoProvider as string) ?? null,
        photoCount: Array.isArray(subj?.photos) ? (subj.photos as unknown[]).length : 0,
        renovationLevelSource: (resp?.renovationLevelSource as string) ?? null,
        visionStatus: vision?.status ?? null,
        stepsJson: report?.steps ? JSON.stringify(report.steps) : null,
        fallbacksJson: report?.fallbacksUsed ? JSON.stringify(report.fallbacksUsed) : null,
        evalJson: JSON.stringify(runEval),
        apiCallStatsJson: resp?.apiCallStats ? JSON.stringify(resp.apiCallStats) : null,
      })
    } catch (err) {
      console.warn('[AnalysisJobDO] recordRun failed (non-fatal):', err instanceof Error ? err.message : err)
    }
  }

  private async pushEvent(event: string, data: unknown): Promise<void> {
    if (!this.jobState) return

    this.jobState.events.push({ event, data, timestamp: Date.now() })

    if (event === 'enrichment_done') {
      this.jobState.status = 'complete'
    } else if (event === 'error') {
      this.jobState.error = (data as { message?: string })?.message
    }

    await this.state.storage.put('jobState', this.jobState)
    this.broadcast(event, data)
  }

  private async handleEvent(request: Request): Promise<Response> {
    const body = await request.json() as { event: string; data: unknown }
    await this.pushEvent(body.event, body.data)
    return new Response('OK', { status: 200 })
  }

  // ─── SSE Stream ───────────────────────────────────────────────────────────

  private async handleSSE(request: Request): Promise<Response> {
    if (!this.jobState) {
      this.jobState = await this.state.storage.get<JobState>('jobState') ?? null
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    this.sseClients.add(writer)

    // Replay buffered events for late-joining clients
    if (this.jobState?.events.length) {
      for (const evt of this.jobState.events) {
        await writer.write(this.encoder.encode(`event: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`))
      }
    }

    // If already complete, close after replay
    if (this.jobState?.status === 'complete' || this.jobState?.status === 'error') {
      await writer.write(this.encoder.encode(`event: enrichment_done\ndata: ${JSON.stringify({ replayed: true })}\n\n`))
      writer.close()
      this.sseClients.delete(writer)
    } else {
      request.signal?.addEventListener('abort', () => {
        this.sseClients.delete(writer)
        writer.close().catch(() => {})
      })
    }

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  }

  // ─── State Query ──────────────────────────────────────────────────────────

  private handleGetState(): Response {
    return Response.json(this.jobState ?? { status: 'not_found' }, { status: this.jobState ? 200 : 404 })
  }

  // ─── Data Merge Helpers ──────────────────────────────────────────────────

  /**
   * Merge market data into a subject property, filling in missing fields.
   * Only overwrites null/undefined fields — CoreLogic data takes priority.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // ─── Broadcast ────────────────────────────────────────────────────────────

  private broadcast(event: string, data: unknown): void {
    const msg = this.encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    const dead: WritableStreamDefaultWriter<Uint8Array>[] = []

    for (const writer of this.sseClients) {
      try { writer.write(msg) } catch { dead.push(writer) }
    }
    for (const d of dead) this.sseClients.delete(d)
  }
}
