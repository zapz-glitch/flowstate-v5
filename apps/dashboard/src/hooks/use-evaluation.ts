'use client'

/**
 * useEvaluation — Consumer hook for evaluation state.
 *
 * Any analysis display component can call this to access evaluation data,
 * comp selection state, and callbacks without prop drilling.
 *
 * Reads from a single consolidated atom written by useEvaluationSync.
 */

import { useAtomValue } from 'jotai'
import { evaluationStateAtom } from '@/atoms/evaluation'

export function useEvaluation() {
  const state = useAtomValue(evaluationStateAtom)

  return {
    // Data
    subject: state.subject,
    displayValuation: state.displayValuation,
    displayComps: state.displayComps,
    isRecalculated: state.isRecalculated,
    recalcData: state.recalcData,

    // Comp selection
    compOverride: state.compOverride,

    // UI state
    aiAnalyzing: state.aiAnalyzing,

    // Callbacks
    onToggleComp: state.callbacks.onToggleComp,
    onResetComps: state.callbacks.onResetComps,
    onOpenSettings: state.callbacks.onOpenSettings,
    onCompClick: state.callbacks.onCompClick,
  }
}
