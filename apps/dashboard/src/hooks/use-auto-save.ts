'use client'

/**
 * useAutoSave — Shared auto-save hook for analysis reports.
 *
 * Debounces evaluation changes and saves the report with updated comp selection,
 * applied settings, and valuation data. Used by both the analyze page and report page.
 */

import { useState, useEffect, useRef } from 'react'
import { updateSavedReport } from '@/lib/client-api'
import type { ValuationData, CompItem } from '@/app/(dashboard)/dashboard/analyze/actions'
import type { UseReportSettingsReturn } from '@/hooks/use-report-settings'
import type { RecalcResult } from '@/lib/recalc'

interface CompOverride {
  selectedCompKeys: Set<string>
  isManual: boolean
}

export interface AiReportData {
  summary: string
  selected: number
  total: number
  model: string
}

interface AutoSaveOptions {
  jobId: string | null | undefined
  analysisData: unknown | null
  displayValuation: ValuationData | undefined
  recalcData: RecalcResult | null
  compOverride: CompOverride | null
  settingsHook: UseReportSettingsReturn
  /** AI analysis report to persist with the saved report */
  aiReport?: AiReportData | null
  /** Original math-based comps before AI override (for undo) */
  preAiComps?: unknown | null
  /** Called after successful save (e.g. to reload history) */
  onSaved?: () => void
}

export function useAutoSave({
  jobId,
  analysisData,
  displayValuation,
  recalcData,
  compOverride,
  settingsHook,
  aiReport,
  preAiComps,
  onSaved,
}: AutoSaveOptions) {
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const saveTimerRef = useRef<NodeJS.Timeout | null>(null)
  const lastSavedRef = useRef<string | null>(null)
  const initialLoadRef = useRef(true)
  const onSavedRef = useRef(onSaved)
  onSavedRef.current = onSaved

  useEffect(() => {
    if (!jobId || !analysisData || !displayValuation || !recalcData) return

    const fingerprint = JSON.stringify({
      arv: displayValuation.arv,
      buyPrice: displayValuation.buyPrice,
      rehabCost: displayValuation.rehabCost,
      rehabLevel: displayValuation.rehabLevel,
      projectedROI: displayValuation.projectedROI,
      proximityDeduction: recalcData.valuation.proximityDeduction,
      comps: compOverride?.selectedCompKeys ? Array.from(compOverride.selectedCompKeys).sort() : null,
      settings: JSON.stringify(settingsHook.settings),
      aiReport: aiReport ? JSON.stringify(aiReport) : null,
    })

    // On initial load, capture fingerprint without saving
    if (initialLoadRef.current) {
      lastSavedRef.current = fingerprint
      if (!settingsHook.settingsChanged) {
        initialLoadRef.current = false
      }
      return
    }

    if (fingerprint === lastSavedRef.current) return

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      setStatus('saving')

      const changes: string[] = []
      if (compOverride?.isManual) changes.push('Comp selection changed')
      if (settingsHook.settingsChanged) changes.push('Evaluation settings adjusted')
      if (recalcData.valuation.proximityDeduction > 0) changes.push('Proximity adjustment applied')

      const description = changes.length > 0 ? changes.join(', ') : 'Evaluation updated'

      try {
        // Patch fullResponseJson with updated settings
        let updatedJson: string | undefined
        if (analysisData) {
          const patched = { ...(analysisData as Record<string, unknown>) }

          // Patch comp selection
          if (compOverride?.selectedCompKeys && (patched.comps as { items?: CompItem[] })?.items) {
            const comps = patched.comps as { items: CompItem[]; [k: string]: unknown }
            patched.comps = {
              ...comps,
              items: comps.items.map((comp: CompItem, i: number) => {
                const key = comp.address || `comp-${i}`
                return { ...comp, isEnabled: compOverride.selectedCompKeys!.has(key) }
              }),
            }
          }

          // Patch appliedSettings
          const s = settingsHook.settings
          patched.appliedSettings = {
            ...((patched.appliedSettings as Record<string, unknown>) ?? {}),
            rehabLevelIndex: s.rehabLevelIndex,
            additionPlay: s.additionPlay ?? 0,
            filters: s.filters.map((f) => ({ type: f.type, enabled: f.enabled, value: f.value })),
            adjustments: s.adjustments.map((a) => ({ type: a.type, enabled: a.enabled, amount: a.amount, percent: a.percent })),
            dealParams: {
              closingCostsPercent: s.dealParams.closingCostsPercent,
              carryingCostsPercent: s.dealParams.carryingCostsPercent,
              wholesaleFee: s.dealParams.wholesaleFee,
            },
            majorItems: s.majorItems.map((m) => ({ id: m.id, enabled: m.enabled, cost: m.cost })),
            arvThresholdPercent: s.dealParams.arvThresholdPercent,
            asIsThresholdPercent: s.asIsThresholdPercent,
          }

          // Persist AI analysis report and pre-AI comps for undo
          if (aiReport) {
            patched.aiReport = aiReport
            if (preAiComps) patched.preAiComps = preAiComps
          } else {
            delete patched.aiReport
            delete patched.preAiComps
          }

          updatedJson = JSON.stringify(patched)
        }

        await updateSavedReport(jobId, {
          ...(updatedJson ? { fullResponseJson: updatedJson } : {}),
          arv: displayValuation.arv,
          maxAllowableOffer: displayValuation.buyPrice,
          estimatedRepairs: displayValuation.rehabCost,
          historyAction: 'evaluation_update',
          historyDescription: description,
          historyChanges: {
            arv: displayValuation.arv,
            buyPrice: displayValuation.buyPrice,
            rehabCost: displayValuation.rehabCost,
            selectedComps: compOverride?.selectedCompKeys ? Array.from(compOverride.selectedCompKeys) : null,
            proximityDeduction: recalcData.valuation.proximityDeduction,
          },
        })
        lastSavedRef.current = fingerprint
        setStatus('saved')
        setTimeout(() => setStatus('idle'), 2000)
        onSavedRef.current?.()
      } catch {
        setStatus('idle')
      }
    }, 2000)

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [jobId, analysisData, displayValuation, compOverride, recalcData, settingsHook.settings, settingsHook.settingsChanged, aiReport])

  // Reset on new analysis
  const reset = () => {
    initialLoadRef.current = true
    lastSavedRef.current = null
  }

  return { autoSaveStatus: status, resetAutoSave: reset }
}
