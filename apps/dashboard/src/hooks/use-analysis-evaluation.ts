'use client'

/**
 * Unified Analysis Evaluation Hook
 *
 * Single source of truth for all evaluation display logic:
 * comp override state, display valuation/comps merging, recalc integration,
 * sticky bar observer, and settings panel state.
 *
 * Used by both the analyze page and the report page.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { toast } from 'sonner'
import type {
  AnalyzeData,
  ValuationData,
  CompsData,
} from '@/app/(dashboard)/dashboard/analyze/actions'
import { getCompKey } from '@/components/analysis/format-helpers'
import { useReportSettings, type UseReportSettingsReturn } from '@/hooks/use-report-settings'
import { recalculateValuationFromComps, type RecalcResult } from '@/lib/recalc'
import { recalculateReportComps } from '@/lib/client-api'

// ─── Types ──────────────────────────────────────────────────────────────────

interface OverrideState {
  selectedCompKeys: Set<string>
  isManual: boolean
}

export interface UseAnalysisEvaluationInput {
  /** The analysis data — null until loaded */
  data: AnalyzeData | null
  /** IntersectionObserver rootMargin for sticky bar (default: '-60px 0px 0px 0px') */
  stickyBarRootMargin?: string
  /** When true, freeze displayValuation until AI analysis completes */
  aiAnalyzing?: boolean
}

export interface UseAnalysisEvaluationReturn {
  authoritativeData: AnalyzeData | null
  // Settings (pass-through from useReportSettings)
  settingsHook: UseReportSettingsReturn
  recalcData: RecalcResult | null

  // Comp override
  compOverride: OverrideState | null
  handleToggleComp: (key: string) => void
  handleResetComps: () => void

  // Computed display data
  displayValuation: ValuationData | undefined
  displayComps: CompsData | undefined
  effectiveComps: CompsData | undefined
  isRecalculated: boolean

  // Sticky bar
  valuationCardRef: React.RefObject<HTMLDivElement>
  showStickyBar: boolean

  // Settings panel
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useAnalysisEvaluation({
  data: inputData,
  stickyBarRootMargin = '-60px 0px 0px 0px',
  aiAnalyzing = false,
}: UseAnalysisEvaluationInput): UseAnalysisEvaluationReturn {
  const [serverSelection, setServerSelection] = useState<{ source: AnalyzeData; analysis: AnalyzeData; isManual: boolean } | null>(null)
  const [selectionPending, setSelectionPending] = useState(false)
  const selectionRequestRef = useRef(false)
  const currentInputRef = useRef(inputData)
  currentInputRef.current = inputData
  const activeSelection = serverSelection?.source === inputData ? serverSelection : null
  const data = activeSelection?.analysis ?? inputData
  const pythonAuthoritative = data?.evaluationEngine === 'python-v4'
  // Settings panel open/close
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Comp override state
  const [compOverride, setCompOverride] = useState<OverrideState | null>(null)
  // Ref tracks isManual to avoid stale closures in the sync effect
  const isManualRef = useRef(false)

  // Compose useReportSettings
  const settingsHook = useReportSettings(data)
  const { recalcData, settingsChanged } = settingsHook

  const applyServerSelection = useCallback(async (selectedCompIds: string[] | null) => {
    if (selectionRequestRef.current || !inputData || !data) return
    const jobId = data.meta?.analysisId
    if (!jobId) {
      toast.error('This report cannot be recalculated. Run a new analysis first.')
      return
    }
    selectionRequestRef.current = true
    setSelectionPending(true)
    try {
      const analysis = await recalculateReportComps(jobId, selectedCompIds, data.evaluationRevision ?? 0)
      const status = (analysis as AnalyzeData & { pythonEvaluation?: { status?: string } } | null)?.pythonEvaluation?.status
      const validComps = Array.isArray(analysis?.comps?.items)
        && analysis.comps.items.every(comp => comp != null && typeof comp.id === 'string' && typeof comp.isEnabled === 'boolean')
      const insufficient = status === 'INSUFFICIENT_COMPS' && analysis?.valuation === null
        && validComps && analysis.comps!.items!.every(comp => !comp.isEnabled)
      const valued = status !== 'INSUFFICIENT_COMPS' && analysis?.valuation != null
        && typeof analysis.valuation.arv === 'number' && Number.isFinite(analysis.valuation.arv) && analysis.valuation.arv > 0
        && Number.isFinite(analysis.valuation.buyPrice)
      if (analysis?.evaluationEngine !== 'python-v4' || !validComps || (!insufficient && !valued)
        || analysis.meta?.analysisId !== jobId || analysis.evaluationRevision !== (data.evaluationRevision ?? 0) + 1) {
        throw new Error('The server returned an incomplete evaluation. Your previous result is unchanged.')
      }
      if (currentInputRef.current === inputData) {
        setServerSelection({ source: inputData, analysis, isManual: selectedCompIds !== null })
        toast.info(selectedCompIds === null
          ? 'Python V4 automatic comparable selection restored.'
          : 'Operator-selected comparables. Python V4 recalculated this preliminary evaluation.')
      }
    } catch (error) {
      if (currentInputRef.current === inputData) toast.error(error instanceof Error ? error.message : 'Comp selection could not be saved. Your previous result is unchanged.')
    } finally {
      selectionRequestRef.current = false
      setSelectionPending(false)
    }
  }, [data, inputData])

  // Initialize comp override when data arrives
  useEffect(() => {
    if (data?.comps?.items) {
      const keys = new Set(
        data.comps.items
          .filter((c) => c.isEnabled === true)
          .map((c, i) => getCompKey(c, i))
      )
      isManualRef.current = false
      setCompOverride({ selectedCompKeys: keys, isManual: false })
    }
  }, [data?.comps?.items])

  // Sync comp selection when user changes evaluation settings (recalc produces new filter results)
  // Skip when: manual selection active, or when data just changed (init effect handles that)
  const prevDataRef = useRef(data?.comps?.items)
  useEffect(() => {
    if (!recalcData || !data?.comps?.items) return
    if (isManualRef.current) return
    // If data items ref changed, the init effect already handled it — skip
    if (prevDataRef.current !== data.comps.items) {
      prevDataRef.current = data.comps.items
      return
    }

    const keys = new Set<string>()
    data.comps.items.forEach((comp, i) => {
      const ev = recalcData.compEvaluations[i]
      if (ev?.isEnabled) {
        keys.add(getCompKey(comp, i))
      }
    })
    setCompOverride({ selectedCompKeys: keys, isManual: false })
  }, [recalcData, data?.comps?.items])

  // Toggle a single comp
  const handleToggleComp = useCallback((key: string) => {
    if (pythonAuthoritative) {
      if (selectionRequestRef.current) return
      const items = data?.comps?.items ?? []
      const target = items.find((comp, index) => getCompKey(comp, index) === key)
      if (!target?.id || items.some(comp => comp.isEnabled && !comp.id)) {
        toast.error('This report has no saved comparable IDs. Run a new analysis first.')
        return
      }
      const selected = new Set(items.filter(comp => comp.isEnabled).map(comp => comp.id!))
      if (selected.has(target.id)) selected.delete(target.id)
      else selected.add(target.id)
      if (!selected.size) {
        toast.error('Keep at least one comparable selected for ARV.')
        return
      }
      void applyServerSelection([...selected])
      return
    }
    isManualRef.current = true
    setCompOverride((prev) => {
      if (!prev) return prev
      const next = new Set(prev.selectedCompKeys)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return { selectedCompKeys: next, isManual: true }
    })
  }, [pythonAuthoritative, data, applyServerSelection])

  // Reset to original enabled comps
  const handleResetComps = useCallback(() => {
    if (pythonAuthoritative) {
      void applyServerSelection(null)
      return
    }
    isManualRef.current = false
    if (data?.comps?.items) {
      const keys = new Set(
        data.comps.items
          .filter((c) => c.isEnabled === true)
          .map((c, i) => getCompKey(c, i))
      )
      setCompOverride({ selectedCompKeys: keys, isManual: false })
    }
  }, [data?.comps?.items, pythonAuthoritative, applyServerSelection])

  // Freeze valuation ref: snapshot the valuation when AI analysis starts
  const frozenValuationRef = useRef<ValuationData | undefined>(undefined)
  const wasAiAnalyzingRef = useRef(false)

  // Build display valuation: always use recalcData, then apply manual comp override
  const computedValuation = useMemo((): ValuationData | undefined => {
    if (!data?.valuation) return undefined
    if (pythonAuthoritative) return data.valuation

    // Start from recalcData (always available once data loads) or original
    let base: ValuationData
    if (recalcData) {
      const v = recalcData.valuation
      base = {
        ...data.valuation,
        arv: v.arv,
        arvPerSqft: v.arvPerSqft,
        buyPrice: v.buyPrice,
        buyPricePercent: v.buyPricePercent,
        rehabCost: v.rehabCost,
        baseRehabCost: v.baseRehabCost,
        majorItemsCost: v.majorItemsCost,
        rehabLevel: v.rehabLevel,
        rehabPerSqft: v.rehabPerSqft,
        totalCosts: v.totalCosts,
        totalInvestment: v.totalInvestment,
        projectedProfit: v.projectedProfit,
        projectedROI: v.projectedROI,
        wholesalePrice: v.wholesalePrice,
        closingCosts: v.closingCosts,
        carryingCosts: v.carryingCosts,
        rehabLevelEstimates: v.rehabLevelEstimates,
      }
    } else {
      base = data.valuation
    }

    // If comp override is manual, recalculate on top using user's full settings
    if (compOverride?.isManual && data?.comps?.items && data?.subject) {
      return recalculateValuationFromComps(
        data.comps.items,
        data.subject,
        compOverride.selectedCompKeys,
        base,
        settingsHook.settings
      )
    }

    return base
  }, [data, recalcData, compOverride, settingsHook.settings, pythonAuthoritative])

  // Freeze valuation during AI analysis — show last known valuation until AI completes
  // When AI starts: snapshot current valuation. When AI ends: release to show new valuation.
  if (aiAnalyzing && !wasAiAnalyzingRef.current) {
    // AI just started — freeze current valuation
    frozenValuationRef.current = computedValuation
  }
  if (!aiAnalyzing && wasAiAnalyzingRef.current) {
    // AI just finished — clear frozen value
    frozenValuationRef.current = undefined
  }
  wasAiAnalyzingRef.current = aiAnalyzing

  const displayValuation = pythonAuthoritative ? computedValuation
    : aiAnalyzing ? (frozenValuationRef.current ?? computedValuation) : computedValuation

  // Build display comps: map recalcData comp evaluations onto original items
  const displayComps = useMemo((): CompsData | undefined => {
    if (pythonAuthoritative) return selectionPending && data?.comps
      ? { ...data.comps, items: data.comps.items?.map(comp => ({ ...comp, selectionPending: true })) }
      : data?.comps
    if (!recalcData || !data?.comps) return data?.comps

    const items = (data.comps.items || []).map((comp, i) => {
      const ev = recalcData.compEvaluations[i]
      if (!ev) return comp
      return {
        ...comp,
        isEnabled: ev.isEnabled,
        compGroup: ev.compGroup,
        pricePercentile: ev.pricePercentile,
        disableReasons: ev.disableReasons,
        adjustedPrice: ev.adjustedPrice,
        appraisalRules: {
          passedFilters: ev.isEnabled,
          totalAdjustment: ev.totalAdjustment,
          filters: ev.filterResults.map((f) => ({
            type: f.type,
            passed: f.passed,
            reason: f.reason,
            actualValue: f.actualValue,
            threshold: f.threshold,
          })),
          adjustments: ev.adjustmentResults.map((a) => ({
            type: a.type,
            applied: a.applied,
            amount: a.amount,
            reason: a.reason,
          })),
        },
      }
    })

    // When user manually selects comps, recompute stats from selected comps
    let { avgPricePerSqft, medianPrice, enabledCount, disabledCount } = recalcData
    if (compOverride?.isManual) {
      const compsItems = data.comps?.items || []
      const selected = items.filter((_, i) => compOverride.selectedCompKeys.has(getCompKey(compsItems[i], i)))
      enabledCount = selected.length
      disabledCount = items.length - enabledCount

      if (selected.length > 0) {
        // Avg $/sqft from selected comps
        const ppsqft = selected
          .map((c) => {
            const price = c.adjustedPrice ?? c.salePrice
            const sqft = c.squareFeet
            return price != null && price > 0 && sqft != null && sqft > 0 ? price / sqft : null
          })
          .filter((v): v is number => v != null)
        avgPricePerSqft = ppsqft.length > 0
          ? Math.round(ppsqft.reduce((a, b) => a + b, 0) / ppsqft.length)
          : null

        // Median sale price from selected comps
        const prices = selected
          .map((c) => c.salePrice)
          .filter((p): p is number => p != null)
          .sort((a, b) => a - b)
        if (prices.length > 0) {
          const mid = Math.floor(prices.length / 2)
          medianPrice = prices.length % 2 !== 0
            ? prices[mid]
            : Math.round((prices[mid - 1] + prices[mid]) / 2)
        } else {
          medianPrice = null
        }
      } else {
        avgPricePerSqft = null
        medianPrice = null
      }
    }

    return {
      ...data.comps,
      count: items.length,
      enabledCount,
      disabledCount,
      avgPricePerSqft,
      medianPrice,
      items,
    }
  }, [recalcData, data?.comps, compOverride, pythonAuthoritative, selectionPending])

  const isRecalculated = !pythonAuthoritative && (settingsChanged || (compOverride?.isManual ?? false))
  const effectiveComps = displayComps ?? data?.comps
  const authoritativeOverride = useMemo(() => pythonAuthoritative && data?.comps?.items ? {
    selectedCompKeys: new Set(data.comps.items.flatMap((comp, index) => comp.isEnabled ? [getCompKey(comp, index)] : [])),
    isManual: activeSelection?.isManual ?? data.manualCompSelection != null,
  } : null, [pythonAuthoritative, data?.comps?.items, data?.manualCompSelection, activeSelection?.isManual])

  // Sticky bar IntersectionObserver
  const valuationCardRef = useRef<HTMLDivElement>(null)
  const [showStickyBar, setShowStickyBar] = useState(false)

  const hasValuation = displayValuation != null
  useEffect(() => {
    const el = valuationCardRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        // Show sticky bar when valuation card scrolls above the viewport top
        setShowStickyBar(!entry.isIntersecting)
      },
      { threshold: 0, rootMargin: stickyBarRootMargin }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [hasValuation, stickyBarRootMargin])

  return {
    authoritativeData: data,
    settingsHook,
    recalcData,
    compOverride: authoritativeOverride ?? compOverride,
    handleToggleComp,
    handleResetComps,
    displayValuation,
    displayComps,
    effectiveComps,
    isRecalculated,
    valuationCardRef,
    showStickyBar,
    settingsOpen,
    setSettingsOpen,
  }
}
