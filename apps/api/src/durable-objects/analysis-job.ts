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

import { ChunkedJobState } from './chunked-job-state'

import { fetchMarketContext, type MarketContext } from '../services/market-context'
import { type EvaluationParams } from '../services/evaluation'
import { performAnalysis } from '../services/evaluation'
import { detectOsmLocationRisks } from '../services/location-risk'
import { createPhotoService } from '../services/photo-provider'
import { createPropertyApi } from '../services/property-api'
import { mergeComparablePools } from '../services/property-api/comparable-pool'
import {
  resolveCandidateLimit,
  expansionRefetchRadius,
  isProvablyDeadComp,
  type ComparablesRetrievalMeta,
} from '../services/property-api/retrieval-policy'
import { DEFAULT_FILTERS, evaluateComparable, type AppraisalFilter } from '../services/appraisal'
import { flexNumericFilters, isValueEquivalent } from '../services/appraisal/evaluator'
import { arvEvidence } from '../services/evaluation'
import { DEFAULT_EXPANSION_POLICY, saleAgeExpansionSteps, vintageYearCap } from '../services/appraisal/types'
import { filtersToApiParams } from '../services/appraisal/types'
import type { Env } from '../types'
import type { NormalizedProperty, NormalizedComparable } from '../services/property-api/types'
import { fetchCensusGeography } from '../services/geo/census-geocoder'
import { resolveParcelApn } from '../services/geo/parcel-gis'
import { resolveZoning } from '../services/geo/zoning'
import { drizzle } from 'drizzle-orm/d1'
import { and, eq } from 'drizzle-orm'
import { upsertPropertyReport, bMetricsFromValuation } from '../services/report-upsert'
import { notifyEvalComplete } from '../routes/offers'
import { analysisRuns, savedReports } from '../db/schema'
import {
  EVAL_ERROR_TTL_SECONDS,
  decodeVerdict,
  encodeVerdict,
  isCacheableVerdict,
} from '../utils/eval-cache'
import { evaluateRun } from '../services/observability/evals'
import { buildRunRecordPayload, insertRunRecord, linkRunRecordToReport } from '../services/evaluation/run-record'

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
  /** Bypass caches on re-evaluation (explicit refresh/rerun) */
  skipCache?: boolean
  /** KV key under which to store this run's report pointer (21-day eval cache) */
  evalResultCacheKey?: string
  /** Close CRM lead — folds realtor notes into the rehab model */
  leadId?: string
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
  /** Close CRM lead/opportunity this evaluation belongs to — stamped onto the
   *  persisted report so it can be written back to the CRM */
  leadId?: string
  opportunityId?: string
  llmOptions?: {
    includePhotos?: boolean
    compSelectionModel?: string
    marketSearchModel?: string
    reasoning?: boolean
  }
}

export class AnalysisJobDO {
  private state: DurableObjectState
  private env: Env
  private sseClients: Set<WritableStreamDefaultWriter<Uint8Array>> = new Set()
  private encoder = new TextEncoder()
  private jobState: JobState | null = null
  /** Clef comp curb-appeal map + the persisted result it patches. Set
   *  independently because the batch resolves fire-and-forget — whichever
   *  arrives second triggers applyCurbAppealWriteback. */
  private curbAppealMap: import('../services/evaluation').CompCurbAppealMap | null = null
  private curbAppealResult: Record<string, unknown> | null = null
  private persistence: ChunkedJobState<JobState>
  /** True while runStreamingAnalysis/runEnrichment is live in THIS isolate */
  private runActive = false

  /** Watchdog cadence — comfortably above a typical run (~2min). */
  private static readonly WATCHDOG_MS = 5 * 60_000

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
    this.persistence = new ChunkedJobState(state.storage)
    state.blockConcurrencyWhile(async () => {
      this.jobState = await this.persistence.read()
    })
  }

  /**
   * Watchdog: fires while the job reads 'processing'. If the pipeline loop is
   * still live in this isolate, re-arm. If the isolate hosting the run died
   * (eviction, crash, deploy), runActive is false and the persisted run can
   * never finish — convert it to a terminal error so polling clients stop
   * waiting instead of watching 'processing' forever.
   */
  async alarm(): Promise<void> {
    if (!this.jobState) {
      this.jobState = await this.persistence.read()
    }
    const js = this.jobState
    if (!js || js.status !== 'processing') {
      await this.state.storage.deleteAlarm()
      return
    }
    if (this.runActive) {
      await this.state.storage.setAlarm(Date.now() + AnalysisJobDO.WATCHDOG_MS)
      return
    }

    console.warn(`[AnalysisJobDO] watchdog: job ${js.jobId} processing with no live run — marking error`)
    js.status = 'error'
    js.error = 'Analysis was interrupted before completing — retry the request'
    this.jobState = js
    await this.persistence.write(js)
    this.broadcast('error', { step: 'watchdog', message: js.error })
    try {
      const db = drizzle(this.env.DB)
      await db.insert(analysisRuns).values({
        jobId: js.jobId,
        userId: js.userId,
        status: 'error',
        errorCode: 'STALLED',
        errorMessage: js.error,
        durationMs: Date.now() - js.createdAt,
      })
    } catch { /* observability only */ }
    await this.state.storage.deleteAlarm()
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

    // A pipeline is already live in this isolate — a retry/duplicate POST must
    // not start a second interleaved run over the same state. (A persisted
    // 'processing' state with runActive=false is a dead run; restarting is
    // exactly the recovery we want, so only the in-memory flag gates this.)
    if (this.runActive) {
      return new Response(JSON.stringify({ error: 'Job already running' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Ownership guard: a start request for a jobId whose persisted state
    // belongs to a different user is rejected — defense in depth behind the
    // route-level existingJobId ownership check.
    if (!this.jobState) this.jobState = await this.persistence.read()
    if (this.jobState && this.jobState.userId !== body.userId) {
      return new Response(JSON.stringify({ error: 'Job belongs to another user' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const pending = ['property_fetch', 'evaluation']

    this.jobState = {
      jobId: body.jobId,
      userId: body.userId,
      status: 'processing',
      pending,
      events: [],
      createdAt: Date.now(),
    }
    await this.persistence.write(this.jobState)
    await this.state.storage.setAlarm(Date.now() + AnalysisJobDO.WATCHDOG_MS)

    // waitUntil is required: a DO with no tracked work can be evicted the
    // moment this fetch returns — without it, polling-only API clients (no
    // SSE connection holding the object alive) lose the run mid-flight.
    this.runActive = true
    this.state.waitUntil(
      this.runStreamingAnalysis(body)
        .catch((err) => {
          console.error('[AnalysisJobDO] Streaming analysis fatal error:', err)
          const durationMs = Date.now() - (this.jobState?.createdAt ?? Date.now())
          this.pushEvent('error', { step: 'fatal', message: err instanceof Error ? err.message : 'Unknown error' })
          this.recordRun(body, { status: 'error', durationMs, errorCode: 'FATAL', errorMessage: err instanceof Error ? err.message : 'Unknown error' })
          this.pushEvent('enrichment_done', { totalDurationMs: durationMs })
        })
        .finally(() => {
          this.runActive = false
        })
    )

    return new Response('OK', { status: 200 })
  }

  private async runStreamingAnalysis(config: StartStreamingRequest): Promise<void> {
    const startTime = Date.now()
    await new Promise((r) => setTimeout(r, 300)) // Let SSE clients connect
    console.log(`[AnalysisJobDO] ── Streaming analysis started ──`)

    const propertyApi = createPropertyApi(this.env)
    // Explicit reruns bypass every KV cache on this instance — the point
    // of Rerun is fresh comps, fresh property fields, fresh photos.
    propertyApi.setSkipCache(!!config.skipCache)
    const filters = [...(config.evalParams.appraisalRules?.filters ?? DEFAULT_FILTERS)] as AppraisalFilter[]
    // Inject defaults for filter types the preset doesn't define — same
    // merge performAnalysis does, so pruning/params see the identical
    // effective rule set (incl. sale_age_expansion* tiers).
    for (const df of DEFAULT_FILTERS) {
      if (!filters.some((f) => f.type === df.type)) filters.push({ ...df })
    }
    const apiFilterParams = filtersToApiParams(filters)

    // Eval-result cache (route + batch children): a stored jobId replays the
    // saved report, an 'err:' marker replays a terminal verdict — zero
    // provider calls either way.
    if (config.evalResultCacheKey && !config.skipCache && !config.isRefresh) {
      try {
        const cached = await this.env.API_CACHE?.get(config.evalResultCacheKey)
        const verdict = cached ? decodeVerdict(cached) : null
        if (verdict) {
          await this.pushEvent('error', { step: 'cache', message: verdict.message, code: verdict.code })
          await this.recordRun(config, { status: 'error', durationMs: Date.now() - startTime, errorCode: verdict.code, errorMessage: verdict.message })
          await this.pushEvent('enrichment_done', { totalDurationMs: Date.now() - startTime })
          return
        }
        if (cached) {
          const db = drizzle(this.env.DB)
          const [report] = await db
            .select({ fullResponseJson: savedReports.fullResponseJson })
            .from(savedReports)
            .where(and(eq(savedReports.userId, config.userId), eq(savedReports.jobId, cached)))
            .limit(1)
          if (report?.fullResponseJson) {
            const analysisResult = JSON.parse(report.fullResponseJson)
            await this.pushEvent('evaluation_complete', { updatedResult: analysisResult })
            await this.recordRun(config, { status: 'completed', durationMs: Date.now() - startTime, response: analysisResult, cachedJobId: cached })
            await this.pushEvent('enrichment_done', { totalDurationMs: Date.now() - startTime })
            return
          }
          await this.env.API_CACHE.delete(config.evalResultCacheKey).catch(() => {})
        }
      } catch { /* cache lookup best-effort */ }
    }

    // ── Step 1: Search subject property ─────────────────────────────────────
    await this.pushEvent('property_fetch', { message: 'Searching property...' })

    let searchResult = await propertyApi.searchProperty({
      address: config.search.address,
      streetAddress: config.search.streetAddress,
      city: config.search.city,
      state: config.search.state,
      zipCode: config.search.zipCode,
    })

    // ATTOM address-string miss → parcel-GIS bridge: Census geocode →
    // county parcel lookup → APN → exact fipsApn resolve on ATTOM. 100%
    // ATTOM — a parcel hit resumes the full pipeline; a miss fails the
    // run as PROPERTY_NOT_FOUND below.
    if (!searchResult.success && propertyApi.providerName === 'attom-mcp') {
      console.log('[AnalysisJobDO] attom-mcp could not resolve subject — trying parcel-GIS bridge')
      await this.pushEvent('property_fetch', { message: 'ATTOM address lookup missed — resolving parcel via county records...' })
      const parcel = await resolveParcelApn(config.search.address ??
        [config.search.streetAddress, config.search.city, config.search.state, config.search.zipCode].filter(Boolean).join(', '))
      if (parcel) {
        const byParcel = await propertyApi.searchProperty({
          address: config.search.address,
          fips: parcel.fips,
          apn: parcel.apn,
        })
        if (byParcel.success) {
          console.log('[AnalysisJobDO] parcel bridge succeeded — ATTOM pipeline resumes on attomId', byParcel.data?.id)
          await this.pushEvent('property_fetch', { message: 'Parcel resolved — continuing on ATTOM...' })
          searchResult = byParcel
        }
      }
    }

    if (!searchResult.success) {
      const msg = ('error' in searchResult ? searchResult.error : null) || 'Property not found'
      await this.cacheVerdict(config, 'PROPERTY_NOT_FOUND', msg)
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
        parcelId: property.parcelId ?? null,
        neighborhoodName: property.neighborhoodName ?? property.geoScopes?.n4 ?? property.geoScopes?.n3 ?? null,
        cbsaCode: property.cbsaCode ?? null,
        censusTract: property.censusTract ?? null,
        censusBlockGroup: property.censusBlockGroup ?? null,
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

    // Candidate pool: request up to the configured/provider-max limit so the
    // appraisal rules see the broadest universe the provider supports in one
    // call (CoreLogic maxComps hard max = 100, no pagination).
    const candidateLimit = resolveCandidateLimit(this.env, propertyApi.providerName, config.searchOptions.maxComps)
    const comparablesParams = {
        propertyId: property.id,
        radiusMiles: config.searchOptions.radiusMiles ?? apiFilterParams.radiusMiles ?? 1,
        maxComps: candidateLimit,
        // attom-mcp: the sale-age ladder (expansion tiers + param flex) can
        // reach ~18 months — the configured window (often ~6mo, derived
        // from sale_age) truncates the exact comps the rules are built to
        // admit. Floor the fetch at the deepest reachable tier.
        monthsBack: propertyApi.providerName === 'attom-mcp'
          ? Math.max(18, config.searchOptions.monthsBack ?? apiFilterParams.monthsBack ?? 0)
          : (config.searchOptions.monthsBack ?? apiFilterParams.monthsBack ?? 12),
        // Sub-1,000sf subjects: evaluation replaces the ±diff band with an
        // absolute 1,000sf ceiling — widen the provider-side diff so
        // qualifying comps aren't culled upstream.
        sqftDiff: (property.squareFeet != null && property.squareFeet < 1000)
          ? Math.max(apiFilterParams.sqftDiff ?? 0, 1000)
          : apiFilterParams.sqftDiff,
        subjectSqft: property.squareFeet ?? undefined,
        subjectPropertyType: property.propertyType ?? undefined,
    }
    const [compsResult, permitsResult, floodResult, avmResult, buildingDetailResult, osmResult, prefetchedPhotoBundleRaw] = await Promise.all([
      propertyApi.getComparables(comparablesParams),
      // Permits: fetched on every run (KV-cached) — the permit-age
      // thresholds drive major-item additions in the buybox derivation.
      // 'unavailable' must still mean the call failed, not that the
      // property has no permits on file (that's 'empty').
      (config.enrichment?.permits !== false)
        ? propertyApi.getBuildingPermits(property.id, { address1: property.address, address2: `${property.city}, ${property.state} ${property.zipCode}` })
        : Promise.resolve(null),
      // Flood zone: OPT-IN only — the First Street signal is scraped from the
      // Redfin listing during photo fetch instead (free via Firecrawl).
      (config.enrichment?.floodZone === true)
        ? propertyApi.getFloodZoneForProperty(property).catch(() => null)
        : Promise.resolve(null),
      // Subject AVM (Total Home Value) — parcel-level, subject only
      property.parcelId
        ? propertyApi.getAvm(property.parcelId).catch(() => null)
        : Promise.resolve(null),
      // Subject building detail — literal-text condition/style/foundation
      // when the coded property-detail block lacks them
      property.parcelId &&
        (!property.buildingCondition ||
          !property.construction?.buildingStyle ||
          !property.construction?.foundationType)
        ? propertyApi.getBuildingDetail(property.parcelId).catch(() => null)
        : Promise.resolve(null),
      // Location risk (major roads, railroads, commercial) — fetched during
      // enrichment so it can deduct from valuation, not just flag post-hoc.
      // The street name lets detection classify fronting/backing/siding.
      property.latitude && property.longitude
        ? detectOsmLocationRisks(property.latitude, property.longitude, 150, {
            streetName: property.address?.replace(/^\d+\s+/, '') ?? undefined,
          }).catch(() => null)
        : Promise.resolve(null),
      // Subject photos — subject-only scrape; the bundle feeds the Zillow
      // field merge, the flood signal, vision, and R2 persistence inside
      // performAnalysis. Prefetching here overlaps it with the comps fetch.
      (async () => {
        try {
          const photoService = createPhotoService(this.env)
          if (!photoService.isAvailable()) return null
          return await photoService.fetchPhotoBundle({
            propertyId: property.id,
            address: property.address,
            city: property.city,
            state: property.state,
            zipCode: property.zipCode,
          }, [], { maxComps: 0, skipCache: !!config.skipCache })
        } catch { return null }
      })(),
    ])

    // Photo retry — the listing scrape keys on the address string and
    // misses on odd spellings (same class of gap as the ATTOM address
    // matcher). The county's canonical site address often matches what
    // the listing sites index; retry once with it.
    let prefetchedPhotoBundle = prefetchedPhotoBundleRaw
    if (!prefetchedPhotoBundle?.subject?.photos?.length && propertyApi.providerName === 'attom-mcp') {
      const parcel = await resolveParcelApn(
        `${property.address}, ${property.city}, ${property.state} ${property.zipCode ?? ''}`.trim(),
      ).catch(() => null)
      if (parcel?.siteAddress && !property.address.toUpperCase().startsWith(parcel.siteAddress.slice(0, 12))) {
        console.log('[AnalysisJobDO] subject photos empty — retrying scrape with county canonical address', parcel.siteAddress)
        try {
          const photoService = createPhotoService(this.env)
          if (photoService.isAvailable()) {
            prefetchedPhotoBundle = await photoService.fetchPhotoBundle({
              propertyId: property.id,
              address: parcel.siteAddress,
              city: property.city,
              state: property.state,
              zipCode: property.zipCode,
            }, [], { maxComps: 0, skipCache: true })
          }
        } catch { /* retry is best-effort */ }
      }
    }

    // Zoning — county GIS point-in-polygon on the subject. ATTOM carries
    // no zoning dataset; the county layers populate the fields
    // detectLocationRisks already reads (commercial/mixed-use flags) and
    // feed the HBU/development signal downstream.
    if (property.zoning == null && property.latitude != null && property.longitude != null) {
      const z = await resolveZoning(
        property.latitude,
        property.longitude,
        (property.censusTract ?? '').slice(0, 5) || null,
      ).catch(() => null)
      if (z) {
        property.zoning = z.code
        property.zoningDescription = z.description ?? property.zoningDescription
      }
    }

    if (!compsResult.success) {
      const msg = ('error' in compsResult ? compsResult.error : null) || 'Failed to fetch comparables'
      await this.pushEvent('error', { step: 'comps_fetch', message: msg })
      await this.recordRun(config, { status: 'error', durationMs: Date.now() - startTime, errorCode: 'COMPS_FETCH_FAILED', errorMessage: msg })
      await this.pushEvent('enrichment_done', { totalDurationMs: Date.now() - startTime })
      return
    }

    const pools = { comparables: compsResult.success ? compsResult.data.comparables : [], conflictIds: [] as string[] }
    const rawComps = pools.comparables
    // Retrieval audit — what the provider actually returned for this pool.
    // Provider exposes no totalCount/hasMore, so providerTruncated is an
    // inference (received filled the whole requested window).
    const retrieval: ComparablesRetrievalMeta = compsResult.data.retrieval ?? {
      providerCandidatesReported: null,
      providerCandidatesReceived: rawComps.length,
      candidateLimitRequested: candidateLimit,
      candidateLimitEffective: candidateLimit,
      providerTruncated: rawComps.length >= candidateLimit,
      pagesRequested: 1,
      providerCallsUsed: 1,
      ordering: 'distance',
      radiusMiles: comparablesParams.radiusMiles,
      monthsBack: comparablesParams.monthsBack,
    }
    let candidatesPruned = 0
    let candidatesEnriched = 0
    console.log(`[AnalysisJobDO] ✓ ${rawComps.length} comps found in ${Date.now() - compsStart}ms (requested ${retrieval.candidateLimitEffective}${retrieval.providerTruncated ? ', provider-truncated' : ''})`)

    // Stream comps immediately → dashboard shows map markers + basic comp cards
    await this.pushEvent('comps_found', {
      compCount: rawComps.length,
      retrieval,
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

    // ── Step 3: Dead-comp pruning — enrichment lives in the census gate ─────────
    // for attom-mcp — provider detail calls run on census-verified comps only.
    // strongest first, capped) inside evaluation — mass-enriching the raw
    // pool here spent ~80 detail calls per run on comps that mostly fail
    // test 1. Pruning is pure field checks (no calls) and feeds retrieval
    // telemetry.
    const filterValue = (type: string, fallback: number): number => {
      const f = filters.find((x) => x.type === type)
      return f && f.enabled === false ? Infinity : (f?.value ?? fallback)
    }
    const saleAgeBase = filterValue('sale_age', 180)
    const deadThresholds = {
      // Widest window ANY tier can reach — the deepest enabled
      // sale_age_expansion* row. Pruning on the strict sale_age alone
      // would starve enrichment for comps a configured fallback tier
      // could still admit.
      saleAgeDays: DEFAULT_EXPANSION_POLICY.allowSaleAgeExpansion
        ? Math.max(saleAgeBase, ...saleAgeExpansionSteps(filters, saleAgeBase))
        : saleAgeBase,
      sqftDiff: filterValue('sqft_diff', 250),
      maxYearDiff: filterValue('year_built_diff', 10) +
        Math.max(0, ...DEFAULT_EXPANSION_POLICY.yearBuiltExpansionSteps),
      // Vintage-subject fallback: when the subject predates the configured
      // cap, comps built on/before it can still be admitted by the vintage
      // tier — pruning on ±maxYearDiff would starve them of enrichment.
      vintageYearCap: vintageYearCap(filters, property.yearBuilt),
    }
    const nowMs = Date.now()
    const isDeadComp = (c: NormalizedComparable): boolean =>
      isProvablyDeadComp(c, property, deadThresholds, nowMs)

    const skipped = rawComps.filter((c) => isDeadComp(c)).length
    candidatesPruned = skipped
    candidatesEnriched = 0
    if (skipped > 0) {
      console.log(`[AnalysisJobDO] ${skipped} comp(s) dead on sale-age/sqft/year rules (telemetry only — Jev funnel decides enrichment)`)
    }

    let enrichedComps = rawComps
    const poolCompIds = new Set(rawComps.map((c) => c.id))
    // Param-flex ladder record — how far numeric tolerances stretched to
    // admit evidence (0 = strict tier admitted it).
    let paramFlexExtensions = 0
    let paramFlexFactor = 1
    retrieval.candidatesPrunedBeforeEnrichment = candidatesPruned
    retrieval.candidatesEnriched = candidatesEnriched

    // Human-readable concessions the winning flex tier made — only the
    // numeric filters that actually moved.
    const describeFlexConcessions = (base: AppraisalFilter[], factor: number): string[] => {
      if (factor <= 1) return []
      const label: Record<string, (v: number) => string> = {
        sale_age: (v) => `sale age to ${Math.round(v)} days`,
        sale_age_expansion: () => null as unknown as string,
        sale_age_expansion_2: () => null as unknown as string,
        sqft_diff: (v) => `sqft tolerance to ±${Math.round(v)}`,
        year_built_diff: (v) => `year built to ±${Math.round(v)} yrs`,
        lot_size_diff: (v) => `lot size to ±${Math.round(v)} sqft`,
        distance: (v) => `distance to ${Math.round(v * 10) / 10}mi`,
      }
      const out: string[] = []
      for (const f of base) {
        const fmt = label[f.type]
        if (!fmt || !f.enabled || typeof f.value !== 'number') continue
        const stretched = f.value * factor
        const txt = fmt(stretched)
        if (txt) out.push(`${txt} (was ${fmt(f.value)})`)
      }
      return out
    }

    // ── attom-mcp: free-first census gate + gated enrichment ──────────────────
    // Census-geocode every comp (free, no key) and only spend a provider
    // detail call (1 AI Intelligence Report each) on comps sharing the
    // subject's census block group or tract. Non-passers stay in the pool
    // unenriched with sameBlockGroup/crossesMajorRoad/censusTract stamped.
    const isAttomMcp = propertyApi.providerName === 'attom-mcp'
    const gateAndEnrich = async (
      comps: NormalizedComparable[],
    ): Promise<NormalizedComparable[]> => {
      if (!isAttomMcp || property.latitude == null || property.longitude == null) return comps
      const subjectGeo = await fetchCensusGeography(
        property.latitude,
        property.longitude,
        this.env.API_CACHE,
        this.env.FIRECRAWL_API_KEY,
        this.env.GEOCODIO_API_KEY,
      )
      if (!subjectGeo) return comps
      property.censusTract ??= subjectGeo.tract
      property.censusBlockGroup ??= subjectGeo.blockGroup
      property.neighborhoodName ??= property.geoScopes?.n4 ?? property.geoScopes?.n3

      // market-context supplement — the second retrieval source: recent
      // same-pocket sales the primary comp search missed entirely (e.g.
      // same-street sales). Candidates arrive detail-enriched, then flow
      // through the same census geo gate as everything else.
      try {
        const seenIds = new Set(comps.map((c) => String(c.id)))
        const normAddr = (a?: string | null) => (a ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
        const seenAddrs = new Set(comps.map((c) => normAddr(c.address)).filter(Boolean))
        const supplement = await propertyApi.marketContextSupplement(String(property.id), {
          ids: seenIds,
          addresses: seenAddrs,
        })
        if (supplement.length > 0) {
          console.log(`[AnalysisJobDO] market-context supplement: +${supplement.length} comp(s) added to pool`)
          comps = [...comps, ...supplement]
        }
      } catch (e) {
        console.warn('[AnalysisJobDO] market-context supplement failed (non-fatal):', e instanceof Error ? e.message : e)
      }

      const cache = this.env.API_CACHE ?? undefined
      const lookup = async (lat: number, lng: number) => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const g = await fetchCensusGeography(lat, lng, cache, this.env.FIRECRAWL_API_KEY, this.env.GEOCODIO_API_KEY).catch(() => null)
          if (g) return g
          // Brief spacing between retries — the free endpoint throttles bursts
          if (attempt < 2) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)))
        }
        return null
      }
      // Geocodio backs the lookups (1,000 lookups/min) — wide concurrency is
      // safe; the Census/Firecrawl fallbacks only fire when Geocodio misses.
      const geos: (Awaited<ReturnType<typeof lookup>> | null)[] = new Array(comps.length).fill(null)
      const queue = comps.map((c, i) => ({ c, i }))
      await Promise.all(
        Array.from({ length: 15 }, async () => {
          for (let item = queue.shift(); item; item = queue.shift()) {
            if (item.c.latitude != null && item.c.longitude != null) {
              geos[item.i] = await lookup(item.c.latitude, item.c.longitude)
            }
          }
        }),
      )
      const geoPassers = comps.filter((c, i) => {
        const g = geos[i]
        if (!g) return false
        c.censusTract ??= g.tract
        c.censusBlockGroup ??= g.blockGroup
        c.sameBlockGroup ??= g.blockGroup === subjectGeo.blockGroup
        c.crossesMajorRoad ??= g.tract !== subjectGeo.tract
        return g.blockGroup === subjectGeo.blockGroup || g.tract === subjectGeo.tract
      })
      // ATTOM fallback for Census misses: geography-context ships censusTract
      // on the detail call anyway — spend one provider call on comps that
      // look competitive (dead comps don't merit it) so "unverified" can't
      // silently read as "passes" downstream. Verified: half a pool failed
      // Census and two cross-boundary comps enabled without geography.
      const censusMisses = comps.filter((c, i) =>
        !geos[i] && c.latitude != null && c.salePrice != null && c.salePrice >= 10_000 && c.squareFeet != null)
      if (censusMisses.length > 0) {
        const geoEnriched = await propertyApi.enrichComparables(censusMisses, { concurrency: 5 })
          .catch(() => [] as NormalizedComparable[])
        for (const e of geoEnriched) {
          const comp = comps.find((c) => c.id === e.id)
          if (!comp || !e.censusTract) continue
          comp.censusTract ??= e.censusTract
          comp.censusBlockGroup ??= e.censusBlockGroup
          comp.crossesMajorRoad ??= comp.censusTract !== subjectGeo.tract
          if (comp.censusTract === subjectGeo.tract && !geoPassers.includes(comp)) geoPassers.push(comp)
        }
      }
      // Still unstamped after both ladders → explicitly unverified so the
      // evaluator/report can see "geography never checked" vs "passed".
      // Runs at merge — enrichComparables returns fresh objects that would
      // drop a flag set on the originals.
      const flagUnverified = (list: NormalizedComparable[]) => {
        let n = 0
        list.forEach((c) => { if (c.censusTract == null && c.latitude != null) { c.geographyUnverified = true; n++ } })
        if (n) console.log(`[AnalysisJobDO] geography unverified: ${n} comps`)
      }
      if (geoPassers.length === 0) { flagUnverified(comps); return comps }
      // Thin-pool flex ladder — geo stays required; numeric tolerances
      // (sqft, year built, lot, sale age, distance) stretch ×1.15 → ×1.25 →
      // ×1.35 → … until a passer carries ARV evidence or every geo-verified
      // comp has been enriched. First admission stops the stretch, enriches
      // the cohort, checks evidence; no ARV evidence → stretch again.
      // Value-equivalent crossers — geocoded comps in a different tract
      // whose pocket sits within ±10% $/sf of the subject's. Census is
      // preferred; under flex (i≥1) these become enrichment candidates.
      const geoPasserIds = new Set(geoPassers.map((c) => c.id))
      const flexCrossers = comps.filter((c, i) => {
        const g = geos[i]
        if (!g || geoPasserIds.has(c.id)) return false
        return isValueEquivalent(property, c)
      })
      const FLEX_TIERS = [1, 1.15, 1.25, 1.35, 1.5, 1.75, 2, 2.5, 3, 4, 5]
      const enrichedById = new Map<string, NormalizedComparable>()
      for (let i = 0; i < FLEX_TIERS.length; i++) {
        // Deepest stretch wins across gate invocations (initial pool and
        // expansion refetch share the record).
        paramFlexFactor = Math.max(paramFlexFactor, FLEX_TIERS[i])
        paramFlexExtensions = Math.max(paramFlexExtensions, i)
        const tierFilters = flexNumericFilters(filters, FLEX_TIERS[i])
        const candidates = i === 0 ? geoPassers : [...geoPassers, ...flexCrossers]
        const newPassers = candidates.filter((c) => {
          if (enrichedById.has(c.id)) return false
          return !evaluateComparable(property, c, tierFilters, []).shouldDisable
        })
        if (newPassers.length > 0) {
          const enriched = await propertyApi.enrichComparables(newPassers, { concurrency: 10 })
          for (const e of enriched) enrichedById.set(e.id, e)
          candidatesEnriched += enriched.filter((c) => c.isEnriched).length
        }
        const enrichedSoFar = [...geoPassers, ...flexCrossers].filter((c) => enrichedById.has(c.id))
        if (enrichedSoFar.some((c) => arvEvidence(c, property.avmValue) != null)) break
        if (enrichedSoFar.length >= geoPassers.length + flexCrossers.length) break
      }
      retrieval.paramFlex = {
        extensions: paramFlexExtensions,
        factor: paramFlexFactor,
        concessions: describeFlexConcessions(filters, paramFlexFactor),
      }
      if (enrichedById.size === 0) { flagUnverified(comps); return comps }
      const merged = comps.map((c) => enrichedById.get(c.id) ?? c)
      flagUnverified(merged)
      return merged
    }
    if (isAttomMcp) {
      enrichedComps = await gateAndEnrich(rawComps)
      retrieval.candidatesEnriched = candidatesEnriched
      console.log(`[AnalysisJobDO] attom-mcp census gate: ${enrichedComps.filter((c) => c.isEnriched).length}/${rawComps.length} comps share the subject's tract/BG — enriched those only`)
    }

    // ── Expansion refetch ─────────────────────────────────────────────────────
    // The pool fetched at radius R provably contains zero candidates beyond R.
    // When the appraisal ladder reaches a radius-bound tier (subdivision 2x,
    // geographic, or pool exhaustion), do ONE wider provider request, merge
    // pools (conflict-aware), and enrich only new provably-live candidates.
    // evidenceLimitations is referenced by the bundle built below — pushes
    // here land in the audit trail even though they run inside evaluation.
    const evidenceLimitations: string[] = []
    let refetchUsed = false
    const expandComparablesPool = async (radiusMiles: number, monthsBack?: number): Promise<NormalizedComparable[] | null> => {
      if (refetchUsed) return null
      refetchUsed = true
      console.log(`[AnalysisJobDO] Expansion refetch: widening comparable search to ${radiusMiles}mi${monthsBack != null ? ` / ${monthsBack}mo` : ''}`)
      await this.pushEvent('property_fetch', { message: `Widening comp search to ${radiusMiles} miles${monthsBack != null ? `, ${monthsBack} months back` : ''}...` })
      const wider = await propertyApi.getComparables({
        ...comparablesParams,
        radiusMiles,
        ...(monthsBack != null ? { monthsBack } : {}),
      })
      if (!wider.success) {
        console.warn(`[AnalysisJobDO] Expansion refetch failed: ${wider.error}`)
        return null
      }
      // Merge against the CURRENT pool (enrichedComps), not rawComps — the
      // attom-mcp census gate has already enriched passers; merging from
      // rawComps would clobber the enriched records.
      const merged = mergeComparablePools(enrichedComps, wider.data.comparables)
      if (isAttomMcp) {
        // mergeComparablePools prefers the expanded pool's copy of a duped
        // comp — which is the unenriched variant. Overlay the enrichment
        // fields the gate paid for onto the winner.
        const ENRICHED_KEYS = [
          'subdivision', 'neighborhoodName', 'neighborhoodCode', 'censusTract',
          'censusBlockGroup', 'sameBlockGroup', 'crossesMajorRoad',
          'buildingCondition', 'buildingGrade', 'stories', 'construction',
          'transaction', 'features', 'flip', 'distressedSale', 'isEnriched',
          'latestSale', 'ppsfMedians', 'avmValue',
        ] as const
        const enrichedById = new Map(
          enrichedComps.filter((c) => c.isEnriched).map((c) => [c.id, c]),
        )
        // Geo stamps ride every gated comp, enriched or not — the merge
        // prefers the expanded pool's clean copy, which would otherwise
        // erase censusTract/sameBlockGroup/crossesMajorRoad/geoScopes and
        // re-flag a verified comp as geographyUnverified.
        const GEO_KEYS = [
          'censusTract', 'censusBlockGroup', 'sameBlockGroup', 'crossesMajorRoad',
          'geoScopes', 'geographyUnverified',
        ] as const
        const gatedById = new Map(enrichedComps.map((c) => [c.id, c]))
        merged.comparables = merged.comparables.map((c) => {
          const prior = enrichedById.get(c.id)
          const gated = gatedById.get(c.id)
          if ((!prior || c.isEnriched) && !gated) return c
          const out = { ...c } as unknown as Record<string, unknown>
          if (gated) {
            const gsrc = gated as unknown as Record<string, unknown>
            for (const k of GEO_KEYS) {
              if (out[k] == null && gsrc[k] != null) out[k] = gsrc[k]
            }
          }
          if (!prior || c.isEnriched) return out as unknown as NormalizedComparable
          const src = prior as unknown as Record<string, unknown>
          for (const k of ENRICHED_KEYS) {
            if (out[k] == null && src[k] != null) {
              out[k] = src[k]
            }
          }
          // The widened winner can hold the flip's stale acquisition leg —
          // re-apply the sales-history price correction on the merged comp.
          const ls = src.latestSale as { price: number; date: string } | null | undefined
          if (ls && (!out.saleDate || ls.date > (out.saleDate as string))) {
            out.salePrice = ls.price
            out.saleDate = ls.date
            out.pricePerSqft = out.squareFeet ? Math.round(ls.price / (out.squareFeet as number)) : out.pricePerSqft
          }
          return out as unknown as NormalizedComparable
        })
      }
      for (const id of merged.conflictIds) {
        pools.conflictIds.push(id)
        evidenceLimitations.push(`${id}: Provider comparable pools disagree on the same sale date; price is quarantined from evaluation`)
      }
      // New candidates join the raw pool — enrichment is deferred to the
      // census gate for attom-mcp, same as the initial pool.
      // attom-mcp: same census gate + gated enrichment as the initial pool.
      let newCandidates = merged.comparables.filter((c) => !poolCompIds.has(c.id))
      for (const c of newCandidates) poolCompIds.add(c.id)
      candidatesPruned += newCandidates.filter((c) => isDeadComp(c)).length
      if (isAttomMcp) {
        newCandidates = await gateAndEnrich(newCandidates)
        retrieval.candidatesEnriched = candidatesEnriched
      }
      const newById = new Map(newCandidates.map((c) => [c.id, c]))
      enrichedComps = merged.comparables.map((c) => newById.get(c.id) ?? c)
      retrieval.providerCallsUsed += 1
      retrieval.pagesRequested += 1
      if (monthsBack != null) retrieval.monthsBack = monthsBack
      retrieval.providerCandidatesReceived = enrichedComps.length
      retrieval.candidatesPrunedBeforeEnrichment = candidatesPruned
      retrieval.candidatesEnriched = candidatesEnriched
      retrieval.providerTruncated =
        (wider.data.retrieval?.providerTruncated ?? wider.data.comparables.length >= candidateLimit) || retrieval.providerTruncated
      console.log(`[AnalysisJobDO] Expansion refetch: pool ${rawComps.length} → ${enrichedComps.length} candidates`)
      return enrichedComps
    }

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
        neighborhood: property.neighborhoodName,
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
    // Subject AVM (Cotality THV) — parcel-level; attaches to enrichment and
    // mirrors onto the property so report serialization can surface it.
    const avmData = avmResult && 'success' in avmResult && avmResult.success ? avmResult.data : null
    if (avmData) {
      property.avmValue = avmData.value
      property.avmConfidence = avmData.confidence
    }
    // Building detail supplement — fills condition/style/foundation when the
    // coded property-detail block lacks them (literal-text provider data)
    const buildingDetail = buildingDetailResult && 'success' in buildingDetailResult && buildingDetailResult.success ? buildingDetailResult.data : null
    if (buildingDetail) {
      property.buildingCondition ??= buildingDetail.condition
      property.stories ??= buildingDetail.stories
      property.yearBuilt ??= buildingDetail.yearBuilt
      property.construction = {
        ...(property.construction ?? {}),
        buildingStyle: property.construction?.buildingStyle ?? buildingDetail.buildingStyle ?? undefined,
        foundationType: property.construction?.foundationType ?? buildingDetail.foundation ?? undefined,
        type: property.construction?.type ?? buildingDetail.constructionType ?? undefined,
        exteriorWalls: property.construction?.exteriorWalls ?? buildingDetail.exteriorWalls ?? undefined,
        roofCover: property.construction?.roofCover ?? buildingDetail.roofCover ?? undefined,
      }
      property.features = {
        ...(property.features ?? {}),
        heating: property.features?.heating ?? buildingDetail.heating ?? undefined,
        cooling: property.features?.cooling ?? buildingDetail.cooling ?? undefined,
        poolType: property.features?.poolType ?? buildingDetail.pool ?? undefined,
        garageType: property.features?.garageType ??
          (buildingDetail.parkingType && !/carport/i.test(buildingDetail.parkingType)
            ? buildingDetail.parkingType
            : undefined),
        garageSquareFeet: property.features?.garageSquareFeet ?? buildingDetail.garageSquareFeet ?? undefined,
        carportType: property.features?.carportType ??
          (buildingDetail.parkingType && /carport/i.test(buildingDetail.parkingType)
            ? buildingDetail.parkingType
            : undefined),
      }
    }
    for (const id of pools.conflictIds) evidenceLimitations.push(`${id}: Provider comparable pools disagree on the same sale date; price is quarantined from evaluation`)
    if (!permitsData) evidenceLimitations.push(config.enrichment?.permits === false
      ? 'Subject permits were not pulled during analysis — pull them on demand from the report'
      : 'Subject permit lookup failed or is unavailable; this does not mean no permits exist')
    if (!floodData) evidenceLimitations.push(config.enrichment?.floodZone !== true
      ? 'Subject flood zone was not pulled from the provider; a listing-derived flood signal may still apply'
      : 'Subject flood-zone evidence is unavailable; this does not mean the property is outside a flood zone')
    if (retrieval.providerTruncated) evidenceLimitations.push(
      `Provider returned the maximum requested comparables (${retrieval.candidateLimitEffective}); additional qualifying sales may exist beyond the candidate limit`)

    const bundle: import('../services/property-api/types').PropertyBundle = {
      property,
      comparables: enrichedComps,
      metadata: {
        fetchedAt: new Date().toISOString(),
        provider: property.provider,
        searchParams: config.search as import('../services/property-api/types').PropertySearchParams,
        comparablesParams: { ...comparablesParams },
        enrichmentOptions: { permits: config.enrichment?.permits !== false, floodZone: config.enrichment?.floodZone === true, weatherRisk: false },
        retrieval,
      },
      enrichment: {
        evidenceLimitations,
        permits,
        floodZone: floodData ?? null,
        avm: avmData ?? null,
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
      // attom-mcp: when the flex ladder stretched numeric tolerances to
      // admit evidence, evaluate the pool under the winning tier — comps
      // admitted by flex must stay enabled through evaluation.
      ...(isAttomMcp && paramFlexFactor > 1
        ? {
            appraisalRules: {
              ...(config.evalParams.appraisalRules ?? {}),
              filters: flexNumericFilters(filters, paramFlexFactor),
            },
          }
        : {}),
      apiCallStats: {
        corelogic: { total: propertyCallStats.total, cached: propertyCallStats.cached, endpoints: propertyCallStats.endpoints },
        totalExternalCalls: propertyCallStats.total,
      },
      // Radius-bound expansion tiers refetch instead of pretending the
      // fetched-radius pool contains candidates it never had.
      expandComparablesPool,
      // B retry attempt 3 — per-comp valuation/tax-history fetch for pool
      // members lacking AVM/land evidence.
      enrichComparables: (comps: NormalizedComparable[]) => propertyApi.enrichComparables(comps, { concurrency: 8 }).catch(() => null),
      // Sqft-conflict permit verification — ATTOM permits dataset per comp.
      getCompPermits: (compId: string) =>
        propertyApi.getBuildingPermits(compId)
          .then((r) => (r.success ? r.data.permits : null))
          .catch(() => null),
      // attom-mcp comp enrichment happens in the census gate above —
      // passers only, 1 provider call each.
      prefetchedPhotoBundle,
      skipCache: !!config.skipCache,
      // Clef comp-evidence resolves fire-and-forget — the callback patches
      // comp curb-appeal stamps into the persisted report whenever it lands.
      onCurbAppeal: (map: import('../services/evaluation').CompCurbAppealMap) => {
        this.curbAppealMap = map
        if (this.curbAppealResult) {
          void this.applyCurbAppealWriteback(config).catch((e) =>
            console.warn('[AnalysisJobDO] curb-appeal writeback failed:', e))
        }
      },
    }

    let evalResult
    try {
      evalResult = await performAnalysis({ jobId: config.jobId, bundle, ...evalParams, userId: config.userId, leadId: config.leadId }, this.env,
        (message, data) => { void this.pushEvent('eval_progress', { message, ...data }) })
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
      await this.cacheVerdict(config, code, msg)
      await this.recordRun(config, { status: 'error', durationMs: Date.now() - startTime, errorCode: code ?? 'EVALUATION_ERROR', errorMessage: msg, compCount: bundle.comparables?.length })
      await this.pushEvent('enrichment_done', { totalDurationMs: Date.now() - startTime })
      return
    }

    let analysisResult = evalResult.response as unknown as Record<string, unknown>

    // Stamp the CRM link onto the persisted response — the report's
    // Update CRM action resolves the lead from full_response_json.
    if (config.leadId) analysisResult.leadId = config.leadId
    if (config.opportunityId) analysisResult.opportunityId = config.opportunityId

    // Rule-based comp selection stays intact — AI will override later if enabled

    console.log(`[AnalysisJobDO] ✓ Evaluation complete in ${Date.now() - evalStart}ms`)

    // OSM location risks now fetched during enrichment — they're already in
    // the response via bundle.enrichment.locationRisks (and feed valuation)

    // Save/update report in DB — the immutable run evidence lands first so
    // an overwrite can never erase what this run was computed from.
    let completedRunRecordId: string | undefined
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
        ...bMetricsFromValuation(val),
      }

      completedRunRecordId = await this.saveRunRecord(config, {
        status: 'completed',
        evidence: evalResult.runEvidence,
        attempts: evalResult.runEvidence.attempts,
        response: analysisResult,
      })

      await upsertPropertyReport(db, {
        userId: config.userId,
        jobId: config.jobId,
        propertyAddress: (subj.address as string) || '',
        propertyCity: property.city || '',
        propertyState: property.state || '',
        propertyZip: property.zipCode || '',
        propertyClip: property.id || null,
      }, reportData)
      await linkRunRecordToReport(db.$client, completedRunRecordId, config.jobId, config.userId)

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

    // Clef writeback — if the batch resolved mid-eval (after the response
    // serialized without stamps), patch the saved report now. If it lands
    // later, onCurbAppeal calls the same helper.
    this.curbAppealResult = analysisResult
    if (this.curbAppealMap) {
      await this.applyCurbAppealWriteback(config).catch((e) =>
        console.warn('[AnalysisJobDO] curb-appeal writeback failed:', e))
    }

    // Private image access checks the saved report owner before serving any bytes.
    await this.pushEvent('evaluation_complete', { updatedResult: analysisResult })
    await this.recordRun(config, { status: 'completed', durationMs: Date.now() - startTime, response: analysisResult, runRecordId: completedRunRecordId })

    // LLM comp annotation removed — evidence classification drives the eval;
    // the separate annotate pass only wrote prose onto cards.

    // Wait for parallel tasks before closing SSE (so client receives them)
    await marketContextPromise
    await this.pushEvent('enrichment_done', { totalDurationMs: Date.now() - startTime })
    console.log(`[AnalysisJobDO] ── Streaming analysis complete in ${Date.now() - startTime}ms ──`)
  }

  /** Clef comp curb-appeal writeback — the comp-evidence batch resolves
   *  fire-and-forget during/after evaluation. When the map and the persisted
   *  result are both present this stamps missing curbAppeal fields onto
   *  comps.items, re-saves the report, and emits an SSE event so live
   *  clients can merge the stamps without a refresh. Idempotent. */
  private async applyCurbAppealWriteback(config: StartStreamingRequest): Promise<void> {
    const map = this.curbAppealMap
    const result = this.curbAppealResult
    if (!map || !result) return
    const items = (result.comps as { items?: Array<{ id?: string; curbAppeal?: unknown }> } | undefined)?.items
    let stamped = 0
    if (Array.isArray(items)) {
      for (const item of items) {
        if (item?.id && !item.curbAppeal && map[item.id]) {
          item.curbAppeal = map[item.id]
          stamped++
        }
      }
    }
    await this.pushEvent('curb_appeal', { compCurbAppeal: map })
    if (stamped === 0) return // response already carried the stamps
    try {
      const db = drizzle(this.env.DB)
      const val = result.valuation as Record<string, unknown> | null
      const subj = result.subject as Record<string, unknown>
      await upsertPropertyReport(db, {
        userId: config.userId,
        jobId: config.jobId,
        propertyAddress: (subj.address as string) || '',
        propertyCity: (subj.city as string) || '',
        propertyState: (subj.state as string) || '',
        propertyZip: (subj.zipCode as string) || '',
        propertyClip: (subj.id as string) || null,
      }, {
        fullResponseJson: JSON.stringify(result),
        arv: (val?.arv as number) ?? null,
        asIsValue: (val?.asIsValue as number) ?? null,
        maxAllowableOffer: (val?.buyPrice as number) ?? null,
        estimatedRepairs: (val?.rehabCost as number) ?? null,
        ...bMetricsFromValuation(val),
      })
    } catch (e) {
      console.warn('[AnalysisJobDO] curb-appeal re-save failed:', e instanceof Error ? e.message : e)
    }
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
    await this.persistence.write(this.jobState)
    await this.state.storage.setAlarm(Date.now() + AnalysisJobDO.WATCHDOG_MS)

    // Run enrichment inside the DO under waitUntil — without it the DO can
    // be evicted mid-run once this fetch returns (see handleStartStreaming).
    this.runActive = true
    this.state.waitUntil(
      this.runEnrichment(body)
        .catch((err) => {
          console.error('[AnalysisJobDO] Enrichment fatal error:', err)
          this.pushEvent('error', { step: 'fatal', message: err instanceof Error ? err.message : 'Unknown error' })
          this.pushEvent('enrichment_done', { totalDurationMs: Date.now() - (this.jobState?.createdAt ?? Date.now()) })
        })
        .finally(() => {
          this.runActive = false
        })
    )

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
          leadId: config.leadId,
          skipCache: !!config.skipCache,
        }, this.env,
          (message, data) => { void this.pushEvent('eval_progress', { message, ...data }) })

        const updatedResponse = evalResult.response as unknown as Record<string, unknown>

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
          const runRecordId = await this.saveRunRecord({
            jobId: config.jobId,
            userId: config.userId,
            evalParams: config.evalParams,
            skipCache: !!config.skipCache,
          }, {
            status: 'completed',
            evidence: evalResult.runEvidence,
            attempts: evalResult.runEvidence.attempts,
            response: updatedResponse,
          })
          await upsertPropertyReport(db, {
            userId: config.userId,
            jobId: config.jobId,
            propertyAddress: (subject.address as string) || '',
            propertyCity: (config.bundle.property.city) || '',
            propertyState: (config.bundle.property.state) || '',
            propertyZip: (config.bundle.property.zipCode) || '',
            propertyClip: config.bundle.property.id || null,
          }, {
            fullResponseJson: JSON.stringify(updatedResponse),
            arv: (valuation?.arv as number) ?? null,
            asIsValue: (valuation?.asIsValue as number) ?? null,
            maxAllowableOffer: (valuation?.buyPrice as number) ?? null,
            estimatedRepairs: (valuation?.rehabCost as number) ?? null,
            ...bMetricsFromValuation(valuation),
          })
          await linkRunRecordToReport(db.$client, runRecordId, config.jobId, config.userId)
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

    // LLM comp annotation removed — evidence classification drives the eval.

    // Wait for OSM risk flags if still running
    await osmPromise
    const totalMs = Date.now() - startTime
    await this.pushEvent('enrichment_done', { totalDurationMs: totalMs })
    console.log(`[AnalysisJobDO] ── Enrichment complete in ${(totalMs / 1000).toFixed(1)}s ──`)
  }

  // ─── Event Management ─────────────────────────────────────────────────────

  // ─── Observability: record every run outcome (success AND failure) ────────

  private async saveRunRecord(
    config: Pick<StartStreamingRequest, 'jobId' | 'userId'> & Partial<StartStreamingRequest>,
    input: {
      status: 'completed' | 'error' | 'cached' | 'persistence_error'
      evidence?: unknown
      attempts?: unknown[]
      response?: unknown
      errorCode?: string | null
      errorMessage?: string | null
      cachedJobId?: string | null
    },
  ): Promise<string> {
    const payload = buildRunRecordPayload({
      jobId: config.jobId,
      userId: config.userId,
      status: input.status,
      request: {
        search: config.search,
        searchOptions: config.searchOptions,
        enrichment: config.enrichment,
        evalParams: config.evalParams,
        skipCache: !!config.skipCache,
        isRefresh: !!config.isRefresh,
        cachedJobId: input.cachedJobId ?? null,
      },
      evidence: input.evidence,
      attempts: input.attempts,
      response: input.response,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
    })
    const saved = await insertRunRecord(this.env.DB, payload, this.env.REPORT_ASSETS)
    return saved.id
  }

  /**
   * Persist a terminal verdict (insufficient comps / property not found) under
   * the eval-result key so retries of the same address+params replay the error
   * instead of re-spending provider calls. 24h TTL — provider data can change.
   */
  private async cacheVerdict(config: StartStreamingRequest, code: string | undefined, message: string): Promise<void> {
    if (!config.evalResultCacheKey || !isCacheableVerdict(code)) return
    await this.env.API_CACHE?.put(config.evalResultCacheKey, encodeVerdict(code!, message), {
      expirationTtl: EVAL_ERROR_TTL_SECONDS,
    }).catch(() => { /* best-effort */ })
  }

  private async recordRun(
    config: StartStreamingRequest,
    outcome: {
      status: 'completed' | 'error'
      durationMs: number
      response?: Record<string, unknown> | null
      errorCode?: string
      errorMessage?: string
      compCount?: number
      cachedJobId?: string
      runRecordId?: string
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

      // Every terminal outcome gets an immutable record. Full evaluations are
      // saved before report overwrite above; cached/error outcomes record the
      // terminal response/verdict here.
      await (outcome.runRecordId
        ? Promise.resolve(outcome.runRecordId)
        : this.saveRunRecord(config, {
          status: outcome.cachedJobId ? 'cached' : outcome.status,
          response: outcome.response,
          errorCode: outcome.errorCode,
          errorMessage: outcome.errorMessage,
          cachedJobId: outcome.cachedJobId ?? null,
        }).catch((err) => {
          console.warn('[AnalysisJobDO] run record fallback failed:', err instanceof Error ? err.message : err)
          return undefined
        }))

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

      // Basin lake — land every analysis outcome as an Iceberg row for the
      // calibration/fine-tune corpus. Non-fatal: a stream failure must never
      // touch the analysis path.
      const stream = this.env.FLOWSTATE_ANALYSIS_EVENTS_STREAM
      if (stream) {
        const compItems = Array.isArray(comps?.items) ? comps.items : []
        const curbAppeals = compItems
          .filter((c) => (c as Record<string, unknown>).curbAppeal)
          .map((c) => {
            const cc = c as Record<string, unknown>
            const ca = cc.curbAppeal as Record<string, unknown>
            return {
              compId: cc.id,
              condition: ca.condition,
              confidence: ca.confidence,
              summary: ca.summary,
              photosExamined: ca.photosExamined,
            }
          })
        try {
          await stream.send([
            {
              ts: new Date().toISOString(),
              job_id: config.jobId,
              address: (subj?.address as string) ?? config.search.address ?? '',
              provider: (resp?.retrieval as Record<string, unknown> | null)?.provider ?? 'corelogic',
              status: outcome.status,
              arv: (val?.arv as number) ?? null,
              enabled_comps: (comps?.enabledCount as number) ?? null,
              comp_conditions: curbAppeals.length > 0 ? curbAppeals : null,
              payload: {
                errorCode: outcome.errorCode ?? null,
                errorMessage: outcome.errorMessage ?? null,
                compCount: outcome.compCount ?? (comps?.total as number) ?? null,
                durationMs: outcome.durationMs,
                fallbacks: report?.fallbacksUsed ?? [],
                steps: report?.steps ?? null,
              },
            },
          ])
        } catch (err) {
          console.warn('[AnalysisJobDO] basin stream send failed (non-fatal):', err instanceof Error ? err.message : err)
        }
      }
    } catch (err) {
      console.warn('[AnalysisJobDO] recordRun failed (non-fatal):', err instanceof Error ? err.message : err)
    }

    // Terminal state → tell the engine so underwriting→Give Offer moves
    // in the same tick. The worker pulls the result by jobId; unknown
    // (dashboard-run) jobIds 404, which is fine. Fire-and-forget.
    this.state.waitUntil(
      notifyEvalComplete(this.env, config.jobId).catch(() => { /* best-effort */ }),
    )
  }

  private async pushEvent(event: string, data: unknown): Promise<void> {
    if (!this.jobState) return

    this.jobState.events.push({ event, data, timestamp: Date.now() })

    if (event === 'enrichment_done') {
      this.jobState.status = 'complete'
    } else if (event === 'error') {
      this.jobState.error = (data as { message?: string })?.message
    }

    await this.persistence.write(this.jobState)
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
      this.jobState = await this.persistence.read()
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    this.sseClients.add(writer)

    // Initial writes are queued, never awaited: a TransformStream write cannot
    // settle until the readable is consumed, and the client cannot consume
    // until this Response is returned — awaiting here deadlocks the connect.
    const initialWrites: Promise<void>[] = [
      // Connection marker — the old worker-side poll loop emitted this; the
      // dashboard hook listens for it.
      writer.write(this.encoder.encode(`event: connected\ndata: ${JSON.stringify({ jobId: this.jobState?.jobId })}\n\n`)),
    ]

    // Replay buffered events for late-joining clients
    if (this.jobState?.events.length) {
      for (const evt of this.jobState.events) {
        initialWrites.push(writer.write(this.encoder.encode(`event: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`)))
      }
    }

    // If already complete, emit the terminal event after replay, then close
    // once the queued writes settle (waitUntil keeps the DO alive for it).
    const terminal = this.jobState?.status === 'complete' || this.jobState?.status === 'error'
    if (terminal) {
      initialWrites.push(writer.write(this.encoder.encode(`event: enrichment_done\ndata: ${JSON.stringify({ replayed: true })}\n\n`)))
    } else {
      request.signal?.addEventListener('abort', () => {
        this.sseClients.delete(writer)
        writer.close().catch(() => {})
      })
    }
    this.state.waitUntil(
      Promise.all(initialWrites)
        .then(async () => {
          if (terminal) {
            await writer.close()
            this.sseClients.delete(writer)
          }
        })
        .catch(() => {
          this.sseClients.delete(writer)
          return writer.abort().catch(() => {})
        }),
    )

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
