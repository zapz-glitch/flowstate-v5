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
import { performAnalysis, type EvaluationParams } from '../services/evaluation'
import { createPhotoService } from '../services/photo-provider'
import type { PropertyIdentifier, PropertyPhotos } from '../services/photo-provider'
import type { Env } from '../types'
import type { NormalizedProperty, NormalizedComparable } from '../services/property-api/types'

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  analysisResult: Record<string, any>
  llmOptions?: { includePhotos?: boolean }
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

  // ─── Start Enrichment ─────────────────────────────────────────────────────

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

    // Brief delay to let SSE clients connect before broadcasting
    await new Promise((r) => setTimeout(r, 1000))
    console.log(`[AnalysisJobDO] ── Enrichment started (pending: ${config.pending.join(', ')}) ──`)

    // Step A: Market data enrichment
    if (config.pending.includes('market_data')) {
      const stepStart = Date.now()
      try {
        await this.pushEvent('market_data_started', { message: 'Fetching market data...' })
        const photoService = createPhotoService(this.env)
        if (photoService.isAvailable()) {
          const properties: PropertyIdentifier[] = [
            { propertyId: config.bundle.property.id, address: config.bundle.property.address, city: config.bundle.property.city, state: config.bundle.property.state, zipCode: config.bundle.property.zipCode },
            ...config.bundle.comparables.map((comp) => ({
              propertyId: comp.id, address: comp.address, city: comp.city, state: comp.state, zipCode: comp.zipCode,
            })),
          ]
          const bulkResult = await photoService.fetchBulkPhotos(properties)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const enrichedData: Record<string, Record<string, any>> = {}
          for (const [propId, data] of bulkResult.results) {
            enrichedData[propId] = {
              photos: data.photos,
              description: data.description,
              features: data.features,
              sourceUrl: data.sourceUrl,
              status: data.status,
              // Property details from public listing
              bedrooms: data.bedrooms,
              bathrooms: data.bathrooms,
              squareFeet: data.squareFeet,
              yearBuilt: data.yearBuilt,
              foundationType: data.foundationType,
              style: data.style,
              stories: data.stories,
              hoaFee: data.hoaFee,
              lastSaleDate: data.lastSaleDate,
              lastSalePrice: data.lastSalePrice,
              // Construction & features
              roof: data.roof,
              construction: data.construction,
              heating: data.heating,
              cooling: data.cooling,
              flooring: data.flooring,
              parking: data.parking,
              pool: data.pool,
              propertyType: data.propertyType,
              whatsSpecial: data.whatsSpecial,
              exteriorFeatures: data.exteriorFeatures,
              appliances: data.appliances,
            }
            console.log(`[AnalysisJobDO] Market data for ${data.sourceUrl || propId}:`)
            console.log(`  Property: beds=${data.bedrooms || '-'} baths=${data.bathrooms || '-'} sqft=${data.squareFeet || '-'} year=${data.yearBuilt || '-'} type=${data.propertyType || '-'}`)
            console.log(`  Construction: foundation=${data.foundationType || '-'} roof=${data.roof || '-'} construction=${data.construction || '-'} style=${data.style || '-'} stories=${data.stories || '-'}`)
            console.log(`  Systems: heating=${data.heating || '-'} cooling=${data.cooling || '-'}`)
            console.log(`  Features: flooring=${data.flooring || '-'} parking=${data.parking || '-'} pool=${data.pool || '-'}`)
            console.log(`  Media: photos=${data.photos?.length || 0} description=${data.description ? 'yes' : 'no'} whatsSpecial=${data.whatsSpecial?.length || 0} items`)
            console.log(`  Sale: price=$${data.lastSalePrice?.toLocaleString() || '-'} date=${data.lastSaleDate || '-'} status=${data.status || '-'} hoa=$${data.hoaFee || 0}/mo`)
          }
          console.log(`[AnalysisJobDO] ✓ Market data: ${bulkResult.results.size}/${properties.length} scraped in ${Date.now() - stepStart}ms`)

          // ── Merge enriched data into bundle and re-evaluate ──
          const reEvalStart = Date.now()
          console.log(`[AnalysisJobDO] Re-evaluating with enriched data...`)

          // Merge into subject property
          const subjectData = enrichedData[config.bundle.property.id]
          if (subjectData) {
            this.mergeMarketDataIntoProperty(config.bundle.property, subjectData)
          }

          // Merge into comparables
          for (const comp of config.bundle.comparables) {
            const compData = enrichedData[comp.id]
            if (compData) {
              this.mergeMarketDataIntoComparable(comp, compData)
            }
          }

          // Re-run evaluation with enriched data
          const reEvalResult = performAnalysis({
            jobId: config.jobId,
            bundle: config.bundle,
            ...config.evalParams,
          })

          // Inject photos from Zillow into the re-evaluated result
          const updatedResponse = reEvalResult.response as unknown as Record<string, unknown>
          // Subject photos
          const subjectEnriched = enrichedData[config.bundle.property.id]
          if (subjectEnriched?.photos?.length && updatedResponse.subject) {
            (updatedResponse.subject as Record<string, unknown>).photos = subjectEnriched.photos.slice(0, 10)
          }
          // Comp photos
          if (updatedResponse.comps && (updatedResponse.comps as Record<string, unknown>).items) {
            const items = (updatedResponse.comps as Record<string, unknown>).items as Array<Record<string, unknown>>
            for (const comp of items) {
              const compEnriched = enrichedData[comp.id as string]
              if (compEnriched?.photos?.length) {
                comp.photos = compEnriched.photos.slice(0, 5)
              }
            }
          }

          // Update analysisResult for LLM step
          config.analysisResult = updatedResponse

          console.log(`[AnalysisJobDO] ✓ Re-evaluation complete in ${Date.now() - reEvalStart}ms`)
          console.log(`[AnalysisJobDO] Photos injected: subject=${subjectEnriched?.photos?.length ?? 0}, comps=${Object.values(enrichedData).filter((d: Record<string, unknown>) => (d.photos as string[])?.length > 0).length}`)

          await this.pushEvent('market_data_complete', {
            enrichedData,
            summary: bulkResult.summary,
            updatedResult: updatedResponse,
          })
        } else {
          await this.pushEvent('market_data_complete', { enrichedData: {}, skipped: true, reason: 'Firecrawl not configured' })
        }
      } catch (error) {
        console.warn('[AnalysisJobDO] Market data error:', error instanceof Error ? error.message : error)
        await this.pushEvent('error', { step: 'market_data', message: error instanceof Error ? error.message : 'Market data enrichment failed' })
      }
    }

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

        const llmResult = await analyzeComps(
          config.bundle.property, config.bundle.comparables, evalContexts,
          this.env, { includePhotos: config.llmOptions?.includePhotos },
        )

        if (llmResult && llmResult.selectedForArv.length > 0) {
          console.log(`[AnalysisJobDO] LLM selected ${llmResult.selectedForArv.length} comps for ARV: ${llmResult.selectedForArv.join(', ')}`)

          // Apply LLM's comp selection: update isEnabled on all comps
          const selectedSet = new Set(llmResult.selectedForArv)
          const currentResult = config.analysisResult
          if (currentResult.comps?.items && Array.isArray(currentResult.comps.items)) {
            currentResult.comps.items = currentResult.comps.items.map((comp: Record<string, unknown>) => {
              const compId = comp.id as string
              const ranking = llmResult.rankings.find((r) => r.compId === compId)
              const isSelected = selectedSet.has(compId)
              return {
                ...comp,
                isEnabled: isSelected,
                compGroup: isSelected ? 'arv' : (comp.compGroup === 'as_is' ? 'as_is' : null),
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

    const totalMs = Date.now() - startTime
    await this.pushEvent('enrichment_done', { totalDurationMs: totalMs })
    console.log(`[AnalysisJobDO] ── Enrichment complete in ${(totalMs / 1000).toFixed(1)}s ──`)
  }

  // ─── Event Management ─────────────────────────────────────────────────────

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
  private mergeMarketDataIntoProperty(property: NormalizedProperty, data: Record<string, any>): void {
    // Construction details
    if (!property.construction) property.construction = {}
    if (!property.construction.foundationType && data.foundationType) {
      property.construction.foundationType = data.foundationType
    }
    if (!property.construction.buildingStyle && data.style) {
      property.construction.buildingStyle = data.style
    }
    if (!property.construction.roofType && data.roof) {
      property.construction.roofType = data.roof
    }
    if (!property.construction.exteriorWalls && data.construction) {
      property.construction.exteriorWalls = data.construction
    }

    // Features
    if (!property.features) property.features = {}
    if (!property.features.heating && data.heating) {
      property.features.heating = data.heating
    }
    if (!property.features.cooling && data.cooling) {
      property.features.cooling = data.cooling
    }
    if (!property.features.poolType && data.pool) {
      property.features.poolType = String(data.pool)
    }

    // Basic details (only if missing from CoreLogic)
    if (!property.stories && data.stories) property.stories = data.stories
    if (!property.hoaFee && data.hoaFee) property.hoaFee = data.hoaFee
  }

  /**
   * Merge market data into a comparable, filling in missing fields.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private mergeMarketDataIntoComparable(comp: NormalizedComparable, data: Record<string, any>): void {
    if (!comp.construction) comp.construction = {}
    if (!comp.construction.foundationType && data.foundationType) {
      comp.construction.foundationType = data.foundationType
    }
    if (!comp.construction.buildingStyle && data.style) {
      comp.construction.buildingStyle = data.style
    }
    if (!comp.construction.roofType && data.roof) {
      comp.construction.roofType = data.roof
    }
    if (!comp.construction.exteriorWalls && data.construction) {
      comp.construction.exteriorWalls = data.construction
    }
  }

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
