'use client'

import { useAtomValue } from 'jotai'
import {
  activeAnalysisAtom,
  analysisStateAtom,
  analysisResultAtom,
  displayDataAtom,
  analysisActionsAtom,
} from '@/atoms/analysis'

/**
 * Consumer hook for analysis state.
 * Reads from Jotai atoms; no Context provider required.
 */
export function useAnalysis() {
  const activeAnalysis = useAtomValue(activeAnalysisAtom)
  const analysisState = useAtomValue(analysisStateAtom)
  const analysisResult = useAtomValue(analysisResultAtom)
  const displayData = useAtomValue(displayDataAtom)
  const actions = useAtomValue(analysisActionsAtom)

  return {
    activeAnalysis,
    analysisState,
    analysisResult,
    displayData,
    ...actions,
  }
}
