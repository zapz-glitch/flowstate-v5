'use client'

import { atom } from 'jotai'
import type { AnalysisState } from '@/types/analysis'
import { initialAnalysisState } from '@/types/analysis'
import type { AnalyzeData } from '@/app/(dashboard)/dashboard/analyze/actions'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ActiveAnalysis {
  jobId: string
  address: string
}

export interface AnalysisActions {
  clearAnalysis: () => void
  cancelAnalysis: () => void
}

const noopActions: AnalysisActions = {
  clearAnalysis: () => { throw new Error('AnalysisBridge not mounted') },
  cancelAnalysis: () => { throw new Error('AnalysisBridge not mounted') },
}

// ─── Primitive Atoms ────────────────────────────────────────────────────────

export const activeAnalysisAtom = atom<ActiveAnalysis | null>(null)
export const analysisResultAtom = atom<AnalyzeData | null>(null)
export const analysisStateAtom = atom<AnalysisState>(initialAnalysisState)
export const analysisActionsAtom = atom<AnalysisActions>(noopActions)

// ─── Derived Atoms (read-only) ──────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const partialResultAtom = atom<Record<string, any> | null>((get) => {
  return get(analysisStateAtom).partialResult ?? null
})

export const displayDataAtom = atom<Partial<AnalyzeData> | null>((get) => {
  const result = get(analysisResultAtom)
  if (result) return result
  const partial = get(partialResultAtom)
  if (partial) return partial as Partial<AnalyzeData>
  return null
})
