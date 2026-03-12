'use client'

import { useAtomValue } from 'jotai'
import {
  activeAnalysisAtom,
  analysisStateAtom,
  analysisResultAtom,
  partialResultAtom,
  displayDataAtom,
  isConnectingAtom,
  usePollingAtom,
  analysisActionsAtom,
} from '@/atoms/analysis'

/**
 * Consumer hook for analysis state — drop-in replacement for the old useAnalysis() from context.
 * Reads from Jotai atoms; no Context provider required.
 */
export function useAnalysis() {
  const activeAnalysis = useAtomValue(activeAnalysisAtom)
  const analysisState = useAtomValue(analysisStateAtom)
  const analysisResult = useAtomValue(analysisResultAtom)
  const partialResult = useAtomValue(partialResultAtom)
  const displayData = useAtomValue(displayDataAtom)
  const isConnecting = useAtomValue(isConnectingAtom)
  const usePolling = useAtomValue(usePollingAtom)
  const actions = useAtomValue(analysisActionsAtom)

  return {
    activeAnalysis,
    analysisState,
    analysisResult,
    partialResult,
    displayData,
    isConnecting,
    usePolling,
    ...actions,
  }
}
