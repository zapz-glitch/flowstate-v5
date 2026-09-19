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
import type { AnalyzeData, JevOutcomeData, SubjectData, ValuationData, CompsData, CompItem } from '@/app/(dashboard)/dashboard/analyze/actions'
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
  feedback?: {
    appliedFilters?: Array<{ type: string; enabled: boolean; value: number; priority?: 'hard' | 'soft' }> | null
    fallbackUsed?: string | null
    fallbackReason?: string | null
    jobId?: string | null
    subjectAddress?: string | null
  } | null
  aiAnalyzing?: boolean
  isStreaming?: boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  marketContext?: Record<string, any> | null
  aiReport?: { summary: string; selected: number; total: number; model: string } | null
  jevOutcome?: JevOutcomeData | null
  onOpenSettings: () => void
  onCompClick?: (comp: CompItem) => void
  onRunAiAnalysis?: () => void
  onUndoAiSelection?: () => void
  onFeedbackSubmitted?: (type: 'validate' | 'improve') => void
  onPermitsPulled?: (analysis: AnalyzeData) => void
}

export function useEvaluationSync({
  evaluation,
  subject,
  displayValuation,
  effectiveComps,
  feedback = null,
  aiAnalyzing = false,
  isStreaming = false,
  marketContext = null,
  aiReport = null,
  jevOutcome = null,
  onOpenSettings,
  onCompClick,
  onRunAiAnalysis,
  onUndoAiSelection,
  onFeedbackSubmitted,
  onPermitsPulled,
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
      feedbackContext: feedback ?? null,
      marketContext,
      aiReport,
      jevOutcome,
      aiAnalyzing,
      isStreaming,
      callbacks: {
        onToggleComp: evaluation.handleToggleComp,
        onResetComps: evaluation.handleResetComps,
        onOpenSettings,
        onCompClick,
        onRunAiAnalysis,
        onUndoAiSelection,
        onFeedbackSubmitted,
        onPermitsPulled,
      },
    })
  }, [
    subject, displayValuation, effectiveComps,
    evaluation.isRecalculated, evaluation.recalcData, evaluation.compOverride,
    evaluation.handleToggleComp, evaluation.handleResetComps,
    feedback,
    aiAnalyzing, isStreaming, marketContext, aiReport, jevOutcome, onOpenSettings, onCompClick, onRunAiAnalysis, onUndoAiSelection, onFeedbackSubmitted, onPermitsPulled, setState,
  ])
}
