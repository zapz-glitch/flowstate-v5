'use client'

import { useCallback, useEffect } from 'react'
import { useSetAtom } from 'jotai'
import {
  activeAnalysisAtom,
  analysisResultAtom,
  analysisStateAtom,
  analysisActionsAtom,
} from '@/atoms/analysis'
import { initialAnalysisState } from '@/types/analysis'

/**
 * Bridge hook: provides clearAnalysis and cancelAnalysis actions via Jotai.
 * Must be rendered exactly once in the component tree (inside AnalysisBridge).
 */
export function useAnalysisBridge() {
  const setActiveAnalysis = useSetAtom(activeAnalysisAtom)
  const setAnalysisResult = useSetAtom(analysisResultAtom)
  const setAnalysisState = useSetAtom(analysisStateAtom)
  const setActions = useSetAtom(analysisActionsAtom)

  const clearAnalysis = useCallback(() => {
    setActiveAnalysis(null)
    setAnalysisResult(null)
    setAnalysisState(initialAnalysisState)
  }, [setActiveAnalysis, setAnalysisResult, setAnalysisState])

  const cancelAnalysis = useCallback(() => {
    setActiveAnalysis(null)
    setAnalysisState(initialAnalysisState)
  }, [setActiveAnalysis, setAnalysisState])

  useEffect(() => {
    setActions({ clearAnalysis, cancelAnalysis })
  }, [clearAnalysis, cancelAnalysis, setActions])
}
