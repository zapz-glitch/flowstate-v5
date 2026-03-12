'use client'

import { atom } from 'jotai'
import type { AnalysisState } from '@/types/analysis'
import { initialAnalysisState } from '@/types/analysis'
import type { AnalyzeData } from '@/app/(dashboard)/dashboard/analyze/actions'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ActiveAnalysis {
  jobId: string
  propertyKey: string
  streamUrl: string
  address: string
}

export interface AnalysisActions {
  startAnalysis: (params: ActiveAnalysis) => void
  clearAnalysis: () => void
  cancelAnalysis: () => void
  switchToPolling: () => void
  seedPartialData: (data: Record<string, unknown>) => void
}

const noopActions: AnalysisActions = {
  startAnalysis: () => { throw new Error('AnalysisBridge not mounted') },
  clearAnalysis: () => { throw new Error('AnalysisBridge not mounted') },
  cancelAnalysis: () => { throw new Error('AnalysisBridge not mounted') },
  switchToPolling: () => { throw new Error('AnalysisBridge not mounted') },
  seedPartialData: () => { throw new Error('AnalysisBridge not mounted') },
}

// ─── Primitive Atoms ────────────────────────────────────────────────────────

export const activeAnalysisAtom = atom<ActiveAnalysis | null>(null)
export const streamUrlAtom = atom<string | null>(null)
export const propertyKeyAtom = atom<string | null>(null)
export const usePollingAtom = atom<boolean>(false)
export const analysisResultAtom = atom<AnalyzeData | null>(null)
export const analysisStateAtom = atom<AnalysisState>(initialAnalysisState)
export const isConnectingAtom = atom<boolean>(false)
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
