'use client'

/**
 * useEvaluationSync — Hydrates the consolidated evaluation atom.
 *
 * Called once at the page level. Writes all evaluation state into a single
 * Jotai atom in one useEffect, avoiding the render-flicker problem of
 * writing 9 separate atoms post-render.
 */

import { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import type { SubjectData, ValuationData, CompsData, CompItem } from '@/app/(dashboard)/dashboard/analyze/actions'
import type { UseAnalysisEvaluationReturn } from '@/hooks/use-analysis-evaluation'
import { evaluationStateAtom } from '@/atoms/evaluation'

type EvaluationFields = Pick<
  UseAnalysisEvaluationReturn,
  'isRecalculated' | 'recalcData' | 'compOverride' | 'handleToggleComp' | 'handleResetComps'
>

interface SyncOptions {
  evaluation: EvaluationFields
  subject?: SubjectData | null
  displayValuation?: ValuationData
  effectiveComps?: CompsData
  aiAnalyzing?: boolean
  isStreaming?: boolean
  onOpenSettings: () => void
  onCompClick?: (comp: CompItem) => void
}

export function useEvaluationSync({
  evaluation,
  subject,
  displayValuation,
  effectiveComps,
  aiAnalyzing = false,
  isStreaming = false,
  onOpenSettings,
  onCompClick,
}: SyncOptions) {
  const setState = useSetAtom(evaluationStateAtom)

  useEffect(() => {
    setState({
      subject,
      displayValuation,
      displayComps: effectiveComps,
      isRecalculated: evaluation.isRecalculated,
      recalcData: evaluation.recalcData,
      compOverride: evaluation.compOverride,
      aiAnalyzing,
      isStreaming,
      callbacks: {
        onToggleComp: evaluation.handleToggleComp,
        onResetComps: evaluation.handleResetComps,
        onOpenSettings,
        onCompClick,
      },
    })
  }, [
    subject, displayValuation, effectiveComps,
    evaluation.isRecalculated, evaluation.recalcData, evaluation.compOverride,
    evaluation.handleToggleComp, evaluation.handleResetComps,
    aiAnalyzing, isStreaming, onOpenSettings, onCompClick, setState,
  ])
}
