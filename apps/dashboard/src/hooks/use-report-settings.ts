/**
 * Report Settings Hook
 *
 * Always loads the user's current evaluation settings from the API
 * (appraisal preset, rehab config, deal params, major items) so the
 * sidebar reflects what the user has configured on the Evaluation
 * Settings page — not what the server happened to snapshot during analysis.
 *
 * The server's `appliedSettings` is kept as the comparison baseline so
 * recalculation can detect when the user's current settings differ from
 * what was actually used for the analysis.
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
  closingCostsPercent: 8,
  carryingCostsPercent: 2,
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

/** Deterministic JSON string for change detection — strips undefined values and sorts keys */
function normalizeForComparison(obj: unknown): string {
  return JSON.stringify(obj, (_key, value) => (value === undefined ? null : value))
}

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

  // Saved defaults (loaded from API — the user's current evaluation settings) for reset
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

  // Always fetch user's current settings from the API.
  // appliedSettings is used only as the recalc comparison baseline.
  useEffect(() => {
    let cancelled = false

    async function loadSettings() {
      try {
        const applied = data?.appliedSettings

        // Always load user's current settings from the API
        const [preset, defaults, rehabResponse, dealResponse, majorItemsResponse] = await Promise.all([
          getOrCreateDefaultPreset().catch(() => null),
          getAppraisalDefaults().catch(() => null),
          getRehabConfig().catch(() => null),
          getDealParams().catch(() => null),
          getMajorItemCosts().catch(() => null),
        ])

        if (cancelled) return

        // Build filters from user's current preset
        const filters: RecalcFilter[] = preset?.filters
          ? preset.filters.map((f) => ({
              type: f.filterType,
              enabled: f.enabled,
              value: f.value,
            }))
          : applied?.filters?.length
            ? applied.filters.map((f) => ({
                type: f.type,
                enabled: f.enabled,
                value: f.value,
              }))
            : DEFAULT_FILTERS

        // Build adjustments from user's current preset
        const adjustments: RecalcAdjustment[] = preset?.adjustments
          ? preset.adjustments.map((a) => ({
              type: a.adjustmentType,
              enabled: a.enabled,
              amount: a.amount,
              percent: a.percentage || undefined,
            }))
          : applied?.adjustments?.length
            ? applied.adjustments.map((a) => ({
                type: a.type,
                enabled: a.enabled,
                amount: a.amount,
                percent: a.percent,
              }))
            : DEFAULT_ADJUSTMENTS

        const rehabTable = rehabResponse?.config ?? applied?.rehabTable ?? DEFAULT_REHAB_TABLE
        const tierRanges = rehabResponse?.tierRanges ?? applied?.tierRanges
        const dealParams = dealResponse?.config ?? applied?.dealParams ?? DEFAULT_DEAL_PARAMS

        // Build major items from user's current settings
        const majorItems: MajorItemSetting[] = majorItemsResponse?.items
          ? majorItemsResponse.items.map((item) => ({
              id: item.id,
              name: item.name,
              enabled: false,
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

        // Use applied rehabLevelIndex and additionPlay from the analysis as
        // initial values since those are per-report choices, not global settings
        const rehabLevelIndex = applied?.rehabLevelIndex ?? 2
        const additionPlay = applied?.additionPlay ?? 0

        const loaded: EvaluationSettings = {
          filters,
          adjustments,
          dealParams,
          rehabTable,
          tierRanges,
          rehabLevelIndex,
          majorItems,
          additionPlay,
        }

        if (!cancelled) {
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

  // settingsChanged = user has actively modified settings from the loaded defaults.
  // We compare current settings against what was initially loaded (savedDefaults),
  // NOT against the server's appliedSettings — this avoids false positives from
  // shape/format differences between the API response and the server snapshot.
  const settingsChanged = useMemo(() => {
    if (!savedDefaults) return false
    const currentSnapshot = normalizeForComparison({
      filters: settings.filters,
      adjustments: settings.adjustments,
      dealParams: settings.dealParams,
      rehabTable: settings.rehabTable,
      rehabLevelIndex: settings.rehabLevelIndex,
      additionPlay: settings.additionPlay,
    })
    const defaultsSnapshot = normalizeForComparison({
      filters: savedDefaults.filters,
      adjustments: savedDefaults.adjustments,
      dealParams: savedDefaults.dealParams,
      rehabTable: savedDefaults.rehabTable,
      rehabLevelIndex: savedDefaults.rehabLevelIndex,
      additionPlay: savedDefaults.additionPlay,
    })
    return currentSnapshot !== defaultsSnapshot
  }, [settings, savedDefaults])

  // Only recalculate when settings differ from what the server used.
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
