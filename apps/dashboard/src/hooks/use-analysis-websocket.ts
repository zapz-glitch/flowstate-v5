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
} from '@/types/analysis'
import { initialAnalysisState, STEP_CONFIGS } from '@/types/analysis'

interface UseAnalysisWebSocketOptions {
  /** WebSocket URL to connect to (includes signed token) */
  url: string | null
  /** Property key for the job (used for polling fallback) */
  propertyKey: string | null
  /** Callback when job completes */
  onComplete?: (result: unknown) => void
  /** Callback when job fails */
  onError?: (error: string) => void
  /** Auto-reconnect on disconnect */
  autoReconnect?: boolean
}

interface UseAnalysisWebSocketReturn {
  /** Current analysis state */
  state: AnalysisState
  /** Connect to WebSocket */
  connect: () => void
  /** Disconnect from WebSocket */
  disconnect: () => void
  /** Reset state */
  reset: () => void
  /** Is currently connecting */
  isConnecting: boolean
}

export function useAnalysisWebSocket(
  options: UseAnalysisWebSocketOptions
): UseAnalysisWebSocketReturn {
  const { url, propertyKey, onComplete, onError, autoReconnect = false } = options

  const [state, setState] = useState<AnalysisState>(initialAnalysisState)
  const [isConnecting, setIsConnecting] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)

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

  // Handle incoming WebSocket messages
  const handleMessage = useCallback(
    (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data) as StatusMessage

        // Add message to history
        setState((prev) => ({
          ...prev,
          messages: [...prev.messages, message],
        }))

        // Handle different message types
        switch (message.type) {
          case 'job_created': {
            setState((prev) => ({
              ...prev,
              jobId: message.jobId,
              status: 'queued',
            }))
            break
          }

          case 'job_started': {
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
            // Cache hit is informational, already handled in step_completed
            break
          }

          case 'job_completed': {
            const data = message.data as JobCompletedData
            setState((prev) => ({
              ...prev,
              status: 'completed',
              currentStep: null,
              totalDurationMs: data.totalDurationMs,
            }))

            // Close WebSocket - job is done
            if (wsRef.current) {
              console.log('[WebSocket] Job completed, closing connection')
              wsRef.current.close(1000, 'Job completed')
              wsRef.current = null
            }

            // Fetch the full result via polling endpoint
            if (onComplete) {
              // The result should come with the job_completed message
              // For now, we'll need to poll the status endpoint
              onComplete(data)
            }
            break
          }

          case 'job_failed': {
            const data = message.data as JobFailedData
            setState((prev) => ({
              ...prev,
              status: 'failed',
              currentStep: null,
              error: data.error,
            }))

            // Close WebSocket - job is done
            if (wsRef.current) {
              console.log('[WebSocket] Job failed, closing connection')
              wsRef.current.close(1000, 'Job failed')
              wsRef.current = null
            }

            if (onError) {
              onError(data.error)
            }
            break
          }
        }
      } catch (error) {
        console.error('[WebSocket] Failed to parse message:', error)
      }
    },
    [updateStepProgress, onComplete, onError]
  )

  // Connect to WebSocket
  const connect = useCallback(() => {
    if (!url) {
      console.warn('[WebSocket] Missing URL')
      return
    }

    console.log('[WebSocket] Received URL from API:', url)

    // Close existing connection
    if (wsRef.current) {
      wsRef.current.close()
    }

    setIsConnecting(true)

    // The URL already contains the signed token from the API
    // The API returns ws:// or wss:// URLs directly, so we can use them as-is
    // Only convert http to ws if needed (for backwards compatibility)
    let wsUrlString = url
    if (url.startsWith('http://')) {
      wsUrlString = url.replace('http://', 'ws://')
    } else if (url.startsWith('https://')) {
      wsUrlString = url.replace('https://', 'wss://')
    }

    console.log('[WebSocket] Connecting to:', wsUrlString)

    const ws = new WebSocket(wsUrlString)

    ws.onopen = () => {
      console.log('[WebSocket] Connected')
      setIsConnecting(false)
      setState((prev) => ({ ...prev, isConnected: true }))
    }

    ws.onmessage = handleMessage

    ws.onclose = (event) => {
      console.log('[WebSocket] Disconnected:', event.code, event.reason)
      setIsConnecting(false)
      setState((prev) => ({ ...prev, isConnected: false }))

      // Auto-reconnect if enabled and not a clean close
      if (autoReconnect && event.code !== 1000) {
        reconnectTimeoutRef.current = setTimeout(() => {
          console.log('[WebSocket] Attempting reconnect...')
          connect()
        }, 3000)
      }
    }

    ws.onerror = (error) => {
      console.error('[WebSocket] Error:', error)
      setIsConnecting(false)
    }

    wsRef.current = ws
  }, [url, handleMessage, autoReconnect])

  // Disconnect from WebSocket
  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }

    if (wsRef.current) {
      wsRef.current.close(1000, 'User disconnected')
      wsRef.current = null
    }

    setState((prev) => ({ ...prev, isConnected: false }))
  }, [])

  // Reset state
  const reset = useCallback(() => {
    disconnect()
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
          error: jobData.error?.message || null,
        }))

        // Stop polling if job is done
        if (jobData.status === 'completed' || jobData.status === 'failed') {
          setIsPolling(false)
          if (intervalRef.current) {
            clearInterval(intervalRef.current)
            intervalRef.current = null
          }

          if (jobData.status === 'completed' && onComplete) {
            onComplete(jobData.result)
          }
        }
      }
    } catch (error) {
      console.error('[Polling] Error:', error)
    }
  }, [url, propertyKey, onComplete])

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
        status: 'pending',
      })),
    })
  }, [])

  return {
    state,
    isPolling,
    reset,
  }
}
