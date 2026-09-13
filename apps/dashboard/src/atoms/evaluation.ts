'use client'

/**
 * Evaluation Atoms
 *
 * Single consolidated atom for evaluation state. Written once per render
 * cycle by useEvaluationSync, consumed by useEvaluation.
 */

import { atom } from 'jotai'
import type {
  ValuationData,
  CompsData,
  SubjectData,
  CompItem,
} from '@/app/(dashboard)/dashboard/analyze/actions'
import type { RecalcResult } from '@/lib/recalc'

// ─── Comp Override ─────────────────────────────────────────────────────────

export interface CompOverrideState {
  selectedCompKeys: Set<string>
  isManual: boolean
}

// ─── Callbacks ─────────────────────────────────────────────────────────────

export interface EvaluationCallbacks {
  onToggleComp: (key: string) => void
  onResetComps: () => void
  onOpenSettings: () => void
  onCompClick?: (comp: CompItem) => void
  onRunAiAnalysis?: () => void
  onUndoAiSelection?: () => void
}

// ─── Consolidated State ────────────────────────────────────────────────────

export interface EvaluationState {
  // Data
  subject: SubjectData | null | undefined
  displayValuation: ValuationData | undefined
  displayComps: CompsData | undefined
  isRecalculated: boolean
  recalcData: RecalcResult | null

  // Comp selection
  compOverride: CompOverrideState | null

  // Comp-selection feedback ("Notify") context — rules/fallback as applied
  feedbackContext: {
    appliedFilters?: Array<{ type: string; enabled: boolean; value: number; priority?: 'hard' | 'soft' }> | null
    fallbackUsed?: string | null
    fallbackReason?: string | null
    jobId?: string | null
    subjectAddress?: string | null
  } | null

  // Market research (from web search, arrives independently)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  marketContext: Record<string, any> | null

  // AI analysis report
  aiReport: { summary: string; selected: number; total: number; model: string } | null

  // UI state
  aiAnalyzing: boolean
  /** Whether the streaming pipeline is still running (property fetch → evaluation → LLM) */
  isStreaming: boolean

  // Callbacks
  callbacks: EvaluationCallbacks
}

const defaultCallbacks: EvaluationCallbacks = {
  onToggleComp: () => {},
  onResetComps: () => {},
  onOpenSettings: () => {},
  onCompClick: undefined,
}

export const evaluationStateAtom = atom<EvaluationState>({
  subject: null,
  displayValuation: undefined,
  displayComps: undefined,
  isRecalculated: false,
  recalcData: null,
  compOverride: null,
  feedbackContext: null,
  marketContext: null,
  aiReport: null,
  aiAnalyzing: false,
  isStreaming: false,
  callbacks: defaultCallbacks,
})
