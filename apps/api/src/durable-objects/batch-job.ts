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
import { kickNextQueuedBatch } from '../services/batch-queue'
import { withDbRetry } from '../lib/db-retry'

interface BatchState {
  batchId: string
  userId: string
  status: 'idle' | 'processing' | 'paused' | 'completed' | 'failed'
  addresses: string[]
  results: BatchResult[]
  currentIndex: number
  totalAddresses: number
  completedCount: number
  failedCount: number
  createdAt: number
  /** Timestamp of last address completion — lets the DO alarm detect a dead loop */
  lastProgressAt?: number
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
  confidence?: string
  /** Volume: comps selected that matched appraisal rules */
  compCount?: number
  /** Wall time for this address's analysis */
  durationMs?: number
  /** Epoch ms when this address entered processing — drives the UI stopwatch */
  startedAt?: number
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
  /** True while processBatch/retryFailed is actively iterating in this isolate */
  private loopRunning = false

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.env = env
  }

  // ─── Alarm: self-healing watchdog ─────────────────────────────────────────
  // The processing loop re-arms this every address. If the isolate was evicted
  // mid-run (deploy, idle reclaim, crash), loopRunning resets to false and the
  // alarm still fires — that's the signal to resume the list automatically.

  async alarm(): Promise<void> {
    if (!this.batchState) {
      this.batchState = await this.state.storage.get<BatchState>('batchState') ?? null
    }
    const bs = this.batchState
    if (!bs || bs.status !== 'processing' || this.stopRequested) {
      await this.state.storage.deleteAlarm()
      return
    }
    // Loop alive in this isolate → just re-arm
    if (this.loopRunning) {
      await this.state.storage.setAlarm(Date.now() + 60_000)
      return
    }
    // Grace window: a single address can legitimately take ~180s. Only declare
    // the loop dead when the last completed address is older than that.
    const lastProgress = bs.lastProgressAt ?? 0
    if (Date.now() - lastProgress < 210_000) {
      await this.state.storage.setAlarm(Date.now() + 60_000)
      return
    }

    console.warn('[BatchJobDO] alarm: processing batch with dead loop — resuming automatically')
    const indices = bs.results
      .map((r, i) => (r.status === 'pending' || r.status === 'processing') ? i : -1)
      .filter((i) => i >= 0)

    if (indices.length === 0) {
      bs.status = 'completed'
      await this.state.storage.put('batchState', bs)
      await this.updateDbStatus('completed')
      await kickNextQueuedBatch(this.env, bs.userId)
      return
    }

    // Reset the in-flight row so it gets re-run — clear its startedAt and
    // persist immediately so polling clients don't see a stale stopwatch
    for (const i of indices) {
      if (bs.results[i].status === 'processing') {
        bs.results[i].status = 'pending'
        bs.results[i].startedAt = undefined
      }
    }
    this.batchState = bs
    await this.state.storage.put('batchState', bs)
    await this.updateDbProgress()

    this.state.waitUntil(this.retryFailed(bs.userId, indices).catch(async (err) => {
      console.error('[BatchJobDO] Alarm-resume fatal error:', err)
      await this.pushEvent('batch_error', { message: err instanceof Error ? err.message : 'Auto-resume failed' })
      if (this.batchState) {
        this.batchState.status = 'failed'
        await this.state.storage.put('batchState', this.batchState)
      }
      await this.updateDbStatus('failed')
      await kickNextQueuedBatch(this.env, bs.userId)
    }))
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
    if (request.method === 'POST' && path === '/resume') {
      return this.handleResume(request)
    }
    if (request.method === 'POST' && path === '/stop') {
      return this.handleStop('stop')
    }
    if (request.method === 'POST' && path === '/cancel') {
      return this.handleStop('cancel')
    }
    if (request.method === 'POST' && path === '/nudge') {
      // Cron sweeper poke — run the same dead-loop check the alarm watchdog
      // uses so an unattended batch resumes even when no alarm survived
      await this.alarm()
      return new Response(JSON.stringify({ ok: true }))
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

    // Run processing in background — waitUntil keeps the isolate alive
    // until the run settles (without it the DO can be evicted mid-batch)
    this.state.waitUntil(this.processBatch(body).catch(async (err) => {
      console.error('[BatchJobDO] Fatal error:', err)
      await this.pushEvent('batch_error', { message: err instanceof Error ? err.message : 'Unknown error' })
      // Mark failed + release the FIFO queue so the next list isn't stranded
      if (this.batchState) {
        this.batchState.status = 'failed'
        await this.state.storage.put('batchState', this.batchState)
      }
      await this.updateDbStatus('failed')
      await kickNextQueuedBatch(this.env, body.userId)
    }))

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
      this.batchState.results[i] = { ...this.batchState.results[i], status: 'pending', error: undefined, startedAt: undefined }
    }
    this.batchState.status = 'processing'
    this.batchState.failedCount = 0
    await this.state.storage.put('batchState', this.batchState)

    // Run retry in background — waitUntil survives isolate eviction
    this.state.waitUntil(this.retryFailed(body.userId, failedIndices).catch(async (err) => {
      console.error('[BatchJobDO] Retry fatal error:', err)
      await this.pushEvent('batch_error', { message: err instanceof Error ? err.message : 'Retry failed' })
      if (this.batchState) {
        this.batchState.status = 'failed'
        await this.state.storage.put('batchState', this.batchState)
      }
      await this.updateDbStatus('failed')
      await kickNextQueuedBatch(this.env, body.userId)
    }))

    return new Response('OK', { status: 200 })
  }

  // ─── Resume From Index ──────────────────────────────────────────────────

  private async handleResume(request: Request): Promise<Response> {
    const body = await request.json() as {
      userId: string
      batchId?: string
      addresses?: string[]
      results?: BatchResult[]
      fromIndex?: number
    }

    if (!this.batchState) {
      this.batchState = await this.state.storage.get<BatchState>('batchState') ?? null
    }
    // Reconstruct state when this DO never ran the batch (e.g. DB-seeded rows)
    if (!this.batchState && body.addresses && body.results) {
      this.batchState = {
        batchId: body.batchId!,
        userId: body.userId,
        status: 'completed',
        addresses: body.addresses,
        results: body.results,
        currentIndex: 0,
        totalAddresses: body.addresses.length,
        completedCount: 0,
        failedCount: 0,
        createdAt: Date.now(),
      }
    }
    if (!this.batchState) {
      return new Response('No batch state', { status: 400 })
    }

    const fromIndex = Math.max(0, Math.floor(body.fromIndex ?? 0))
    const indices = this.batchState.results
      .map((r, i) => (i >= fromIndex && r.status !== 'completed') ? i : -1)
      .filter((i) => i >= 0)

    if (indices.length === 0) {
      return new Response('Nothing to resume', { status: 400 })
    }

    for (const i of indices) {
      this.batchState.results[i] = { ...this.batchState.results[i], status: 'pending', error: undefined, startedAt: undefined }
    }
    this.batchState.status = 'processing'
    this.batchState.completedCount = this.batchState.results.filter((r) => r.status === 'completed').length
    this.batchState.failedCount = this.batchState.results.filter((r) => r.status === 'failed').length
    await this.state.storage.put('batchState', this.batchState)

    this.state.waitUntil(this.retryFailed(body.userId, indices).catch(async (err) => {
      console.error('[BatchJobDO] Resume fatal error:', err)
      await this.pushEvent('batch_error', { message: err instanceof Error ? err.message : 'Resume failed' })
      if (this.batchState) {
        this.batchState.status = 'failed'
        await this.state.storage.put('batchState', this.batchState)
      }
      await this.updateDbStatus('failed')
      await kickNextQueuedBatch(this.env, body.userId)
    }))

    return new Response('OK', { status: 200 })
  }

  // ─── Stop / Cancel ──────────────────────────────────────────────────────

  /** 'stop' pauses (rows stay pending, resumable); 'cancel' marks the rest cancelled. Checked between addresses. */
  private stopRequested: 'stop' | 'cancel' | null = null
  private lastDbTouch = 0

  private handleStop(mode: 'stop' | 'cancel'): Response {
    if (!this.batchState || this.batchState.status !== 'processing') {
      return new Response('Not processing', { status: 400 })
    }
    this.stopRequested = mode
    return new Response('OK', { status: 200 })
  }

  /** Bump batch_jobs.updated_at during long analyses so the UI doesn't flag a live run as stuck. */
  private touchDb(): void {
    if (!this.batchState || Date.now() - this.lastDbTouch < 60_000) return
    this.lastDbTouch = Date.now()
    const batchId = this.batchState.batchId
    drizzle(this.env.DB)
      .update(batchJobs)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(batchJobs.id, batchId))
      .catch((err) => console.warn('[BatchJobDO] heartbeat touch failed:', err))
  }

  private async finishStopped(mode: 'stop' | 'cancel', userId: string): Promise<void> {
    if (!this.batchState) return
    if (mode === 'cancel') {
      this.batchState.results = this.batchState.results.map((r) =>
        r.status === 'completed' ? r : { ...r, status: 'failed' as const, error: 'Cancelled — stopped by user' })
      this.batchState.completedCount = this.batchState.results.filter((r) => r.status === 'completed').length
      this.batchState.failedCount = this.batchState.results.filter((r) => r.status === 'failed').length
      this.batchState.status = 'completed'
      await this.state.storage.put('batchState', this.batchState)
      await this.updateDbStatus('completed')
      await this.pushEvent('batch_completed', {
        totalAddresses: this.batchState.totalAddresses,
        completedCount: this.batchState.completedCount,
        failedCount: this.batchState.failedCount,
        results: this.batchState.results,
      })
    } else {
      this.batchState.results = this.batchState.results.map((r) =>
        r.status === 'processing' ? { ...r, status: 'pending' as const } : r)
      this.batchState.status = 'paused'
      await this.state.storage.put('batchState', this.batchState)
      await this.updateDbStatus('paused')
      await this.pushEvent('batch_paused', {
        completedCount: this.batchState.completedCount,
        failedCount: this.batchState.failedCount,
      })
    }
    this.stopRequested = null
    await this.state.storage.deleteAlarm()
    await kickNextQueuedBatch(this.env, userId)
  }

  private async retryFailed(userId: string, indices: number[]): Promise<void> {
    if (!this.batchState) return

    let userSettings
    try {
      userSettings = await withDbRetry(() => loadUserAnalysisSettings(this.env.DB, { userId }))
    } catch (err) {
      // Previously this returned silently — before the alarm was armed and
      // without updating status — leaving the batch 'processing' forever.
      console.error('[BatchJobDO] retryFailed: settings load failed:', err)
      await this.pushEvent('batch_error', { message: 'Failed to load user settings' })
      if (this.batchState) {
        this.batchState.status = 'failed'
        await this.state.storage.put('batchState', this.batchState)
      }
      await this.updateDbStatus('failed')
      await kickNextQueuedBatch(this.env, userId)
      return
    }

    const heartbeat = setInterval(() => {
      this.broadcast('heartbeat', { timestamp: Date.now() })
      this.touchDb()
    }, 15000)

    this.loopRunning = true
    await this.state.storage.setAlarm(Date.now() + 60_000)

    for (const i of indices) {
      if (!this.batchState) break
      if (this.stopRequested) {
        this.loopRunning = false
        clearInterval(heartbeat)
        await this.finishStopped(this.stopRequested, userId)
        return
      }
      const address = this.batchState.addresses[i]

      this.batchState.currentIndex = i
      this.batchState.results[i].status = 'processing'
      this.batchState.results[i].startedAt = Date.now()
      await this.state.storage.put('batchState', this.batchState)
      // Persist the in-flight row so page reloads/polls see it processing
      // (with its real start time) instead of pending
      await this.updateDbProgress()
      await this.pushEvent('address_started', { index: i, total: this.batchState.totalAddresses, address, startedAt: this.batchState.results[i].startedAt })

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
          confidence: result.confidence,
          compCount: result.compCount,
          durationMs: result.durationMs,
          error: undefined,
        }
        this.batchState.completedCount++
        await this.pushEvent('address_completed', {
          index: i, total: this.batchState.totalAddresses, address,
          jobId: result.jobId, arv: result.arv, buyPrice: result.buyPrice, recommendation: result.recommendation, confidence: result.confidence,
        })
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Retry failed'
        this.batchState.results[i] = {
          ...this.batchState.results[i],
          status: 'failed',
          error: errorMsg,
          durationMs: this.batchState.results[i].startedAt ? Date.now() - this.batchState.results[i].startedAt! : undefined,
        }
        this.batchState.failedCount++
        await this.pushEvent('address_failed', { index: i, total: this.batchState.totalAddresses, address, error: errorMsg })
      }

      this.batchState.lastProgressAt = Date.now()
      await this.state.storage.put('batchState', this.batchState)
      await this.updateDbProgress()
      await this.state.storage.setAlarm(Date.now() + 60_000)

      if (i < indices[indices.length - 1]) {
        await new Promise((r) => setTimeout(r, 2000))
      }
    }

    this.loopRunning = false
    clearInterval(heartbeat)
    await this.state.storage.deleteAlarm()

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
    await kickNextQueuedBatch(this.env, userId)
  }

  // ─── Sequential Processing ──────────────────────────────────────────────

  private async processBatch(config: StartBatchRequest): Promise<void> {
    const startTime = Date.now()

    // Load user settings once for all addresses
    let userSettings
    try {
      userSettings = await withDbRetry(() => loadUserAnalysisSettings(this.env.DB, { userId: config.userId }))
    } catch (err) {
      await this.pushEvent('batch_error', { message: 'Failed to load user settings' })
      if (this.batchState) {
        this.batchState.status = 'failed'
        await this.state.storage.put('batchState', this.batchState)
      }
      await this.updateDbStatus('failed')
      await kickNextQueuedBatch(this.env, config.userId)
      return
    }

    // Heartbeat keeps SSE connections alive through proxies/CDNs
    const heartbeat = setInterval(() => {
      this.broadcast('heartbeat', { timestamp: Date.now() })
      this.touchDb()
    }, 15000)

    await this.pushEvent('batch_started', {
      totalAddresses: config.addresses.length,
      message: `Processing ${config.addresses.length} addresses...`,
    })

    this.loopRunning = true
    await this.state.storage.setAlarm(Date.now() + 60_000)

    for (let i = 0; i < config.addresses.length; i++) {
      const address = config.addresses[i]
      if (!this.batchState) break
      if (this.stopRequested) {
        this.loopRunning = false
        clearInterval(heartbeat)
        await this.finishStopped(this.stopRequested, config.userId)
        return
      }

      this.batchState.currentIndex = i
      this.batchState.results[i].status = 'processing'
      this.batchState.results[i].startedAt = Date.now()
      await this.state.storage.put('batchState', this.batchState)
      await this.updateDbProgress()

      await this.pushEvent('address_started', {
        index: i,
        total: config.addresses.length,
        address,
        startedAt: this.batchState.results[i].startedAt,
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
          confidence: result.confidence,
          compCount: result.compCount,
          durationMs: result.durationMs,
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
          confidence: result.confidence,
        })
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Analysis failed'
        this.batchState.results[i] = {
          ...this.batchState.results[i],
          status: 'failed',
          error: errorMsg,
          durationMs: this.batchState.results[i].startedAt ? Date.now() - this.batchState.results[i].startedAt! : undefined,
        }
        this.batchState.failedCount++

        await this.pushEvent('address_failed', {
          index: i,
          total: config.addresses.length,
          address,
          error: errorMsg,
        })
      }

      this.batchState.lastProgressAt = Date.now()
      await this.state.storage.put('batchState', this.batchState)
      await this.updateDbProgress()
      await this.state.storage.setAlarm(Date.now() + 60_000)

      // Rate limit delay between addresses (2s)
      if (i < config.addresses.length - 1) {
        await new Promise((r) => setTimeout(r, 2000))
      }
    }

    this.loopRunning = false
    clearInterval(heartbeat)
    await this.state.storage.deleteAlarm()

    // Mark complete
    if (this.batchState) {
      this.batchState.status = 'completed'
      await this.state.storage.put('batchState', this.batchState)
    }
    await this.updateDbStatus('completed')
    await kickNextQueuedBatch(this.env, config.userId)

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
    confidence?: string
    compCount?: number
    durationMs?: number
  }> {
    const startTime = Date.now()
    const jobId = `batch_${config.batchId}_${crypto.randomUUID().slice(0, 8)}`

    const doId = this.env.ANALYSIS_JOB.idFromName(jobId)
    const stub = this.env.ANALYSIS_JOB.get(doId)

    // Start the analysis in the sub-DO (no LLM) — bounded fetch so a hung
    // child DO fails the address instead of freezing the whole list.
    const appraisalRules = userSettings.appraisalRules ?? {}
    let startResp: Response
    try {
      startResp = await stub.fetch('http://internal/start-streaming', {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          jobId,
          userId: config.userId,
          search: { address },
          searchOptions: config.searchOptions ?? { radiusMiles: 1, maxComps: 25, monthsBack: 12 },
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
    } catch (err) {
      throw new Error(`Failed to start analysis: ${err instanceof Error ? err.message : 'timeout'}`)
    }

    // Poll for completion — 3 min hard cap, plus stall detection: once the
    // address has run 60s+, if the child DO shows no new events or status
    // change for 45s it's wedged → fail the address and continue the list.
    const deadline = Date.now() + 180_000
    let lastStep = ''
    let lastProgressAt = Date.now()
    let lastEventCount = 0
    let lastStatus = ''
    let fetchFailures = 0
    const index = this.batchState?.currentIndex ?? 0
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000))

      let state: { status: string; events?: Array<{ event: string; data: unknown }> }
      try {
        const stateResp = await stub.fetch('http://internal/state', {
          signal: AbortSignal.timeout(15_000),
        })
        state = await stateResp.json()
        fetchFailures = 0
      } catch (err) {
        fetchFailures++
        console.warn(`[BatchJobDO] Failed to poll child DO state for ${address} (${fetchFailures}/3):`, err)
        if (fetchFailures >= 3) {
          throw new Error('Analysis job unreachable — child DO not responding')
        }
        continue
      }

      // Progress = new events or a status change
      const eventCount = state.events?.length ?? 0
      if (eventCount > lastEventCount || state.status !== lastStatus) {
        lastProgressAt = Date.now()
        lastEventCount = eventCount
        lastStatus = state.status
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
          confidence: result?.report?.confidence,
          compCount: result?.comps?.enabledCount ?? result?.report?.arv?.compPool?.enabled,
          durationMs: Date.now() - startTime,
        }
      }

      // Stall detection: past 60s with no new events/status for 45s → wedged
      const elapsed = Date.now() - startTime
      if (elapsed > 60_000 && Date.now() - lastProgressAt > 45_000) {
        throw new Error(`Analysis stalled — no progress for ${Math.round((Date.now() - lastProgressAt) / 1000)}s`)
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
