/**
 * AnalysisJob Durable Object
 *
 * Manages individual analysis job state and provides real-time updates via WebSocket.
 * Uses the Hibernation API for cost-efficient WebSocket connections.
 */

import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../types'
import type {
  AnalysisJobState,
  AnalysisStep,
  StepStatus,
  JobStatus,
  StepProgress,
  StatusMessage,
  StatusMessageType,
  StatusMessageData,
  InitJobRequest,
  UpdateStepRequest,
  SetResultRequest,
  SetErrorRequest,
  JobError,
  TOTAL_STEPS,
  getStepNumber,
  getStepConfig,
} from './types'
import { STEP_CONFIGS } from './types'

export class AnalysisJobDO extends DurableObject<Env> {
  private state: AnalysisJobState | null = null

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
        case '/state':
          return this.handleGetState()
        case '/ws':
          return this.handleWebSocketUpgrade(request)
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

    // Close all WebSocket connections - job is done
    this.closeAllConnections(1000, 'Job completed')

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

    // Close all WebSocket connections - job is done
    this.closeAllConnections(1000, 'Job failed')

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
      },
    }

    return new Response(JSON.stringify(response), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * Handle WebSocket upgrade request
   */
  private handleWebSocketUpgrade(request: Request): Response {
    console.log('[AnalysisJobDO] WebSocket upgrade requested')

    // Check for upgrade header
    const upgradeHeader = request.headers.get('Upgrade')
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      console.log('[AnalysisJobDO] No upgrade header, returning 426')
      return new Response('Expected WebSocket upgrade', { status: 426 })
    }

    // Create WebSocket pair
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    // Accept the WebSocket with hibernation
    this.ctx.acceptWebSocket(server)
    console.log('[AnalysisJobDO] WebSocket accepted')

    // Send current state to new client
    this.sendCurrentStateToSocket(server)

    return new Response(null, {
      status: 101,
      webSocket: client,
    })
  }

  /**
   * Send current state to a WebSocket
   */
  private async sendCurrentStateToSocket(ws: WebSocket): Promise<void> {
    const state = await this.loadState()
    console.log('[AnalysisJobDO] Sending current state to socket, state exists:', !!state)
    if (!state) {
      console.log('[AnalysisJobDO] No state found, not sending initial message')
      return
    }

    // Calculate progress
    const completedSteps = state.steps.filter(
      (s) => s.status === 'completed' || s.status === 'skipped'
    ).length
    const totalSteps = STEP_CONFIGS.length

    // Send current state as initial message
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
      ws.send(JSON.stringify(message))

      // If in progress, send current step info
      if (state.status === 'processing' && state.currentStep) {
        const stepIndex = state.steps.findIndex((s) => s.step === state.currentStep)
        const stepConfig = STEP_CONFIGS[stepIndex]
        const stepProgress = state.steps[stepIndex]

        ws.send(
          JSON.stringify({
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
        )
      }
    } catch {
      // Socket might be closed already
    }
  }

  /**
   * WebSocket message handler (Hibernation API)
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // Handle client messages (e.g., ping, cancel request)
    if (typeof message === 'string') {
      try {
        const parsed = JSON.parse(message)
        if (parsed.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }))
        }
        // Future: handle cancel requests
      } catch {
        // Ignore invalid messages
      }
    }
  }

  /**
   * WebSocket close handler (Hibernation API)
   * Must call ws.close() to complete the close handshake
   */
  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    // Complete the WebSocket close handshake
    ws.close(code, reason)
  }

  /**
   * WebSocket error handler (Hibernation API)
   */
  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error('[AnalysisJobDO] WebSocket error:', error)
  }

  /**
   * Broadcast a message to all connected WebSocket clients
   */
  private broadcast(message: StatusMessage): void {
    const sockets = this.ctx.getWebSockets()
    const data = JSON.stringify(message)

    for (const ws of sockets) {
      try {
        ws.send(data)
      } catch (error) {
        console.error('[AnalysisJobDO] Failed to send to socket:', error)
        // Socket might be closed, handled by close event
      }
    }
  }

  /**
   * Close all WebSocket connections
   */
  private closeAllConnections(code: number, reason: string): void {
    const sockets = this.ctx.getWebSockets()
    for (const ws of sockets) {
      try {
        ws.close(code, reason)
      } catch {
        // Socket already closed
      }
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
