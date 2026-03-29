'use client'

import React, { useState, useEffect, useCallback } from 'react'
import {
  SlidersHorizontal,
  Plus,
  Loader2,
  Star,
  Trash2,
  Pencil,
  MoreHorizontal,
  Check,
  Save,
  RotateCcw,
  Settings2,
  Hammer,
  DollarSign,
  MapPin,
  Building2,
  Map as MapIcon,
  Hash,
  ChevronDown,
  Wrench,
  AlertCircle,
  TrendingUp,
  Navigation,
  ArrowRight,
  ArrowLeft,
  ArrowUp,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  getOrCreateDefaultPreset,
  updateAppraisalPreset,
  getAppraisalDefaults,
  getRehabConfig,
  saveRehabConfig,
  resetRehabConfig,
  getDealParams,
  saveDealParams,
  resetDealParams,
  getLocationSettings,
  createLocationSetting,
  updateLocationSetting,
  deleteLocationSetting,
  getMajorItemCosts,
  saveMajorItemCosts,
  resetMajorItemCosts,
  ARV_TIERS,
  ARV_TIER_LABELS,
  REHAB_LEVEL_NAMES,
  DEFAULT_TIER_RANGES,
  computeTierLabel,
  type AppraisalPreset,
  type AppraisalDefaults,
  type FilterType,
  type AdjustmentType,
  type LocationAppraisalFilter,
  type LocationAppraisalAdjustment,
  type RehabTable,
  type ArvTier,
  type DealParamsConfig,
  type LocationSetting,
  type LocationSettingInput,
  type MajorItemInfo,
  type TierRangeDefinition,
  type ArvThresholdConfig,
  getArvThreshold,
  saveArvThreshold,
  resetArvThreshold,
  getProximityConfig,
  saveProximityConfig,
  resetProximityConfig,
  PROXIMITY_DEFAULTS,
  type ProximityConfig,
  type ProximityPosition,
} from '@/lib/client-api'

// ═══════════════════════════════════════════════════════════════════════════════
// APPRAISAL RULES TAB — preset list only
// ═══════════════════════════════════════════════════════════════════════════════

type FormFilterState = { filterType: FilterType; enabled: boolean; value: number }
type FormAdjustmentState = { adjustmentType: AdjustmentType; enabled: boolean; amount: number; percentage: number }

function buildDefaultFormState(defaults: AppraisalDefaults) {
  return {
    filters: defaults.filters.map((f) => ({ filterType: f.type, enabled: f.enabled, value: f.value })),
    adjustments: defaults.adjustments.map((a) => ({
      adjustmentType: a.type,
      enabled: a.enabled,
      amount: a.amount,
      percentage: a.percent ?? 0,
    })),
  }
}

function buildFormStateFromPreset(preset: AppraisalPreset, defaults: AppraisalDefaults) {
  const base = buildDefaultFormState(defaults)
  const filterMap = new Map(preset.filters.map((f) => [f.filterType, f]))
  const adjMap = new Map(preset.adjustments.map((a) => [a.adjustmentType, a]))
  return {
    filters: base.filters.map((f) => {
      const saved = filterMap.get(f.filterType)
      return saved ? { filterType: f.filterType, enabled: saved.enabled, value: saved.value } : f
    }),
    adjustments: base.adjustments.map((a) => {
      const saved = adjMap.get(a.adjustmentType)
      return saved
        ? { adjustmentType: a.adjustmentType, enabled: saved.enabled, amount: saved.amount, percentage: saved.percentage }
        : a
    }),
  }
}

// ─── Filter / Adjustment inline editors (used inside PresetFormDialog) ─────────

function RulesTable({
  accent,
  headers,
  children,
}: {
  accent: 'blue' | 'emerald' | 'amber'
  headers: string[]
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <div
        className={`grid text-[9px] font-semibold uppercase tracking-widest px-3 py-2 border-b ${
          accent === 'blue'
            ? 'border-blue-500/20 bg-blue-500/5 text-blue-600 dark:text-blue-400'
            : 'border-emerald-500/20 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400'
        }`}
        style={{ gridTemplateColumns: headers.length === 3 ? '1fr 120px 80px' : '1fr 120px 100px 80px' }}
      >
        {headers.map((h) => (
          <span key={h} className={h !== headers[0] ? 'text-center' : ''}>{h}</span>
        ))}
      </div>
      <div className="divide-y divide-border/30 bg-background">{children}</div>
    </div>
  )
}

function FilterRow({
  filterType,
  label,
  unit,
  description,
  enabled,
  value,
  isBoolean,
  onToggle,
  onValueChange,
}: {
  filterType: FilterType
  label: string
  unit: string
  description: string
  enabled: boolean
  value: number
  isBoolean: boolean
  onToggle: (enabled: boolean) => void
  onValueChange: (value: number) => void
}) {
  return (
    <div
      className={`grid items-center gap-x-3 px-3 py-2 transition-colors ${enabled ? '' : 'opacity-50'}`}
      style={{ gridTemplateColumns: '1fr 120px 80px' }}
    >
      <div className="min-w-0">
        <div className="text-[12px] font-medium text-foreground leading-tight">{label}</div>
        <div className="text-[10px] text-muted-foreground mt-0.5 leading-tight truncate">{description}</div>
      </div>
      <div className="flex items-center justify-center">
        {isBoolean ? (
          <span className={`text-[10px] font-medium px-2.5 py-1 rounded-full border ${
            enabled
              ? 'bg-blue-500/10 border-blue-400/30 text-blue-600 dark:text-blue-400'
              : 'bg-muted border-border text-muted-foreground'
          }`}>
            {enabled ? 'Required' : 'Ignored'}
          </span>
        ) : (
          <div className="flex items-center rounded-md border border-border bg-muted/30 overflow-hidden focus-within:ring-1 focus-within:ring-primary/30 focus-within:border-primary/50">
            <Input
              type="number"
              min={0}
              step={filterType === 'distance' ? 0.1 : 1}
              value={value}
              disabled={!enabled}
              onChange={(e) => {
                const v = parseFloat(e.target.value)
                if (!isNaN(v) && v >= 0) onValueChange(v)
              }}
              className="h-7 w-16 text-[11px] text-right tabular-nums border-0 bg-transparent shadow-none focus-visible:ring-0 pr-1 pl-2"
            />
            <span className="text-[10px] text-muted-foreground pr-2 select-none">{unit}</span>
          </div>
        )}
      </div>
      <div className="flex justify-center">
        <Switch checked={enabled} onCheckedChange={onToggle} className="data-[state=checked]:bg-blue-500" />
      </div>
    </div>
  )
}

function AdjustmentRow({
  adjustmentType,
  label,
  description,
  enabled,
  amount,
  percentage,
  isPercentage,
  unavailable,
  onToggle,
  onAmountChange,
  onPercentageChange,
}: {
  adjustmentType: AdjustmentType
  label: string
  description: string
  enabled: boolean
  amount: number
  percentage: number
  isPercentage: boolean
  unavailable?: boolean
  onToggle: (enabled: boolean) => void
  onAmountChange: (value: number) => void
  onPercentageChange: (value: number) => void
}) {
  return (
    <div
      className={`grid items-center gap-x-3 px-3 py-2 transition-colors ${unavailable || !enabled ? 'opacity-50' : ''}`}
      style={{ gridTemplateColumns: '1fr 120px 100px 80px' }}
    >
      <div className="min-w-0">
        <div className="text-[12px] font-medium text-foreground leading-tight">{label}</div>
        <div className="text-[10px] text-muted-foreground mt-0.5 leading-tight truncate">{description}</div>
      </div>
      <div className="flex justify-center">
        <span className={`text-[9px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border ${
          unavailable
            ? 'border-border text-muted-foreground/50 bg-muted/20'
            : isPercentage
              ? 'border-amber-400/30 text-amber-600 dark:text-amber-400 bg-amber-500/5'
              : 'border-emerald-400/30 text-emerald-600 dark:text-emerald-400 bg-emerald-500/5'
        }`}>
          {unavailable ? 'N/A' : isPercentage ? 'Percent' : 'Dollar'}
        </span>
      </div>
      <div className="flex items-center justify-center">
        {unavailable ? (
          <span className="text-[10px] text-muted-foreground/40">—</span>
        ) : isPercentage ? (
          <div className="flex items-center rounded-md border border-border bg-muted/30 overflow-hidden focus-within:ring-1 focus-within:ring-primary/30 focus-within:border-primary/50">
            <Input
              type="number" min={0} max={100} value={percentage} disabled={!enabled}
              onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 0 && v <= 100) onPercentageChange(v) }}
              className="h-7 w-12 text-[11px] text-right tabular-nums border-0 bg-transparent shadow-none focus-visible:ring-0 pr-1 pl-2"
            />
            <span className="text-[10px] text-muted-foreground pr-2 select-none">%</span>
          </div>
        ) : (
          <div className="flex items-center rounded-md border border-border bg-muted/30 overflow-hidden focus-within:ring-1 focus-within:ring-primary/30 focus-within:border-primary/50">
            <span className="text-[10px] text-muted-foreground pl-2 select-none">$</span>
            <Input
              type="number" min={0} step={1000} value={amount} disabled={!enabled}
              onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 0) onAmountChange(v) }}
              className="h-7 w-20 text-[11px] text-right tabular-nums border-0 bg-transparent shadow-none focus-visible:ring-0 pr-2"
            />
          </div>
        )}
      </div>
      <div className="flex justify-center">
        {unavailable ? (
          <Switch checked={false} disabled className="opacity-40" />
        ) : (
          <Switch checked={enabled} onCheckedChange={onToggle} className="data-[state=checked]:bg-emerald-500" />
        )}
      </div>
    </div>
  )
}

// ─── Preset Form Dialog (create / edit) ────────────────────────────────────────

function PresetFormDialog({
  open,
  onClose,
  onSaved,
  defaults,
  editingPreset,
}: {
  open: boolean
  onClose: () => void
  onSaved: (preset: AppraisalPreset) => void
  defaults: AppraisalDefaults
  editingPreset: AppraisalPreset | null
}) {
  const isEdit = editingPreset !== null
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [isDefault, setIsDefault] = useState(false)
  const [filters, setFilters] = useState<FormFilterState[]>([])
  const [adjustments, setAdjustments] = useState<FormAdjustmentState[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    if (isEdit && editingPreset) {
      setName(editingPreset.name)
      setDescription(editingPreset.description ?? '')
      setIsDefault(editingPreset.isDefault)
      const { filters: f, adjustments: a } = buildFormStateFromPreset(editingPreset, defaults)
      setFilters(f)
      setAdjustments(a)
    } else {
      setName('')
      setDescription('')
      setIsDefault(false)
      const { filters: f, adjustments: a } = buildDefaultFormState(defaults)
      setFilters(f)
      setAdjustments(a)
    }
    setError(null)
  }, [open, isEdit, editingPreset, defaults])

  const updateFilter = (idx: number, patch: Partial<FormFilterState>) =>
    setFilters((prev) => prev.map((f, i) => (i === idx ? { ...f, ...patch } : f)))

  const updateAdjustment = (idx: number, patch: Partial<FormAdjustmentState>) =>
    setAdjustments((prev) => prev.map((a, i) => (i === idx ? { ...a, ...patch } : a)))

  const handleSubmit = async () => {
    if (!name.trim()) { setError('Preset name is required'); return }
    setSaving(true); setError(null)
    try {
      const input = {
        name: name.trim(),
        description: description.trim() || undefined,
        isDefault,
        filters: filters.map((f) => ({ filterType: f.filterType, enabled: f.enabled, value: f.value })),
        adjustments: adjustments.map((a) => ({ adjustmentType: a.adjustmentType, enabled: a.enabled, amount: a.amount, percentage: a.percentage })),
      }
      const saved = await updateAppraisalPreset(editingPreset!.id, input)
      onSaved(saved)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SlidersHorizontal className="w-4 h-4 text-primary" />
            {isEdit ? 'Edit Preset' : 'New Preset'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-1">
          {/* Name + description */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Preset Name *</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Standard Underwriting" className="h-8 text-sm" autoFocus />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-foreground">Description</label>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" className="h-8 text-sm" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="set-default-dialog" checked={isDefault} onCheckedChange={setIsDefault} />
            <label htmlFor="set-default-dialog" className="text-xs font-medium text-foreground cursor-pointer">Set as default preset</label>
          </div>

          {/* Filter Rules */}
          {filters.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="inline-block w-2 h-2 rounded-full bg-blue-500" />
                <span className="text-xs font-semibold text-foreground">Filter Rules</span>
                <span className="text-[10px] text-muted-foreground">— exclude comps that don&apos;t meet threshold criteria</span>
              </div>
              <RulesTable accent="blue" headers={['Rule', 'Threshold', 'Active']}>
                {filters.map((f, idx) => {
                  const labelInfo = defaults.filterLabels[f.filterType]
                  const isBoolean = f.filterType === 'subdivision_match' || f.filterType === 'building_style_match' || f.filterType === 'property_type'
                  return (
                    <FilterRow
                      key={f.filterType}
                      filterType={f.filterType}
                      label={labelInfo?.label ?? f.filterType}
                      unit={labelInfo?.unit ?? ''}
                      description={labelInfo?.description ?? ''}
                      enabled={f.enabled}
                      value={f.value}
                      isBoolean={isBoolean}
                      onToggle={(v) => updateFilter(idx, { enabled: v })}
                      onValueChange={(v) => updateFilter(idx, { value: v })}
                    />
                  )
                })}
              </RulesTable>
            </div>
          )}

          {/* Adjustment Rules */}
          {adjustments.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
                <span className="text-xs font-semibold text-foreground">Adjustment Rules</span>
                <span className="text-[10px] text-muted-foreground">— modify comp prices to normalize differences</span>
              </div>
              <RulesTable accent="emerald" headers={['Rule', 'Type', 'Amount', 'Active']}>
                {adjustments.map((a, idx) => {
                  const labelInfo = defaults.adjustmentLabels[a.adjustmentType]
                  return (
                    <AdjustmentRow
                      key={a.adjustmentType}
                      adjustmentType={a.adjustmentType}
                      label={labelInfo?.label ?? a.adjustmentType}
                      description={labelInfo?.description ?? ''}
                      enabled={a.enabled}
                      amount={a.amount}
                      percentage={a.percentage}
                      isPercentage={!!labelInfo?.isPercentage}
                      unavailable={!!labelInfo?.unavailable}
                      onToggle={(v) => updateAdjustment(idx, { enabled: v })}
                      onAmountChange={(v) => updateAdjustment(idx, { amount: v })}
                      onPercentageChange={(v) => updateAdjustment(idx, { percentage: v })}
                    />
                  )
                })}
              </RulesTable>
            </div>
          )}

          {error && (
            <div className="px-3 py-2 rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-400">{error}</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button size="sm" onClick={handleSubmit} disabled={saving} className="gap-1.5">
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {isEdit ? 'Update Preset' : 'Save Preset'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Preset Card ───────────────────────────────────────────────────────────────

const FILTER_SHORT: Record<string, string> = {
  subdivision_match: 'Subdivision', sale_age: 'Sale Age', sqft_diff: 'Sqft Diff',
  property_type: 'Prop. Type', year_built_diff: 'Year Built', distance: 'Distance',
}
const FILTER_UNIT: Record<string, string> = { sale_age: 'days', sqft_diff: '%', year_built_diff: 'yrs', distance: 'mi' }
const ADJUSTMENT_SHORT: Record<string, string> = {
  old_comp_discount: 'Comp Discount', bedroom: 'Bedroom', bathroom: 'Bathroom',
  pool: 'Pool', garage: 'Garage', carport: 'Carport',
}

function FilterChip({ label, value, enabled }: { label: string; value: string; enabled: boolean }) {
  return (
    <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md border text-[10px] transition-colors ${
      enabled ? 'border-blue-400/30 bg-blue-500/5 text-foreground' : 'border-border bg-muted/20 text-muted-foreground/50 line-through'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${enabled ? 'bg-blue-500' : 'bg-muted-foreground/30'}`} />
      <span className="font-medium">{label}</span>
      {value && <span className={enabled ? 'text-muted-foreground' : 'text-muted-foreground/40'}>{value}</span>}
    </div>
  )
}

function AdjustmentChip({ label, value, enabled }: { label: string; value: string; enabled: boolean }) {
  return (
    <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md border text-[10px] transition-colors ${
      enabled ? 'border-emerald-400/30 bg-emerald-500/5 text-foreground' : 'border-border bg-muted/20 text-muted-foreground/50 line-through'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${enabled ? 'bg-emerald-500' : 'bg-muted-foreground/30'}`} />
      <span className="font-medium">{label}</span>
      {value && <span className={enabled ? 'text-muted-foreground' : 'text-muted-foreground/40'}>{value}</span>}
    </div>
  )
}

function PresetCard({ preset, onEdit, onDelete, onSetDefault }: {
  preset: AppraisalPreset
  onEdit: () => void
  onDelete: () => void
  onSetDefault: () => void
}) {
  return (
    <Card className={`border-border hover:border-border transition-colors ${preset.isDefault ? 'ring-1 ring-amber-400/30' : ''}`}>
      <CardContent className="p-0">
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold text-foreground truncate">{preset.name}</span>
            {preset.isDefault && (
              <Badge className="text-[9px] py-0 px-1.5 h-4 bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-400/30 gap-1 flex-shrink-0">
                <Star className="w-2 h-2" />Default
              </Badge>
            )}
            {preset.description && <span className="text-[11px] text-muted-foreground truncate hidden sm:block">— {preset.description}</span>}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <span className="text-[10px] text-muted-foreground/50 hidden md:block mr-2">{new Date(preset.updatedAt).toLocaleDateString()}</span>
            <Button variant="ghost" size="sm" onClick={onEdit} className="h-7 w-7 p-0"><Pencil className="w-3.5 h-3.5" /></Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0"><MoreHorizontal className="w-4 h-4" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {!preset.isDefault ? (
                  <DropdownMenuItem onClick={onSetDefault} className="gap-2 text-xs"><Star className="w-3.5 h-3.5" />Set as Default</DropdownMenuItem>
                ) : (
                  <DropdownMenuItem disabled className="gap-2 text-xs text-muted-foreground"><Check className="w-3.5 h-3.5" />Default Preset</DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onDelete} className="gap-2 text-xs text-red-600 focus:text-red-600 focus:bg-red-500/10">
                  <Trash2 className="w-3.5 h-3.5" />Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-border/30">
          <div className="px-4 py-3 space-y-2">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
              <span className="text-[10px] font-semibold uppercase tracking-widest text-blue-600 dark:text-blue-400">Filters</span>
              <span className="text-[10px] text-muted-foreground/60 ml-auto">{preset.filters.filter((f) => f.enabled).length}/{preset.filters.length} on</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {preset.filters.map((f) => {
                const isBoolean = f.filterType === 'subdivision_match' || f.filterType === 'building_style_match' || f.filterType === 'property_type'
                const unit = FILTER_UNIT[f.filterType]
                return <FilterChip key={f.filterType} label={FILTER_SHORT[f.filterType] ?? f.filterType} value={isBoolean ? '' : `≤ ${f.value}${unit ? ` ${unit}` : ''}`} enabled={f.enabled} />
              })}
              {preset.filters.length === 0 && <span className="text-[10px] text-muted-foreground/50 italic">No filters configured</span>}
            </div>
          </div>
          <div className="px-4 py-3 space-y-2">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              <span className="text-[10px] font-semibold uppercase tracking-widest text-emerald-600 dark:text-emerald-400">Adjustments</span>
              <span className="text-[10px] text-muted-foreground/60 ml-auto">{preset.adjustments.filter((a) => a.enabled).length}/{preset.adjustments.length} on</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {preset.adjustments.map((a) => {
                const isPercent = a.adjustmentType === 'old_comp_discount'
                return <AdjustmentChip key={a.adjustmentType} label={ADJUSTMENT_SHORT[a.adjustmentType] ?? a.adjustmentType} value={isPercent ? `${a.percentage}%` : `$${a.amount.toLocaleString()}`} enabled={a.enabled} />
              })}
              {preset.adjustments.length === 0 && <span className="text-[10px] text-muted-foreground/50 italic">No adjustments configured</span>}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

const US_STATES: { code: string; name: string }[] = [
  { code: 'AL', name: 'Alabama' }, { code: 'AK', name: 'Alaska' }, { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' }, { code: 'CA', name: 'California' }, { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' }, { code: 'DE', name: 'Delaware' }, { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' }, { code: 'HI', name: 'Hawaii' }, { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' }, { code: 'IN', name: 'Indiana' }, { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' }, { code: 'KY', name: 'Kentucky' }, { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' }, { code: 'MD', name: 'Maryland' }, { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' }, { code: 'MN', name: 'Minnesota' }, { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' }, { code: 'MT', name: 'Montana' }, { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' }, { code: 'NH', name: 'New Hampshire' }, { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' }, { code: 'NY', name: 'New York' }, { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' }, { code: 'OH', name: 'Ohio' }, { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' }, { code: 'PA', name: 'Pennsylvania' }, { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' }, { code: 'SD', name: 'South Dakota' }, { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' }, { code: 'UT', name: 'Utah' }, { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' }, { code: 'WA', name: 'Washington' }, { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' }, { code: 'WY', name: 'Wyoming' }, { code: 'DC', name: 'District of Columbia' },
]

function AppraisalRulesTab() {
  const [defaults, setDefaults] = useState<AppraisalDefaults | null>(null)
  const [preset, setPreset] = useState<AppraisalPreset | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Inline form state (mirrors preset filters/adjustments)
  const [filters, setFilters] = useState<FormFilterState[]>([])
  const [adjustments, setAdjustments] = useState<FormAdjustmentState[]>([])
  const [dirty, setDirty] = useState(false)

  // Location overrides for appraisal rules
  const [locSettings, setLocSettings] = useState<LocationSetting[]>([])
  const [locExpandedId, setLocExpandedId] = useState<string | null>(null)
  const [locEditStates, setLocEditStates] = useState<Record<string, {
    filters: FormFilterState[]
    adjustments: FormAdjustmentState[]
    proximity: ProximityConfig
    saving: boolean
    error: string | null
  }>>({})
  const [addLocOpen, setAddLocOpen] = useState(false)
  const [addStateCode, setAddStateCode] = useState('')
  const [addSubScope, setAddSubScope] = useState<'state' | 'city' | 'zip'>('state')
  const [addLocValue, setAddLocValue] = useState('')
  const [addLocError, setAddLocError] = useState<string | null>(null)
  const [addLocSaving, setAddLocSaving] = useState(false)

  // Proximity config state (saved together with appraisal rules)
  const [proximityConfig, setProximityConfig] = useState<ProximityConfig>(PROXIMITY_DEFAULTS)
  const [proximityOriginal, setProximityOriginal] = useState<ProximityConfig>(PROXIMITY_DEFAULTS)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [presetData, defaultsData, settingsData, proxRes] = await Promise.all([
        getOrCreateDefaultPreset(),
        getAppraisalDefaults(),
        getLocationSettings('appraisal'),
        getProximityConfig().catch(() => ({ config: PROXIMITY_DEFAULTS, isCustom: false })),
      ])
      setDefaults(defaultsData)
      setPreset(presetData)
      const { filters: f, adjustments: a } = buildFormStateFromPreset(presetData, defaultsData)
      setFilters(f)
      setAdjustments(a)
      setDirty(false)
      setLocSettings(settingsData)
      setProximityConfig(proxRes.config)
      setProximityOriginal(proxRes.config)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const updateFilter = (idx: number, patch: Partial<FormFilterState>) => {
    setFilters((prev) => prev.map((f, i) => (i === idx ? { ...f, ...patch } : f)))
    setDirty(true)
  }
  const updateAdjustment = (idx: number, patch: Partial<FormAdjustmentState>) => {
    setAdjustments((prev) => prev.map((a, i) => (i === idx ? { ...a, ...patch } : a)))
    setDirty(true)
  }

  const updateProximity = (c: ProximityConfig) => {
    setProximityConfig(c)
    setDirty(true)
  }

  const proximityDirty = JSON.stringify(proximityConfig) !== JSON.stringify(proximityOriginal)

  const handleSave = async () => {
    if (!preset) return
    setSaving(true)
    setError(null)
    try {
      const [saved] = await Promise.all([
        updateAppraisalPreset(preset.id, {
          filters: filters.map((f) => ({ filterType: f.filterType, enabled: f.enabled, value: f.value })),
          adjustments: adjustments.map((a) => ({ adjustmentType: a.adjustmentType, enabled: a.enabled, amount: a.amount, percentage: a.percentage })),
        }),
        proximityDirty ? saveProximityConfig(proximityConfig) : Promise.resolve(null),
      ])
      setPreset(saved)
      setProximityOriginal(proximityConfig)
      setDirty(false)
      setSuccessMessage('Appraisal rules saved.')
      setTimeout(() => setSuccessMessage(null), 3000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleReset = () => {
    if (!defaults) return
    const { filters: f, adjustments: a } = buildDefaultFormState(defaults)
    setFilters(f)
    setAdjustments(a)
    setProximityConfig(PROXIMITY_DEFAULTS)
    setDirty(true)
  }

  // ── Location override helpers ──────────────────────────────────────────────

  function getLocEditState(id: string, s: LocationSetting) {
    if (locEditStates[id]) return locEditStates[id]
    // Seed from the location's saved override, or fall back to default preset values
    let seedFilters: FormFilterState[] = filters
    let seedAdjustments: FormAdjustmentState[] = adjustments
    if (s.appraisalFilters && defaults) {
      const { filters: f, adjustments: a } = buildFormStateFromPreset(
        { filters: s.appraisalFilters.map((f) => ({ ...f, id: '', presetId: '', createdAt: '' })), adjustments: s.appraisalAdjustments?.map((a) => ({ ...a, id: '', presetId: '', createdAt: '' })) ?? [] } as AppraisalPreset,
        defaults
      )
      seedFilters = f
      seedAdjustments = a
    }
    const seedProximity = (s.proximityConfigJson as ProximityConfig | null) ?? proximityConfig
    return { filters: seedFilters, adjustments: seedAdjustments, proximity: seedProximity, saving: false, error: null }
  }

  function patchLocEditState(id: string, s: LocationSetting, patch: Partial<typeof locEditStates[string]>) {
    setLocEditStates((prev) => ({
      ...prev,
      [id]: { ...getLocEditState(id, s), ...patch },
    }))
  }

  async function handleSaveLocOverride(s: LocationSetting) {
    const es = getLocEditState(s.id, s)
    patchLocEditState(s.id, s, { saving: true, error: null })
    try {
      const updated = await updateLocationSetting(s.id, {
        appraisalFilters: es.filters.map((f) => ({ filterType: f.filterType, enabled: f.enabled, value: f.value })),
        appraisalAdjustments: es.adjustments.map((a) => ({ adjustmentType: a.adjustmentType, enabled: a.enabled, amount: a.amount, percentage: a.percentage })),
        proximityConfigJson: es.proximity,
      })
      setLocSettings((prev) => prev.map((x) => x.id === s.id ? updated : x))
      setLocEditStates((prev) => { const n = { ...prev }; delete n[s.id]; return n })
      setLocExpandedId(null)
    } catch (e) {
      patchLocEditState(s.id, s, { error: e instanceof Error ? e.message : 'Failed to save', saving: false })
    }
  }

  async function handleDeleteLoc(id: string) {
    if (!confirm('Delete this location market?')) return
    await deleteLocationSetting(id)
    setLocSettings((prev) => prev.filter((s) => s.id !== id))
    setLocExpandedId(null)
  }

  async function handleAddLoc() {
    if (!addStateCode) { setAddLocError('Please select a state'); return }
    if (addSubScope === 'city' && !addLocValue.trim()) { setAddLocError('City name is required'); return }
    if (addSubScope === 'zip' && !/^\d{5}$/.test(addLocValue.trim())) { setAddLocError('Enter a valid 5-digit zip code'); return }
    setAddLocSaving(true)
    try {
      const input: LocationSettingInput = { settingType: 'appraisal', state: addStateCode }
      if (addSubScope === 'city') input.city = addLocValue.trim()
      else if (addSubScope === 'zip') { input.zipCode = addLocValue.trim(); delete input.state }
      const created = await createLocationSetting(input)
      setLocSettings((prev) => [...prev, created])
      setAddLocOpen(false)
      setLocExpandedId(created.id)
    } catch (e) {
      setAddLocError(e instanceof Error ? e.message : 'Failed to create')
    } finally {
      setAddLocSaving(false)
    }
  }

  function getLocLabel(s: LocationSetting): string {
    if (s.zipCode) return s.zipCode
    if (s.city && s.state) return `${s.city.charAt(0).toUpperCase() + s.city.slice(1)}, ${s.state}`
    return s.state ?? '—'
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Set the default appraisal filters and adjustments applied to every analysis. Add location overrides below to use different rules per market.
      </p>

      {error && (
        <div className="px-4 py-3 rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-400 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />{error}
        </div>
      )}
      {successMessage && !error && (
        <div className="px-4 py-3 rounded-lg bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 text-sm text-green-700 dark:text-green-400">{successMessage}</div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : defaults && (
        <>
          {/* ── Filter Rules ── */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-blue-500" />
              <span className="text-xs font-semibold text-foreground">Filter Rules</span>
              <span className="text-[10px] text-muted-foreground">— exclude comps that don&apos;t meet threshold criteria</span>
            </div>
            <RulesTable accent="blue" headers={['Rule', 'Threshold', 'Active']}>
              {filters.map((f, idx) => {
                const labelInfo = defaults.filterLabels[f.filterType]
                const isBoolean = f.filterType === 'subdivision_match' || f.filterType === 'building_style_match' || f.filterType === 'property_type'
                return (
                  <FilterRow
                    key={f.filterType}
                    filterType={f.filterType}
                    label={labelInfo?.label ?? f.filterType}
                    unit={labelInfo?.unit ?? ''}
                    description={labelInfo?.description ?? ''}
                    enabled={f.enabled}
                    value={f.value}
                    isBoolean={isBoolean}
                    onToggle={(v) => updateFilter(idx, { enabled: v })}
                    onValueChange={(v) => updateFilter(idx, { value: v })}
                  />
                )
              })}
            </RulesTable>
          </div>

          {/* ── Adjustment Rules ── */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
              <span className="text-xs font-semibold text-foreground">Adjustment Rules</span>
              <span className="text-[10px] text-muted-foreground">— modify comp prices to normalize differences</span>
            </div>
            <RulesTable accent="emerald" headers={['Rule', 'Type', 'Amount', 'Active']}>
              {adjustments.map((a, idx) => {
                const labelInfo = defaults.adjustmentLabels[a.adjustmentType]
                return (
                  <AdjustmentRow
                    key={a.adjustmentType}
                    adjustmentType={a.adjustmentType}
                    label={labelInfo?.label ?? a.adjustmentType}
                    description={labelInfo?.description ?? ''}
                    enabled={a.enabled}
                    amount={a.amount}
                    percentage={a.percentage}
                    isPercentage={!!labelInfo?.isPercentage}
                    unavailable={!!labelInfo?.unavailable}
                    onToggle={(v) => updateAdjustment(idx, { enabled: v })}
                    onAmountChange={(v) => updateAdjustment(idx, { amount: v })}
                    onPercentageChange={(v) => updateAdjustment(idx, { percentage: v })}
                  />
                )
              })}
            </RulesTable>
          </div>

          {/* ── Proximity Adjustments ── */}
          <div className="space-y-2 pt-2">
            <div className="flex items-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
              <span className="text-xs font-semibold text-foreground">Proximity Adjustments</span>
              <span className="text-[10px] text-muted-foreground">— deductions for traffic or commercial exposure</span>
            </div>
            <ProximitySection config={proximityConfig} onChange={updateProximity} />
          </div>

          {/* ── Save / Reset ── */}
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" onClick={handleSave} disabled={saving || (!dirty && !proximityDirty)} className="gap-1.5">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Save Changes
            </Button>
            <Button size="sm" variant="outline" onClick={handleReset} disabled={saving} className="gap-1.5">
              <RotateCcw className="w-3.5 h-3.5" />
              Reset to Defaults
            </Button>
            {(dirty || proximityDirty) && <span className="text-xs text-amber-600 dark:text-amber-400">Unsaved changes</span>}
          </div>

          {/* ══ Location Overrides section ══════════════════════════════════════ */}
          <div className="pt-2">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex-1 h-px bg-border" />
              <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground px-1">Location Overrides</span>
              <div className="flex-1 h-px bg-border" />
            </div>

            <div className="flex items-center justify-between mb-3">
              <p className="text-xs text-muted-foreground">Override appraisal rules for specific markets. Most specific match wins: Zip &rsaquo; City &rsaquo; State.</p>
              <Button size="sm" variant="outline" onClick={() => { setAddStateCode(''); setAddSubScope('state'); setAddLocValue(''); setAddLocError(null); setAddLocOpen(true) }} className="gap-1.5 flex-shrink-0">
                <Plus className="w-3.5 h-3.5" />Add Market
              </Button>
            </div>

            {locSettings.length === 0 ? (
              <div className="border border-dashed rounded-lg py-10 flex flex-col items-center justify-center gap-2 text-center">
                <MapPin className="w-5 h-5 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">No location overrides yet</p>
                <p className="text-xs text-muted-foreground/60">Add a state, city, or zip to use different rules for that market.</p>
              </div>
            ) : (
              <div className="border rounded-lg divide-y overflow-hidden">
                {locSettings.map((s) => {
                  const expanded = locExpandedId === s.id
                  const es = getLocEditState(s.id, s)
                  return (
                    <div key={s.id}>
                      <div
                        className={`flex items-center gap-3 px-4 py-3 cursor-pointer select-none transition-colors hover:bg-muted/40 ${expanded ? 'bg-muted/30' : ''}`}
                        onClick={() => setLocExpandedId(expanded ? null : s.id)}
                      >
                        <div className={`flex-shrink-0 p-1.5 rounded-md ${expanded ? 'bg-primary/15' : 'bg-muted'}`}>
                          {s.zipCode ? <Hash className={`w-3.5 h-3.5 ${expanded ? 'text-primary' : 'text-muted-foreground'}`} /> :
                           s.city ? <Building2 className={`w-3.5 h-3.5 ${expanded ? 'text-primary' : 'text-muted-foreground'}`} /> :
                           <MapIcon className={`w-3.5 h-3.5 ${expanded ? 'text-primary' : 'text-muted-foreground'}`} />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-semibold text-foreground">{getLocLabel(s)}</span>
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            {s.hasAppraisalOverride || s.hasProximityConfig
                              ? (s.isEnabled
                                ? `Custom ${[s.hasAppraisalOverride && 'appraisal', s.hasProximityConfig && 'proximity'].filter(Boolean).join(' + ')} rules active`
                                : 'Override saved (disabled)')
                              : 'No override — using default rules'}
                          </p>
                        </div>
                        {s.hasAppraisalOverride && (
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${s.isEnabled ? 'bg-blue-500' : 'bg-gray-400'}`} title={s.isEnabled ? 'Appraisal override active' : 'Appraisal override saved (disabled)'} />
                        )}
                        <ChevronDown className={`w-4 h-4 text-muted-foreground flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                      </div>

                      {expanded && (
                        <div className="border-t bg-card px-4 pt-3 pb-4 space-y-3">
                          {es.error && <div className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">{es.error}</div>}

                          <div className="flex items-center justify-between">
                            <p className="text-xs text-muted-foreground">
                              {s.isEnabled
                                ? 'Enabled — override applied during analysis'
                                : 'Disabled — override saved but not applied'}
                            </p>
                            <Switch
                              checked={s.isEnabled}
                              onCheckedChange={async (v) => {
                                const updated = await updateLocationSetting(s.id, { isEnabled: v })
                                setLocSettings((prev) => prev.map((x) => x.id === s.id ? updated : x))
                              }}
                              className="data-[state=checked]:bg-blue-500"
                            />
                          </div>

                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <span className="inline-block w-2 h-2 rounded-full bg-blue-500" />
                              <span className="text-xs font-semibold text-foreground">Filter Rules</span>
                            </div>
                            <RulesTable accent="blue" headers={['Rule', 'Threshold', 'Active']}>
                              {es.filters.map((f, idx) => {
                                const labelInfo = defaults.filterLabels[f.filterType]
                                const isBoolean = f.filterType === 'subdivision_match' || f.filterType === 'building_style_match' || f.filterType === 'property_type'
                                return (
                                  <FilterRow
                                    key={f.filterType}
                                    filterType={f.filterType}
                                    label={labelInfo?.label ?? f.filterType}
                                    unit={labelInfo?.unit ?? ''}
                                    description={labelInfo?.description ?? ''}
                                    enabled={f.enabled}
                                    value={f.value}
                                    isBoolean={isBoolean}
                                    onToggle={(v) => patchLocEditState(s.id, s, { filters: es.filters.map((ff, i) => i === idx ? { ...ff, enabled: v } : ff) })}
                                    onValueChange={(v) => patchLocEditState(s.id, s, { filters: es.filters.map((ff, i) => i === idx ? { ...ff, value: v } : ff) })}
                                  />
                                )
                              })}
                            </RulesTable>
                          </div>

                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
                              <span className="text-xs font-semibold text-foreground">Adjustment Rules</span>
                            </div>
                            <RulesTable accent="emerald" headers={['Rule', 'Type', 'Amount', 'Active']}>
                              {es.adjustments.map((a, idx) => {
                                const labelInfo = defaults.adjustmentLabels[a.adjustmentType]
                                return (
                                  <AdjustmentRow
                                    key={a.adjustmentType}
                                    adjustmentType={a.adjustmentType}
                                    label={labelInfo?.label ?? a.adjustmentType}
                                    description={labelInfo?.description ?? ''}
                                    enabled={a.enabled}
                                    amount={a.amount}
                                    percentage={a.percentage}
                                    isPercentage={!!labelInfo?.isPercentage}
                                    unavailable={!!labelInfo?.unavailable}
                                    onToggle={(v) => patchLocEditState(s.id, s, { adjustments: es.adjustments.map((aa, i) => i === idx ? { ...aa, enabled: v } : aa) })}
                                    onAmountChange={(v) => patchLocEditState(s.id, s, { adjustments: es.adjustments.map((aa, i) => i === idx ? { ...aa, amount: v } : aa) })}
                                    onPercentageChange={(v) => patchLocEditState(s.id, s, { adjustments: es.adjustments.map((aa, i) => i === idx ? { ...aa, percentage: v } : aa) })}
                                  />
                                )
                              })}
                            </RulesTable>
                          </div>

                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
                              <span className="text-xs font-semibold text-foreground">Proximity Adjustments</span>
                            </div>
                            <ProximitySection
                              config={es.proximity}
                              onChange={(c) => patchLocEditState(s.id, s, { proximity: c })}
                            />
                          </div>

                          <div className="flex items-center justify-between pt-1">
                            <Button size="sm" variant="ghost" className="gap-1.5 text-muted-foreground h-7 px-2 text-xs"
                              onClick={() => handleDeleteLoc(s.id)}>
                              <Trash2 className="w-3 h-3" />Delete Market
                            </Button>
                            <div className="flex items-center gap-2">
                              <Button size="sm" variant="outline" className="h-7 px-3 text-xs"
                                onClick={() => { setLocEditStates((prev) => { const n = { ...prev }; delete n[s.id]; return n }); setLocExpandedId(null) }}>
                                Cancel
                              </Button>
                              <Button size="sm" className="h-7 px-3 gap-1.5 text-xs"
                                disabled={es.saving}
                                onClick={() => handleSaveLocOverride(s)}>
                                {es.saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                Save Override
                              </Button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Add Location Dialog */}
          <Dialog open={addLocOpen} onOpenChange={setAddLocOpen}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle>Add Market Override</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-1">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-foreground">State</label>
                  <select
                    value={addStateCode}
                    onChange={e => { setAddStateCode(e.target.value); setAddSubScope('state'); setAddLocValue(''); setAddLocError(null) }}
                    className={`w-full h-9 text-sm rounded-md border bg-background px-2 ${addLocError && !addStateCode ? 'border-destructive' : 'border-input'}`}
                    autoFocus
                  >
                    <option value="">— Select a state —</option>
                    {US_STATES.map(s => (
                      <option key={s.code} value={s.code}>{s.name} ({s.code})</option>
                    ))}
                  </select>
                </div>
                {addStateCode && (
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-foreground">Narrow to</label>
                      <div className="grid grid-cols-3 gap-2">
                        {([
                          { scope: 'state' as const, label: 'Entire State', desc: 'All cities' },
                          { scope: 'city'  as const, label: 'City',         desc: 'Specific city' },
                          { scope: 'zip'   as const, label: 'Zip Code',     desc: 'Single zip' },
                        ]).map(({ scope, label, desc }) => (
                          <button key={scope}
                            onClick={() => { setAddSubScope(scope); setAddLocValue(''); setAddLocError(null) }}
                            className={`py-2 px-1 text-xs rounded-lg border font-medium transition-colors flex flex-col items-center gap-0.5 ${
                              addSubScope === scope
                                ? 'bg-primary text-primary-foreground border-primary'
                                : 'bg-background text-muted-foreground border-border hover:border-foreground/30'
                            }`}
                          >
                            <span>{label}</span>
                            <span className={`text-[10px] font-normal ${addSubScope === scope ? 'text-primary-foreground/70' : 'text-muted-foreground/60'}`}>{desc}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    {addSubScope === 'city' && (
                      <Input placeholder="e.g. Miami" value={addLocValue}
                        onChange={e => { setAddLocValue(e.target.value); setAddLocError(null) }}
                        onKeyDown={e => e.key === 'Enter' && handleAddLoc()} className="h-9" autoFocus />
                    )}
                    {addSubScope === 'zip' && (
                      <Input placeholder="e.g. 33101" value={addLocValue}
                        onChange={e => { setAddLocValue(e.target.value); setAddLocError(null) }}
                        onKeyDown={e => e.key === 'Enter' && handleAddLoc()} className="h-9" autoFocus />
                    )}
                  </div>
                )}
                {addLocError && <p className="text-xs text-destructive">{addLocError}</p>}
              </div>
              <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => setAddLocOpen(false)}>Cancel</Button>
                <Button size="sm" onClick={handleAddLoc}
                  disabled={addLocSaving || !addStateCode}
                  className="gap-1.5">
                  {addLocSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                  Add & Configure
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// RENOVATION LEVELS TAB
// ═══════════════════════════════════════════════════════════════════════════════

/** Format a dollar value for display: $500K, $1M, $1.5M, etc. */
function fmtBound(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return m % 1 === 0 ? `$${m}M` : `$${m.toFixed(1)}M`
  }
  if (n >= 1000) return `$${Math.round(n / 1000)}K`
  return `$${n}`
}

/** Editable boundary pill shown between tier cards in the range bar */
function BoundaryPill({
  value,
  minAllowed,
  onChange,
  onRemoveNext,
}: {
  value: number
  minAllowed: number
  onChange: (v: number) => void
  onRemoveNext?: () => void
}) {
  const [draft, setDraft] = useState(value.toLocaleString())
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!focused) setDraft(value.toLocaleString())
  }, [value, focused])

  const commit = () => {
    setFocused(false)
    const raw = draft.replace(/[,$\s]/g, '')
    const v = parseInt(raw, 10)
    if (!isNaN(v) && v > minAllowed) {
      onChange(v)
    } else {
      setDraft(value.toLocaleString())
    }
  }

  return (
    <div className="flex flex-col items-center gap-0.5 relative group">
      <div className="relative">
        <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 text-[9px] pointer-events-none select-none">$</span>
        <Input
          type="text"
          inputMode="numeric"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => { setFocused(true); setDraft(String(value)); e.target.select() }}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur() } }}
          className="h-7 w-[100px] text-[11px] pl-4 pr-1.5 text-center tabular-nums rounded-full border-primary/30 bg-background hover:border-primary/60 focus:border-primary shadow-sm"
        />
      </div>
      {onRemoveNext && (
        <button
          onClick={onRemoveNext}
          className="absolute -top-1.5 -right-1.5 hidden group-hover:flex items-center justify-center w-4 h-4 rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90"
          title="Remove this boundary (merge tiers)"
        >
          <span className="text-[9px] leading-none font-bold">&times;</span>
        </button>
      )}
    </div>
  )
}

/** Compact range bar: shows tier breakpoints as editable pills.
 *  Wraps naturally when there are many tiers. */
function TierRangeBar({
  tierRanges,
  onBoundaryChange,
  onRemoveBoundary,
}: {
  tierRanges: TierRangeDefinition[]
  onBoundaryChange: (index: number, value: number) => void
  onRemoveBoundary?: (boundaryIndex: number) => void
}) {
  const boundaries = tierRanges
    .slice(0, -1)
    .map((t, idx) => ({ value: t.maxValue!, minAllowed: t.minValue ?? 0, idx }))
    .filter((b) => b.value !== null)

  if (boundaries.length === 0) return null

  return (
    <div className="border rounded-lg bg-muted/20 px-4 py-3">
      <div className="flex items-center gap-1 mb-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Tier breakpoints</span>
        <span className="text-[10px] text-muted-foreground/50">— edit values to adjust tier ranges</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] text-muted-foreground/60">$0</span>
        {boundaries.map((b, i) => (
          <React.Fragment key={b.idx}>
            <div className="w-4 h-px bg-border" />
            <BoundaryPill
              value={b.value}
              minAllowed={b.minAllowed}
              onChange={(v) => onBoundaryChange(b.idx, v)}
              onRemoveNext={tierRanges.length > 1 && onRemoveBoundary ? () => onRemoveBoundary(b.idx) : undefined}
            />
            {i < boundaries.length - 1 && <div className="w-4 h-px bg-border" />}
          </React.Fragment>
        ))}
        <div className="w-4 h-px bg-border" />
        <span className="text-[10px] text-muted-foreground/60">&infin;</span>
      </div>
    </div>
  )
}

function TierCard({
  range,
  estimates,
  onUpdate,
}: {
  range: TierRangeDefinition
  estimates: Array<{ perSqft: number; minProfit: number }>
  onUpdate: (levelIndex: number, field: 'perSqft' | 'minProfit', value: number) => void
}) {
  return (
    <Card className="border-border">
      <CardContent className="p-0">
        <div className="px-3 pt-3 pb-2 border-b border-border">
          <CardTitle className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            {computeTierLabel(range)}
          </CardTitle>
        </div>
        <div className="grid grid-cols-[1fr_60px_80px] text-[9px] font-medium text-muted-foreground/60 uppercase tracking-wider px-3 py-1 border-b border-border">
          <span>Level</span>
          <span className="text-right">$/sqft</span>
          <span className="text-right">Min Profit</span>
        </div>
        <div>
          {estimates.map((est, levelIdx) => {
            const levelName = REHAB_LEVEL_NAMES[levelIdx]
            return (
              <TooltipProvider key={levelName} delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="grid grid-cols-[1fr_60px_80px] items-center gap-x-1.5 px-3 py-[3px] border-b border-border last:border-0">
                      <span className="text-[11px] text-foreground/80 font-medium">{levelName}</span>
                      <div className="relative">
                        <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 text-[9px] pointer-events-none select-none">$</span>
                        <Input
                          type="number" min={0} value={est.perSqft}
                          onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 0) onUpdate(levelIdx, 'perSqft', v) }}
                          className="h-6 text-[11px] pl-4 pr-1 text-right tabular-nums rounded-sm border-border bg-muted/30 focus:bg-background"
                        />
                      </div>
                      <div className="relative">
                        <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 text-[9px] pointer-events-none select-none">$</span>
                        <Input
                          type="number" min={0} step={1000} value={est.minProfit}
                          onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 0) onUpdate(levelIdx, 'minProfit', v) }}
                          className="h-6 text-[11px] pl-4 pr-1 text-right tabular-nums rounded-sm border-border bg-muted/30 focus:bg-background"
                        />
                      </div>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    <p className="font-medium">{levelName}</p>
                    <p className="text-muted-foreground">${est.perSqft}/sqft · min profit ${est.minProfit.toLocaleString()}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}

function RenovationLevelsTab() {
  const [table, setTable] = useState<RehabTable | null>(null)
  const [original, setOriginal] = useState<RehabTable | null>(null)
  const [isCustom, setIsCustom] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  // Tier ranges state
  const [tierRanges, setTierRanges] = useState<TierRangeDefinition[]>(DEFAULT_TIER_RANGES)
  const [originalTierRanges, setOriginalTierRanges] = useState<TierRangeDefinition[]>(DEFAULT_TIER_RANGES)

  // Location overrides
  const [locSettings, setLocSettings] = useState<LocationSetting[]>([])
  const [locExpandedId, setLocExpandedId] = useState<string | null>(null)
  const [locEditStates, setLocEditStates] = useState<Record<string, {
    rehabTable: RehabTable; tierRanges: TierRangeDefinition[]; saving: boolean; error: string | null
  }>>({})
  const [addLocOpen, setAddLocOpen] = useState(false)
  const [addStateCode, setAddStateCode] = useState('')
  const [addSubScope, setAddSubScope] = useState<'state' | 'city' | 'zip'>('state')
  const [addLocValue, setAddLocValue] = useState('')
  const [addLocError, setAddLocError] = useState<string | null>(null)
  const [addLocSaving, setAddLocSaving] = useState(false)

  // Derived tier keys from current tierRanges
  const tierKeys = tierRanges.map((t) => t.key)

  const fallbackRehabTable = useCallback(() => tierKeys.reduce((acc, tier) => {
    acc[tier] = REHAB_LEVEL_NAMES.map(() => ({ perSqft: 25, minProfit: 30000 }))
    return acc
  }, {} as RehabTable), [tierKeys])

  useEffect(() => {
    setLoading(true)
    Promise.all([getRehabConfig(), getLocationSettings('rehab')])
      .then(([res, settingsData]) => {
        setTable(structuredClone(res.config))
        setOriginal(structuredClone(res.config))
        setIsCustom(res.isCustom)
        setUpdatedAt(res.updatedAt)
        const ranges = res.tierRanges ?? DEFAULT_TIER_RANGES
        setTierRanges(structuredClone(ranges))
        setOriginalTierRanges(structuredClone(ranges))
        setLocSettings(settingsData)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load config'))
      .finally(() => setLoading(false))
  }, [])

  const isDirty = (table !== null && original !== null && JSON.stringify(table) !== JSON.stringify(original))
    || JSON.stringify(tierRanges) !== JSON.stringify(originalTierRanges)

  const handleUpdate = useCallback((tier: string, levelIndex: number, field: 'perSqft' | 'minProfit', value: number) => {
    setTable((prev) => {
      if (!prev) return prev
      const next = { ...prev, [tier]: [...(prev[tier] ?? [])] }
      next[tier][levelIndex] = { ...next[tier][levelIndex], [field]: value }
      return next
    })
  }, [])

  // Tier boundary editing — updates upper bound and cascades to keep all ranges contiguous and valid
  const handleBoundaryChange = useCallback((index: number, newMaxValue: number) => {
    setTierRanges((prev) => {
      const next = structuredClone(prev)
      next[index].maxValue = newMaxValue

      // Cascade forward: each subsequent tier's min follows the previous tier's max.
      // If a tier's max ends up <= its new min, push its max up too.
      for (let i = index + 1; i < next.length; i++) {
        next[i].minValue = next[i - 1].maxValue
        // If this tier has an upper bound that's now <= its lower bound, push it up
        if (next[i].maxValue !== null && next[i].minValue !== null && next[i].maxValue! <= next[i].minValue!) {
          next[i].maxValue = next[i].minValue! + 1000
        }
      }

      // Recompute all labels
      next.forEach((t) => { t.label = computeTierLabel(t) })
      return next
    })
  }, [])

  const handleAddTier = useCallback(() => {
    setTierRanges((prev) => {
      const next = structuredClone(prev)
      const lastIdx = next.length - 1
      const lastTier = next[lastIdx]
      const splitPoint = (lastTier.minValue ?? 0) + 500000

      // Give the current last tier an upper bound
      lastTier.maxValue = splitPoint
      lastTier.label = computeTierLabel(lastTier)

      // Create new last tier (no upper bound)
      const newTier: TierRangeDefinition = {
        key: `tier_${Date.now()}`,
        label: '',
        minValue: splitPoint,
        maxValue: null,
      }
      newTier.label = computeTierLabel(newTier)
      next.push(newTier)

      // Initialize pricing for the new tier
      setTable((prevTable) => {
        if (!prevTable) return prevTable
        return {
          ...prevTable,
          [newTier.key]: REHAB_LEVEL_NAMES.map(() => ({ perSqft: 25, minProfit: 30000 })),
        }
      })
      return next
    })
  }, [])

  // Remove a boundary between tier[boundaryIndex] and tier[boundaryIndex+1],
  // merging them by dropping the right tier and extending the left tier's range
  const handleRemoveBoundary = useCallback((boundaryIndex: number) => {
    setTierRanges((prev) => {
      if (prev.length <= 1) return prev
      const next = structuredClone(prev)
      const removedIdx = boundaryIndex + 1
      const removed = next[removedIdx]
      // Extend the left tier to cover the removed tier's range
      next[boundaryIndex].maxValue = removed.maxValue
      next.splice(removedIdx, 1)
      // Recompute all labels
      next.forEach((t) => { t.label = computeTierLabel(t) })
      // Remove the right tier's pricing from the rehab table
      setTable((prevTable) => {
        if (!prevTable) return prevTable
        const t = { ...prevTable }
        delete t[removed.key]
        return t
      })
      return next
    })
  }, [])

  const handleSave = async () => {
    if (!table || !isDirty) return
    setSaving(true); setError(null); setSuccessMessage(null)
    try {
      // Auto-compute labels before save
      const rangesWithLabels = tierRanges.map((t) => ({ ...t, label: computeTierLabel(t) }))
      const tierRangesToSave = JSON.stringify(rangesWithLabels) !== JSON.stringify(DEFAULT_TIER_RANGES) ? rangesWithLabels : undefined
      const res = await saveRehabConfig(table, tierRangesToSave)
      setOriginal(structuredClone(res.config))
      setTable(structuredClone(res.config))
      const ranges = res.tierRanges ?? DEFAULT_TIER_RANGES
      setTierRanges(structuredClone(ranges))
      setOriginalTierRanges(structuredClone(ranges))
      setIsCustom(true); setUpdatedAt(res.updatedAt)
      setSuccessMessage('Renovation pricing saved successfully.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    if (!confirm('Reset all renovation pricing and tier ranges to system defaults? This cannot be undone.')) return
    setSaving(true); setError(null); setSuccessMessage(null)
    try {
      const res = await resetRehabConfig()
      setTable(structuredClone(res.config)); setOriginal(structuredClone(res.config))
      const ranges = res.tierRanges ?? DEFAULT_TIER_RANGES
      setTierRanges(structuredClone(ranges))
      setOriginalTierRanges(structuredClone(ranges))
      setIsCustom(false); setUpdatedAt(undefined)
      setSuccessMessage('Reset to system defaults.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed')
    } finally {
      setSaving(false)
    }
  }

  // ── Location override helpers ──
  function getLocEditState(id: string, s: LocationSetting) {
    if (locEditStates[id]) return locEditStates[id]
    const hasCustomTiers = s.hasTierRanges && Array.isArray(s.tierRangesJson) && s.tierRangesJson.length > 0
    const locTiers = hasCustomTiers ? structuredClone(s.tierRangesJson!) : structuredClone(tierRanges)
    const seedTable = s.rehabConfigJson ?? structuredClone(table ?? fallbackRehabTable())
    return { rehabTable: seedTable, tierRanges: locTiers, saving: false, error: null }
  }

  function patchLocEditState(id: string, s: LocationSetting, patch: Partial<ReturnType<typeof getLocEditState>>) {
    setLocEditStates(prev => ({ ...prev, [id]: { ...getLocEditState(id, s), ...patch } }))
  }

  function updateLocRehabValue(id: string, s: LocationSetting, tier: string, idx: number, field: 'perSqft' | 'minProfit', value: number) {
    const es = getLocEditState(id, s)
    const next = JSON.parse(JSON.stringify(es.rehabTable)) as RehabTable
    if (!next[tier]) next[tier] = REHAB_LEVEL_NAMES.map(() => ({ perSqft: 25, minProfit: 30000 }))
    next[tier][idx] = { ...next[tier][idx], [field]: value }
    patchLocEditState(id, s, { rehabTable: next })
  }

  function handleLocBoundaryChange(id: string, s: LocationSetting, index: number, newMaxValue: number) {
    const es = getLocEditState(id, s)
    const next = structuredClone(es.tierRanges)
    next[index].maxValue = newMaxValue
    for (let i = index + 1; i < next.length; i++) {
      next[i].minValue = next[i - 1].maxValue
      if (next[i].maxValue !== null && next[i].minValue !== null && next[i].maxValue! <= next[i].minValue!) {
        next[i].maxValue = next[i].minValue! + 1000
      }
    }
    next.forEach((t) => { t.label = computeTierLabel(t) })
    patchLocEditState(id, s, { tierRanges: next })
  }

  function handleLocAddTier(id: string, s: LocationSetting) {
    const es = getLocEditState(id, s)
    const next = structuredClone(es.tierRanges)
    const lastIdx = next.length - 1
    const lastTier = next[lastIdx]
    const splitPoint = (lastTier.minValue ?? 0) + 500000
    lastTier.maxValue = splitPoint
    lastTier.label = computeTierLabel(lastTier)
    const newTier: TierRangeDefinition = { key: `loc_tier_${Date.now()}`, label: '', minValue: splitPoint, maxValue: null }
    newTier.label = computeTierLabel(newTier)
    next.push(newTier)
    const rt = structuredClone(es.rehabTable)
    rt[newTier.key] = REHAB_LEVEL_NAMES.map(() => ({ perSqft: 25, minProfit: 30000 }))
    patchLocEditState(id, s, { tierRanges: next, rehabTable: rt })
  }

  function handleLocRemoveBoundary(id: string, s: LocationSetting, boundaryIndex: number) {
    const es = getLocEditState(id, s)
    if (es.tierRanges.length <= 1) return
    const next = structuredClone(es.tierRanges)
    const removedIdx = boundaryIndex + 1
    const removed = next[removedIdx]
    next[boundaryIndex].maxValue = removed.maxValue
    next.splice(removedIdx, 1)
    next.forEach((t) => { t.label = computeTierLabel(t) })
    const rt = structuredClone(es.rehabTable)
    delete rt[removed.key]
    patchLocEditState(id, s, { tierRanges: next, rehabTable: rt })
  }

  async function handleSaveLocOverride(s: LocationSetting) {
    const es = getLocEditState(s.id, s)
    patchLocEditState(s.id, s, { saving: true, error: null })
    try {
      const input: Partial<LocationSettingInput> = { rehabConfigJson: es.rehabTable }
      // Save tier ranges — if they differ from global, store them; otherwise clear to inherit
      const rangesWithLabels = es.tierRanges.map(t => ({ ...t, label: computeTierLabel(t) }))
      const isCustomTiers = JSON.stringify(rangesWithLabels) !== JSON.stringify(tierRanges)
      input.tierRangesJson = isCustomTiers ? rangesWithLabels : null
      const updated = await updateLocationSetting(s.id, input)
      setLocSettings(prev => prev.map(x => x.id === s.id ? updated : x))
      setLocEditStates(prev => { const n = { ...prev }; delete n[s.id]; return n })
      setLocExpandedId(null)
    } catch (e) {
      patchLocEditState(s.id, s, { error: e instanceof Error ? e.message : 'Failed to save', saving: false })
    }
  }

  async function handleDeleteLoc(id: string) {
    if (!confirm('Delete this location market?')) return
    await deleteLocationSetting(id)
    setLocSettings(prev => prev.filter(s => s.id !== id))
    setLocExpandedId(null)
  }

  async function handleAddLoc() {
    if (!addStateCode) { setAddLocError('Please select a state'); return }
    if (addSubScope === 'city' && !addLocValue.trim()) { setAddLocError('City name is required'); return }
    if (addSubScope === 'zip' && !/^\d{5}$/.test(addLocValue.trim())) { setAddLocError('Enter a valid 5-digit zip code'); return }
    setAddLocSaving(true)
    try {
      const input: LocationSettingInput = { settingType: 'rehab', state: addStateCode }
      if (addSubScope === 'city') input.city = addLocValue.trim()
      else if (addSubScope === 'zip') { input.zipCode = addLocValue.trim(); delete input.state }
      const created = await createLocationSetting(input)
      setLocSettings(prev => [...prev, created])
      setAddLocOpen(false)
      setLocExpandedId(created.id)
    } catch (e) {
      setAddLocError(e instanceof Error ? e.message : 'Failed to create')
    } finally {
      setAddLocSaving(false)
    }
  }

  function getLocLabel(s: LocationSetting): string {
    if (s.zipCode) return s.zipCode
    if (s.city && s.state) return `${s.city.charAt(0).toUpperCase() + s.city.slice(1)}, ${s.state}`
    return s.state ?? '—'
  }

  const statusBadge = isDirty
    ? <Badge variant="outline" className="border-amber-500 text-amber-600 dark:text-amber-400 text-xs">Unsaved changes</Badge>
    : isCustom
      ? <Badge variant="outline" className="border-green-500 text-green-600 dark:text-green-400 text-xs">
          Custom pricing{updatedAt && <span className="ml-1 opacity-70">· {new Date(updatedAt).toLocaleDateString()}</span>}
        </Badge>
      : <Badge variant="outline" className="text-xs text-muted-foreground">Using system defaults</Badge>

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <p className="text-sm text-muted-foreground">Configure $/sqft and minimum profit per rehab level and ARV tier.</p>
        <div className="flex items-center gap-2 flex-shrink-0">
          {!loading && statusBadge}
          <Button variant="outline" size="sm" onClick={handleReset} disabled={saving || loading || (!isCustom && !isDirty)} className="gap-1.5">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
            Reset Defaults
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!isDirty || saving || loading} className="gap-1.5">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Save Changes
          </Button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-3 rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-400">{error}</div>
      )}
      {successMessage && !error && (
        <div className="px-4 py-3 rounded-lg bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 text-sm text-green-700 dark:text-green-400">{successMessage}</div>
      )}

      {loading && <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>}

      {!loading && table && (
        <>
          <div className="space-y-4">
            {/* Range bar — shows tier segments with editable boundary pills between them */}
            <TierRangeBar
              tierRanges={tierRanges}
              onBoundaryChange={handleBoundaryChange}
              onRemoveBoundary={tierRanges.length > 1 ? handleRemoveBoundary : undefined}
            />

            {/* Pricing cards */}
            <div className="flex flex-wrap gap-3">
              {tierRanges.map((range) => (
                <div key={range.key} className="w-full sm:w-[calc(50%-0.375rem)] lg:w-[calc(25%-0.5625rem)] min-w-[220px]">
                  <TierCard
                    range={range}
                    estimates={table[range.key] ?? REHAB_LEVEL_NAMES.map(() => ({ perSqft: 25, minProfit: 30000 }))}
                    onUpdate={(levelIndex, field, value) => handleUpdate(range.key, levelIndex, field, value)}
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between">
              <Button variant="outline" size="sm" onClick={handleAddTier} className="gap-1.5 text-xs">
                <Plus className="w-3.5 h-3.5" />Add Tier
              </Button>
              <div className="flex flex-wrap gap-6 text-xs text-muted-foreground">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground">$/sqft</span>
                  <span>Base rehab cost per square foot</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground">Min Profit</span>
                  <span>Minimum desired profit deducted from buy price</span>
                </div>
              </div>
            </div>
          </div>

          {/* ══ Location Overrides section ══ */}
          <div className="pt-2">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex-1 h-px bg-border" />
              <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground px-1">Location Overrides</span>
              <div className="flex-1 h-px bg-border" />
            </div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs text-muted-foreground">Override rehab pricing for specific markets. Most specific match wins: Zip &rsaquo; City &rsaquo; State.</p>
              <Button size="sm" variant="outline" onClick={() => { setAddStateCode(''); setAddSubScope('state'); setAddLocValue(''); setAddLocError(null); setAddLocOpen(true) }} className="gap-1.5 flex-shrink-0">
                <Plus className="w-3.5 h-3.5" />Add Market
              </Button>
            </div>

            {locSettings.length === 0 ? (
              <div className="border border-dashed rounded-lg py-10 flex flex-col items-center justify-center gap-2 text-center">
                <MapPin className="w-5 h-5 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">No location overrides yet</p>
                <p className="text-xs text-muted-foreground/60">Add a state, city, or zip to use different pricing for that market.</p>
              </div>
            ) : (
              <div className="border rounded-lg divide-y overflow-hidden">
                {locSettings.map((s) => {
                  const expanded = locExpandedId === s.id
                  const es = getLocEditState(s.id, s)
                  return (
                    <div key={s.id}>
                      <div
                        className={`flex items-center gap-3 px-4 py-3 cursor-pointer select-none transition-colors hover:bg-muted/40 ${expanded ? 'bg-muted/30' : ''}`}
                        onClick={() => setLocExpandedId(expanded ? null : s.id)}
                      >
                        <div className={`flex-shrink-0 p-1.5 rounded-md ${expanded ? 'bg-primary/15' : 'bg-muted'}`}>
                          {s.zipCode ? <Hash className={`w-3.5 h-3.5 ${expanded ? 'text-primary' : 'text-muted-foreground'}`} /> :
                           s.city ? <Building2 className={`w-3.5 h-3.5 ${expanded ? 'text-primary' : 'text-muted-foreground'}`} /> :
                           <MapIcon className={`w-3.5 h-3.5 ${expanded ? 'text-primary' : 'text-muted-foreground'}`} />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-semibold text-foreground">{getLocLabel(s)}</span>
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            {s.hasRehabConfig
                              ? (s.isEnabled
                                ? `Custom rehab pricing active${s.hasTierRanges ? ' · custom tiers' : ''}`
                                : 'Rehab override saved (disabled)')
                              : 'No override — using default pricing'}
                          </p>
                        </div>
                        {s.hasRehabConfig && (
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${s.isEnabled ? 'bg-green-500' : 'bg-gray-400'}`} title={s.isEnabled ? 'Rehab override active' : 'Rehab override saved (disabled)'} />
                        )}
                        <ChevronDown className={`w-4 h-4 text-muted-foreground flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                      </div>

                      {expanded && (
                        <div className="border-t bg-card px-4 pt-3 pb-4 space-y-3">
                          {es.error && <div className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">{es.error}</div>}
                          <div className="flex items-center justify-between">
                            <div>
                              <p className="text-sm font-medium">Rehab Pricing Override</p>
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {s.isEnabled
                                  ? 'Enabled — override applied during analysis'
                                  : 'Disabled — override saved but not applied'}
                              </p>
                            </div>
                            <Switch
                              checked={s.isEnabled}
                              onCheckedChange={async (v) => {
                                const updated = await updateLocationSetting(s.id, { isEnabled: v })
                                setLocSettings(prev => prev.map(x => x.id === s.id ? updated : x))
                              }}
                              className="data-[state=checked]:bg-green-600"
                            />
                          </div>

                          {/* Tier range bar — always shown, editable */}
                          <div className="space-y-2">
                            <TierRangeBar
                              tierRanges={es.tierRanges}
                              onBoundaryChange={(idx, val) => handleLocBoundaryChange(s.id, s, idx, val)}
                              onRemoveBoundary={es.tierRanges.length > 1 ? (bIdx) => handleLocRemoveBoundary(s.id, s, bIdx) : undefined}
                            />
                            <div className="flex justify-end">
                              <Button variant="outline" size="sm" className="gap-1 text-[10px] h-6 px-2" onClick={() => handleLocAddTier(s.id, s)}>
                                <Plus className="w-3 h-3" />Add Tier
                              </Button>
                            </div>
                          </div>

                          {/* Pricing cards — use location's own tier ranges */}
                          <div className="flex flex-wrap gap-3">
                            {es.tierRanges.map(range => (
                              <div key={range.key} className="w-full sm:w-[calc(50%-0.375rem)] lg:w-[calc(25%-0.5625rem)] min-w-[220px]">
                              <Card className="border-border">
                                <CardContent className="p-0">
                                  <div className="px-3 pt-3 pb-2 border-b border-border">
                                    <CardTitle className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{computeTierLabel(range)}</CardTitle>
                                  </div>
                                  <div className="grid grid-cols-[1fr_60px_80px] text-[9px] font-medium text-muted-foreground/60 uppercase tracking-wider px-3 py-1 border-b border-border">
                                    <span>Level</span><span className="text-right">$/sqft</span><span className="text-right">Min $</span>
                                  </div>
                                  <div>
                                    {REHAB_LEVEL_NAMES.map((lvl, idx) => (
                                      <div key={lvl} className="grid grid-cols-[1fr_60px_80px] items-center gap-x-1.5 px-3 py-[3px] border-b border-border last:border-0">
                                        <span className="text-[11px] text-foreground/80 font-medium truncate" title={lvl}>{lvl}</span>
                                        <div className="relative">
                                          <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 text-[9px] pointer-events-none select-none">$</span>
                                          <Input type="number" min={0} step={1}
                                            value={es.rehabTable[range.key]?.[idx]?.perSqft ?? 0}
                                            onChange={e => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 0) updateLocRehabValue(s.id, s, range.key, idx, 'perSqft', v) }}
                                            className="h-6 text-[11px] pl-4 pr-1 text-right tabular-nums rounded-sm border-border bg-muted/30 focus:bg-background" />
                                        </div>
                                        <div className="relative">
                                          <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 text-[9px] pointer-events-none select-none">$</span>
                                          <Input type="number" min={0} step={1000}
                                            value={es.rehabTable[range.key]?.[idx]?.minProfit ?? 0}
                                            onChange={e => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 0) updateLocRehabValue(s.id, s, range.key, idx, 'minProfit', v) }}
                                            className="h-6 text-[11px] pl-4 pr-1 text-right tabular-nums rounded-sm border-border bg-muted/30 focus:bg-background" />
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </CardContent>
                              </Card>
                              </div>
                            ))}
                          </div>
                          <div className="flex items-center justify-between pt-1">
                            <Button size="sm" variant="ghost" className="gap-1.5 text-muted-foreground h-7 px-2 text-xs" onClick={() => handleDeleteLoc(s.id)}>
                              <Trash2 className="w-3 h-3" />Delete Market
                            </Button>
                            <div className="flex items-center gap-2">
                              <Button size="sm" variant="outline" className="h-7 px-3 text-xs"
                                onClick={() => { setLocEditStates(prev => { const n = { ...prev }; delete n[s.id]; return n }); setLocExpandedId(null) }}>
                                Cancel
                              </Button>
                              <Button size="sm" className="h-7 px-3 gap-1.5 text-xs" disabled={es.saving} onClick={() => handleSaveLocOverride(s)}>
                                {es.saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                Save Override
                              </Button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Add Location Dialog */}
          <Dialog open={addLocOpen} onOpenChange={setAddLocOpen}>
            <DialogContent className="max-w-sm">
              <DialogHeader><DialogTitle>Add Market Override</DialogTitle></DialogHeader>
              <div className="space-y-4 py-1">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-foreground">State</label>
                  <select value={addStateCode} onChange={e => { setAddStateCode(e.target.value); setAddSubScope('state'); setAddLocValue(''); setAddLocError(null) }}
                    className={`w-full h-9 text-sm rounded-md border bg-background px-2 ${addLocError && !addStateCode ? 'border-destructive' : 'border-input'}`} autoFocus>
                    <option value="">— Select a state —</option>
                    {US_STATES.map(s => <option key={s.code} value={s.code}>{s.name} ({s.code})</option>)}
                  </select>
                </div>
                {addStateCode && (
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-foreground">Narrow to</label>
                      <div className="grid grid-cols-3 gap-2">
                        {([{ scope: 'state' as const, label: 'Entire State', desc: 'All cities' }, { scope: 'city' as const, label: 'City', desc: 'Specific city' }, { scope: 'zip' as const, label: 'Zip Code', desc: 'Single zip' }]).map(({ scope, label, desc }) => (
                          <button key={scope} onClick={() => { setAddSubScope(scope); setAddLocValue(''); setAddLocError(null) }}
                            className={`py-2 px-1 text-xs rounded-lg border font-medium transition-colors flex flex-col items-center gap-0.5 ${addSubScope === scope ? 'bg-primary text-primary-foreground border-primary' : 'bg-background text-muted-foreground border-border hover:border-foreground/30'}`}>
                            <span>{label}</span>
                            <span className={`text-[10px] font-normal ${addSubScope === scope ? 'text-primary-foreground/70' : 'text-muted-foreground/60'}`}>{desc}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    {addSubScope === 'city' && (
                      <Input placeholder="e.g. Miami" value={addLocValue} onChange={e => { setAddLocValue(e.target.value); setAddLocError(null) }} onKeyDown={e => e.key === 'Enter' && handleAddLoc()} className="h-9" autoFocus />
                    )}
                    {addSubScope === 'zip' && (
                      <Input placeholder="e.g. 33101" value={addLocValue} onChange={e => { setAddLocValue(e.target.value); setAddLocError(null) }} onKeyDown={e => e.key === 'Enter' && handleAddLoc()} className="h-9" autoFocus />
                    )}
                  </div>
                )}
                {addLocError && <p className="text-xs text-destructive">{addLocError}</p>}
              </div>
              <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => setAddLocOpen(false)}>Cancel</Button>
                <Button size="sm" onClick={handleAddLoc} disabled={addLocSaving || !addStateCode} className="gap-1.5">
                  {addLocSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                  Add & Configure
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}

    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEAL PARAMETERS TAB
// ═══════════════════════════════════════════════════════════════════════════════

const DEAL_PARAMS_DEFAULTS_UI: DealParamsConfig = {
  closingCostsPercent: 8,
  carryingCostsPercent: 2,
  wholesaleFee: 10000,
}

// Sample ARV used in the live preview
const PREVIEW_ARV = 350000

function fmt$(n: number) {
  return '$' + Math.round(n).toLocaleString()
}

function NumericInput({
  value,
  onChange,
  min = 0,
  max,
  step = 1,
  prefix,
  suffix,
  className,
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  prefix?: string
  suffix?: string
  className?: string
}) {
  return (
    <div className={`flex items-center rounded-md border border-border bg-background overflow-hidden focus-within:ring-2 focus-within:ring-primary/25 focus-within:border-primary/50 transition-colors ${className ?? ''}`}>
      {prefix && <span className="text-sm text-muted-foreground pl-2.5 select-none">{prefix}</span>}
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          if (!isNaN(v) && v >= min && (max === undefined || v <= max)) onChange(v)
        }}
        className="h-9 border-0 shadow-none focus-visible:ring-0 bg-transparent text-sm tabular-nums"
      />
      {suffix && <span className="text-sm text-muted-foreground pr-2.5 select-none">{suffix}</span>}
    </div>
  )
}

function ParamCard({
  label,
  sublabel,
  accent,
  children,
}: {
  label: string
  sublabel: string
  accent: string
  children: React.ReactNode
}) {
  return (
    <div className={`rounded-xl border bg-card p-4 space-y-3 ${accent}`}>
      <div>
        <p className="text-xs font-semibold text-foreground">{label}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{sublabel}</p>
      </div>
      {children}
    </div>
  )
}

function FormulaRow({
  label,
  value,
  variant = 'default',
  dimmed,
}: {
  label: string
  value: string
  variant?: 'default' | 'deduct' | 'result' | 'muted'
  dimmed?: boolean
}) {
  return (
    <div className={`flex items-center justify-between py-1 ${dimmed ? 'opacity-40' : ''}`}>
      <span className={`text-[11px] ${
        variant === 'result' ? 'font-semibold text-foreground' :
        variant === 'muted' ? 'text-muted-foreground' :
        'text-muted-foreground'
      }`}>{label}</span>
      <span className={`text-[11px] tabular-nums font-medium ${
        variant === 'deduct' ? 'text-red-500 dark:text-red-400' :
        variant === 'result' ? 'text-primary font-bold text-sm' :
        variant === 'muted' ? 'text-muted-foreground/60' :
        'text-foreground'
      }`}>{value}</span>
    </div>
  )
}

function DealParamsTab() {
  const [config, setConfig] = useState<DealParamsConfig>(DEAL_PARAMS_DEFAULTS_UI)
  const [original, setOriginal] = useState<DealParamsConfig>(DEAL_PARAMS_DEFAULTS_UI)
  const [isCustom, setIsCustom] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  // Location overrides
  const [locSettings, setLocSettings] = useState<LocationSetting[]>([])
  const [locExpandedId, setLocExpandedId] = useState<string | null>(null)
  const [locEditStates, setLocEditStates] = useState<Record<string, {
    dealParams: DealParamsConfig; saving: boolean; error: string | null
  }>>({})
  const [addLocOpen, setAddLocOpen] = useState(false)
  const [addStateCode, setAddStateCode] = useState('')
  const [addSubScope, setAddSubScope] = useState<'state' | 'city' | 'zip'>('state')
  const [addLocValue, setAddLocValue] = useState('')
  const [addLocError, setAddLocError] = useState<string | null>(null)
  const [addLocSaving, setAddLocSaving] = useState(false)

  useEffect(() => {
    setLoading(true)
    Promise.all([getDealParams(), getLocationSettings('deal')])
      .then(([res, settingsData]) => {
        setConfig(res.config)
        setOriginal(res.config)
        setIsCustom(res.isCustom)
        setUpdatedAt(res.updatedAt)
        setLocSettings(settingsData)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load deal parameters'))
      .finally(() => setLoading(false))
  }, [])

  const isDirty = JSON.stringify(config) !== JSON.stringify(original)

  const handleSave = async () => {
    if (!isDirty) return
    setSaving(true); setError(null); setSuccessMessage(null)
    try {
      const res = await saveDealParams(config)
      setConfig(res.config); setOriginal(res.config)
      setIsCustom(true); setUpdatedAt(res.updatedAt)
      setSuccessMessage('Deal parameters saved.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    if (!confirm('Reset deal parameters to system defaults?')) return
    setSaving(true); setError(null); setSuccessMessage(null)
    try {
      const res = await resetDealParams()
      setConfig(res.config); setOriginal(res.config)
      setIsCustom(false); setUpdatedAt(undefined)
      setSuccessMessage('Reset to defaults.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed')
    } finally {
      setSaving(false)
    }
  }

  const set = (key: keyof DealParamsConfig, value: number | null) =>
    setConfig((prev) => ({ ...prev, [key]: value }))

  // ── Location override helpers ──
  function getLocEditState(id: string, s: LocationSetting) {
    if (locEditStates[id]) return locEditStates[id]
    return { dealParams: s.dealParamsJson ?? { ...config }, saving: false, error: null }
  }

  function patchLocEditState(id: string, s: LocationSetting, patch: Partial<ReturnType<typeof getLocEditState>>) {
    setLocEditStates(prev => ({ ...prev, [id]: { ...getLocEditState(id, s), ...patch } }))
  }

  async function handleSaveLocOverride(s: LocationSetting) {
    const es = getLocEditState(s.id, s)
    patchLocEditState(s.id, s, { saving: true, error: null })
    try {
      const updated = await updateLocationSetting(s.id, { dealParamsJson: es.dealParams })
      setLocSettings(prev => prev.map(x => x.id === s.id ? updated : x))
      setLocEditStates(prev => { const n = { ...prev }; delete n[s.id]; return n })
      setLocExpandedId(null)
    } catch (e) {
      patchLocEditState(s.id, s, { error: e instanceof Error ? e.message : 'Failed to save', saving: false })
    }
  }

  async function handleDeleteLoc(id: string) {
    if (!confirm('Delete this location market?')) return
    await deleteLocationSetting(id)
    setLocSettings(prev => prev.filter(s => s.id !== id))
    setLocExpandedId(null)
  }

  async function handleAddLoc() {
    if (!addStateCode) { setAddLocError('Please select a state'); return }
    if (addSubScope === 'city' && !addLocValue.trim()) { setAddLocError('City name is required'); return }
    if (addSubScope === 'zip' && !/^\d{5}$/.test(addLocValue.trim())) { setAddLocError('Enter a valid 5-digit zip code'); return }
    setAddLocSaving(true)
    try {
      const input: LocationSettingInput = { settingType: 'deal', state: addStateCode }
      if (addSubScope === 'city') input.city = addLocValue.trim()
      else if (addSubScope === 'zip') { input.zipCode = addLocValue.trim(); delete input.state }
      const created = await createLocationSetting(input)
      setLocSettings(prev => [...prev, created])
      setAddLocOpen(false)
      setLocExpandedId(created.id)
    } catch (e) {
      setAddLocError(e instanceof Error ? e.message : 'Failed to create')
    } finally {
      setAddLocSaving(false)
    }
  }

  function getLocLabel(s: LocationSetting): string {
    if (s.zipCode) return s.zipCode
    if (s.city && s.state) return `${s.city.charAt(0).toUpperCase() + s.city.slice(1)}, ${s.state}`
    return s.state ?? '—'
  }

  // Live preview calculation (simplified MAO formula)
  const arv = PREVIEW_ARV
  const rehabCost = 35000  // illustrative
  const tierMinProfit = 25000 // illustrative tier default
  const closingDeduct = arv * (config.closingCostsPercent / 100)
  const carryingDeduct = arv * (config.carryingCostsPercent / 100)
  const profitDeduct = tierMinProfit
  const mao = arv - rehabCost - closingDeduct - carryingDeduct - profitDeduct - config.wholesaleFee

  const statusBadge = isDirty
    ? <Badge variant="outline" className="border-amber-500 text-amber-600 dark:text-amber-400 text-xs">Unsaved changes</Badge>
    : isCustom
      ? <Badge variant="outline" className="border-green-500 text-green-600 dark:text-green-400 text-xs">
          Custom{updatedAt && <span className="ml-1 opacity-70">· {new Date(updatedAt).toLocaleDateString()}</span>}
        </Badge>
      : <Badge variant="outline" className="text-xs text-muted-foreground">System defaults</Badge>

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Cost assumptions applied to every analysis when calculating the max allowable offer.
        </p>
        <div className="flex items-center gap-2 flex-shrink-0">
          {!loading && statusBadge}
          <Button variant="outline" size="sm" onClick={handleReset} disabled={saving || loading || (!isCustom && !isDirty)} className="gap-1.5">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
            Reset
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!isDirty || saving || loading} className="gap-1.5">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Save Changes
          </Button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-3 rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-400">{error}</div>
      )}
      {successMessage && !error && (
        <div className="px-4 py-3 rounded-lg bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 text-sm text-green-700 dark:text-green-400">{successMessage}</div>
      )}

      {loading && <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>}

      {!loading && (
        <>
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-5">

          {/* ── Left: param cards ── */}
          <div className="space-y-3">

            {/* Cost percentages */}
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="px-4 py-3 border-b border-border bg-muted/20">
                <p className="text-xs font-semibold text-foreground">Transaction Costs</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">Applied as a percentage of ARV</p>
              </div>
              <div className="divide-y divide-border/30">
                {/* Closing costs */}
                <div className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">Closing Costs</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">Title, escrow, agent commissions</p>
                  </div>
                  <NumericInput
                    value={config.closingCostsPercent}
                    onChange={(v) => set('closingCostsPercent', v)}
                    min={0} max={50} step={0.5}
                    suffix="%"
                    className="w-24"
                  />
                </div>
                {/* Carrying costs */}
                <div className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">Carrying Costs</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">Taxes, insurance, loan interest</p>
                  </div>
                  <NumericInput
                    value={config.carryingCostsPercent}
                    onChange={(v) => set('carryingCostsPercent', v)}
                    min={0} max={50} step={0.5}
                    suffix="%"
                    className="w-24"
                  />
                </div>
              </div>
            </div>

            {/* Wholesale fee */}
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="px-4 py-3 border-b border-border bg-muted/20">
                <p className="text-xs font-semibold text-foreground">Wholesale Fee</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">Fixed assignment fee deducted from the MAO</p>
              </div>
              <div className="px-4 py-3 flex items-center justify-between gap-4">
                <p className="text-[11px] text-muted-foreground">Applies to wholesale investment scenarios</p>
                <NumericInput
                  value={config.wholesaleFee}
                  onChange={(v) => set('wholesaleFee', v)}
                  min={0} step={500}
                  prefix="$"
                  className="w-32"
                />
              </div>
            </div>


          </div>

          {/* ── Right: live MAO preview ── */}
          <div className="rounded-xl border border-border bg-card overflow-hidden h-fit sticky top-4">
            <div className="px-4 py-3 border-b border-border bg-muted/20">
              <p className="text-xs font-semibold text-foreground">MAO Preview</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">Example deal · ARV {fmt$(arv)}</p>
            </div>
            <div className="px-4 py-3 space-y-0.5">
              <FormulaRow label="ARV" value={fmt$(arv)} />
              <FormulaRow label={`− Rehab (illustrative)`} value={`−${fmt$(rehabCost)}`} variant="deduct" />
              <FormulaRow label={`− Closing (${config.closingCostsPercent}%)`} value={`−${fmt$(closingDeduct)}`} variant="deduct" />
              <FormulaRow label={`− Carrying (${config.carryingCostsPercent}%)`} value={`−${fmt$(carryingDeduct)}`} variant="deduct" />
              <FormulaRow
                label="− Flip Profit (from rehab level)"
                value={`−${fmt$(profitDeduct)}`}
                variant="deduct"
              />
              <FormulaRow label="− Wholesale fee" value={`−${fmt$(config.wholesaleFee)}`} variant="deduct" />
              <div className="border-t border-border mt-2 pt-2">
                <FormulaRow
                  label="Max Allowable Offer"
                  value={mao > 0 ? fmt$(mao) : '—'}
                  variant="result"
                />
              </div>
            </div>
            <div className="px-4 pb-3">
              <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
                Rehab cost is illustrative. Actual values come from the analysis.
              </p>
            </div>
          </div>

        </div>

        {/* ══ Location Overrides section ══ */}
        <div className="pt-2">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex-1 h-px bg-border" />
            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground px-1">Location Overrides</span>
            <div className="flex-1 h-px bg-border" />
          </div>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs text-muted-foreground">Override deal parameters for specific markets. Most specific match wins: Zip &rsaquo; City &rsaquo; State.</p>
            <Button size="sm" variant="outline" onClick={() => { setAddStateCode(''); setAddSubScope('state'); setAddLocValue(''); setAddLocError(null); setAddLocOpen(true) }} className="gap-1.5 flex-shrink-0">
              <Plus className="w-3.5 h-3.5" />Add Market
            </Button>
          </div>

          {locSettings.length === 0 ? (
            <div className="border border-dashed rounded-lg py-10 flex flex-col items-center justify-center gap-2 text-center">
              <MapPin className="w-5 h-5 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">No location overrides yet</p>
              <p className="text-xs text-muted-foreground/60">Add a state, city, or zip to use different deal parameters for that market.</p>
            </div>
          ) : (
            <div className="border rounded-lg divide-y overflow-hidden">
              {locSettings.map((s) => {
                const expanded = locExpandedId === s.id
                const es = getLocEditState(s.id, s)
                return (
                  <div key={s.id}>
                    <div
                      className={`flex items-center gap-3 px-4 py-3 cursor-pointer select-none transition-colors hover:bg-muted/40 ${expanded ? 'bg-muted/30' : ''}`}
                      onClick={() => setLocExpandedId(expanded ? null : s.id)}
                    >
                      <div className={`flex-shrink-0 p-1.5 rounded-md ${expanded ? 'bg-primary/15' : 'bg-muted'}`}>
                        {s.zipCode ? <Hash className={`w-3.5 h-3.5 ${expanded ? 'text-primary' : 'text-muted-foreground'}`} /> :
                         s.city ? <Building2 className={`w-3.5 h-3.5 ${expanded ? 'text-primary' : 'text-muted-foreground'}`} /> :
                         <MapIcon className={`w-3.5 h-3.5 ${expanded ? 'text-primary' : 'text-muted-foreground'}`} />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-semibold text-foreground">{getLocLabel(s)}</span>
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          {s.hasDealParams ? (s.isEnabled ? 'Custom deal parameters active' : 'Deal params override saved (disabled)') : 'No override — using default parameters'}
                        </p>
                      </div>
                      {s.hasDealParams && (
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${s.isEnabled ? 'bg-purple-500' : 'bg-gray-400'}`} title={s.isEnabled ? 'Deal params override active' : 'Deal params override saved (disabled)'} />
                      )}
                      <ChevronDown className={`w-4 h-4 text-muted-foreground flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                    </div>

                    {expanded && (
                      <div className="border-t bg-card px-4 pt-3 pb-4 space-y-3">
                        {es.error && <div className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">{es.error}</div>}
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm font-medium">Deal Parameters Override</p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {s.isEnabled
                                ? 'Enabled — override applied during analysis'
                                : 'Disabled — override saved but not applied'}
                            </p>
                          </div>
                          <Switch
                            checked={s.isEnabled}
                            onCheckedChange={async (v) => {
                              const updated = await updateLocationSetting(s.id, { isEnabled: v })
                              setLocSettings(prev => prev.map(x => x.id === s.id ? updated : x))
                            }}
                            className="data-[state=checked]:bg-purple-500"
                          />
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                          {([
                            { label: 'Closing Cost', field: 'closingCostsPercent' as const, max: 100 as number | undefined, step: 0.5, suffix: '%' as string | undefined, prefix: undefined as string | undefined, placeholder: undefined as string | undefined },
                            { label: 'Carrying Cost', field: 'carryingCostsPercent' as const, max: 100 as number | undefined, step: 0.5, suffix: '%' as string | undefined, prefix: undefined as string | undefined, placeholder: undefined as string | undefined },
                            { label: 'Wholesale Fee', field: 'wholesaleFee' as const, step: 500, prefix: '$' as string | undefined, max: undefined as number | undefined, suffix: undefined as string | undefined, placeholder: undefined as string | undefined },
                          ]).map(({ label, field, max, step, prefix, suffix, placeholder }) => (
                            <div key={field} className="space-y-1.5">
                              <label className="text-xs font-medium text-muted-foreground">{label}</label>
                              <div className="flex items-center h-9 rounded-lg border border-input bg-background overflow-hidden focus-within:ring-2 focus-within:ring-primary/25 focus-within:border-primary/50 transition-colors">
                                {prefix && <span className="text-sm text-muted-foreground pl-3 select-none">{prefix}</span>}
                                <Input
                                  type="number" min={0} max={max} step={step}
                                  value={es.dealParams[field] ?? ''}
                                  placeholder={placeholder}
                                  onChange={e => {
                                    const raw = e.target.value
                                    const v = raw === '' ? null : parseFloat(raw)
                                    patchLocEditState(s.id, s, { dealParams: { ...es.dealParams, [field]: v } })
                                  }}
                                  className="h-full border-0 shadow-none focus-visible:ring-0 bg-transparent text-sm tabular-nums px-2"
                                />
                                {suffix && <span className="text-sm text-muted-foreground pr-3 select-none">{suffix}</span>}
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="flex items-center justify-between pt-1">
                          <Button size="sm" variant="ghost" className="gap-1.5 text-muted-foreground h-7 px-2 text-xs" onClick={() => handleDeleteLoc(s.id)}>
                            <Trash2 className="w-3 h-3" />Delete Market
                          </Button>
                          <div className="flex items-center gap-2">
                            <Button size="sm" variant="outline" className="h-7 px-3 text-xs"
                              onClick={() => { setLocEditStates(prev => { const n = { ...prev }; delete n[s.id]; return n }); setLocExpandedId(null) }}>
                              Cancel
                            </Button>
                            <Button size="sm" className="h-7 px-3 gap-1.5 text-xs" disabled={es.saving} onClick={() => handleSaveLocOverride(s)}>
                              {es.saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                              Save Override
                            </Button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Add Location Dialog */}
        <Dialog open={addLocOpen} onOpenChange={setAddLocOpen}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>Add Market Override</DialogTitle></DialogHeader>
            <div className="space-y-4 py-1">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-foreground">State</label>
                <select value={addStateCode} onChange={e => { setAddStateCode(e.target.value); setAddSubScope('state'); setAddLocValue(''); setAddLocError(null) }}
                  className={`w-full h-9 text-sm rounded-md border bg-background px-2 ${addLocError && !addStateCode ? 'border-destructive' : 'border-input'}`} autoFocus>
                  <option value="">— Select a state —</option>
                  {US_STATES.map(s => <option key={s.code} value={s.code}>{s.name} ({s.code})</option>)}
                </select>
              </div>
              {addStateCode && (
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-foreground">Narrow to</label>
                    <div className="grid grid-cols-3 gap-2">
                      {([{ scope: 'state' as const, label: 'Entire State', desc: 'All cities' }, { scope: 'city' as const, label: 'City', desc: 'Specific city' }, { scope: 'zip' as const, label: 'Zip Code', desc: 'Single zip' }]).map(({ scope, label, desc }) => (
                        <button key={scope} onClick={() => { setAddSubScope(scope); setAddLocValue(''); setAddLocError(null) }}
                          className={`py-2 px-1 text-xs rounded-lg border font-medium transition-colors flex flex-col items-center gap-0.5 ${addSubScope === scope ? 'bg-primary text-primary-foreground border-primary' : 'bg-background text-muted-foreground border-border hover:border-foreground/30'}`}>
                          <span>{label}</span>
                          <span className={`text-[10px] font-normal ${addSubScope === scope ? 'text-primary-foreground/70' : 'text-muted-foreground/60'}`}>{desc}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  {addSubScope === 'city' && (
                    <Input placeholder="e.g. Miami" value={addLocValue} onChange={e => { setAddLocValue(e.target.value); setAddLocError(null) }} onKeyDown={e => e.key === 'Enter' && handleAddLoc()} className="h-9" autoFocus />
                  )}
                  {addSubScope === 'zip' && (
                    <Input placeholder="e.g. 33101" value={addLocValue} onChange={e => { setAddLocValue(e.target.value); setAddLocError(null) }} onKeyDown={e => e.key === 'Enter' && handleAddLoc()} className="h-9" autoFocus />
                  )}
                </div>
              )}
              {addLocError && <p className="text-xs text-destructive">{addLocError}</p>}
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setAddLocOpen(false)}>Cancel</Button>
              <Button size="sm" onClick={handleAddLoc} disabled={addLocSaving || !addStateCode} className="gap-1.5">
                {addLocSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                Add & Configure
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAJOR ITEM COSTS TAB
// ═══════════════════════════════════════════════════════════════════════════════

// System defaults for major items (matches API MAJOR_ITEMS)
const MAJOR_ITEMS_DEFAULTS: Array<{ id: string; name: string; defaultCost: number; ageThreshold: number | null }> = [
  { id: 'roof', name: 'Roof', defaultCost: 10000, ageThreshold: 20 },
  { id: 'hvac', name: 'HVAC', defaultCost: 8000, ageThreshold: 15 },
  { id: 'water_heater', name: 'Water Heater', defaultCost: 2500, ageThreshold: 10 },
  { id: 'electric_panel', name: 'Electric Panel', defaultCost: 3500, ageThreshold: 30 },
  { id: 'replumb', name: 'Re-Plumb', defaultCost: 8000, ageThreshold: 40 },
  { id: 'rewire', name: 'Re-Wire', defaultCost: 8000, ageThreshold: 40 },
  { id: 'sinkhole', name: 'Sinkhole', defaultCost: 15000, ageThreshold: null },
  { id: 'foundation', name: 'Foundation', defaultCost: 12000, ageThreshold: null },
  { id: 'septic', name: 'Septic Repair', defaultCost: 5000, ageThreshold: 25 },
  { id: 'new_septic', name: 'New Septic', defaultCost: 15000, ageThreshold: null },
  { id: 'pool_redone', name: 'Pool Redone', defaultCost: 15000, ageThreshold: null },
  { id: 'pool_plaster', name: 'Pool Plaster', defaultCost: 5000, ageThreshold: 10 },
  { id: 'termite', name: 'Termite', defaultCost: 3000, ageThreshold: null },
  { id: 'mold', name: 'Mold', defaultCost: 5000, ageThreshold: null },
  { id: 'asbestos', name: 'Asbestos', defaultCost: 10000, ageThreshold: null },
  { id: 'vinyl', name: 'Replace Vinyl', defaultCost: 5000, ageThreshold: 20 },
  { id: 'well_pump', name: 'Well Pump', defaultCost: 4000, ageThreshold: 15 },
]

const ITEM_TOOLTIPS: Record<string, string> = {
  roof: 'Full roof replacement including materials and labor',
  hvac: 'Heating, ventilation, and air conditioning system replacement',
  water_heater: 'Water heater replacement',
  electric_panel: 'Electrical panel upgrade',
  replumb: 'Full plumbing system re-pipe',
  rewire: 'Full electrical rewiring',
  sinkhole: 'Sinkhole remediation and foundation stabilization',
  foundation: 'Foundation repair or underpinning',
  septic: 'Septic system repair',
  new_septic: 'New septic system installation',
  pool_redone: 'Full pool renovation (deck, equipment, surface)',
  pool_plaster: 'Pool plaster / resurfacing',
  termite: 'Termite treatment and damage repair',
  mold: 'Mold remediation',
  asbestos: 'Asbestos abatement',
  vinyl: 'Replace vinyl siding or flooring',
  well_pump: 'Well pump and pressure tank replacement',
}

function MajorItemCostsTab() {
  const [items, setItems] = useState<MajorItemInfo[]>([])
  const [pending, setPending] = useState<Record<string, string>>({}) // id → string input value
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [isCustom, setIsCustom] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Location overrides
  const [locSettings, setLocSettings] = useState<LocationSetting[]>([])
  const [locExpandedId, setLocExpandedId] = useState<string | null>(null)
  const [locEditStates, setLocEditStates] = useState<Record<string, {
    majorItemCosts: Record<string, number>; saving: boolean; error: string | null
  }>>({})
  const [addLocOpen, setAddLocOpen] = useState(false)
  const [addStateCode, setAddStateCode] = useState('')
  const [addSubScope, setAddSubScope] = useState<'state' | 'city' | 'zip'>('state')
  const [addLocValue, setAddLocValue] = useState('')
  const [addLocError, setAddLocError] = useState<string | null>(null)
  const [addLocSaving, setAddLocSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      const [data, settingsData] = await Promise.all([getMajorItemCosts(), getLocationSettings('major')])
      setItems(data.items)
      setIsCustom(data.isCustom)
      setUpdatedAt(data.updatedAt)
      setLocSettings(settingsData)
      // Seed pending from custom costs
      const p: Record<string, string> = {}
      for (const item of data.items) {
        p[item.id] = item.customCost !== null ? String(item.customCost) : ''
      }
      setPending(p)
    } catch {
      setError('Failed to load major item costs')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleSave() {
    setSaving(true)
    setError(null)
    try {
      const costs: Record<string, number | null> = {}
      for (const item of items) {
        const v = pending[item.id]
        costs[item.id] = v && v !== '' ? parseFloat(v) : null
      }
      const data = await saveMajorItemCosts(costs)
      setItems(data.items)
      setIsCustom(data.isCustom)
      setUpdatedAt(data.updatedAt)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function handleReset() {
    if (!confirm('Reset all major item costs to system defaults?')) return
    setSaving(true)
    setError(null)
    try {
      const data = await resetMajorItemCosts()
      setItems(data.items)
      setIsCustom(false)
      setUpdatedAt(null)
      const p: Record<string, string> = {}
      for (const item of data.items) p[item.id] = ''
      setPending(p)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to reset')
    } finally {
      setSaving(false)
    }
  }

  function hasPendingChanges() {
    return items.some(item => {
      const current = pending[item.id]
      const original = item.customCost !== null ? String(item.customCost) : ''
      return current !== original
    })
  }

  // ── Location override helpers ──
  function getLocEditState(id: string, s: LocationSetting) {
    if (locEditStates[id]) return locEditStates[id]
    const seedCosts = s.majorItemCostsJson
      ? (s.majorItemCostsJson as Record<string, number>)
      : Object.fromEntries(items.map(item => [item.id, item.effectiveCost]))
    return { majorItemCosts: seedCosts, saving: false, error: null }
  }

  function patchLocEditState(id: string, s: LocationSetting, patch: Partial<ReturnType<typeof getLocEditState>>) {
    setLocEditStates(prev => ({ ...prev, [id]: { ...getLocEditState(id, s), ...patch } }))
  }

  async function handleSaveLocOverride(s: LocationSetting) {
    const es = getLocEditState(s.id, s)
    patchLocEditState(s.id, s, { saving: true, error: null })
    try {
      const updated = await updateLocationSetting(s.id, { majorItemCostsJson: es.majorItemCosts })
      setLocSettings(prev => prev.map(x => x.id === s.id ? updated : x))
      setLocEditStates(prev => { const n = { ...prev }; delete n[s.id]; return n })
      setLocExpandedId(null)
    } catch (e) {
      patchLocEditState(s.id, s, { error: e instanceof Error ? e.message : 'Failed to save', saving: false })
    }
  }

  async function handleDeleteLoc(id: string) {
    if (!confirm('Delete this location market?')) return
    await deleteLocationSetting(id)
    setLocSettings(prev => prev.filter(s => s.id !== id))
    setLocExpandedId(null)
  }

  async function handleAddLoc() {
    if (!addStateCode) { setAddLocError('Please select a state'); return }
    if (addSubScope === 'city' && !addLocValue.trim()) { setAddLocError('City name is required'); return }
    if (addSubScope === 'zip' && !/^\d{5}$/.test(addLocValue.trim())) { setAddLocError('Enter a valid 5-digit zip code'); return }
    setAddLocSaving(true)
    try {
      const input: LocationSettingInput = { settingType: 'major', state: addStateCode }
      if (addSubScope === 'city') input.city = addLocValue.trim()
      else if (addSubScope === 'zip') { input.zipCode = addLocValue.trim(); delete input.state }
      const created = await createLocationSetting(input)
      setLocSettings(prev => [...prev, created])
      setAddLocOpen(false)
      setLocExpandedId(created.id)
    } catch (e) {
      setAddLocError(e instanceof Error ? e.message : 'Failed to create')
    } finally {
      setAddLocSaving(false)
    }
  }

  function getLocLabel(s: LocationSetting): string {
    if (s.zipCode) return s.zipCode
    if (s.city && s.state) return `${s.city.charAt(0).toUpperCase() + s.city.slice(1)}, ${s.state}`
    return s.state ?? '—'
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="text-sm">Loading…</span>
      </div>
    )
  }

  const dirty = hasPendingChanges()

  return (
    <div className="space-y-5">
      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            Set your default repair costs for major items. These are used when the analysis detects aging systems or issues.
            Individual analysis calls can still override these via the <code className="text-xs bg-muted px-1 rounded">buybox.majorItems</code> parameter.
          </p>
          {isCustom && updatedAt && (
            <p className="text-[11px] text-muted-foreground">
              Last saved {new Date(updatedAt).toLocaleDateString()}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isCustom && (
            <Button size="sm" variant="outline" className="gap-1.5 h-8" onClick={handleReset} disabled={saving}>
              <RotateCcw className="w-3.5 h-3.5" />
              Reset to defaults
            </Button>
          )}
          <Button size="sm" className="gap-1.5 h-8" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : saved ? <Check className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
            {saved ? 'Saved' : 'Save changes'}
          </Button>
        </div>
      </div>

      {/* Items table */}
      <div className="rounded-lg border border-border overflow-hidden">
        {/* Header row */}
        <div className="grid bg-muted/40 border-b border-border px-4 py-2"
          style={{ gridTemplateColumns: '1fr 130px 130px 100px' }}>
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Item</span>
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground text-center">System Default</span>
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground text-center">Your Cost</span>
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground text-center">Age Threshold</span>
        </div>

        {/* Item rows */}
        <div className="divide-y divide-border/30 bg-background">
          {items.map((item) => {
            const hasCustom = pending[item.id] !== '' && pending[item.id] !== undefined
            const tooltip = ITEM_TOOLTIPS[item.id]
            return (
              <div
                key={item.id}
                className="grid items-center gap-x-3 px-4 py-2.5"
                style={{ gridTemplateColumns: '1fr 130px 130px 100px' }}
              >
                {/* Name + tooltip */}
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-sm font-medium text-foreground">{item.name}</span>
                  {hasCustom && (
                    <div className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0" title="Custom cost set" />
                  )}
                  {tooltip && (
                    <TooltipProvider delayDuration={300}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-muted-foreground/40 cursor-help text-[10px] select-none">?</span>
                        </TooltipTrigger>
                        <TooltipContent side="right" className="max-w-[180px] text-xs">
                          {tooltip}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>

                {/* System default */}
                <div className="flex justify-center">
                  <span className="text-xs text-muted-foreground tabular-nums">
                    ${item.defaultCost.toLocaleString()}
                  </span>
                </div>

                {/* Your cost input */}
                <div className="flex justify-center">
                  <div className="flex items-center rounded-md border border-border bg-muted/30 overflow-hidden focus-within:ring-1 focus-within:ring-primary/30 focus-within:border-primary/50">
                    <span className="text-xs text-muted-foreground pl-2 select-none">$</span>
                    <Input
                      type="number"
                      min={0}
                      step={500}
                      placeholder={String(item.defaultCost)}
                      value={pending[item.id] ?? ''}
                      onChange={e => setPending(prev => ({ ...prev, [item.id]: e.target.value }))}
                      className="h-7 w-20 text-xs text-right tabular-nums border-0 bg-transparent shadow-none focus-visible:ring-0 pr-2 pl-1"
                    />
                  </div>
                </div>

                {/* Age threshold */}
                <div className="flex justify-center">
                  <span className="text-xs text-muted-foreground">
                    {item.ageThreshold ? `${item.ageThreshold} yrs` : '—'}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Leave a field blank to use the system default. The age threshold is how old a system must be before it&apos;s flagged for likely replacement.
      </p>

      {/* ══ Location Overrides section ══ */}
      <div className="pt-2">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex-1 h-px bg-border" />
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground px-1">Location Overrides</span>
          <div className="flex-1 h-px bg-border" />
        </div>
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs text-muted-foreground">Override major item costs for specific markets. Most specific match wins: Zip &rsaquo; City &rsaquo; State.</p>
          <Button size="sm" variant="outline" onClick={() => { setAddStateCode(''); setAddSubScope('state'); setAddLocValue(''); setAddLocError(null); setAddLocOpen(true) }} className="gap-1.5 flex-shrink-0">
            <Plus className="w-3.5 h-3.5" />Add Market
          </Button>
        </div>

        {locSettings.length === 0 ? (
          <div className="border border-dashed rounded-lg py-10 flex flex-col items-center justify-center gap-2 text-center">
            <MapPin className="w-5 h-5 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No location overrides yet</p>
            <p className="text-xs text-muted-foreground/60">Add a state, city, or zip to use different major item costs for that market.</p>
          </div>
        ) : (
          <div className="border rounded-lg divide-y overflow-hidden">
            {locSettings.map((s) => {
              const expanded = locExpandedId === s.id
              const es = getLocEditState(s.id, s)
              return (
                <div key={s.id}>
                  <div
                    className={`flex items-center gap-3 px-4 py-3 cursor-pointer select-none transition-colors hover:bg-muted/40 ${expanded ? 'bg-muted/30' : ''}`}
                    onClick={() => setLocExpandedId(expanded ? null : s.id)}
                  >
                    <div className={`flex-shrink-0 p-1.5 rounded-md ${expanded ? 'bg-primary/15' : 'bg-muted'}`}>
                      {s.zipCode ? <Hash className={`w-3.5 h-3.5 ${expanded ? 'text-primary' : 'text-muted-foreground'}`} /> :
                       s.city ? <Building2 className={`w-3.5 h-3.5 ${expanded ? 'text-primary' : 'text-muted-foreground'}`} /> :
                       <MapIcon className={`w-3.5 h-3.5 ${expanded ? 'text-primary' : 'text-muted-foreground'}`} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-semibold text-foreground">{getLocLabel(s)}</span>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {s.hasMajorItemCosts ? (s.isEnabled ? 'Custom major item costs active' : 'Major items override saved (disabled)') : 'No override — using default costs'}
                      </p>
                    </div>
                    {s.hasMajorItemCosts && (
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${s.isEnabled ? 'bg-orange-500' : 'bg-gray-400'}`} title={s.isEnabled ? 'Major item costs override active' : 'Major items override saved (disabled)'} />
                    )}
                    <ChevronDown className={`w-4 h-4 text-muted-foreground flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                  </div>

                  {expanded && (
                    <div className="border-t bg-card px-4 pt-3 pb-4 space-y-3">
                      {es.error && <div className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">{es.error}</div>}
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium">Major Item Costs Override</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {s.isEnabled
                              ? 'Enabled — override applied during analysis'
                              : 'Disabled — override saved but not applied'}
                          </p>
                        </div>
                        <Switch
                          checked={s.isEnabled}
                          onCheckedChange={async (v) => {
                            const updated = await updateLocationSetting(s.id, { isEnabled: v })
                            setLocSettings(prev => prev.map(x => x.id === s.id ? updated : x))
                          }}
                          className="data-[state=checked]:bg-orange-500"
                        />
                      </div>
                      <div className="rounded-lg border border-border overflow-hidden">
                        <div className="grid bg-muted/40 border-b border-border px-4 py-2" style={{ gridTemplateColumns: '1fr 110px 110px 90px' }}>
                          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Item</span>
                          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground text-center">Default</span>
                          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground text-center">Override</span>
                          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground text-center">Age Trigger</span>
                        </div>
                        <div className="divide-y divide-border/30 bg-background">
                          {MAJOR_ITEMS_DEFAULTS.map(item => {
                            const tooltip = ITEM_TOOLTIPS[item.id]
                            const currentCost = es.majorItemCosts[item.id] ?? item.defaultCost
                            const isItemCustom = currentCost !== item.defaultCost
                            return (
                              <div key={item.id} className="grid items-center gap-x-3 px-4 py-2" style={{ gridTemplateColumns: '1fr 110px 110px 90px' }}>
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <span className="text-sm font-medium text-foreground">{item.name}</span>
                                  {isItemCustom && <div className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0" title="Custom cost set" />}
                                  {tooltip && (
                                    <TooltipProvider delayDuration={300}>
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <span className="text-muted-foreground/40 cursor-help text-[10px] select-none">?</span>
                                        </TooltipTrigger>
                                        <TooltipContent side="right" className="max-w-[180px] text-xs">{tooltip}</TooltipContent>
                                      </Tooltip>
                                    </TooltipProvider>
                                  )}
                                </div>
                                <div className="flex justify-center">
                                  <span className="text-xs text-muted-foreground tabular-nums">${item.defaultCost.toLocaleString()}</span>
                                </div>
                                <div className="flex justify-center">
                                  <div className="flex items-center rounded-md border border-border bg-muted/30 overflow-hidden focus-within:ring-1 focus-within:ring-primary/30 focus-within:border-primary/50">
                                    <span className="text-xs text-muted-foreground pl-2 select-none">$</span>
                                    <Input
                                      type="number" min={0} step={500}
                                      value={currentCost}
                                      onChange={e => {
                                        const v = parseInt(e.target.value, 10)
                                        if (!isNaN(v) && v >= 0) patchLocEditState(s.id, s, { majorItemCosts: { ...es.majorItemCosts, [item.id]: v } })
                                      }}
                                      className="h-7 w-20 text-xs text-right tabular-nums border-0 bg-transparent shadow-none focus-visible:ring-0 pr-2 pl-1"
                                    />
                                  </div>
                                </div>
                                <div className="flex justify-center">
                                  <span className="text-xs text-muted-foreground">{item.ageThreshold ? `${item.ageThreshold} yrs` : '—'}</span>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                      <div className="flex items-center justify-between pt-1">
                        <Button size="sm" variant="ghost" className="gap-1.5 text-muted-foreground h-7 px-2 text-xs" onClick={() => handleDeleteLoc(s.id)}>
                          <Trash2 className="w-3 h-3" />Delete Market
                        </Button>
                        <div className="flex items-center gap-2">
                          <Button size="sm" variant="outline" className="h-7 px-3 text-xs"
                            onClick={() => { setLocEditStates(prev => { const n = { ...prev }; delete n[s.id]; return n }); setLocExpandedId(null) }}>
                            Cancel
                          </Button>
                          <Button size="sm" className="h-7 px-3 gap-1.5 text-xs" disabled={es.saving} onClick={() => handleSaveLocOverride(s)}>
                            {es.saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                            Save Override
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Add Location Dialog */}
      <Dialog open={addLocOpen} onOpenChange={setAddLocOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Add Market Override</DialogTitle></DialogHeader>
          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-foreground">State</label>
              <select value={addStateCode} onChange={e => { setAddStateCode(e.target.value); setAddSubScope('state'); setAddLocValue(''); setAddLocError(null) }}
                className={`w-full h-9 text-sm rounded-md border bg-background px-2 ${addLocError && !addStateCode ? 'border-destructive' : 'border-input'}`} autoFocus>
                <option value="">— Select a state —</option>
                {US_STATES.map(s => <option key={s.code} value={s.code}>{s.name} ({s.code})</option>)}
              </select>
            </div>
            {addStateCode && (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-foreground">Narrow to</label>
                  <div className="grid grid-cols-3 gap-2">
                    {([{ scope: 'state' as const, label: 'Entire State', desc: 'All cities' }, { scope: 'city' as const, label: 'City', desc: 'Specific city' }, { scope: 'zip' as const, label: 'Zip Code', desc: 'Single zip' }]).map(({ scope, label, desc }) => (
                      <button key={scope} onClick={() => { setAddSubScope(scope); setAddLocValue(''); setAddLocError(null) }}
                        className={`py-2 px-1 text-xs rounded-lg border font-medium transition-colors flex flex-col items-center gap-0.5 ${addSubScope === scope ? 'bg-primary text-primary-foreground border-primary' : 'bg-background text-muted-foreground border-border hover:border-foreground/30'}`}>
                        <span>{label}</span>
                        <span className={`text-[10px] font-normal ${addSubScope === scope ? 'text-primary-foreground/70' : 'text-muted-foreground/60'}`}>{desc}</span>
                      </button>
                    ))}
                  </div>
                </div>
                {addSubScope === 'city' && (
                  <Input placeholder="e.g. Miami" value={addLocValue} onChange={e => { setAddLocValue(e.target.value); setAddLocError(null) }} onKeyDown={e => e.key === 'Enter' && handleAddLoc()} className="h-9" autoFocus />
                )}
                {addSubScope === 'zip' && (
                  <Input placeholder="e.g. 33101" value={addLocValue} onChange={e => { setAddLocValue(e.target.value); setAddLocError(null) }} onKeyDown={e => e.key === 'Enter' && handleAddLoc()} className="h-9" autoFocus />
                )}
              </div>
            )}
            {addLocError && <p className="text-xs text-destructive">{addLocError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setAddLocOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={handleAddLoc} disabled={addLocSaving || !addStateCode} className="gap-1.5">
              {addLocSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              Add & Configure
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAGE
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// ARV COMP THRESHOLD TAB
// ═══════════════════════════════════════════════════════════════════════════════

const ARV_THRESHOLD_DEFAULTS_UI: ArvThresholdConfig = { percent: 15 }

function ArvThresholdTab() {
  const [config, setConfig] = useState<ArvThresholdConfig>(ARV_THRESHOLD_DEFAULTS_UI)
  const [original, setOriginal] = useState<ArvThresholdConfig>(ARV_THRESHOLD_DEFAULTS_UI)
  const [asIsThreshold, setAsIsThreshold] = useState(70)
  const [originalAsIs, setOriginalAsIs] = useState(70)
  const [isCustom, setIsCustom] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  // Location overrides
  const [locSettings, setLocSettings] = useState<LocationSetting[]>([])
  const [locExpandedId, setLocExpandedId] = useState<string | null>(null)
  const [locEditStates, setLocEditStates] = useState<Record<string, {
    arvThreshold: ArvThresholdConfig; saving: boolean; error: string | null
  }>>({})
  const [addLocOpen, setAddLocOpen] = useState(false)
  const [addStateCode, setAddStateCode] = useState('')
  const [addSubScope, setAddSubScope] = useState<'state' | 'city' | 'zip'>('state')
  const [addLocValue, setAddLocValue] = useState('')
  const [addLocError, setAddLocError] = useState<string | null>(null)
  const [addLocSaving, setAddLocSaving] = useState(false)

  useEffect(() => {
    setLoading(true)
    Promise.all([getArvThreshold(), getLocationSettings('arv_threshold'), getDealParams()])
      .then(([res, settingsData, dealRes]) => {
        setConfig(res.config); setOriginal(res.config)
        setIsCustom(res.isCustom); setUpdatedAt(res.updatedAt)
        setLocSettings(settingsData)
        const asIs = dealRes.config.asIsThresholdPercent ?? 70
        setAsIsThreshold(asIs); setOriginalAsIs(asIs)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [])

  const isDirty = JSON.stringify(config) !== JSON.stringify(original) || asIsThreshold !== originalAsIs

  const handleSave = async () => {
    if (!isDirty) return
    setSaving(true); setError(null); setSuccessMessage(null)
    try {
      const [res] = await Promise.all([
        saveArvThreshold(config),
        asIsThreshold !== originalAsIs ? saveDealParams({ asIsThresholdPercent: asIsThreshold }) : Promise.resolve(null),
      ])
      setConfig(res.config); setOriginal(res.config)
      setIsCustom(true); setUpdatedAt(res.updatedAt)
      setOriginalAsIs(asIsThreshold)
      setSuccessMessage('Thresholds saved.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally { setSaving(false) }
  }

  const handleReset = async () => {
    if (!confirm('Reset thresholds to system defaults?')) return
    setSaving(true); setError(null); setSuccessMessage(null)
    try {
      const res = await resetArvThreshold()
      setConfig(res.config); setOriginal(res.config)
      setIsCustom(false); setUpdatedAt(undefined)
      setAsIsThreshold(70); setOriginalAsIs(70)
      setSuccessMessage('Reset to defaults.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed')
    } finally { setSaving(false) }
  }

  // Location override helpers
  function getLocEditState(id: string, s: LocationSetting) {
    if (locEditStates[id]) return locEditStates[id]
    return { arvThreshold: s.arvThresholdJson ?? { ...config, asIsThresholdPercent: asIsThreshold }, saving: false, error: null }
  }

  function patchLocEditState(id: string, s: LocationSetting, patch: Partial<ReturnType<typeof getLocEditState>>) {
    setLocEditStates(prev => ({ ...prev, [id]: { ...getLocEditState(id, s), ...patch } }))
  }

  async function handleSaveLocOverride(s: LocationSetting) {
    const es = getLocEditState(s.id, s)
    patchLocEditState(s.id, s, { saving: true, error: null })
    try {
      const updated = await updateLocationSetting(s.id, { arvThresholdJson: es.arvThreshold })
      setLocSettings(prev => prev.map(x => x.id === s.id ? updated : x))
      setLocEditStates(prev => { const n = { ...prev }; delete n[s.id]; return n })
      setLocExpandedId(null)
    } catch (e) {
      patchLocEditState(s.id, s, { error: e instanceof Error ? e.message : 'Failed to save', saving: false })
    }
  }

  async function handleDeleteLoc(id: string) {
    if (!confirm('Delete this location override?')) return
    await deleteLocationSetting(id)
    setLocSettings(prev => prev.filter(s => s.id !== id))
    setLocExpandedId(null)
  }

  async function handleAddLoc() {
    if (!addStateCode) { setAddLocError('Please select a state'); return }
    if (addSubScope === 'city' && !addLocValue.trim()) { setAddLocError('City name is required'); return }
    if (addSubScope === 'zip' && !/^\d{5}$/.test(addLocValue.trim())) { setAddLocError('Enter a valid 5-digit zip code'); return }
    setAddLocSaving(true)
    try {
      const input: LocationSettingInput = { settingType: 'arv_threshold', state: addStateCode }
      if (addSubScope === 'city') input.city = addLocValue.trim()
      else if (addSubScope === 'zip') { input.zipCode = addLocValue.trim(); delete input.state }
      const created = await createLocationSetting(input)
      setLocSettings(prev => [...prev, created])
      setAddLocOpen(false); setLocExpandedId(created.id)
    } catch (e) {
      setAddLocError(e instanceof Error ? e.message : 'Failed to create')
    } finally { setAddLocSaving(false) }
  }

  function getLocLabel(s: LocationSetting): string {
    if (s.zipCode) return s.zipCode
    if (s.city && s.state) return `${s.city.charAt(0).toUpperCase() + s.city.slice(1)}, ${s.state}`
    return s.state ?? '—'
  }

  const statusBadge = isDirty
    ? <Badge variant="outline" className="border-amber-500 text-amber-600 dark:text-amber-400 text-xs">Unsaved changes</Badge>
    : isCustom
      ? <Badge variant="outline" className="border-green-500 text-green-600 dark:text-green-400 text-xs">
          Custom{updatedAt && <span className="ml-1 opacity-70">· {new Date(updatedAt).toLocaleDateString()}</span>}
        </Badge>
      : <Badge variant="outline" className="text-xs text-muted-foreground">System default</Badge>

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Thresholds that control how comps are classified for ARV and as-is valuation.
        </p>
        <div className="flex items-center gap-2 flex-shrink-0">
          {!loading && statusBadge}
          <Button variant="outline" size="sm" onClick={handleReset} disabled={saving || loading || (!isCustom && !isDirty)} className="gap-1.5">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
            Reset
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!isDirty || saving || loading} className="gap-1.5">
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Save
          </Button>
        </div>
      </div>

      {error && <div className="px-4 py-3 rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-400">{error}</div>}
      {successMessage && !error && <div className="px-4 py-3 rounded-lg bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 text-sm text-green-700 dark:text-green-400">{successMessage}</div>}

      {loading && <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>}

      {!loading && (
        <div className="space-y-5">
          {/* Threshold settings */}
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="px-4 py-3 border-b border-border bg-muted/20">
              <p className="text-xs font-semibold text-foreground">Comp Classification Thresholds</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">Control how comps are split into after-renovation and as-is groups</p>
            </div>
            <div className="divide-y divide-border/30">
              <div className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-foreground">ARV Comp Percentile</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">Comps in the top {config.percent}% by sale price are used for ARV</p>
                </div>
                <NumericInput
                  value={config.percent}
                  onChange={(v) => setConfig(prev => ({ ...prev, percent: v ?? 10 }))}
                  min={1} max={100} step={5}
                  suffix="%"
                  className="w-24"
                />
              </div>
              <div className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-3">
                <div>
                  <p className="text-sm font-medium text-foreground">As-Is Threshold</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">Comps priced below {asIsThreshold}% of ARV are classified as-is</p>
                </div>
                <NumericInput
                  value={asIsThreshold}
                  onChange={(v) => setAsIsThreshold(v ?? 70)}
                  min={0} max={100} step={5}
                  suffix="%"
                  className="w-24"
                />
              </div>
            </div>
          </div>

          {/* How it works */}
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="px-4 py-3 border-b border-border bg-muted/20">
              <p className="text-xs font-semibold text-foreground">How It Works</p>
            </div>
            <div className="px-4 py-3 text-[11px] text-muted-foreground space-y-1.5">
              <p>1. Comps are sorted by sale price (highest first)</p>
              <p>2. Top {config.percent}% are classified as &quot;after renovation&quot; comps</p>
              <p>3. Comps priced below {asIsThreshold}% of ARV are classified as &quot;as-is&quot;</p>
              <p>4. Appraisal rules (filters &amp; adjustments) are applied to each group</p>
              <p>5. If not enough pass, the threshold widens by 1.5x (up to 3 attempts)</p>
              <p>6. Final fallback uses all comps with standard rules</p>
            </div>
          </div>

          {/* ══ Location Overrides section ══ */}
          <div className="pt-2">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex-1 h-px bg-border" />
              <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground px-1">Location Overrides</span>
              <div className="flex-1 h-px bg-border" />
            </div>
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs text-muted-foreground">Override the ARV threshold for specific markets. Most specific match wins: Zip &rsaquo; City &rsaquo; State.</p>
              <Button size="sm" variant="outline" onClick={() => { setAddStateCode(''); setAddSubScope('state'); setAddLocValue(''); setAddLocError(null); setAddLocOpen(true) }} className="gap-1.5 flex-shrink-0">
                <Plus className="w-3.5 h-3.5" />Add Market
              </Button>
            </div>

            {locSettings.length === 0 ? (
              <div className="border border-dashed rounded-lg py-10 flex flex-col items-center justify-center gap-2 text-center">
                <MapPin className="w-5 h-5 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">No location overrides yet</p>
                <p className="text-xs text-muted-foreground/60">Add a state, city, or zip to use a different ARV threshold for that market.</p>
              </div>
            ) : (
              <div className="border rounded-lg divide-y overflow-hidden">
                {locSettings.map((s) => {
                  const expanded = locExpandedId === s.id
                  const es = getLocEditState(s.id, s)
                  return (
                    <div key={s.id}>
                      <div
                        className={`flex items-center gap-3 px-4 py-3 cursor-pointer select-none transition-colors hover:bg-muted/40 ${expanded ? 'bg-muted/30' : ''}`}
                        onClick={() => setLocExpandedId(expanded ? null : s.id)}
                      >
                        <div className={`flex-shrink-0 p-1.5 rounded-md ${expanded ? 'bg-primary/15' : 'bg-muted'}`}>
                          {s.zipCode ? <Hash className={`w-3.5 h-3.5 ${expanded ? 'text-primary' : 'text-muted-foreground'}`} /> :
                           s.city ? <Building2 className={`w-3.5 h-3.5 ${expanded ? 'text-primary' : 'text-muted-foreground'}`} /> :
                           <MapIcon className={`w-3.5 h-3.5 ${expanded ? 'text-primary' : 'text-muted-foreground'}`} />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-semibold text-foreground">{getLocLabel(s)}</span>
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            {s.hasArvThreshold
                              ? `ARV ${(s.arvThresholdJson as ArvThresholdConfig).percent}% · As-Is ${(s.arvThresholdJson as ArvThresholdConfig).asIsThresholdPercent ?? asIsThreshold}%`
                              : `Using defaults (ARV ${config.percent}% · As-Is ${asIsThreshold}%)`}
                          </p>
                        </div>
                        {s.hasArvThreshold && (
                          <Badge variant="outline" className="text-[10px] px-2 py-0 border-purple-500/30 text-purple-500 flex-shrink-0">
                            {(s.arvThresholdJson as ArvThresholdConfig).percent}% / {(s.arvThresholdJson as ArvThresholdConfig).asIsThresholdPercent ?? asIsThreshold}%
                          </Badge>
                        )}
                        <ChevronDown className={`w-4 h-4 text-muted-foreground flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                      </div>

                      {expanded && (
                        <div className="border-t bg-card space-y-3">
                          {es.error && <div className="mx-4 mt-3 text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">{es.error}</div>}
                          <div className="divide-y divide-border/30">
                            <div className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-3">
                              <div>
                                <p className="text-sm font-medium text-foreground">ARV Comp Percentile</p>
                                <p className="text-[11px] text-muted-foreground mt-0.5">Comps in the top {es.arvThreshold.percent}% by sale price are used for ARV</p>
                              </div>
                              <NumericInput
                                value={es.arvThreshold.percent}
                                onChange={(v) => patchLocEditState(s.id, s, { arvThreshold: { ...es.arvThreshold, percent: v ?? 15 } })}
                                min={1} max={100} step={5}
                                suffix="%"
                                className="w-24"
                              />
                            </div>
                            <div className="grid grid-cols-[1fr_auto] items-center gap-4 px-4 py-3">
                              <div>
                                <p className="text-sm font-medium text-foreground">As-Is Threshold</p>
                                <p className="text-[11px] text-muted-foreground mt-0.5">Comps below {es.arvThreshold.asIsThresholdPercent ?? asIsThreshold}% of ARV = as-is</p>
                              </div>
                              <NumericInput
                                value={es.arvThreshold.asIsThresholdPercent ?? asIsThreshold}
                                onChange={(v) => patchLocEditState(s.id, s, { arvThreshold: { ...es.arvThreshold, asIsThresholdPercent: v ?? 70 } })}
                                min={0} max={100} step={5}
                                suffix="%"
                                className="w-24"
                              />
                            </div>
                          </div>
                          <div className="flex items-center justify-between px-4 pb-3">
                            <Button size="sm" variant="ghost" className="gap-1.5 text-muted-foreground h-7 px-2 text-xs" onClick={() => handleDeleteLoc(s.id)}>
                              <Trash2 className="w-3 h-3" />Delete Market
                            </Button>
                            <div className="flex items-center gap-2">
                              <Button size="sm" variant="outline" className="h-7 px-3 text-xs"
                                onClick={() => { setLocEditStates(prev => { const n = { ...prev }; delete n[s.id]; return n }); setLocExpandedId(null) }}>
                                Cancel
                              </Button>
                              <Button size="sm" className="h-7 px-3 gap-1.5 text-xs" disabled={es.saving} onClick={() => handleSaveLocOverride(s)}>
                                {es.saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                Save Override
                              </Button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Add Location Dialog */}
          <Dialog open={addLocOpen} onOpenChange={setAddLocOpen}>
            <DialogContent className="max-w-sm">
              <DialogHeader><DialogTitle>Add Market Override</DialogTitle></DialogHeader>
              <div className="space-y-4 py-1">
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-foreground">State</label>
                  <select value={addStateCode} onChange={e => { setAddStateCode(e.target.value); setAddSubScope('state'); setAddLocValue(''); setAddLocError(null) }}
                    className={`w-full h-9 text-sm rounded-md border bg-background px-2 ${addLocError && !addStateCode ? 'border-destructive' : 'border-input'}`} autoFocus>
                    <option value="">— Select a state —</option>
                    {US_STATES.map(st => <option key={st.code} value={st.code}>{st.name} ({st.code})</option>)}
                  </select>
                </div>
                {addStateCode && (
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-foreground">Narrow to</label>
                      <div className="grid grid-cols-3 gap-2">
                        {([{ scope: 'state' as const, label: 'Entire State', desc: 'All cities' }, { scope: 'city' as const, label: 'City', desc: 'Specific city' }, { scope: 'zip' as const, label: 'Zip Code', desc: 'Single zip' }]).map(({ scope, label, desc }) => (
                          <button key={scope} onClick={() => { setAddSubScope(scope); setAddLocValue(''); setAddLocError(null) }}
                            className={`py-2 px-1 text-xs rounded-lg border font-medium transition-colors flex flex-col items-center gap-0.5 ${addSubScope === scope ? 'bg-primary text-primary-foreground border-primary' : 'bg-background text-muted-foreground border-border hover:border-foreground/30'}`}>
                            <span>{label}</span>
                            <span className={`text-[10px] font-normal ${addSubScope === scope ? 'text-primary-foreground/70' : 'text-muted-foreground/60'}`}>{desc}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    {addSubScope === 'city' && (
                      <Input placeholder="e.g. Miami" value={addLocValue} onChange={e => { setAddLocValue(e.target.value); setAddLocError(null) }} onKeyDown={e => e.key === 'Enter' && handleAddLoc()} className="h-9" autoFocus />
                    )}
                    {addSubScope === 'zip' && (
                      <Input placeholder="e.g. 33101" value={addLocValue} onChange={e => { setAddLocValue(e.target.value); setAddLocError(null) }} onKeyDown={e => e.key === 'Enter' && handleAddLoc()} className="h-9" autoFocus />
                    )}
                  </div>
                )}
                {addLocError && <p className="text-xs text-destructive">{addLocError}</p>}
              </div>
              <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => setAddLocOpen(false)}>Cancel</Button>
                <Button size="sm" onClick={handleAddLoc} disabled={addLocSaving || !addStateCode} className="gap-1.5">
                  {addLocSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                  Add &amp; Configure
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROXIMITY ADJUSTMENTS — controlled section (no own save/load)
// ═══════════════════════════════════════════════════════════════════════════════

const POSITIONS = [
  { key: 'siding' as const, label: 'Siding', description: 'Property sits beside a road, rail, or commercial zone', impact: 'Lowest', Icon: ArrowRight, color: 'text-yellow-500', bg: 'bg-yellow-500/10', border: 'border-yellow-500/20' },
  { key: 'backing' as const, label: 'Backing', description: 'Property\'s backyard faces the feature', impact: 'Medium', Icon: ArrowUp, color: 'text-orange-500', bg: 'bg-orange-500/10', border: 'border-orange-500/20' },
  { key: 'fronting' as const, label: 'Fronting', description: 'Property\'s front door faces the feature directly', impact: 'Highest', Icon: ArrowLeft, color: 'text-red-500', bg: 'bg-red-500/10', border: 'border-red-500/20' },
]

function ProximitySection({ config, onChange }: { config: ProximityConfig; onChange: (c: ProximityConfig) => void }) {
  const updatePosition = (key: 'siding' | 'backing' | 'fronting', field: keyof ProximityPosition, value: number) => {
    onChange({ ...config, [key]: { ...config[key], [field]: value } })
  }

  const sampleArvLow = 350000
  const sampleArvHigh = 650000

  return (
    <div className="space-y-3">
      {/* Pricing tier cutoff */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-4 py-3 flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-semibold text-foreground">Pricing Tier Cutoff</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">Below: flat dollar &middot; Above: percentage of ARV</p>
          </div>
          <NumericInput value={config.arvThreshold} onChange={(v) => onChange({ ...config, arvThreshold: v })} min={0} step={50000} prefix="$" className="w-36" />
        </div>
      </div>

      {/* Position cards */}
      {POSITIONS.map(({ key, label, description, impact, Icon, color, bg, border }) => (
        <div key={key} className={`rounded-xl border ${border} bg-card overflow-hidden`}>
          <div className="px-4 py-3 flex items-center gap-3">
            <div className={`w-8 h-8 rounded-lg ${bg} flex items-center justify-center flex-shrink-0`}><Icon className={`w-4 h-4 ${color}`} /></div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-foreground">{label}</p>
                <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${border} ${color}`}>{impact} impact</Badge>
              </div>
              <p className="text-[11px] text-muted-foreground mt-0.5">{description}</p>
            </div>
          </div>
          <div className="px-4 pb-3 grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-muted/30 p-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Flat Amount</span>
                <span className="text-[10px] text-muted-foreground/60">ARV &lt; {fmt$(config.arvThreshold)}</span>
              </div>
              <NumericInput value={config[key].flat} onChange={(v) => updatePosition(key, 'flat', v)} min={0} step={1000} prefix="$" className="w-full" />
            </div>
            <div className="rounded-lg bg-muted/30 p-3 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Percentage</span>
                <span className="text-[10px] text-muted-foreground/60">ARV &ge; {fmt$(config.arvThreshold)}</span>
              </div>
              <NumericInput value={config[key].percent} onChange={(v) => updatePosition(key, 'percent', v)} min={0} max={100} step={1} suffix="%" className="w-full" />
            </div>
          </div>
        </div>
      ))}

      {/* Preview */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-border bg-muted/20">
          <p className="text-xs font-semibold text-foreground">Deduction Preview</p>
        </div>
        <div className="grid grid-cols-2 divide-x divide-border/30">
          <div className="px-4 py-3">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">ARV {fmt$(sampleArvLow)} <span className="font-normal">(flat)</span></p>
            <div className="space-y-1">
              {POSITIONS.map(({ key, label, color }) => (
                <div key={key} className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{label}</span>
                  <span className={`font-medium tabular-nums ${color}`}>&minus;{fmt$(config[key].flat)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="px-4 py-3">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">ARV {fmt$(sampleArvHigh)} <span className="font-normal">(%)</span></p>
            <div className="space-y-1">
              {POSITIONS.map(({ key, label, color }) => (
                <div key={key} className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{label} ({config[key].percent}%)</span>
                  <span className={`font-medium tabular-nums ${color}`}>&minus;{fmt$(Math.round(sampleArvHigh * config[key].percent / 100))}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function EvaluationSettingsPage() {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-primary/10">
          <Settings2 className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Evaluation Settings</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Configure appraisal rules, renovation pricing, deal parameters, and market-specific overrides.
          </p>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="thresholds">
        <TabsList className="h-9">
          <TabsTrigger value="thresholds" className="gap-1.5 text-xs">
            <TrendingUp className="w-3.5 h-3.5" />
            Thresholds
          </TabsTrigger>
          <TabsTrigger value="appraisal-rules" className="gap-1.5 text-xs">
            <SlidersHorizontal className="w-3.5 h-3.5" />
            Appraisal Rules
          </TabsTrigger>
          <TabsTrigger value="renovation-levels" className="gap-1.5 text-xs">
            <Hammer className="w-3.5 h-3.5" />
            Renovation Levels
          </TabsTrigger>
          <TabsTrigger value="deal-params" className="gap-1.5 text-xs">
            <DollarSign className="w-3.5 h-3.5" />
            Deal Parameters
          </TabsTrigger>
          <TabsTrigger value="major-items" className="gap-1.5 text-xs">
            <Wrench className="w-3.5 h-3.5" />
            Major Items
          </TabsTrigger>
        </TabsList>

        <TabsContent value="thresholds" className="mt-5">
          <ArvThresholdTab />
        </TabsContent>

        <TabsContent value="appraisal-rules" className="mt-5">
          <AppraisalRulesTab />
        </TabsContent>

        <TabsContent value="renovation-levels" className="mt-5">
          <RenovationLevelsTab />
        </TabsContent>

        <TabsContent value="deal-params" className="mt-5">
          <DealParamsTab />
        </TabsContent>

        <TabsContent value="major-items" className="mt-5">
          <MajorItemCostsTab />
        </TabsContent>

      </Tabs>
    </div>
  )
}
