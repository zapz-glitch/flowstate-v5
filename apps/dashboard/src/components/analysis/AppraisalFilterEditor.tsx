'use client'

import { useState, useEffect } from 'react'
import { SlidersHorizontal, AlertTriangle } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import {
  getAppraisalDefaults,
  getOrCreateDefaultPreset,
  type AppraisalDefaults,
  type FilterType,
  type AdjustmentType,
} from '@/lib/client-api'

export interface FilterState {
  type: string
  enabled: boolean
  value: number
}

export interface AdjustmentState {
  type: string
  enabled: boolean
  amount: number
  percent?: number
}

interface AppraisalFilterEditorProps {
  /** Current filter states — if provided, component is controlled */
  filters?: FilterState[]
  adjustments?: AdjustmentState[]
  /** Called when filters change */
  onFiltersChange?: (filters: FilterState[]) => void
  /** Called when adjustments change */
  onAdjustmentsChange?: (adjustments: AdjustmentState[]) => void
  /** ARV threshold percentage */
  arvThreshold?: number
  /** Called when ARV threshold changes */
  onArvThresholdChange?: (value: number) => void
  /** Error message with filter suggestions (from failed analysis) */
  errorMessage?: string | null
  /** Suggested filter values from API (shown as diff preview) */
  suggestedFilters?: FilterState[] | null
  /** Compact mode for inline use */
  compact?: boolean
}

/**
 * Reusable appraisal filter editor.
 * Loads defaults from API, renders inline editable filter/adjustment rows.
 * Can be used standalone or controlled via props.
 */
export function AppraisalFilterEditor({
  filters: controlledFilters,
  adjustments: controlledAdjustments,
  onFiltersChange,
  onAdjustmentsChange,
  arvThreshold,
  onArvThresholdChange,
  errorMessage,
  suggestedFilters: suggested,
  compact = false,
}: AppraisalFilterEditorProps) {
  const [defaults, setDefaults] = useState<AppraisalDefaults | null>(null)
  const [internalFilters, setInternalFilters] = useState<FilterState[]>([])
  const [internalAdjustments, setInternalAdjustments] = useState<AdjustmentState[]>([])
  const [loading, setLoading] = useState(true)

  const filters = controlledFilters ?? internalFilters
  const adjustments = controlledAdjustments ?? internalAdjustments

  useEffect(() => {
    Promise.all([getAppraisalDefaults(), getOrCreateDefaultPreset()])
      .then(([defs, preset]) => {
        setDefaults(defs)
        // Use preset values if available, otherwise defaults
        const presetFilterMap = new Map(preset?.filters?.map((f) => [f.filterType, f]) ?? [])
        const presetAdjMap = new Map(preset?.adjustments?.map((a) => [a.adjustmentType, a]) ?? [])

        const initFilters: FilterState[] = defs.filters.map((f) => {
          const saved = presetFilterMap.get(f.type)
          return { type: f.type, enabled: saved?.enabled ?? f.enabled, value: saved?.value ?? f.value }
        })
        const initAdjs: AdjustmentState[] = defs.adjustments.map((a) => {
          const saved = presetAdjMap.get(a.type)
          return { type: a.type, enabled: saved?.enabled ?? a.enabled, amount: saved?.amount ?? a.amount, percent: saved?.percentage ?? a.percent }
        })

        if (!controlledFilters) setInternalFilters(initFilters)
        if (!controlledAdjustments) setInternalAdjustments(initAdjs)
        // Initialize controlled state if empty
        if (controlledFilters?.length === 0) onFiltersChange?.(initFilters)
        if (controlledAdjustments?.length === 0) onAdjustmentsChange?.(initAdjs)
      })
      .finally(() => setLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const updateFilter = (index: number, patch: Partial<FilterState>) => {
    const updated = filters.map((f, i) => i === index ? { ...f, ...patch } : f)
    if (controlledFilters) {
      onFiltersChange?.(updated)
    } else {
      setInternalFilters(updated)
      onFiltersChange?.(updated)
    }
  }

  const updateAdjustment = (index: number, patch: Partial<AdjustmentState>) => {
    const updated = adjustments.map((a, i) => i === index ? { ...a, ...patch } : a)
    if (controlledAdjustments) {
      onAdjustmentsChange?.(updated)
    } else {
      setInternalAdjustments(updated)
      onAdjustmentsChange?.(updated)
    }
  }

  // Parse error suggestions
  const suggestions = errorMessage ? parseSuggestions(errorMessage) : []

  if (loading || !defaults) {
    return <div className="text-xs text-muted-foreground py-2">Loading filters...</div>
  }

  return (
    <div className={compact ? 'space-y-2' : 'space-y-4'}>
      {/* Error with suggestions */}
      {errorMessage && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-3 space-y-2">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" />
            <div className="text-sm text-red-600 dark:text-red-400 font-medium">
              No comps matched all filters
            </div>
          </div>
          {suggestions.length > 0 && (
            <div className="space-y-1 ml-6">
              {suggestions.map((s, i) => (
                <div key={i} className="text-xs text-red-500/80">{i + 1}. {s}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ARV Threshold */}
      {arvThreshold != null && onArvThresholdChange && (
        <div className="flex items-center gap-3 px-3 py-2 rounded-lg border border-border">
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-foreground">ARV Comp Threshold</div>
            {!compact && <div className="text-[10px] text-muted-foreground mt-0.5">Top % of comps by sale price used for ARV</div>}
          </div>
          <div className="flex items-center rounded-md border border-border bg-muted/30 overflow-hidden w-20">
            <Input
              type="number"
              min={1}
              max={100}
              step={5}
              value={arvThreshold}
              onChange={(e) => {
                const v = parseInt(e.target.value)
                if (!isNaN(v) && v >= 1 && v <= 100) onArvThresholdChange(v)
              }}
              className="h-7 w-14 text-[11px] text-right tabular-nums border-0 bg-transparent shadow-none focus-visible:ring-0 pr-1 pl-2"
            />
            <span className="text-[10px] text-muted-foreground pr-1.5">%</span>
          </div>
        </div>
      )}

      {/* Filters */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <SlidersHorizontal className="w-3.5 h-3.5 text-foreground-tertiary" />
          <span className="text-xs font-semibold text-foreground-secondary uppercase tracking-wider">Filters</span>
        </div>
        <div className="rounded-lg border border-border divide-y divide-border/50">
          {filters.map((f, idx) => {
            const label = defaults.filterLabels[f.type as FilterType]
            const isBoolean = f.type === 'subdivision_match' || f.type === 'building_style_match' || f.type === 'property_type'
            const suggestedFilter = suggested?.find((s) => s.type === f.type)
            const hasDiff = suggestedFilter && (suggestedFilter.enabled !== f.enabled || suggestedFilter.value !== f.value)

            return (
              <div
                key={f.type}
                className={`flex items-center gap-3 px-3 py-2 ${hasDiff ? 'bg-amber-500/5 border-l-2 border-l-amber-500' : ''} ${!f.enabled ? 'opacity-50' : ''}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-foreground">{label?.label ?? f.type}</div>
                  {hasDiff && isBoolean && !suggestedFilter!.enabled && (
                    <div className="text-[10px] text-amber-600 mt-0.5">Suggestion: disable this filter</div>
                  )}
                  {hasDiff && !isBoolean && (
                    <div className="text-[10px] text-amber-600 mt-0.5">
                      Suggestion: {f.value} → <span className="font-semibold">{suggestedFilter!.value}</span> {label?.unit}
                    </div>
                  )}
                  {!hasDiff && !compact && label?.description && (
                    <div className="text-[10px] text-muted-foreground mt-0.5">{label.description}</div>
                  )}
                </div>
                {!isBoolean && (
                  <div className="flex items-center rounded-md border border-border bg-muted/30 overflow-hidden w-20">
                    <Input
                      type="number"
                      min={0}
                      step={f.type === 'distance' ? 0.1 : 1}
                      value={f.value}
                      disabled={!f.enabled}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value)
                        if (!isNaN(v) && v >= 0) updateFilter(idx, { value: v })
                      }}
                      className="h-7 w-14 text-[11px] text-right tabular-nums border-0 bg-transparent shadow-none focus-visible:ring-0 pr-1 pl-2"
                    />
                    <span className="text-[10px] text-muted-foreground pr-1.5">{label?.unit}</span>
                  </div>
                )}
                <Switch
                  checked={f.enabled}
                  onCheckedChange={(v) => updateFilter(idx, { enabled: v })}
                  className="data-[state=checked]:bg-blue-500 scale-75"
                />
              </div>
            )
          })}
        </div>
      </div>

    </div>
  )
}

function parseSuggestions(errorMessage: string): string[] {
  const suggestionsMatch = errorMessage.match(/Suggested changes:\n([\s\S]+)/)
  if (!suggestionsMatch) return []
  return suggestionsMatch[1]
    .split('\n')
    .map((s) => s.replace(/^\d+\.\s*/, '').trim())
    .filter(Boolean)
}
