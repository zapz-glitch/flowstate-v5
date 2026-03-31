/**
 * Report Settings Hook
 *
 * Loads the user's current evaluation settings from the API and provides
 * real-time recalculation as settings change.
 *
 * Key design decisions:
 * - Always recalculates using current settings (no gating on "changed")
 * - settingsChanged is only used for UI badges ("Recalculated")
 * - recalcData is always available once data + settings are loaded
 * - Uses useMemo for synchronous, glitch-free updates on every change
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import type { AnalyzeData } from '@/app/(dashboard)/dashboard/analyze/actions'
import {
  getOrCreateDefaultPreset,
  getAppraisalDefaults,
  getRehabConfig,
  getDealParams,
  getMajorItemCosts,
  getProximityConfig,
  PROXIMITY_DEFAULTS,
  type AppraisalDefaults,
  type DealParamsConfig,
  type RehabEstimate,
  type ProximityConfig,
} from '@/lib/client-api'
import {
  recalculateReport,
  DEFAULT_REHAB_TABLE,
  MAJOR_ITEMS_LIST,
  type EvaluationSettings,
  type RecalcResult,
  type RecalcFilter,
  type RecalcAdjustment,
  type MajorItemSetting,
  type ProximityToggles,
} from '@/lib/recalc'

// ─── Default Settings ───────────────────────────────────────────────────────

const DEFAULT_DEAL_PARAMS: DealParamsConfig = {
  closingCostsPercent: 8,
  carryingCostsPercent: 2,
  wholesaleFee: 10000,
  asIsThresholdPercent: 70,
}

const DEFAULT_FILTERS: RecalcFilter[] = [
  { type: 'subdivision_match', enabled: true, value: 1 },
  { type: 'sale_age', enabled: true, value: 180 },
  { type: 'sqft_diff', enabled: true, value: 20 },
  { type: 'year_built_diff', enabled: true, value: 10 },
  { type: 'distance', enabled: true, value: 0.5 },
]

const DEFAULT_ADJUSTMENTS: RecalcAdjustment[] = [
  { type: 'old_comp_discount', enabled: true, amount: 0, percent: 15 },
  { type: 'bedroom', enabled: true, amount: 15000 },
  { type: 'bathroom', enabled: true, amount: 10000 },
  { type: 'pool', enabled: false, amount: 10000 },
  { type: 'garage', enabled: false, amount: 10000 },
]

const DEFAULT_MAJOR_ITEMS: MajorItemSetting[] = MAJOR_ITEMS_LIST.map((item) => ({
  id: item.id,
  name: item.name,
  enabled: false,
  cost: item.defaultCost,
}))

// ─── Hook ───────────────────────────────────────────────────────────────────

export interface UseReportSettingsReturn {
  settings: EvaluationSettings
  labels: AppraisalDefaults | null
  loading: boolean
  recalcData: RecalcResult | null
  /** Whether the user has changed any settings from the loaded defaults */
  settingsChanged: boolean
  updateFilter: (type: string, updates: Partial<RecalcFilter>) => void
  updateAdjustment: (type: string, updates: Partial<RecalcAdjustment>) => void
  updateDealParams: (updates: Partial<DealParamsConfig>) => void
  selectRehabLevel: (index: number) => void
  updateRehabTableEntry: (tier: string, levelIndex: number, updates: Partial<RehabEstimate>) => void
  updateMajorItem: (id: string, updates: Partial<MajorItemSetting>) => void
  updateProximityAdjustments: (toggles: ProximityToggles) => void
  resetToDefaults: () => void
}

export function useReportSettings(data: AnalyzeData | null): UseReportSettingsReturn {
  const [loading, setLoading] = useState(true)
  const [labels, setLabels] = useState<AppraisalDefaults | null>(null)

  // Snapshot of loaded defaults for reset + change detection
  const savedDefaultsRef = useRef<string | null>(null)

  // Current settings (mutable by user)
  const [settings, setSettings] = useState<EvaluationSettings>({
    filters: DEFAULT_FILTERS,
    adjustments: DEFAULT_ADJUSTMENTS,
    dealParams: DEFAULT_DEAL_PARAMS,
    rehabTable: DEFAULT_REHAB_TABLE,
    rehabLevelIndex: 2,
    majorItems: DEFAULT_MAJOR_ITEMS,
    additionPlay: 0,
  })

  // Keep a ref to the loaded defaults object for reset
  const savedDefaultsObjRef = useRef<EvaluationSettings | null>(null)

  // Fetch user's current settings from the API on mount
  useEffect(() => {
    let cancelled = false

    async function loadSettings() {
      try {
        const applied = data?.appliedSettings

        const [preset, defaults, rehabResponse, dealResponse, majorItemsResponse, proximityResponse] = await Promise.all([
          getOrCreateDefaultPreset().catch(() => null),
          getAppraisalDefaults().catch(() => null),
          getRehabConfig().catch(() => null),
          getDealParams().catch(() => null),
          getMajorItemCosts().catch(() => null),
          getProximityConfig().catch(() => null),
        ])

        if (cancelled) return

        // Build filters — prefer appliedSettings (reflects what was actually used, including overrides)
        // Fall back to preset, then system defaults
        const filters: RecalcFilter[] = applied?.filters?.length
          ? applied.filters.map((f) => ({
              type: f.type,
              enabled: f.enabled,
              value: f.value,
            }))
          : preset?.filters
            ? preset.filters.map((f) => ({
                type: f.filterType,
                enabled: f.enabled,
                value: f.value,
              }))
            : DEFAULT_FILTERS

        // Build adjustments — prefer appliedSettings, fall back to preset
        const adjustments: RecalcAdjustment[] = applied?.adjustments?.length
          ? applied.adjustments.map((a) => ({
              type: a.type,
              enabled: a.enabled,
              amount: a.amount,
              percent: a.percent,
            }))
          : preset?.adjustments
            ? preset.adjustments.map((a) => ({
                type: a.adjustmentType,
                enabled: a.enabled,
                amount: a.amount,
                percent: a.percentage || undefined,
              }))
            : DEFAULT_ADJUSTMENTS

        const rehabTable = rehabResponse?.config ?? applied?.rehabTable ?? DEFAULT_REHAB_TABLE
        const tierRanges = rehabResponse?.tierRanges ?? applied?.tierRanges
        const dealParams = dealResponse?.config ?? applied?.dealParams ?? DEFAULT_DEAL_PARAMS

        // Build major items from user's current settings
        // Merge costs from user's saved config with enabled state from appliedSettings
        const appliedMajorItemMap = new Map(
          (applied?.majorItems ?? []).map((m) => [m.id, m])
        )
        const majorItems: MajorItemSetting[] = majorItemsResponse?.items
          ? majorItemsResponse.items.map((item) => ({
              id: item.id,
              name: item.name,
              enabled: appliedMajorItemMap.get(item.id)?.enabled ?? false,
              cost: item.effectiveCost,
            }))
          : applied?.majorItems
            ? applied.majorItems.map((item) => {
                const meta = MAJOR_ITEMS_LIST.find((m) => m.id === item.id)
                return {
                  id: item.id,
                  name: meta?.name ?? item.id,
                  enabled: item.enabled,
                  cost: item.cost,
                }
              })
            : DEFAULT_MAJOR_ITEMS

        // Use applied rehabLevelIndex and additionPlay from the analysis
        const rehabLevelIndex = applied?.rehabLevelIndex ?? 2
        const additionPlay = applied?.additionPlay ?? 0

        const proximityConfig = proximityResponse?.config ?? PROXIMITY_DEFAULTS

        const loaded: EvaluationSettings = {
          filters,
          adjustments,
          dealParams,
          rehabTable,
          tierRanges,
          rehabLevelIndex,
          majorItems,
          additionPlay,
          proximityConfig,
        }

        if (!cancelled) {
          setSettings(loaded)
          savedDefaultsObjRef.current = loaded
          // Store serialized snapshot once for cheap change detection
          savedDefaultsRef.current = JSON.stringify(loaded, (_k, v) => v === undefined ? null : v)
          if (defaults) setLabels(defaults)
        }
      } catch {
        // Keep defaults on error
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    loadSettings()
    return () => { cancelled = true }
  }, [data?.appliedSettings])

  // Detect whether user changed settings from loaded defaults.
  // Compares current settings JSON against the snapshot taken at load time.
  // Only used for the "Recalculated" badge — does NOT gate computation.
  const settingsChanged = useMemo(() => {
    if (!savedDefaultsRef.current) return false
    return JSON.stringify(settings, (_k, v) => v === undefined ? null : v) !== savedDefaultsRef.current
  }, [settings])

  // Always recalculate — pure math over ~10 comps, fast enough for useMemo.
  // This runs synchronously during render, so clicks update the UI in the
  // same frame with zero async delay or missed clicks.
  const recalcData = useMemo(() => {
    if (!data) return null
    return recalculateReport(data, settings)
  }, [data, settings])

  // Updaters
  const updateFilter = useCallback((type: string, updates: Partial<RecalcFilter>) => {
    setSettings((prev) => ({
      ...prev,
      filters: prev.filters.map((f) =>
        f.type === type ? { ...f, ...updates } : f
      ),
    }))
  }, [])

  const updateAdjustment = useCallback((type: string, updates: Partial<RecalcAdjustment>) => {
    setSettings((prev) => ({
      ...prev,
      adjustments: prev.adjustments.map((a) =>
        a.type === type ? { ...a, ...updates } : a
      ),
    }))
  }, [])

  const updateDealParams = useCallback((updates: Partial<DealParamsConfig>) => {
    setSettings((prev) => ({
      ...prev,
      dealParams: { ...prev.dealParams, ...updates },
    }))
  }, [])

  const selectRehabLevel = useCallback((index: number) => {
    setSettings((prev) => ({
      ...prev,
      rehabLevelIndex: index,
    }))
  }, [])

  const updateRehabTableEntry = useCallback((tier: string, levelIndex: number, updates: Partial<RehabEstimate>) => {
    setSettings((prev) => {
      const newTable = { ...prev.rehabTable }
      newTable[tier] = [...(newTable[tier] ?? [])]
      newTable[tier][levelIndex] = { ...(newTable[tier][levelIndex] ?? { perSqft: 0, minProfit: 0 }), ...updates }
      return { ...prev, rehabTable: newTable }
    })
  }, [])

  const updateMajorItem = useCallback((id: string, updates: Partial<MajorItemSetting>) => {
    setSettings((prev) => ({
      ...prev,
      majorItems: prev.majorItems.map((item) =>
        item.id === id ? { ...item, ...updates } : item
      ),
    }))
  }, [])

  const updateProximityAdjustments = useCallback((toggles: ProximityToggles) => {
    setSettings((prev) => ({
      ...prev,
      proximityAdjustments: toggles,
    }))
  }, [])

  const resetToDefaults = useCallback(() => {
    if (savedDefaultsObjRef.current) {
      setSettings(savedDefaultsObjRef.current)
    }
  }, [])

  return {
    settings,
    labels,
    loading,
    recalcData,
    settingsChanged,
    updateFilter,
    updateAdjustment,
    updateDealParams,
    selectRehabLevel,
    updateRehabTableEntry,
    updateMajorItem,
    updateProximityAdjustments,
    resetToDefaults,
  }
}
