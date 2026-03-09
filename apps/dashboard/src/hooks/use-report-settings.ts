/**
 * Report Settings Hook
 *
 * Initializes settings from appliedSettings (what the server actually used),
 * falling back to loading from the API if appliedSettings is not available.
 *
 * Key behavior:
 * - recalcData = null when settingsChanged === false (use server values as-is)
 * - recalcData != null when user changes settings (recalculated values)
 */

import { useState, useEffect, useMemo, useCallback } from 'react'
import type { AnalyzeData } from '@/app/(dashboard)/dashboard/analyze/actions'
import {
  getOrCreateDefaultPreset,
  getAppraisalDefaults,
  getRehabConfig,
  getDealParams,
  getMajorItemCosts,
  type AppraisalDefaults,
  type DealParamsConfig,
  type RehabEstimate,
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
} from '@/lib/recalc'

// ─── Default Settings ───────────────────────────────────────────────────────

const DEFAULT_DEAL_PARAMS: DealParamsConfig = {
  closingCostsPercent: 10,
  carryingCostsPercent: 5,
  wholesaleFee: 10000,
  desiredProfit: null,
}

const DEFAULT_FILTERS: RecalcFilter[] = [
  { type: 'subdivision_match', enabled: true, value: 1 },
  { type: 'sale_age', enabled: true, value: 180 },
  { type: 'sqft_diff', enabled: true, value: 250 },
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
  resetToDefaults: () => void
}

export function useReportSettings(data: AnalyzeData | null): UseReportSettingsReturn {
  const [loading, setLoading] = useState(true)
  const [labels, setLabels] = useState<AppraisalDefaults | null>(null)

  // Saved defaults (loaded from appliedSettings or API) for reset
  const [savedDefaults, setSavedDefaults] = useState<EvaluationSettings | null>(null)

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

  // Load settings: prefer appliedSettings from response, fallback to API
  useEffect(() => {
    let cancelled = false

    async function loadSettings() {
      try {
        const applied = data?.appliedSettings

        if (applied) {
          // Initialize from server's appliedSettings — exact match with what was used
          const filters: RecalcFilter[] = applied.filters.length > 0
            ? applied.filters.map((f) => ({
                type: f.type,
                enabled: f.enabled,
                value: f.value,
              }))
            : DEFAULT_FILTERS

          const adjustments: RecalcAdjustment[] = applied.adjustments.length > 0
            ? applied.adjustments.map((a) => ({
                type: a.type,
                enabled: a.enabled,
                amount: a.amount,
                percent: a.percent,
              }))
            : DEFAULT_ADJUSTMENTS

          const rehabTable = applied.rehabTable ?? DEFAULT_REHAB_TABLE
          const dealParams = applied.dealParams ?? DEFAULT_DEAL_PARAMS

          // Build major items from appliedSettings
          const majorItems: MajorItemSetting[] = applied.majorItems
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

          const loaded: EvaluationSettings = {
            filters,
            adjustments,
            dealParams,
            rehabTable,
            rehabLevelIndex: applied.rehabLevelIndex ?? 2,
            majorItems,
            additionPlay: applied.additionPlay ?? 0,
          }

          if (!cancelled) {
            setSettings(loaded)
            setSavedDefaults(loaded)
          }

          // Still fetch labels for UI display (non-blocking)
          getAppraisalDefaults().then((defaults) => {
            if (!cancelled && defaults) setLabels(defaults)
          }).catch(() => {})
        } else {
          // Fallback: load from API (old reports without appliedSettings)
          const [preset, defaults, rehabResponse, dealResponse, majorItemsResponse] = await Promise.all([
            getOrCreateDefaultPreset().catch(() => null),
            getAppraisalDefaults().catch(() => null),
            getRehabConfig().catch(() => null),
            getDealParams().catch(() => null),
            getMajorItemCosts().catch(() => null),
          ])

          if (cancelled) return

          // Build filters from preset
          const filters: RecalcFilter[] = preset?.filters
            ? preset.filters.map((f) => ({
                type: f.filterType,
                enabled: f.enabled,
                value: f.value,
              }))
            : DEFAULT_FILTERS

          // Build adjustments from preset
          const adjustments: RecalcAdjustment[] = preset?.adjustments
            ? preset.adjustments.map((a) => ({
                type: a.adjustmentType,
                enabled: a.enabled,
                amount: a.amount,
                percent: a.percentage || undefined,
              }))
            : DEFAULT_ADJUSTMENTS

          const rehabTable = rehabResponse?.config ?? DEFAULT_REHAB_TABLE
          const dealParams = dealResponse?.config ?? DEFAULT_DEAL_PARAMS

          // Build major items from API response
          const majorItems: MajorItemSetting[] = majorItemsResponse?.items
            ? majorItemsResponse.items.map((item) => ({
                id: item.id,
                name: item.name,
                enabled: false,
                cost: item.effectiveCost,
              }))
            : DEFAULT_MAJOR_ITEMS

          const loaded: EvaluationSettings = {
            filters,
            adjustments,
            dealParams,
            rehabTable,
            rehabLevelIndex: 2,
            majorItems,
            additionPlay: 0,
          }

          setSettings(loaded)
          setSavedDefaults(loaded)
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

  // Track whether user has changed any settings from saved defaults
  const settingsChanged = useMemo(() => {
    if (!savedDefaults) return false
    return JSON.stringify(settings) !== JSON.stringify(savedDefaults)
  }, [settings, savedDefaults])

  // Only recalculate when user has changed settings
  // When settingsChanged is false, return null so the page uses server values
  const recalcData = useMemo(() => {
    if (!data || !settingsChanged) return null
    return recalculateReport(data, settings)
  }, [data, settings, settingsChanged])

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

  const resetToDefaults = useCallback(() => {
    if (savedDefaults) {
      setSettings(savedDefaults)
    }
  }, [savedDefaults])

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
    resetToDefaults,
  }
}
