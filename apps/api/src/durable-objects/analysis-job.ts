/**
 * AnalysisJob Durable Object
 *
 * Manages individual analysis job state and provides real-time updates via SSE.
 */

import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../types'
import type {
  AnalysisJobState,
  AnalysisStep,
  StepStatus,
  StepProgress,
  StatusMessage,
  InitJobRequest,
  UpdateStepRequest,
  SetResultRequest,
  SetErrorRequest,
} from './types'
import { STEP_CONFIGS } from './types'
import { deepMergePartial } from './merge-utils'

export class AnalysisJobDO extends DurableObject<Env> {
  private state: AnalysisJobState | null = null
  private sseControllers: Set<ReadableStreamDefaultController> = new Set()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }

  /**
   * Load state from storage on first access
   */
  private async loadState(): Promise<AnalysisJobState | null> {
    if (this.state) return this.state
    this.state = await this.ctx.storage.get<AnalysisJobState>('state') ?? null
    return this.state
  }

  /**
   * Save state to storage
   */
  private async saveState(): Promise<void> {
    if (this.state) {
      await this.ctx.storage.put('state', this.state)
    }
  }

  /**
   * Handle incoming HTTP requests
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    try {
      switch (url.pathname) {
        case '/init':
          return this.handleInit(request)
        case '/step':
          return this.handleStepUpdate(request)
        case '/result':
          return this.handleSetResult(request)
        case '/error':
          return this.handleSetError(request)
        case '/partial-result':
          return this.handlePartialResult(request)
        case '/step-data':
          return this.handleStepData(request)
        case '/state':
          return this.handleGetState()
        case '/sse':
          return this.handleSSE()
        default:
          return new Response('Not Found', { status: 404 })
      }
    } catch (error) {
      console.error('[AnalysisJobDO] Error handling request:', error)
      return new Response(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'Internal error',
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      )
    }
  }

  /**
   * Initialize a new job
   */
  private async handleInit(request: Request): Promise<Response> {
    const body = await request.json() as InitJobRequest

    // Initialize step progress for all steps
    const steps: StepProgress[] = STEP_CONFIGS.map((config) => ({
      step: config.step,
      status: 'pending' as StepStatus,
    }))

    this.state = {
      jobId: body.jobId,
      userId: body.userId,
      apiKeyId: body.apiKeyId,
      propertyKey: body.propertyKey,
      request: body.request,
      status: 'queued',
      currentStep: null,
      steps,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      totalDurationMs: null,
      result: null,
      error: null,
      stepData: null,
      cacheHits: [],
      cacheMisses: [],
    }

    await this.saveState()

    // Broadcast job created message
    this.broadcast({
      type: 'job_created',
      jobId: body.jobId,
      timestamp: new Date().toISOString(),
      data: {
        propertyKey: body.propertyKey,
        totalSteps: STEP_CONFIGS.length,
      },
    })

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * Update step progress
   */
  private async handleStepUpdate(request: Request): Promise<Response> {
    const body = await request.json() as UpdateStepRequest
    const state = await this.loadState()

    if (!state) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const stepIndex = state.steps.findIndex((s) => s.step === body.step)
    if (stepIndex === -1) {
      return new Response(JSON.stringify({ error: 'Invalid step' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const now = new Date().toISOString()
    const stepProgress = state.steps[stepIndex]
    const stepConfig = STEP_CONFIGS[stepIndex]
    const stepNumber = stepIndex + 1
    const totalSteps = STEP_CONFIGS.length

    // Update step state
    stepProgress.status = body.status
    if (body.message) stepProgress.message = body.message
    if (body.error) stepProgress.error = body.error
    if (body.fromCache !== undefined) stepProgress.fromCache = body.fromCache

    // Track cache hits/misses
    if (body.fromCache === true && !state.cacheHits.includes(body.step)) {
      state.cacheHits.push(body.step)
    } else if (body.fromCache === false && !state.cacheMisses.includes(body.step)) {
      state.cacheMisses.push(body.step)
    }

    // Update timing based on status
    if (body.status === 'in_progress') {
      stepProgress.startedAt = now
      state.currentStep = body.step

      // Mark job as processing if first step
      if (state.status === 'queued') {
        state.status = 'processing'
        state.startedAt = now
        this.broadcast({
          type: 'job_started',
          jobId: state.jobId,
          timestamp: now,
          data: { message: 'Analysis started' },
        })
      }

      // Broadcast step started
      this.broadcast({
        type: 'step_started',
        jobId: state.jobId,
        timestamp: now,
        data: {
          step: body.step,
          stepNumber,
          totalSteps,
          label: stepConfig.label,
          message: body.message || stepConfig.description,
        },
      })
    } else if (body.status === 'completed') {
      stepProgress.completedAt = now
      if (stepProgress.startedAt) {
        stepProgress.durationMs =
          new Date(now).getTime() - new Date(stepProgress.startedAt).getTime()
      }

      // Broadcast step completed
      this.broadcast({
        type: 'step_completed',
        jobId: state.jobId,
        timestamp: now,
        data: {
          step: body.step,
          stepNumber,
          totalSteps,
          durationMs: stepProgress.durationMs || 0,
          fromCache: body.fromCache || false,
          message: body.message || `${stepConfig.label} completed`,
        },
      })

      // Broadcast cache hit if applicable
      if (body.fromCache) {
        this.broadcast({
          type: 'cache_hit',
          jobId: state.jobId,
          timestamp: now,
          data: {
            component: body.step,
            message: `${stepConfig.label} loaded from cache`,
          },
        })
      }
    } else if (body.status === 'failed') {
      stepProgress.completedAt = now
      if (stepProgress.startedAt) {
        stepProgress.durationMs =
          new Date(now).getTime() - new Date(stepProgress.startedAt).getTime()
      }

      // Broadcast step failed
      this.broadcast({
        type: 'step_failed',
        jobId: state.jobId,
        timestamp: now,
        data: {
          step: body.step,
          stepNumber,
          totalSteps,
          error: body.error || 'Unknown error',
          retryable: !stepConfig.required,
        },
      })
    } else if (body.status === 'skipped') {
      stepProgress.completedAt = now

      // Broadcast step skipped
      this.broadcast({
        type: 'step_skipped',
        jobId: state.jobId,
        timestamp: now,
        data: {
          step: body.step,
          stepNumber,
          totalSteps,
          reason: body.message || 'Step skipped',
        },
      })
    }

    await this.saveState()

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * Broadcast the analysis result to SSE clients before storing it
   * This allows the dashboard to render results immediately without waiting for storage
   */
  private async handlePartialResult(request: Request): Promise<Response> {
    const body = await request.json() as SetResultRequest
    const state = await this.loadState()

    if (!state) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Broadcast the result to all connected SSE clients
    this.broadcast({
      type: 'result_ready',
      jobId: state.jobId,
      timestamp: new Date().toISOString(),
      data: {
        result: body.result,
      },
    })

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * Broadcast partial step data to SSE clients and accumulate for late-connecting clients
   */
  private async handleStepData(request: Request): Promise<Response> {
    const body = await request.json() as { step: AnalysisStep; data: Record<string, unknown> }
    const state = await this.loadState()

    if (!state) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Accumulate step data for late-connecting clients
    state.stepData = deepMergePartial(state.stepData ?? {}, body.data)
    await this.saveState()

    // Broadcast to connected SSE clients
    this.broadcast({
      type: 'step_data',
      jobId: state.jobId,
      timestamp: new Date().toISOString(),
      data: {
        step: body.step,
        data: body.data,
      },
    })

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * Set the final result
   */
  private async handleSetResult(request: Request): Promise<Response> {
    const body = await request.json() as SetResultRequest
    const state = await this.loadState()

    if (!state) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const now = new Date().toISOString()

    state.status = 'completed'
    state.completedAt = now
    state.result = body.result
    state.currentStep = null

    if (state.startedAt) {
      state.totalDurationMs =
        new Date(now).getTime() - new Date(state.startedAt).getTime()
    }

    await this.saveState()

    // Count completed and skipped steps
    const stepsCompleted = state.steps.filter((s) => s.status === 'completed').length
    const stepsSkipped = state.steps.filter((s) => s.status === 'skipped').length

    // Broadcast job completed
    this.broadcast({
      type: 'job_completed',
      jobId: state.jobId,
      timestamp: now,
      data: {
        totalDurationMs: state.totalDurationMs || 0,
        cacheHits: state.cacheHits.length,
        cacheMisses: state.cacheMisses.length,
        stepsCompleted,
        stepsSkipped,
      },
    })

    // Close all SSE connections - job is done
    this.closeAllSSEConnections()

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * Set job error state
   */
  private async handleSetError(request: Request): Promise<Response> {
    const body = await request.json() as SetErrorRequest
    const state = await this.loadState()

    if (!state) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const now = new Date().toISOString()

    state.status = 'failed'
    state.completedAt = now
    state.error = body.error
    state.currentStep = null

    if (state.startedAt) {
      state.totalDurationMs =
        new Date(now).getTime() - new Date(state.startedAt).getTime()
    }

    await this.saveState()

    // Broadcast job failed
    this.broadcast({
      type: 'job_failed',
      jobId: state.jobId,
      timestamp: now,
      data: {
        error: body.error.message,
        code: body.error.code,
        step: body.error.step,
        retryable: body.error.retryable,
      },
    })

    // Close all SSE connections - job is done
    this.closeAllSSEConnections()

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * Get current job state
   */
  private async handleGetState(): Promise<Response> {
    const state = await this.loadState()

    if (!state) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Calculate progress
    const completedSteps = state.steps.filter(
      (s) => s.status === 'completed' || s.status === 'skipped'
    ).length
    const totalSteps = STEP_CONFIGS.length
    const percentComplete = Math.round((completedSteps / totalSteps) * 100)

    const response = {
      success: true,
      data: {
        jobId: state.jobId,
        status: state.status,
        currentStep: state.currentStep,
        progress: {
          completedSteps,
          totalSteps,
          percentComplete,
        },
        steps: state.steps,
        createdAt: state.createdAt,
        startedAt: state.startedAt,
        completedAt: state.completedAt,
        totalDurationMs: state.totalDurationMs,
        ...(state.status === 'completed' && state.result && { result: state.result }),
        ...(state.status === 'failed' && state.error && { error: state.error }),
        ...(state.stepData && { stepData: state.stepData }),
      },
    }

    return new Response(JSON.stringify(response), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * Handle SSE connection
   */
  private handleSSE(): Response {
    console.log('[AnalysisJobDO] SSE connection requested')

    const encoder = new TextEncoder()
    let controllerRef: ReadableStreamDefaultController | null = null

    const stream = new ReadableStream({
      start: (controller) => {
        controllerRef = controller
        this.sseControllers.add(controller)
        console.log('[AnalysisJobDO] SSE client connected, total:', this.sseControllers.size)

        // Send current state to new client
        this.sendCurrentStateToSSE(controller)

        // Start heartbeat if not already running
        this.startHeartbeat()
      },
      cancel: () => {
        if (controllerRef) {
          this.sseControllers.delete(controllerRef)
          console.log('[AnalysisJobDO] SSE client disconnected, remaining:', this.sseControllers.size)
        }
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    })
  }

  /**
   * Send current state to an SSE controller
   */
  private async sendCurrentStateToSSE(controller: ReadableStreamDefaultController): Promise<void> {
    const state = await this.loadState()
    console.log('[AnalysisJobDO] Sending current state via SSE, state exists:', !!state)
    if (!state) return

    const completedSteps = state.steps.filter(
      (s) => s.status === 'completed' || s.status === 'skipped'
    ).length
    const totalSteps = STEP_CONFIGS.length

    const message: StatusMessage = {
      type: state.status === 'completed' ? 'job_completed' : 'job_created',
      jobId: state.jobId,
      timestamp: new Date().toISOString(),
      data:
        state.status === 'completed'
          ? {
              totalDurationMs: state.totalDurationMs || 0,
              cacheHits: state.cacheHits.length,
              cacheMisses: state.cacheMisses.length,
              stepsCompleted: completedSteps,
              stepsSkipped: state.steps.filter((s) => s.status === 'skipped').length,
            }
          : {
              propertyKey: state.propertyKey,
              totalSteps,
            },
    }

    try {
      this.sendSSEEvent(controller, message)

      // If in progress, send current step info
      if (state.status === 'processing' && state.currentStep) {
        const stepIndex = state.steps.findIndex((s) => s.step === state.currentStep)
        const stepConfig = STEP_CONFIGS[stepIndex]
        const stepProgress = state.steps[stepIndex]

        this.sendSSEEvent(controller, {
          type: 'step_started',
          jobId: state.jobId,
          timestamp: new Date().toISOString(),
          data: {
            step: state.currentStep,
            stepNumber: stepIndex + 1,
            totalSteps,
            label: stepConfig.label,
            message: stepProgress.message || stepConfig.description,
          },
        } as StatusMessage)
      }

      // Send accumulated step data for progressive rendering (catch-up for late-connecting clients)
      if (state.stepData && state.status !== 'completed') {
        this.sendSSEEvent(controller, {
          type: 'step_data',
          jobId: state.jobId,
          timestamp: new Date().toISOString(),
          data: {
            step: 'property_fetch' as AnalysisStep,
            data: state.stepData,
          },
        } as StatusMessage)
      }
    } catch {
      // Controller might be closed already
      this.sseControllers.delete(controller)
    }
  }

  /**
   * Format and send an SSE event to a single controller
   */
  private sendSSEEvent(controller: ReadableStreamDefaultController, message: StatusMessage): void {
    const encoder = new TextEncoder()
    const data = JSON.stringify(message)
    controller.enqueue(encoder.encode(`event: ${message.type}\ndata: ${data}\n\n`))
  }

  /**
   * Broadcast a message to all connected SSE clients
   */
  private broadcast(message: StatusMessage): void {
    const encoder = new TextEncoder()
    const data = JSON.stringify(message)
    const ssePayload = encoder.encode(`event: ${message.type}\ndata: ${data}\n\n`)

    for (const controller of this.sseControllers) {
      try {
        controller.enqueue(ssePayload)
      } catch (error) {
        console.error('[AnalysisJobDO] Failed to send to SSE client:', error)
        this.sseControllers.delete(controller)
      }
    }
  }

  /**
   * Close all SSE connections
   */
  private closeAllSSEConnections(): void {
    for (const controller of this.sseControllers) {
      try {
        controller.close()
      } catch {
        // Controller already closed
      }
    }
    this.sseControllers.clear()
  }

  /**
   * Start heartbeat alarm to keep SSE connections alive
   */
  private async startHeartbeat(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm()
    if (!existing) {
      await this.ctx.storage.setAlarm(Date.now() + 15_000)
    }
  }

  /**
   * Alarm handler — sends SSE keepalive comment
   */
  async alarm(): Promise<void> {
    if (this.sseControllers.size === 0) return

    const encoder = new TextEncoder()
    const keepalive = encoder.encode(`:keepalive\n\n`)

    for (const controller of this.sseControllers) {
      try {
        controller.enqueue(keepalive)
      } catch {
        this.sseControllers.delete(controller)
      }
    }

    // Schedule next heartbeat if still have connections
    if (this.sseControllers.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 15_000)
    }
  }

  /**
   * Send progress update for long-running steps
   */
  async sendProgress(step: AnalysisStep, progress: number, message: string): Promise<void> {
    const state = await this.loadState()
    if (!state) return

    this.broadcast({
      type: 'step_progress',
      jobId: state.jobId,
      timestamp: new Date().toISOString(),
      data: {
        step,
        progress,
        message,
      },
    })
  }
}
