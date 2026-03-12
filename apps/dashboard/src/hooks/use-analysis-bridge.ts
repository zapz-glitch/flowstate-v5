'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useAtom, useSetAtom } from 'jotai'
import {
  activeAnalysisAtom,
  streamUrlAtom,
  propertyKeyAtom,
  usePollingAtom,
  analysisResultAtom,
  analysisStateAtom,
  isConnectingAtom,
  analysisActionsAtom,
  type ActiveAnalysis,
} from '@/atoms/analysis'
import { useAnalysisSSE, useAnalysisPolling } from '@/hooks/use-analysis-sse'
import type { AnalyzeData } from '@/app/(dashboard)/dashboard/analyze/actions'
import { getJobStatus } from '@/app/(dashboard)/dashboard/analyze/actions'

/**
 * Bridge hook: wires imperative SSE/polling hooks into Jotai atoms.
 * Must be rendered exactly once in the component tree (inside AnalysisBridge).
 */
export function useAnalysisBridge() {
  const [activeAnalysis, setActiveAnalysis] = useAtom(activeAnalysisAtom)
  const [streamUrl, setStreamUrl] = useAtom(streamUrlAtom)
  const [propertyKey, setPropertyKey] = useAtom(propertyKeyAtom)
  const [usePolling, setUsePolling] = useAtom(usePollingAtom)
  const [analysisResult, setAnalysisResult] = useAtom(analysisResultAtom)
  const setAnalysisState = useSetAtom(analysisStateAtom)
  const setIsConnecting = useSetAtom(isConnectingAtom)
  const setActions = useSetAtom(analysisActionsAtom)

  // Handle SSE completion
  const handleComplete = useCallback(async (_completionData: unknown) => {
    // result_ready event should have already populated analysisResult
  }, [])

  // Handle SSE error
  const handleError = useCallback((_error: string) => {
    // Error is tracked in analysisState
  }, [])

  // SSE hook
  const {
    state: sseState,
    connect: sseConnect,
    disconnect: sseDisconnect,
    reset: sseReset,
    isConnecting,
  } = useAnalysisSSE({
    url: streamUrl,
    propertyKey,
    onComplete: handleComplete,
    onError: handleError,
    onFallbackToPolling: () => setUsePolling(true),
  })

  // Polling fallback
  const { state: pollState, reset: pollReset } = useAnalysisPolling({
    url: activeAnalysis?.jobId ? `/api/analyze/jobs/${activeAnalysis.jobId}` : null,
    propertyKey,
    enabled: usePolling && activeAnalysis !== null && sseState.status !== 'completed' && sseState.status !== 'failed',
    onComplete: handleComplete,
  })

  // Sync SSE/polling state -> atom
  const currentState = usePolling ? pollState : sseState
  useEffect(() => {
    setAnalysisState(currentState)
  }, [currentState, setAnalysisState])

  // Sync isConnecting -> atom
  useEffect(() => {
    setIsConnecting(isConnecting)
  }, [isConnecting, setIsConnecting])

  // Track result from SSE state (populated by result_ready event)
  useEffect(() => {
    if (currentState.result && !analysisResult) {
      setAnalysisResult(currentState.result as AnalyzeData)
    }
  }, [currentState.result, analysisResult, setAnalysisResult])

  // If job completed but we never got result_ready, fetch via getJobStatus
  useEffect(() => {
    if (currentState.status === 'completed' && !analysisResult && activeAnalysis) {
      getJobStatus(activeAnalysis.jobId, activeAnalysis.propertyKey).then((statusResult) => {
        if (statusResult.success && statusResult.data?.result) {
          setAnalysisResult(statusResult.data.result)
        }
      })
    }
  }, [currentState.status, analysisResult, activeAnalysis, setAnalysisResult])

  // Auto-connect to SSE when streamUrl is available
  const sseConnectRef = useRef(sseConnect)
  sseConnectRef.current = sseConnect

  useEffect(() => {
    if (streamUrl && propertyKey && !usePolling) {
      sseConnectRef.current()
    }
  }, [streamUrl, propertyKey, usePolling])

  // ── Actions ──

  const startAnalysis = useCallback(
    (params: ActiveAnalysis) => {
      sseReset()
      pollReset()
      setAnalysisResult(null)
      setUsePolling(false)
      setActiveAnalysis(params)
      setStreamUrl(params.streamUrl)
      setPropertyKey(params.propertyKey)
    },
    [sseReset, pollReset, setAnalysisResult, setUsePolling, setActiveAnalysis, setStreamUrl, setPropertyKey]
  )

  const clearAnalysis = useCallback(() => {
    sseDisconnect()
    sseReset()
    pollReset()
    setActiveAnalysis(null)
    setStreamUrl(null)
    setPropertyKey(null)
    setAnalysisResult(null)
    setUsePolling(false)
  }, [sseDisconnect, sseReset, pollReset, setActiveAnalysis, setStreamUrl, setPropertyKey, setAnalysisResult, setUsePolling])

  const cancelAnalysis = useCallback(() => {
    sseDisconnect()
    setActiveAnalysis(null)
    setStreamUrl(null)
    setPropertyKey(null)
    setUsePolling(false)
  }, [sseDisconnect, setActiveAnalysis, setStreamUrl, setPropertyKey, setUsePolling])

  const switchToPolling = useCallback(() => {
    sseDisconnect()
    setUsePolling(true)
  }, [sseDisconnect, setUsePolling])

  const seedPartialData = useCallback((data: Record<string, unknown>) => {
    setAnalysisState((prev) => ({
      ...prev,
      partialResult: {
        ...(prev.partialResult ?? {}),
        ...data,
      },
    }))
  }, [setAnalysisState])

  // Register actions into atom so consumers can access them
  useEffect(() => {
    setActions({ startAnalysis, clearAnalysis, cancelAnalysis, switchToPolling, seedPartialData })
  }, [startAnalysis, clearAnalysis, cancelAnalysis, switchToPolling, seedPartialData, setActions])
}
