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
import type {
  AnalyzeData,
  ValuationData,
  CompsData,
} from '@/app/(dashboard)/dashboard/analyze/actions'
import { getCompKey } from '@/components/analysis/format-helpers'
import { useReportSettings, type UseReportSettingsReturn } from '@/hooks/use-report-settings'
import { recalculateValuationFromComps, type RecalcResult } from '@/lib/recalc'

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
}

export interface UseAnalysisEvaluationReturn {
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
  data,
  stickyBarRootMargin = '-60px 0px 0px 0px',
}: UseAnalysisEvaluationInput): UseAnalysisEvaluationReturn {
  // Settings panel open/close
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Comp override state
  const [compOverride, setCompOverride] = useState<OverrideState | null>(null)
  // Ref tracks isManual to avoid stale closures in the sync effect
  const isManualRef = useRef(false)

  // Compose useReportSettings
  const settingsHook = useReportSettings(data)
  const { recalcData, settingsChanged } = settingsHook

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

  // Sync comp selection when recalc re-evaluates filters (but not when user manually toggled comps)
  useEffect(() => {
    if (!recalcData || !data?.comps?.items) return
    if (isManualRef.current) return

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
    isManualRef.current = true
    setCompOverride((prev) => {
      if (!prev) return prev
      const next = new Set(prev.selectedCompKeys)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return { selectedCompKeys: next, isManual: true }
    })
  }, [])

  // Reset to original enabled comps
  const handleResetComps = useCallback(() => {
    isManualRef.current = false
    if (data?.comps?.items) {
      const keys = new Set(
        data.comps.items
          .filter((c) => c.isEnabled === true)
          .map((c, i) => getCompKey(c, i))
      )
      setCompOverride({ selectedCompKeys: keys, isManual: false })
    }
  }, [data?.comps?.items])

  // Build display valuation: always use recalcData, then apply manual comp override
  const displayValuation = useMemo((): ValuationData | undefined => {
    if (!data?.valuation) return undefined

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
  }, [data, recalcData, compOverride, settingsHook.settings])

  // Build display comps: map recalcData comp evaluations onto original items
  const displayComps = useMemo((): CompsData | undefined => {
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
  }, [recalcData, data?.comps, compOverride])

  const isRecalculated = settingsChanged || (compOverride?.isManual ?? false)
  const effectiveComps = displayComps ?? data?.comps

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
    settingsHook,
    recalcData,
    compOverride,
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
