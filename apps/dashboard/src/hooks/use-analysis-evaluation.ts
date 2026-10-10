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
  CompItem,
} from '@/app/(dashboard)/dashboard/analyze/actions'
import { getCompKey } from '@/components/analysis/format-helpers'
import { useReportSettings, type UseReportSettingsReturn } from '@/hooks/use-report-settings'
import { recalculateValuationFromComps, type RecalcResult } from '@/lib/recalc'
import { recalculateReportComps } from '@/lib/client-api'

// ─── Types ──────────────────────────────────────────────────────────────────

interface OverrideState {
  selectedCompKeys: Set<string>
  isManual: boolean
  /** Reviewer tier pins — compId → 'arv'|'as_is'. An ARV pin admits a
   *  non-evidence comp into the ARV pool; an as_is pin excludes one. */
  tierPins?: Record<string, 'arv' | 'as_is'>
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
  /** Reviewer tier pin — feeds client recalc; persistence stays in the caller */
  handlePinTier: (compId: string, tier: 'arv' | 'as_is' | null) => void

  // Computed display data
  displayValuation: ValuationData | undefined
  displayComps: CompsData | undefined
  effectiveComps: CompsData | undefined
  isRecalculated: boolean

  // Sticky bar
  valuationCardRef: React.RefObject<HTMLDivElement | null>
  showStickyBar: boolean

  // Settings panel
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void
}

// ─── Hook ───────────────────────────────────────────────────────────────────

/**
 * Is this comp's box checked? A checked box means "this sale is in the ARV
 * calculation". Fresh from the server that is the anchor and the other
 * drivers, not every comp that passed the rules. Once the user has changed
 * the selection, the server's enabled set IS their selection.
 */
function isCheckedForArv(
  comp: { isEnabled?: boolean; bRole?: string | null },
  items: Array<{ bRole?: string | null }>,
  manual: boolean,
): boolean {
  if (comp.isEnabled !== true) return false
  if (manual) return true
  const hasRoles = items.some((c) => c.bRole === 'anchor' || c.bRole === 'driver')
  return hasRoles ? comp.bRole === 'anchor' || comp.bRole === 'driver' : true
}

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
  const pythonAuthoritative = data?.evaluationEngine === 'python-v4' || data?.evaluationEngine === 'ts-v5'

  // Optimistic comp selection — the click flips the box (and the map pin)
  // the same frame; the server recalculation settles the authoritative
  // result behind it. A second click while one is in flight queues —
  // the latest selection wins, nothing is dropped.
  const [optimisticSel, setOptimisticSel] = useState<{ source: AnalyzeData; ids: Set<string>; isManual: boolean } | null>(null)
  // Ref mirror — click handlers can run before the state re-render; the
  // next click must chain on what the user just did, not on a stale read.
  const optimisticSelRef = useRef<{ source: AnalyzeData; ids: Set<string>; isManual: boolean } | null>(null)
  const applyOptimistic = useCallback((sel: { source: AnalyzeData; ids: Set<string>; isManual: boolean } | null) => {
    optimisticSelRef.current = sel
    setOptimisticSel(sel)
  }, [])
  const queuedSelRef = useRef<{ ids: string[] | null; source: AnalyzeData } | undefined>(undefined)
  const [settleTick, setSettleTick] = useState(0)
  // Revision/jobId reads must reflect the newest settled data — a queued
  // call fires after the previous response landed, so the expected
  // revision has already moved.
  const dataRef = useRef(data)
  dataRef.current = data
  // Optimistic overlay only applies to the report it was made on — a new
  // input (navigation, SSE swap) makes the queued/optimistic state stale.
  const activeOptimistic = optimisticSel?.source === inputData ? optimisticSel : null
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
    if (selectionRequestRef.current || !inputData) return
    const base = dataRef.current
    if (!base) return
    const jobId = base.meta?.analysisId
    if (!jobId) {
      applyOptimistic(null)
      toast.error('This report cannot be recalculated. Run a new analysis first.')
      return
    }
    const expectedRevision = base.evaluationRevision ?? 0
    selectionRequestRef.current = true
    setSelectionPending(true)
    try {
      const analysis = await recalculateReportComps(jobId, selectedCompIds, expectedRevision)
      const validComps = Array.isArray(analysis?.comps?.items)
        && analysis.comps.items.every(comp => comp != null && typeof comp.id === 'string' && typeof comp.isEnabled === 'boolean')
      const insufficient = (analysis?.valuation?.resultGrade === 'withheld' || analysis?.valuation == null)
        && validComps && analysis.comps!.items!.every(comp => !comp.isEnabled)
      const valued = analysis?.valuation?.resultGrade !== 'withheld' && analysis?.valuation != null
        && typeof analysis.valuation.arv === 'number' && Number.isFinite(analysis.valuation.arv) && analysis.valuation.arv > 0
        && Number.isFinite(analysis.valuation.buyPrice)
      if (!['python-v4', 'ts-v5'].includes(analysis?.evaluationEngine ?? '') || !validComps || (!insufficient && !valued)
        || analysis.meta?.analysisId !== jobId || analysis.evaluationRevision !== expectedRevision + 1) {
        throw new Error('The server returned an incomplete evaluation. Your previous result is unchanged.')
      }
      // Settled — drop the overlay unless a newer selection is already
      // queued behind this response.
      if (queuedSelRef.current === undefined) applyOptimistic(null)
      if (currentInputRef.current === inputData) {
        setServerSelection({ source: inputData, analysis, isManual: selectedCompIds !== null })
        toast.info(selectedCompIds === null
          ? 'Automatic comparable selection restored.'
          : 'Operator-selected comparables. The server recalculated this evaluation.')
      }
    } catch (error) {
      // Failed while nothing newer is queued → drop the optimistic overlay,
      // the UI reverts to the last settled server state.
      if (queuedSelRef.current === undefined) applyOptimistic(null)
      if (currentInputRef.current === inputData) toast.error(error instanceof Error ? error.message : 'Comp selection could not be saved. Your previous result is unchanged.')
    } finally {
      selectionRequestRef.current = false
      setSelectionPending(false)
      setSettleTick((t) => t + 1)
    }
  }, [inputData, applyOptimistic])

  // Drain the queued selection after the in-flight call settles — by the
  // time this runs the response's data has committed, so the queued call
  // sends the fresh expectedRevision (a stale one earns a 409).
  useEffect(() => {
    if (selectionRequestRef.current) return
    const next = queuedSelRef.current
    queuedSelRef.current = undefined
    // Navigated to a different report while in flight — drop the queued
    // selection; it names comps that don't exist here.
    if (next === undefined || next.source !== inputData) return
    void applyServerSelection(next.ids)
  }, [settleTick, inputData, applyServerSelection])

  // Default selection = ARV evidence only — transitional/floor comps stay
  // listed but unselected (they never feed the ARV number).
  const arvDefaultKeys = (items: CompItem[]): Set<string> => new Set(
    items
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.isEnabled === true && (c.classification?.type === 'after_renovation' || c.userTier === 'arv'))
      .map(({ c, i }) => getCompKey(c, i))
  )

  // Initialize comp override when data arrives
  useEffect(() => {
    if (data?.comps?.items) {
      isManualRef.current = false
      // Keep the optimistic overlay while a newer selection is still in
      // flight or queued — clearing here would flicker the user's latest
      // click back to an older server state before the final one lands.
      if (!selectionRequestRef.current && queuedSelRef.current === undefined) applyOptimistic(null)
      setCompOverride({ selectedCompKeys: arvDefaultKeys(data.comps.items), isManual: false })
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
      if (ev?.isEnabled && (comp.classification?.type === 'after_renovation' || comp.userTier === 'arv')) {
        keys.add(getCompKey(comp, i))
      }
    })
    setCompOverride({ selectedCompKeys: keys, isManual: false })
  }, [recalcData, data?.comps?.items])

  // Toggle a single comp
  const handleToggleComp = useCallback((key: string) => {
    if (pythonAuthoritative) {
      const items = data?.comps?.items ?? []
      const target = items.find((comp, index) => getCompKey(comp, index) === key)
      if (!target?.id || items.some(comp => comp.isEnabled && !comp.id)) {
        toast.error('This report has no saved comparable IDs. Run a new analysis first.')
        return
      }
      // Start from the boxes that are checked now — the comps in the ARV —
      // then add or remove the one the user clicked. The optimistic set is
      // the base so a fast second click builds on the first, not on stale
      // server state.
      const opt = optimisticSelRef.current && optimisticSelRef.current.source === inputData ? optimisticSelRef.current : null
      const selected = new Set(opt?.ids ?? items.filter(comp => isCheckedForArv(comp, items, data?.manualCompSelection != null)).map(comp => comp.id!))
      if (selected.has(target.id)) selected.delete(target.id)
      else selected.add(target.id)
      if (!selected.size) {
        toast.error('Keep at least one comparable selected for ARV.')
        return
      }
      const ids = [...selected]
      applyOptimistic({ source: inputData!, ids: selected, isManual: true })
      if (selectionRequestRef.current) queuedSelRef.current = { ids, source: inputData! }
      else void applyServerSelection(ids)
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
  }, [pythonAuthoritative, data, inputData, applyServerSelection, applyOptimistic])

  // Reset to original enabled comps
  const handleResetComps = useCallback(() => {
    if (pythonAuthoritative) {
      // Optimistic reset mirrors the server's auto rule (anchor/driver —
      // all enabled when no roles) so the boxes move now, not on settle.
      const items = data?.comps?.items ?? []
      const hasRoles = items.some((c) => c.bRole === 'anchor' || c.bRole === 'driver')
      const auto = new Set(
        items.filter((c) => c.isEnabled === true && (!hasRoles || c.bRole === 'anchor' || c.bRole === 'driver')).map((c) => c.id!)
      )
      applyOptimistic({ source: inputData!, ids: auto, isManual: false })
      if (selectionRequestRef.current) queuedSelRef.current = { ids: null, source: inputData! }
      else void applyServerSelection(null)
      return
    }
    isManualRef.current = false
    if (data?.comps?.items) {
      setCompOverride({ selectedCompKeys: arvDefaultKeys(data.comps.items), isManual: false })
    }
  }, [data?.comps?.items, inputData, pythonAuthoritative, applyServerSelection])

  // Reviewer tier pin — 'arv' admits the comp into the ARV pool (and selects
  // it), 'as_is' excludes it from ARV evidence, null clears. Persistence to
  // /comp-tier stays in the caller — this feeds the client-side recalc.
  const handlePinTier = useCallback((compId: string, tier: 'arv' | 'as_is' | null) => {
    const items = data?.comps?.items
    if (!items) return
    isManualRef.current = true
    setCompOverride((prev) => {
      const base = prev ?? {
        selectedCompKeys: new Set(
          items.map((c, i) => ({ c, i }))
            .filter(({ c }) => c.isEnabled === true)
            .map(({ c, i }) => getCompKey(c, i))
        ),
        isManual: false,
        tierPins: {},
      }
      const tierPins = { ...(base.tierPins ?? {}) }
      if (tier) tierPins[compId] = tier
      else delete tierPins[compId]
      const selectedCompKeys = new Set(base.selectedCompKeys)
      if (tier === 'arv') {
        const idx = items.findIndex((c) => c.id === compId)
        if (idx >= 0) selectedCompKeys.add(getCompKey(items[idx], idx))
      }
      const hasPins = Object.keys(tierPins).length > 0
      return { selectedCompKeys, isManual: base.isManual || hasPins, tierPins }
    })
  }, [data?.comps?.items])

  // Freeze valuation ref: snapshot the valuation when AI analysis starts
  const frozenValuationRef = useRef<ValuationData | undefined>(undefined)
  const wasAiAnalyzingRef = useRef(false)

  // Build display valuation: always use recalcData, then apply manual comp override
  const computedValuation = useMemo((): ValuationData | undefined => {
    if (!data?.valuation) return undefined
    if (pythonAuthoritative) {
      // Server-authoritative report — only an explicit manual ARV override
      // may alter the displayed deal. Stored percent-of-ARV rules are inert.
      const ov = settingsHook.settings.arvOverride
      if (ov == null || ov <= 0) return data.valuation
      const v0 = data.valuation
      const newArv = Math.max(0, Math.round(ov))
      const ref = Math.max(1, v0.arv ?? 0)
      const closingPct = (v0.closingCosts ?? 0) / ref
      const carryingPct = (v0.carryingCosts ?? 0) / ref
      const rehab = v0.rehabCost ?? 0
      const fee = v0.buyPrice != null && v0.wholesalePrice != null ? v0.buyPrice - v0.wholesalePrice : 0
      const selLevel = v0.rehabLevelEstimates?.find((l) => l.isSelected)
      const minProfit = selLevel?.projectedProfit ?? v0.projectedProfit ?? 0
      const closing = Math.round(newArv * closingPct)
      const carrying = Math.round(newArv * carryingPct)
      const buyPrice = newArv - rehab - closing - carrying - minProfit
      const wholesale = buyPrice - fee
      const totalInv = buyPrice + rehab
      const profit = newArv - totalInv - closing - carrying
      return {
        ...v0,
        arv: newArv,
        arvPerSqft: v0.arvPerSqft != null && data.subject?.squareFeet ? Math.round(newArv / data.subject.squareFeet) : v0.arvPerSqft,
        buyPrice,
        buyPricePercent: newArv > 0 ? Math.round((buyPrice / newArv) * 100) : v0.buyPricePercent,
        wholesalePrice: wholesale,
        closingCosts: closing,
        carryingCosts: carrying,
        totalCosts: closing + carrying,
        totalInvestment: totalInv,
        projectedProfit: profit,
        projectedROI: totalInv > 0 ? Math.round((profit / totalInv) * 1000) / 10 : v0.projectedROI,
        arvAdjustments: [],
      }
    }

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
        arvAdjustments: v.arvAdjustments,
      }
    } else {
      base = data.valuation
    }

    // If comp override is manual, recalculate on top using user's full settings
    if (compOverride?.isManual && data?.comps?.items && data?.subject) {
      const pins = compOverride.tierPins
      const items = pins && Object.keys(pins).length > 0
        ? data.comps.items.map((c) => (c.id && pins[c.id] ? { ...c, userTier: pins[c.id] } : c))
        : data.comps.items
      return recalculateValuationFromComps(
        items,
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
            status: f.status,
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
    // and restamp compGroup so "Selected for ARV" (PDF + saved report)
    // means the user's picks, not the classification-derived tags.
    let { avgPricePerSqft, medianPrice, enabledCount, disabledCount } = recalcData
    const markedItems = compOverride?.isManual
      ? items.map((comp, i) => {
          const picked = compOverride.selectedCompKeys.has(getCompKey(comp, i))
          return picked
            ? { ...comp, compGroup: 'arv' as const }
            : comp.compGroup === 'arv' ? { ...comp, compGroup: null } : comp
        })
      : items
    if (compOverride?.isManual) {
      const compsItems = data.comps?.items || []
      const selected = markedItems.filter((_, i) => compOverride.selectedCompKeys.has(getCompKey(compsItems[i], i)))
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
      items: markedItems,
    }
  }, [recalcData, data?.comps, compOverride, pythonAuthoritative, selectionPending])

  const isRecalculated = !pythonAuthoritative && (settingsChanged || (compOverride?.isManual ?? false))
  const effectiveComps = displayComps ?? data?.comps
  const authoritativeOverride = useMemo(() => pythonAuthoritative && data?.comps?.items ? {
    // The optimistic selection (set the instant the user clicks) wins over
    // the server-derived set until the recalc settles.
    selectedCompKeys: new Set(data.comps.items.flatMap((comp, index) =>
      (activeOptimistic
        ? comp.id != null && activeOptimistic.ids.has(comp.id)
        : isCheckedForArv(comp, data.comps!.items!, data.manualCompSelection != null))
        ? [getCompKey(comp, index)] : [])),
    isManual: activeOptimistic?.isManual ?? activeSelection?.isManual ?? data.manualCompSelection != null,
  } : null, [pythonAuthoritative, data?.comps?.items, data?.manualCompSelection, activeSelection?.isManual, activeOptimistic])

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
    handlePinTier,
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
