'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AnalysisState,
  StatusMessage,
  StepProgress,
  AnalysisStep,
  JobStatus,
  StepStartedData,
  StepCompletedData,
  StepFailedData,
  StepSkippedData,
  JobCompletedData,
  JobFailedData,
  ResultReadyData,
  StepDataData,
  StepStatus,
} from '@/types/analysis'
import { initialAnalysisState, STEP_CONFIGS } from '@/types/analysis'
import { deepMergePartial } from '@/lib/merge-utils'

interface UseAnalysisSSEOptions {
  /** SSE URL to connect to (includes signed token) */
  url: string | null
  /** Property key for the job (used for polling fallback) */
  propertyKey: string | null
  /** Callback when job completes */
  onComplete?: (result: unknown) => void
  /** Callback when job fails */
  onError?: (error: string) => void
  /** Called when SSE fails after max retries — switch to polling */
  onFallbackToPolling?: () => void
}

interface UseAnalysisSSEReturn {
  /** Current analysis state */
  state: AnalysisState
  /** Connect to SSE stream */
  connect: () => void
  /** Disconnect from SSE stream */
  disconnect: () => void
  /** Reset state */
  reset: () => void
  /** Is currently connecting */
  isConnecting: boolean
}

/** All event types we listen for */
const EVENT_TYPES = [
  'job_created',
  'job_started',
  'step_started',
  'step_completed',
  'step_failed',
  'step_skipped',
  'cache_hit',
  'result_ready',
  'step_data',
  'job_completed',
  'job_failed',
] as const

const MAX_RETRIES = 3
const RETRY_BASE_MS = 1000

export function useAnalysisSSE(
  options: UseAnalysisSSEOptions
): UseAnalysisSSEReturn {
  const { url, propertyKey, onComplete, onError, onFallbackToPolling } = options

  const [state, setState] = useState<AnalysisState>(initialAnalysisState)
  const [isConnecting, setIsConnecting] = useState(false)
  const esRef = useRef<EventSource | null>(null)
  const retryCountRef = useRef(0)
  const retryTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Store callbacks in refs to avoid dependency chain issues
  const onCompleteRef = useRef(onComplete)
  const onErrorRef = useRef(onError)
  const onFallbackToPollingRef = useRef(onFallbackToPolling)
  onCompleteRef.current = onComplete
  onErrorRef.current = onError
  onFallbackToPollingRef.current = onFallbackToPolling

  // Track job status in a ref so onerror can read it synchronously
  const statusRef = useRef<JobStatus | null>(null)

  // Update a specific step's progress
  const updateStepProgress = useCallback(
    (step: AnalysisStep, updates: Partial<StepProgress>) => {
      setState((prev) => ({
        ...prev,
        steps: prev.steps.map((s) => (s.step === step ? { ...s, ...updates } : s)),
      }))
    },
    []
  )

  // Handle incoming SSE messages — stable reference (no callback deps)
  const handleMessage = useCallback(
    (message: StatusMessage) => {
      // Add message to history
      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, message],
      }))

      switch (message.type) {
        case 'job_created': {
          statusRef.current = 'queued'
          setState((prev) => ({
            ...prev,
            jobId: message.jobId,
            status: 'queued',
          }))
          break
        }

        case 'job_started': {
          statusRef.current = 'processing'
          setState((prev) => ({
            ...prev,
            status: 'processing',
          }))
          break
        }

        case 'step_started': {
          const data = message.data as StepStartedData
          setState((prev) => ({
            ...prev,
            currentStep: data.step,
          }))
          updateStepProgress(data.step, {
            status: 'in_progress',
            startedAt: message.timestamp,
            message: data.message,
          })
          break
        }

        case 'step_completed': {
          const data = message.data as StepCompletedData
          updateStepProgress(data.step, {
            status: 'completed',
            completedAt: message.timestamp,
            durationMs: data.durationMs,
            fromCache: data.fromCache,
            message: data.message,
          })
          break
        }

        case 'step_failed': {
          const data = message.data as StepFailedData
          updateStepProgress(data.step, {
            status: 'failed',
            completedAt: message.timestamp,
            error: data.error,
          })
          break
        }

        case 'step_skipped': {
          const data = message.data as StepSkippedData
          updateStepProgress(data.step, {
            status: 'skipped',
            completedAt: message.timestamp,
            message: data.reason,
          })
          break
        }

        case 'cache_hit': {
          // Informational, already handled in step_completed
          break
        }

        case 'result_ready': {
          const data = message.data as ResultReadyData
          setState((prev) => ({
            ...prev,
            result: data.result,
          }))
          break
        }

        case 'step_data': {
          const data = message.data as StepDataData
          setState((prev) => ({
            ...prev,
            partialResult: deepMergePartial(prev.partialResult ?? {}, data.data),
          }))
          break
        }

        case 'job_completed': {
          const data = message.data as JobCompletedData
          statusRef.current = 'completed'
          setState((prev) => ({
            ...prev,
            status: 'completed',
            currentStep: null,
            totalDurationMs: data.totalDurationMs,
          }))

          // Close EventSource - job is done
          if (esRef.current) {
            console.log('[SSE] Job completed, closing connection')
            esRef.current.close()
            esRef.current = null
          }

          onCompleteRef.current?.(data)
          break
        }

        case 'job_failed': {
          const data = message.data as JobFailedData
          statusRef.current = 'failed'
          setState((prev) => ({
            ...prev,
            status: 'failed',
            currentStep: null,
            error: data.error,
          }))

          // Close EventSource - job is done
          if (esRef.current) {
            console.log('[SSE] Job failed, closing connection')
            esRef.current.close()
            esRef.current = null
          }

          onErrorRef.current?.(data.error)
          break
        }
      }
    },
    [updateStepProgress]
  )

  // Connect to SSE stream — stable reference (deps are stable refs + url)
  const connect = useCallback(() => {
    if (!url) {
      console.warn('[SSE] Missing URL')
      return
    }

    // Close existing connection
    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }

    // Clear any pending retry timer
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }

    console.log('[SSE] Connecting to:', url)
    setIsConnecting(true)

    const es = new EventSource(url)

    es.onopen = () => {
      console.log('[SSE] Connected')
      setIsConnecting(false)
      retryCountRef.current = 0
      setState((prev) => ({ ...prev, isConnected: true }))
    }

    es.onerror = () => {
      // IMMEDIATELY close the EventSource to prevent browser auto-reconnect
      es.close()
      if (esRef.current === es) {
        esRef.current = null
      }

      setIsConnecting(false)
      setState((prev) => ({ ...prev, isConnected: false }))

      // If the job already completed or failed, the server closed the connection — expected
      const currentStatus = statusRef.current
      if (currentStatus === 'completed' || currentStatus === 'failed') {
        console.log('[SSE] Connection closed (job finished)')
        return
      }

      // Job is still in progress — retry or fallback
      const attempt = retryCountRef.current
      if (attempt < MAX_RETRIES) {
        const delayMs = RETRY_BASE_MS * Math.pow(2, attempt)
        console.warn(`[SSE] Connection error, retrying in ${delayMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`)
        retryCountRef.current = attempt + 1

        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null
          connect()
        }, delayMs)
      } else {
        console.warn('[SSE] Max retries reached, falling back to polling')
        onFallbackToPollingRef.current?.()
      }
    }

    // Listen for each named event type
    for (const eventType of EVENT_TYPES) {
      es.addEventListener(eventType, (event: MessageEvent) => {
        try {
          const message = JSON.parse(event.data) as StatusMessage
          handleMessage(message)
        } catch (error) {
          console.error('[SSE] Failed to parse message:', error)
        }
      })
    }

    esRef.current = es
  }, [url, handleMessage])

  // Disconnect from SSE stream
  const disconnect = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
    retryCountRef.current = 0

    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }

    setState((prev) => ({ ...prev, isConnected: false }))
  }, [])

  // Reset state
  const reset = useCallback(() => {
    disconnect()
    statusRef.current = null
    setState({
      ...initialAnalysisState,
      steps: STEP_CONFIGS.map((c) => ({
        step: c.step,
        status: 'pending',
      })),
    })
  }, [disconnect])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect()
    }
  }, [disconnect])

  return {
    state,
    connect,
    disconnect,
    reset,
    isConnecting,
  }
}

// ─── Polling Hook (Fallback) ──────────────────────────────────────────────────

interface UseAnalysisPollingOptions {
  /** Poll URL */
  url: string | null
  /** Property key */
  propertyKey: string | null
  /** Poll interval in ms */
  interval?: number
  /** Whether polling is enabled */
  enabled?: boolean
  /** Callback when job completes */
  onComplete?: (result: unknown) => void
}

export function useAnalysisPolling(options: UseAnalysisPollingOptions) {
  const { url, propertyKey, interval = 2000, enabled = false, onComplete } = options
  const [state, setState] = useState<AnalysisState>(initialAnalysisState)
  const [isPolling, setIsPolling] = useState(false)
  const intervalRef = useRef<NodeJS.Timeout | null>(null)
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  const poll = useCallback(async () => {
    if (!url || !propertyKey) return

    try {
      const pollUrl = new URL(url)
      pollUrl.searchParams.set('propertyKey', propertyKey)

      const response = await fetch(pollUrl.toString(), {
        credentials: 'include',
      })

      if (!response.ok) {
        throw new Error(`Poll failed: ${response.status}`)
      }

      const data = await response.json() as {
        success?: boolean
        data?: {
          jobId: string
          status: JobStatus
          currentStep: AnalysisStep | null
          steps?: StepProgress[]
          totalDurationMs?: number | null
          result?: unknown
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stepData?: Record<string, any>
          error?: { message: string }
        }
      }

      if (data.success && data.data) {
        const jobData = data.data
        setState((prev) => ({
          ...prev,
          jobId: jobData.jobId,
          status: jobData.status as JobStatus,
          currentStep: jobData.currentStep,
          steps: jobData.steps || prev.steps,
          totalDurationMs: jobData.totalDurationMs ?? null,
          result: jobData.result || prev.result,
          partialResult: jobData.stepData
            ? deepMergePartial(prev.partialResult ?? {}, jobData.stepData)
            : prev.partialResult,
          error: jobData.error?.message || null,
        }))

        // Stop polling if job is done
        if (jobData.status === 'completed' || jobData.status === 'failed') {
          setIsPolling(false)
          if (intervalRef.current) {
            clearInterval(intervalRef.current)
            intervalRef.current = null
          }

          if (jobData.status === 'completed') {
            onCompleteRef.current?.(jobData.result)
          }
        }
      }
    } catch (error) {
      console.error('[Polling] Error:', error)
    }
  }, [url, propertyKey])

  // Start/stop polling based on enabled
  useEffect(() => {
    if (enabled && url && propertyKey && !intervalRef.current) {
      setIsPolling(true)
      poll() // Initial poll
      intervalRef.current = setInterval(poll, interval)
    } else if (!enabled && intervalRef.current) {
      setIsPolling(false)
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [enabled, url, propertyKey, interval, poll])

  const reset = useCallback(() => {
    setIsPolling(false)
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    setState({
      ...initialAnalysisState,
      steps: STEP_CONFIGS.map((c) => ({
        step: c.step,
        status: 'pending' as StepStatus,
      })),
    })
  }, [])

  return {
    state,
    isPolling,
    reset,
  }
}
