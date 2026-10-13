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

/** Restamp items for a manual selection — picked comps get compGroup 'arv',
 *  unpicked lose a stale 'arv' tag — and recompute the section stats from
 *  the picks. Keys read index-stable, so the original items drive them. */
function markManualSelection(items: CompItem[], selectedCompKeys: Set<string>) {
  const markedItems = items.map((comp, i) => {
    const picked = selectedCompKeys.has(getCompKey(comp, i))
    return picked
      ? { ...comp, compGroup: 'arv' as const }
      : comp.compGroup === 'arv' ? { ...comp, compGroup: null } : comp
  })
  const selected = markedItems.filter((comp, i) => selectedCompKeys.has(getCompKey(comp, i)))
  const enabledCount = selected.length
  const disabledCount = items.length - enabledCount

  let avgPricePerSqft: number | null = null
  let medianPrice: number | null = null
  if (selected.length > 0) {
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

    const prices = selected
      .map((c) => c.salePrice)
      .filter((p): p is number => p != null)
      .sort((a, b) => a - b)
    if (prices.length > 0) {
      const mid = Math.floor(prices.length / 2)
      medianPrice = prices.length % 2 !== 0
        ? prices[mid]!
        : Math.round((prices[mid - 1]! + prices[mid]!) / 2)
    }
  }
  return { markedItems, enabledCount, disabledCount, avgPricePerSqft, medianPrice }
}

export function useAnalysisEvaluation({
  data: inputData,
  stickyBarRootMargin = '-60px 0px 0px 0px',
  aiAnalyzing = false,
}: UseAnalysisEvaluationInput): UseAnalysisEvaluationReturn {
  const data = inputData
  const pythonAuthoritative = data?.evaluationEngine === 'python-v4' || data?.evaluationEngine === 'ts-v5'

  // Settings panel open/close
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Comp override state — a click writes this and the shared package
  // recalculates the deal in the same render; no server round-trip.
  const [compOverride, setCompOverride] = useState<OverrideState | null>(null)
  // Ref tracks isManual to avoid stale closures in the sync effect
  const isManualRef = useRef(false)

  // Compose useReportSettings
  const settingsHook = useReportSettings(data)
  const { recalcData, settingsChanged } = settingsHook

  // Default selection = ARV evidence only — transitional/floor comps stay
  // listed but unselected (they never feed the ARV number).
  const arvDefaultKeys = (items: CompItem[]): Set<string> => new Set(
    items
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.isEnabled === true && (c.classification?.type === 'after_renovation' || c.userTier === 'arv'))
      .map(({ c, i }) => getCompKey(c, i))
  )

  /** The comp keys the boxes currently show as checked — for server-seated
   *  reports that is the anchor/driver rule (or every enabled comp once the
   *  saved selection is manual); legacy reports use the ARV-evidence set. */
  const checkedKeys = useCallback((items: CompItem[]): Set<string> => {
    if (pythonAuthoritative) {
      const manual = data?.manualCompSelection != null
      return new Set(items.flatMap((comp, i) => (isCheckedForArv(comp, items, manual) ? [getCompKey(comp, i)] : [])))
    }
    return arvDefaultKeys(items)
  }, [pythonAuthoritative, data?.manualCompSelection])

  // Initialize comp override when data arrives
  useEffect(() => {
    if (data?.comps?.items) {
      isManualRef.current = false
      // Server-seated reports derive their checked boxes from the saved
      // report until the user touches one — no override object at rest.
      if (pythonAuthoritative) setCompOverride(null)
      else setCompOverride({ selectedCompKeys: arvDefaultKeys(data.comps.items), isManual: false })
    }
  }, [data?.comps?.items, pythonAuthoritative])

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

  // Toggle a single comp — writes the override; the recalc is the same
  // shared math the server runs, so the deal updates in this render.
  const handleToggleComp = useCallback((key: string) => {
    const items = data?.comps?.items ?? []
    setCompOverride((prev) => {
      const next = new Set(prev?.selectedCompKeys ?? checkedKeys(items))
      if (next.has(key)) next.delete(key)
      else next.add(key)
      if (next.size === 0) {
        toast.error('Keep at least one comparable selected for ARV.')
        return prev
      }
      isManualRef.current = true
      return { selectedCompKeys: next, isManual: true, tierPins: prev?.tierPins }
    })
  }, [data?.comps?.items, checkedKeys])

  // Reset to the report's automatic selection
  const handleResetComps = useCallback(() => {
    const items = data?.comps?.items
    if (!items) return
    isManualRef.current = false
    setCompOverride({ selectedCompKeys: checkedKeys(items), isManual: false })
  }, [data?.comps?.items, checkedKeys])

  // Reviewer tier pin — 'arv' admits the comp into the ARV pool (and selects
  // it), 'as_is' excludes it from ARV evidence, null clears. Persistence to
  // /comp-tier stays in the caller — this feeds the client-side recalc.
  const handlePinTier = useCallback((compId: string, tier: 'arv' | 'as_is' | null) => {
    const items = data?.comps?.items
    if (!items) return
    isManualRef.current = true
    setCompOverride((prev) => {
      const base = prev ?? {
        // Seed from the boxes currently checked — the report's own auto rule,
        // not every enabled comp.
        selectedCompKeys: checkedKeys(items),
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
  }, [data?.comps?.items, checkedKeys])

  // Freeze valuation ref: snapshot the valuation when AI analysis starts
  const frozenValuationRef = useRef<ValuationData | undefined>(undefined)
  const wasAiAnalyzingRef = useRef(false)

  // Build display valuation: recalcData base, then manual comp override
  const computedValuation = useMemo((): ValuationData | undefined => {
    if (!data?.valuation) return undefined

    // Start from recalcData (always available once data loads) or original.
    // Server-seated engines have no client recalcData — their base is the
    // saved valuation.
    let base: ValuationData = data.valuation
    if (!pythonAuthoritative && recalcData) {
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
    }

    // A manual comp selection recalcs client-side on every engine — the
    // shared package's evaluateB is the same math the server ran. Changed
    // settings (rehab level, deal params, major items) take the same path
    // on server-seated reports — without this the tier pick did nothing.
    if (data?.comps?.items && data?.subject && (compOverride?.isManual || (pythonAuthoritative && settingsChanged))) {
      const pins = compOverride?.tierPins
      const items = pins && Object.keys(pins).length > 0
        ? data.comps.items.map((c) => (c.id && pins[c.id] ? { ...c, userTier: pins[c.id] } : c))
        : data.comps.items
      return recalculateValuationFromComps(
        items,
        data.subject,
        compOverride?.selectedCompKeys ?? checkedKeys(data.comps.items),
        base,
        settingsHook.settings
      )
    }

    if (pythonAuthoritative) {
      // Server-authoritative report — only an explicit manual ARV override
      // may alter the displayed deal. Stored percent-of-ARV rules are inert.
      const ov = settingsHook.settings.arvOverride
      if (ov == null || ov <= 0) return base
      const v0 = base
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
    // Server-seated reports show the saved comps until the user picks a
    // different set — then the picks restamp compGroup and the stats.
    if (pythonAuthoritative) {
      if (!data?.comps || !compOverride?.isManual) return data?.comps
      const { markedItems, enabledCount, disabledCount, avgPricePerSqft, medianPrice } =
        markManualSelection(data.comps.items ?? [], compOverride.selectedCompKeys)
      return { ...data.comps, count: markedItems.length, enabledCount, disabledCount, avgPricePerSqft, medianPrice, items: markedItems }
    }
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
    const manual = compOverride?.isManual
      ? markManualSelection(items, compOverride.selectedCompKeys)
      : null

    return {
      ...data.comps,
      count: items.length,
      enabledCount: manual?.enabledCount ?? recalcData.enabledCount,
      disabledCount: manual?.disabledCount ?? recalcData.disabledCount,
      avgPricePerSqft: manual?.avgPricePerSqft ?? recalcData.avgPricePerSqft,
      medianPrice: manual?.medianPrice ?? recalcData.medianPrice,
      items: manual?.markedItems ?? items,
    }
  }, [recalcData, data?.comps, compOverride, pythonAuthoritative])

  const isRecalculated = (!pythonAuthoritative && settingsChanged) || (compOverride?.isManual ?? false)
  const effectiveComps = displayComps ?? data?.comps
  // Server-seated reports derive their checked boxes from the saved report
  // until the user touches one — then compOverride (non-null) takes over.
  const authoritativeOverride = useMemo(() => pythonAuthoritative && compOverride == null && data?.comps?.items ? {
    selectedCompKeys: checkedKeys(data.comps.items),
    isManual: data.manualCompSelection != null,
  } : null, [pythonAuthoritative, compOverride, data?.comps?.items, data?.manualCompSelection, checkedKeys])

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
    compOverride: compOverride ?? authoritativeOverride,
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
