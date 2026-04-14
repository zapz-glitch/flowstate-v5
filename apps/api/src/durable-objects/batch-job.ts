/**
 * Batch Job Durable Object
 *
 * Orchestrates sequential analysis of multiple addresses from CSV import.
 * Spawns one AnalysisJobDO per address, waits for completion, then moves to next.
 * Broadcasts SSE events for real-time progress tracking.
 *
 * Endpoints:
 *   POST /start    — Start batch processing
 *   GET  /sse      — SSE stream for progress
 *   GET  /state    — Current batch state
 */

import type { Env } from '../types'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { batchJobs } from '../db/schema'
import { loadUserAnalysisSettings } from '../services/user-settings'

interface BatchState {
  batchId: string
  userId: string
  status: 'idle' | 'processing' | 'completed' | 'failed'
  addresses: string[]
  results: BatchResult[]
  currentIndex: number
  totalAddresses: number
  completedCount: number
  failedCount: number
  createdAt: number
}

interface BatchResult {
  address: string
  index: number
  status: 'pending' | 'processing' | 'completed' | 'failed'
  jobId?: string
  error?: string
  arv?: number
  buyPrice?: number
  rehabCost?: number
  recommendation?: string
}

export interface StartBatchRequest {
  batchId: string
  userId: string
  addresses: string[]
  searchOptions?: {
    radiusMiles?: number
    maxComps?: number
    monthsBack?: number
  }
  skipCache?: boolean
}

export class BatchJobDO {
  private state: DurableObjectState
  private env: Env
  private sseClients: Set<WritableStreamDefaultWriter<Uint8Array>> = new Set()
  private encoder = new TextEncoder()
  private batchState: BatchState | null = null

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
    if (request.method === 'POST' && path === '/retry-failed') {
      return this.handleRetryFailed(request)
    }
    if (request.method === 'POST' && path === '/mark-completed') {
      return this.handleMarkCompleted()
    }
    if (request.method === 'GET' && path === '/sse') {
      return this.handleSSE(request)
    }
    if (request.method === 'GET' && path === '/state') {
      return this.handleGetState()
    }

    return new Response('Not found', { status: 404 })
  }

  // ─── Start Batch Processing ─────────────────────────────────────────────

  private async handleStart(request: Request): Promise<Response> {
    const body = await request.json() as StartBatchRequest

    this.batchState = {
      batchId: body.batchId,
      userId: body.userId,
      status: 'processing',
      addresses: body.addresses,
      results: body.addresses.map((address, i) => ({
        address,
        index: i,
        status: 'pending' as const,
      })),
      currentIndex: 0,
      totalAddresses: body.addresses.length,
      completedCount: 0,
      failedCount: 0,
      createdAt: Date.now(),
    }
    await this.state.storage.put('batchState', this.batchState)

    // Run processing in background
    this.processBatch(body).catch((err) => {
      console.error('[BatchJobDO] Fatal error:', err)
      this.pushEvent('batch_error', { message: err instanceof Error ? err.message : 'Unknown error' })
    })

    return new Response('OK', { status: 200 })
  }

  // ─── Mark Completed (for stuck batch recovery) ──────────────────────────

  private async handleMarkCompleted(): Promise<Response> {
    if (!this.batchState) {
      this.batchState = await this.state.storage.get<BatchState>('batchState') ?? null
    }
    if (this.batchState) {
      // Mark any pending/processing as failed
      this.batchState.results = this.batchState.results.map((r) => {
        if (r.status === 'pending' || r.status === 'processing') {
          this.batchState!.failedCount++
          return { ...r, status: 'failed' as const, error: r.error || 'Batch timed out' }
        }
        return r
      })
      this.batchState.status = 'completed'
      await this.state.storage.put('batchState', this.batchState)
      await this.pushEvent('batch_completed', {
        totalAddresses: this.batchState.totalAddresses,
        completedCount: this.batchState.completedCount,
        failedCount: this.batchState.failedCount,
        results: this.batchState.results,
      })
    }
    return new Response('OK', { status: 200 })
  }

  // ─── Retry Failed Addresses ─────────────────────────────────────────────

  private async handleRetryFailed(request: Request): Promise<Response> {
    const body = await request.json() as { userId: string }

    if (!this.batchState) {
      this.batchState = await this.state.storage.get<BatchState>('batchState') ?? null
    }
    if (!this.batchState) {
      return new Response('No batch state', { status: 400 })
    }

    const failedIndices = this.batchState.results
      .map((r, i) => r.status === 'failed' ? i : -1)
      .filter((i) => i >= 0)

    if (failedIndices.length === 0) {
      return new Response('No failed addresses', { status: 400 })
    }

    // Reset failed results to pending
    for (const i of failedIndices) {
      this.batchState.results[i] = { ...this.batchState.results[i], status: 'pending', error: undefined }
    }
    this.batchState.status = 'processing'
    this.batchState.failedCount = 0
    await this.state.storage.put('batchState', this.batchState)

    // Run retry in background
    this.retryFailed(body.userId, failedIndices).catch((err) => {
      console.error('[BatchJobDO] Retry fatal error:', err)
      this.pushEvent('batch_error', { message: err instanceof Error ? err.message : 'Retry failed' })
    })

    return new Response('OK', { status: 200 })
  }

  private async retryFailed(userId: string, indices: number[]): Promise<void> {
    if (!this.batchState) return

    let userSettings
    try {
      userSettings = await loadUserAnalysisSettings(this.env.DB, { userId })
    } catch {
      await this.pushEvent('batch_error', { message: 'Failed to load user settings' })
      return
    }

    const heartbeat = setInterval(() => {
      this.broadcast('heartbeat', { timestamp: Date.now() })
    }, 15000)

    for (const i of indices) {
      if (!this.batchState) break
      const address = this.batchState.addresses[i]

      this.batchState.currentIndex = i
      this.batchState.results[i].status = 'processing'
      await this.state.storage.put('batchState', this.batchState)
      await this.pushEvent('address_started', { index: i, total: this.batchState.totalAddresses, address })

      try {
        const config: StartBatchRequest = {
          batchId: this.batchState.batchId,
          userId,
          addresses: this.batchState.addresses,
        }
        const result = await this.processOneAddress(address, config, userSettings)
        this.batchState.results[i] = {
          ...this.batchState.results[i],
          status: 'completed',
          jobId: result.jobId,
          arv: result.arv,
          buyPrice: result.buyPrice,
          rehabCost: result.rehabCost,
          recommendation: result.recommendation,
          error: undefined,
        }
        this.batchState.completedCount++
        await this.pushEvent('address_completed', {
          index: i, total: this.batchState.totalAddresses, address,
          jobId: result.jobId, arv: result.arv, buyPrice: result.buyPrice, recommendation: result.recommendation,
        })
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Retry failed'
        this.batchState.results[i] = { ...this.batchState.results[i], status: 'failed', error: errorMsg }
        this.batchState.failedCount++
        await this.pushEvent('address_failed', { index: i, total: this.batchState.totalAddresses, address, error: errorMsg })
      }

      await this.state.storage.put('batchState', this.batchState)
      await this.updateDbProgress()

      if (i < indices[indices.length - 1]) {
        await new Promise((r) => setTimeout(r, 2000))
      }
    }

    clearInterval(heartbeat)

    if (this.batchState) {
      this.batchState.status = 'completed'
      await this.state.storage.put('batchState', this.batchState)
    }
    await this.updateDbStatus('completed')
    await this.pushEvent('batch_completed', {
      totalAddresses: this.batchState?.totalAddresses ?? 0,
      completedCount: this.batchState?.completedCount ?? 0,
      failedCount: this.batchState?.failedCount ?? 0,
      results: this.batchState?.results ?? [],
    })
  }

  // ─── Sequential Processing ──────────────────────────────────────────────

  private async processBatch(config: StartBatchRequest): Promise<void> {
    const startTime = Date.now()

    // Load user settings once for all addresses
    let userSettings
    try {
      userSettings = await loadUserAnalysisSettings(this.env.DB, { userId: config.userId })
    } catch (err) {
      await this.pushEvent('batch_error', { message: 'Failed to load user settings' })
      await this.updateDbStatus('failed')
      return
    }

    // Heartbeat keeps SSE connections alive through proxies/CDNs
    const heartbeat = setInterval(() => {
      this.broadcast('heartbeat', { timestamp: Date.now() })
    }, 15000)

    await this.pushEvent('batch_started', {
      totalAddresses: config.addresses.length,
      message: `Processing ${config.addresses.length} addresses...`,
    })

    for (let i = 0; i < config.addresses.length; i++) {
      const address = config.addresses[i]
      if (!this.batchState) break

      this.batchState.currentIndex = i
      this.batchState.results[i].status = 'processing'
      await this.state.storage.put('batchState', this.batchState)

      await this.pushEvent('address_started', {
        index: i,
        total: config.addresses.length,
        address,
      })

      try {
        const result = await this.processOneAddress(address, config, userSettings)

        this.batchState.results[i] = {
          ...this.batchState.results[i],
          status: 'completed',
          jobId: result.jobId,
          arv: result.arv,
          buyPrice: result.buyPrice,
          rehabCost: result.rehabCost,
          recommendation: result.recommendation,
        }
        this.batchState.completedCount++

        await this.pushEvent('address_completed', {
          index: i,
          total: config.addresses.length,
          address,
          jobId: result.jobId,
          arv: result.arv,
          buyPrice: result.buyPrice,
          recommendation: result.recommendation,
        })
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Analysis failed'
        this.batchState.results[i] = {
          ...this.batchState.results[i],
          status: 'failed',
          error: errorMsg,
        }
        this.batchState.failedCount++

        await this.pushEvent('address_failed', {
          index: i,
          total: config.addresses.length,
          address,
          error: errorMsg,
        })
      }

      await this.state.storage.put('batchState', this.batchState)
      await this.updateDbProgress()

      // Rate limit delay between addresses (2s)
      if (i < config.addresses.length - 1) {
        await new Promise((r) => setTimeout(r, 2000))
      }
    }

    // Clean up heartbeat
    clearInterval(heartbeat)

    // Mark complete
    if (this.batchState) {
      this.batchState.status = 'completed'
      await this.state.storage.put('batchState', this.batchState)
    }
    await this.updateDbStatus('completed')

    const totalMs = Date.now() - startTime
    await this.pushEvent('batch_completed', {
      totalAddresses: config.addresses.length,
      completedCount: this.batchState?.completedCount ?? 0,
      failedCount: this.batchState?.failedCount ?? 0,
      durationMs: totalMs,
      results: this.batchState?.results ?? [],
    })

    console.log(`[BatchJobDO] Batch complete: ${this.batchState?.completedCount}/${config.addresses.length} in ${(totalMs / 1000).toFixed(1)}s`)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async processOneAddress(address: string, config: StartBatchRequest, userSettings: any): Promise<{
    jobId: string
    arv?: number
    buyPrice?: number
    rehabCost?: number
    recommendation?: string
  }> {
    const jobId = `batch_${config.batchId}_${crypto.randomUUID().slice(0, 8)}`

    const doId = this.env.ANALYSIS_JOB.idFromName(jobId)
    const stub = this.env.ANALYSIS_JOB.get(doId)

    // Start the analysis in the sub-DO (no LLM)
    const appraisalRules = userSettings.appraisalRules ?? {}
    const startResp = await stub.fetch('http://internal/start-streaming', {
      method: 'POST',
      body: JSON.stringify({
        jobId,
        userId: config.userId,
        search: { address },
        searchOptions: config.searchOptions ?? { radiusMiles: 1, maxComps: 15, monthsBack: 12 },
        skipCache: config.skipCache ?? false,
        evalParams: {
          appraisalRules,
          buybox: userSettings.mergedBuybox,
          customRehabTable: userSettings.customRehabTable,
          customTierRanges: userSettings.customTierRanges,
          customMajorItemCosts: userSettings.customMajorItemCosts,
          arvThreshold: userSettings.arvThreshold,
          asIsThresholdPercent: userSettings.asIsThresholdPercent,
        },
        llmEnabled: false, // No AI for batch
        isRefresh: false,
      }),
    })
    await startResp.text()

    // Poll for completion (3 min timeout per address)
    const timeout = Date.now() + 180_000
    let lastStep = ''
    const index = this.batchState?.currentIndex ?? 0
    while (Date.now() < timeout) {
      await new Promise((r) => setTimeout(r, 2000))

      let state: { status: string; events?: Array<{ event: string; data: unknown }> }
      try {
        const stateResp = await stub.fetch('http://internal/state')
        state = await stateResp.json()
      } catch (err) {
        console.warn(`[BatchJobDO] Failed to poll child DO state for ${address}:`, err)
        continue // Retry on next poll cycle
      }

      // Broadcast sub-step progress to batch SSE clients
      if (state.events?.length) {
        const stepEvents = ['property_fetch', 'subject_found', 'comps_found', 'evaluation_started', 'evaluation_complete']
        const latestStep = state.events.findLast((e) => stepEvents.includes(e.event))
        if (latestStep && latestStep.event !== lastStep) {
          lastStep = latestStep.event
          const stepLabel = latestStep.event === 'property_fetch' ? 'Searching property...'
            : latestStep.event === 'subject_found' ? 'Property found'
            : latestStep.event === 'comps_found' ? 'Comps found'
            : latestStep.event === 'evaluation_started' ? 'Evaluating...'
            : latestStep.event === 'evaluation_complete' ? 'Evaluation complete'
            : latestStep.event
          await this.pushEvent('address_progress', { index, address, step: latestStep.event, stepLabel })
        }
      }

      if (state.status === 'complete' || state.status === 'error') {
        // Check for errors — AnalysisJobDO sets status to 'complete' even after errors
        // (because enrichment_done always fires), so check events for error indicators
        const errorEvent = state.events?.findLast((e) => e.event === 'error')
        const evalEvent = state.events?.findLast((e) => e.event === 'evaluation_complete')

        if (errorEvent && !evalEvent) {
          // Error occurred and no evaluation completed — this is a failure
          const errorMsg = (errorEvent.data as { message?: string })?.message || 'Analysis error'
          throw new Error(errorMsg)
        }

        if (!evalEvent) {
          throw new Error('Analysis completed but no evaluation data found')
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (evalEvent.data as any)?.updatedResult
        return {
          jobId,
          arv: result?.valuation?.arv,
          buyPrice: result?.valuation?.buyPrice,
          rehabCost: result?.valuation?.rehabCost,
          recommendation: result?.valuation?.recommendation,
        }
      }
    }

    throw new Error('Analysis timed out after 180 seconds')
  }

  // ─── DB Updates ──────────────────────────────────────────────────────────

  private async updateDbProgress(): Promise<void> {
    if (!this.batchState) return
    try {
      const db = drizzle(this.env.DB)
      await db.update(batchJobs)
        .set({
          completedCount: this.batchState.completedCount,
          failedCount: this.batchState.failedCount,
          resultsJson: JSON.stringify(this.batchState.results),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(batchJobs.id, this.batchState.batchId))
    } catch (err) {
      console.warn('[BatchJobDO] Failed to update DB progress:', err)
    }
  }

  private async updateDbStatus(status: string): Promise<void> {
    if (!this.batchState) return
    try {
      const db = drizzle(this.env.DB)
      await db.update(batchJobs)
        .set({
          status,
          completedCount: this.batchState.completedCount,
          failedCount: this.batchState.failedCount,
          resultsJson: JSON.stringify(this.batchState.results),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(batchJobs.id, this.batchState.batchId))
    } catch (err) {
      console.warn('[BatchJobDO] Failed to update DB status:', err)
    }
  }

  // ─── Event Management ──────────────────────────────────────────────────

  private async pushEvent(event: string, data: unknown): Promise<void> {
    if (this.batchState) {
      await this.state.storage.put('batchState', this.batchState)
    }
    this.broadcast(event, data)
  }

  private broadcast(event: string, data: unknown): void {
    const msg = this.encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    for (const writer of this.sseClients) {
      writer.write(msg).catch(() => {
        this.sseClients.delete(writer)
      })
    }
  }

  // ─── SSE Stream ────────────────────────────────────────────────────────

  private async handleSSE(request: Request): Promise<Response> {
    if (!this.batchState) {
      this.batchState = await this.state.storage.get<BatchState>('batchState') ?? null
    }

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    this.sseClients.add(writer)

    // Send current state snapshot for late-joining clients
    if (this.batchState) {
      await writer.write(this.encoder.encode(`event: batch_state\ndata: ${JSON.stringify({
        status: this.batchState.status,
        totalAddresses: this.batchState.totalAddresses,
        completedCount: this.batchState.completedCount,
        failedCount: this.batchState.failedCount,
        currentIndex: this.batchState.currentIndex,
        results: this.batchState.results,
      })}\n\n`))
    }

    // If already done, close after snapshot
    if (this.batchState?.status === 'completed' || this.batchState?.status === 'failed') {
      await writer.write(this.encoder.encode(`event: batch_done\ndata: ${JSON.stringify({ replayed: true })}\n\n`))
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

  // ─── State Query ──────────────────────────────────────────────────────

  private handleGetState(): Response {
    return Response.json(this.batchState ?? { status: 'not_found' }, {
      status: this.batchState ? 200 : 404,
    })
  }
}
