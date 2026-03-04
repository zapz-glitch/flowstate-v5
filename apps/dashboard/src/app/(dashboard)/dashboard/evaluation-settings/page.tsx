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
  getAppraisalPresets,
  getAppraisalDefaults,
  createAppraisalPreset,
  updateAppraisalPreset,
  deleteAppraisalPreset,
  setDefaultAppraisalPreset,
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
  type AppraisalPreset,
  type AppraisalDefaults,
  type FilterType,
  type AdjustmentType,
  type RehabTable,
  type ArvTier,
  type DealParamsConfig,
  type LocationSetting,
  type LocationSettingInput,
  type MajorItemInfo,
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
  accent: 'blue' | 'emerald'
  headers: string[]
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-border/50 overflow-hidden">
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
              : 'bg-muted border-border/30 text-muted-foreground'
          }`}>
            {enabled ? 'Required' : 'Ignored'}
          </span>
        ) : (
          <div className="flex items-center rounded-md border border-border/50 bg-muted/30 overflow-hidden focus-within:ring-1 focus-within:ring-primary/30 focus-within:border-primary/50">
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
            ? 'border-border/30 text-muted-foreground/50 bg-muted/20'
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
          <div className="flex items-center rounded-md border border-border/50 bg-muted/30 overflow-hidden focus-within:ring-1 focus-within:ring-primary/30 focus-within:border-primary/50">
            <Input
              type="number" min={0} max={100} value={percentage} disabled={!enabled}
              onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 0 && v <= 100) onPercentageChange(v) }}
              className="h-7 w-12 text-[11px] text-right tabular-nums border-0 bg-transparent shadow-none focus-visible:ring-0 pr-1 pl-2"
            />
            <span className="text-[10px] text-muted-foreground pr-2 select-none">%</span>
          </div>
        ) : (
          <div className="flex items-center rounded-md border border-border/50 bg-muted/30 overflow-hidden focus-within:ring-1 focus-within:ring-primary/30 focus-within:border-primary/50">
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
      const saved = isEdit ? await updateAppraisalPreset(editingPreset!.id, input) : await createAppraisalPreset(input)
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
                  const isBoolean = f.filterType === 'subdivision_match' || f.filterType === 'property_type'
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
const FILTER_UNIT: Record<string, string> = { sale_age: 'days', sqft_diff: 'sqft', year_built_diff: 'yrs', distance: 'mi' }
const ADJUSTMENT_SHORT: Record<string, string> = {
  old_comp_discount: 'Comp Discount', bedroom: 'Bedroom', bathroom: 'Bathroom',
  pool: 'Pool', garage: 'Garage', carport: 'Carport',
}

function FilterChip({ label, value, enabled }: { label: string; value: string; enabled: boolean }) {
  return (
    <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md border text-[10px] transition-colors ${
      enabled ? 'border-blue-400/30 bg-blue-500/5 text-foreground' : 'border-border/30 bg-muted/20 text-muted-foreground/50 line-through'
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
      enabled ? 'border-emerald-400/30 bg-emerald-500/5 text-foreground' : 'border-border/30 bg-muted/20 text-muted-foreground/50 line-through'
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
    <Card className={`border-border/50 hover:border-border/80 transition-colors ${preset.isDefault ? 'ring-1 ring-amber-400/30' : ''}`}>
      <CardContent className="p-0">
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border/40">
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
                const isBoolean = f.filterType === 'subdivision_match' || f.filterType === 'property_type'
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

function AppraisalRulesTab() {
  const [defaults, setDefaults] = useState<AppraisalDefaults | null>(null)
  const [presets, setPresets] = useState<AppraisalPreset[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingPreset, setEditingPreset] = useState<AppraisalPreset | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [presetsData, defaultsData] = await Promise.all([getAppraisalPresets(), getAppraisalDefaults()])
      setDefaults(defaultsData)
      setPresets(presetsData)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleSaved = (saved: AppraisalPreset) => {
    setPresets((prev) => {
      const idx = prev.findIndex((p) => p.id === saved.id)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = saved
        if (saved.isDefault) return next.map((p) => p.id === saved.id ? p : { ...p, isDefault: false })
        return next
      }
      if (saved.isDefault) return [saved, ...prev.map((p) => ({ ...p, isDefault: false }))]
      return [saved, ...prev]
    })
    setSuccessMessage(editingPreset ? 'Preset updated.' : 'Preset created.')
    setTimeout(() => setSuccessMessage(null), 3000)
  }

  const handleDelete = async (preset: AppraisalPreset) => {
    if (!confirm(`Delete preset "${preset.name}"? This cannot be undone.`)) return
    try {
      await deleteAppraisalPreset(preset.id)
      setPresets((prev) => prev.filter((p) => p.id !== preset.id))
      setSuccessMessage('Preset deleted.')
      setTimeout(() => setSuccessMessage(null), 3000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  const handleSetDefault = async (preset: AppraisalPreset) => {
    try {
      await setDefaultAppraisalPreset(preset.id)
      setPresets((prev) => prev.map((p) => ({ ...p, isDefault: p.id === preset.id })))
      setSuccessMessage(`"${preset.name}" set as default.`)
      setTimeout(() => setSuccessMessage(null), 3000)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to set default')
    }
  }

  const openNew = () => { setEditingPreset(null); setDialogOpen(true) }
  const openEdit = (preset: AppraisalPreset) => { setEditingPreset(preset); setDialogOpen(true) }
  const closeDialog = () => { setDialogOpen(false); setEditingPreset(null) }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Create named rule presets with custom filters and adjustments. Set one as default to apply it automatically.
        </p>
        <Button size="sm" onClick={openNew} className="gap-1.5 flex-shrink-0">
          <Plus className="w-3.5 h-3.5" />
          New Preset
        </Button>
      </div>

      {error && (
        <div className="px-4 py-3 rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-400">{error}</div>
      )}
      {successMessage && !error && (
        <div className="px-4 py-3 rounded-lg bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 text-sm text-green-700 dark:text-green-400">{successMessage}</div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {!loading && presets.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-3 border border-dashed border-border/50 rounded-xl">
          <SlidersHorizontal className="w-8 h-8 text-muted-foreground/40" />
          <div className="text-center">
            <p className="text-sm font-medium text-foreground">No presets yet</p>
            <p className="text-xs text-muted-foreground mt-1">Create your first preset to customize how comps are filtered and adjusted.</p>
          </div>
          <Button size="sm" onClick={openNew} className="gap-1.5 mt-1">
            <Plus className="w-3.5 h-3.5" />Create First Preset
          </Button>
        </div>
      )}

      {!loading && presets.length > 0 && (
        <div className="space-y-2">
          {presets.slice().sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0)).map((preset) => (
            <PresetCard
              key={preset.id}
              preset={preset}
              onEdit={() => openEdit(preset)}
              onDelete={() => handleDelete(preset)}
              onSetDefault={() => handleSetDefault(preset)}
            />
          ))}
        </div>
      )}

      {/* Create / Edit Dialog */}
      {defaults && (
        <PresetFormDialog
          open={dialogOpen}
          onClose={closeDialog}
          onSaved={handleSaved}
          defaults={defaults}
          editingPreset={editingPreset}
        />
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// RENOVATION LEVELS TAB
// ═══════════════════════════════════════════════════════════════════════════════

function TierCard({
  tier,
  estimates,
  onUpdate,
}: {
  tier: ArvTier
  estimates: Array<{ perSqft: number; minProfit: number }>
  onUpdate: (levelIndex: number, field: 'perSqft' | 'minProfit', value: number) => void
}) {
  return (
    <Card className="border-border/50">
      <CardContent className="p-0">
        <div className="px-3 pt-3 pb-2 border-b border-border/40">
          <CardTitle className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            {ARV_TIER_LABELS[tier]}
          </CardTitle>
        </div>
        <div className="grid grid-cols-[1fr_60px_80px] text-[9px] font-medium text-muted-foreground/60 uppercase tracking-wider px-3 py-1 border-b border-border/30">
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
                    <div className="grid grid-cols-[1fr_60px_80px] items-center gap-x-1.5 px-3 py-[3px] border-b border-border/20 last:border-0">
                      <span className="text-[11px] text-foreground/80 font-medium">{levelName}</span>
                      <div className="relative">
                        <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 text-[9px] pointer-events-none select-none">$</span>
                        <Input
                          type="number" min={0} value={est.perSqft}
                          onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 0) onUpdate(levelIdx, 'perSqft', v) }}
                          className="h-6 text-[11px] pl-4 pr-1 text-right tabular-nums rounded-sm border-border/50 bg-muted/30 focus:bg-background"
                        />
                      </div>
                      <div className="relative">
                        <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 text-[9px] pointer-events-none select-none">$</span>
                        <Input
                          type="number" min={0} step={1000} value={est.minProfit}
                          onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 0) onUpdate(levelIdx, 'minProfit', v) }}
                          className="h-6 text-[11px] pl-4 pr-1 text-right tabular-nums rounded-sm border-border/50 bg-muted/30 focus:bg-background"
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

  useEffect(() => {
    setLoading(true)
    getRehabConfig()
      .then((res) => {
        setTable(structuredClone(res.config))
        setOriginal(structuredClone(res.config))
        setIsCustom(res.isCustom)
        setUpdatedAt(res.updatedAt)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load config'))
      .finally(() => setLoading(false))
  }, [])

  const isDirty = table !== null && original !== null && JSON.stringify(table) !== JSON.stringify(original)

  const handleUpdate = useCallback((tier: ArvTier, levelIndex: number, field: 'perSqft' | 'minProfit', value: number) => {
    setTable((prev) => {
      if (!prev) return prev
      const next = { ...prev, [tier]: [...prev[tier]] }
      next[tier][levelIndex] = { ...next[tier][levelIndex], [field]: value }
      return next
    })
  }, [])

  const handleSave = async () => {
    if (!table || !isDirty) return
    setSaving(true); setError(null); setSuccessMessage(null)
    try {
      const res = await saveRehabConfig(table)
      setOriginal(structuredClone(res.config))
      setTable(structuredClone(res.config))
      setIsCustom(true); setUpdatedAt(res.updatedAt)
      setSuccessMessage('Renovation pricing saved successfully.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    if (!confirm('Reset all renovation pricing to system defaults? This cannot be undone.')) return
    setSaving(true); setError(null); setSuccessMessage(null)
    try {
      const res = await resetRehabConfig()
      setTable(structuredClone(res.config)); setOriginal(structuredClone(res.config))
      setIsCustom(false); setUpdatedAt(undefined)
      setSuccessMessage('Reset to system defaults.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed')
    } finally {
      setSaving(false)
    }
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
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            {ARV_TIERS.map((tier) => (
              <TierCard
                key={tier}
                tier={tier}
                estimates={table[tier]}
                onUpdate={(levelIndex, field, value) => handleUpdate(tier, levelIndex, field, value)}
              />
            ))}
          </div>
          <div className="pt-2 border-t border-border/50">
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
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEAL PARAMETERS TAB
// ═══════════════════════════════════════════════════════════════════════════════

const DEAL_PARAMS_DEFAULTS_UI: DealParamsConfig = {
  closingCostsPercent: 10,
  carryingCostsPercent: 5,
  wholesaleFee: 10000,
  desiredProfit: null,
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
    <div className={`flex items-center rounded-md border border-border/60 bg-background overflow-hidden focus-within:ring-2 focus-within:ring-primary/25 focus-within:border-primary/50 transition-colors ${className ?? ''}`}>
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

  useEffect(() => {
    setLoading(true)
    getDealParams()
      .then((res) => {
        setConfig(res.config)
        setOriginal(res.config)
        setIsCustom(res.isCustom)
        setUpdatedAt(res.updatedAt)
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

  // Live preview calculation (simplified MAO formula)
  const arv = PREVIEW_ARV
  const rehabCost = 35000  // illustrative
  const tierMinProfit = 25000 // illustrative tier default
  const closingDeduct = arv * (config.closingCostsPercent / 100)
  const carryingDeduct = arv * (config.carryingCostsPercent / 100)
  const profitDeduct = config.desiredProfit !== null ? config.desiredProfit : tierMinProfit
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
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-5">

          {/* ── Left: param cards ── */}
          <div className="space-y-3">

            {/* Cost percentages */}
            <div className="rounded-xl border border-border/60 bg-card overflow-hidden">
              <div className="px-4 py-3 border-b border-border/40 bg-muted/20">
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
            <div className="rounded-xl border border-border/60 bg-card overflow-hidden">
              <div className="px-4 py-3 border-b border-border/40 bg-muted/20">
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

            {/* Desired profit */}
            <div className="rounded-xl border border-border/60 bg-card overflow-hidden">
              <div className="px-4 py-3 border-b border-border/40 bg-muted/20 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold text-foreground">Profit Target</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">Minimum profit deducted from the MAO</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-[10px] text-muted-foreground select-none">Use tier default</span>
                  <Switch
                    checked={config.desiredProfit === null}
                    onCheckedChange={(v) => set('desiredProfit', v ? null : 25000)}
                    className="data-[state=checked]:bg-primary/70 scale-90"
                  />
                </div>
              </div>
              <div className="px-4 py-3">
                {config.desiredProfit === null ? (
                  <div className="flex items-center gap-2.5 text-[11px] text-muted-foreground">
                    <div className="w-1.5 h-1.5 rounded-full bg-primary/40 flex-shrink-0" />
                    Pulled from the <span className="font-medium text-foreground">Renovation Levels</span> table per rehab tier — toggle off to set a global override.
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-4">
                    <p className="text-[11px] text-muted-foreground">Fixed profit target across all tiers</p>
                    <NumericInput
                      value={config.desiredProfit}
                      onChange={(v) => set('desiredProfit', v)}
                      min={0} step={1000}
                      prefix="$"
                      className="w-32"
                    />
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ── Right: live MAO preview ── */}
          <div className="rounded-xl border border-border/60 bg-card overflow-hidden h-fit sticky top-4">
            <div className="px-4 py-3 border-b border-border/40 bg-muted/20">
              <p className="text-xs font-semibold text-foreground">MAO Preview</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">Example deal · ARV {fmt$(arv)}</p>
            </div>
            <div className="px-4 py-3 space-y-0.5">
              <FormulaRow label="ARV" value={fmt$(arv)} />
              <FormulaRow label={`− Rehab (illustrative)`} value={`−${fmt$(rehabCost)}`} variant="deduct" />
              <FormulaRow label={`− Closing (${config.closingCostsPercent}%)`} value={`−${fmt$(closingDeduct)}`} variant="deduct" />
              <FormulaRow label={`− Carrying (${config.carryingCostsPercent}%)`} value={`−${fmt$(carryingDeduct)}`} variant="deduct" />
              <FormulaRow
                label={config.desiredProfit === null ? `− Profit (tier default)` : `− Profit target`}
                value={`−${fmt$(profitDeduct)}`}
                variant="deduct"
                dimmed={config.desiredProfit === null}
              />
              <FormulaRow label="− Wholesale fee" value={`−${fmt$(config.wholesaleFee)}`} variant="deduct" />
              <div className="border-t border-border/50 mt-2 pt-2">
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
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAJOR ITEM COSTS TAB
// ═══════════════════════════════════════════════════════════════════════════════

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

  const load = useCallback(async () => {
    try {
      setLoading(true)
      const data = await getMajorItemCosts()
      setItems(data.items)
      setIsCustom(data.isCustom)
      setUpdatedAt(data.updatedAt)
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
      <div className="rounded-lg border border-border/60 overflow-hidden">
        {/* Header row */}
        <div className="grid bg-muted/40 border-b border-border/50 px-4 py-2"
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
                  <div className="flex items-center rounded-md border border-border/50 bg-muted/30 overflow-hidden focus-within:ring-1 focus-within:ring-primary/30 focus-within:border-primary/50">
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
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOCATION OVERRIDES TAB
// ═══════════════════════════════════════════════════════════════════════════════

type LocationType = 'state' | 'city' | 'zip'

// Scope order for display grouping (broadest → most specific)
const SCOPE_ORDER: LocationType[] = ['state', 'city', 'zip']
const SCOPE_LABELS: Record<LocationType, { plural: string }> = {
  state: { plural: 'States' },
  city:  { plural: 'Cities' },
  zip:   { plural: 'Zips' },
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

function getStateName(code: string): string {
  return US_STATES.find(s => s.code === code)?.name ?? code
}

function getLocationType(s: LocationSetting): LocationType {
  if (s.zipCode) return 'zip'
  if (s.city) return 'city'
  return 'state'
}

function getLocationValue(s: LocationSetting): string {
  if (s.zipCode) return s.zipCode
  if (s.city) {
    const cityName = s.city.charAt(0).toUpperCase() + s.city.slice(1)
    return s.state ? `${cityName}, ${s.state}` : cityName
  }
  return s.state ? getStateName(s.state) : '—'
}

// What each override card shows when collapsed
function overrideSummary(s: LocationSetting): string {
  const parts: string[] = []
  if (s.appraisalPresetId) parts.push(s.appraisalPresetName ?? 'Preset')
  if (s.hasRehabConfig) parts.push('Rehab pricing')
  if (s.hasDealParams) parts.push('Deal params')
  if (s.hasMajorItemCosts) parts.push('Major items')
  return parts.length ? parts.join(' · ') : 'No overrides — click to configure'
}

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

interface LocEditState {
  // Which override sections are open
  activeTab: 'appraisal' | 'deal' | 'rehab' | 'major'
  // Appraisal
  enableAppraisal: boolean
  appraisalPresetId: string | null
  // Deal params
  enableDealParams: boolean
  dealParams: DealParamsConfig
  // Rehab
  enableRehab: boolean
  rehabTable: RehabTable
  // active ARV tier tab in rehab editor
  rehabActiveTier: ArvTier
  // Major items
  enableMajorItems: boolean
  majorItemCosts: Record<string, number>
  saving: boolean
  error: string | null
}

function LocationOverridesTab() {
  const [settings, setSettings] = useState<LocationSetting[]>([])
  const [presets, setPresets] = useState<AppraisalPreset[]>([])
  const [loading, setLoading] = useState(true)
  const [pageError, setPageError] = useState<string | null>(null)

  // User's current global defaults — used as seed values for new location overrides
  const [userRehabTable, setUserRehabTable] = useState<RehabTable | null>(null)
  const [userDealParams, setUserDealParams] = useState<DealParamsConfig | null>(null)
  const [userMajorItemCosts, setUserMajorItemCosts] = useState<Record<string, number> | null>(null)

  // Expanded row ID — only one row expanded at a time
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // Edit state per row (keyed by setting id, or 'new' for the create form)
  const [editStates, setEditStates] = useState<Record<string, LocEditState>>({})

    // Add dialog — progressive: state first, then narrow to city or zip
  const [addOpen, setAddOpen] = useState(false)
  const [addStateCode, setAddStateCode] = useState('')
  const [addSubScope, setAddSubScope] = useState<'state' | 'city' | 'zip'>('state')
  const [addValue, setAddValue] = useState('') // city name or zip
  const [addValidationError, setAddValidationError] = useState<string | null>(null)
  const [addSaving, setAddSaving] = useState(false)

  const fallbackRehabTable = ARV_TIERS.reduce((acc, tier) => {
    acc[tier] = REHAB_LEVEL_NAMES.map(() => ({ perSqft: 25, minProfit: 30000 }))
    return acc
  }, {} as RehabTable)
  const fallbackDealParams: DealParamsConfig = { closingCostsPercent: 10, carryingCostsPercent: 5, wholesaleFee: 10000, desiredProfit: null }

  const load = useCallback(async () => {
    try {
      setLoading(true)
      const [settingsData, presetsData, rehabData, dealData, majorData] = await Promise.all([
        getLocationSettings(),
        getAppraisalPresets(),
        getRehabConfig(),
        getDealParams(),
        getMajorItemCosts(),
      ])
      setSettings(settingsData)
      setPresets(presetsData)
      setUserRehabTable(rehabData.config)
      setUserDealParams(dealData.config)
      // Build effective cost map from user's major item costs
      const costMap: Record<string, number> = {}
      for (const item of majorData.items) costMap[item.id] = item.effectiveCost
      setUserMajorItemCosts(costMap)
    } catch {
      setPageError('Failed to load location settings')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  function getEditState(id: string, s: LocationSetting): LocEditState {
    if (editStates[id]) return editStates[id]
    // Seed major items from location override or user global defaults
    const seedMajorItems = s.majorItemCostsJson
      ? (s.majorItemCostsJson as Record<string, number>)
      : { ...(userMajorItemCosts ?? Object.fromEntries(MAJOR_ITEMS_DEFAULTS.map(i => [i.id, i.defaultCost]))) }
    return {
      activeTab: 'appraisal',
      enableAppraisal: !!s.appraisalPresetId,
      appraisalPresetId: s.appraisalPresetId ?? null,
      enableDealParams: s.hasDealParams,
      dealParams: s.dealParamsJson ?? { ...(userDealParams ?? fallbackDealParams) },
      enableRehab: s.hasRehabConfig,
      rehabTable: s.rehabConfigJson ?? JSON.parse(JSON.stringify(userRehabTable ?? fallbackRehabTable)),
      rehabActiveTier: ARV_TIERS[0],
      enableMajorItems: s.hasMajorItemCosts,
      majorItemCosts: seedMajorItems,
      saving: false,
      error: null,
    }
  }

  function patchEditState(id: string, patch: Partial<LocEditState>) {
    setEditStates(prev => ({
      ...prev,
      [id]: { ...getEditState(id, settings.find(s => s.id === id)!), ...patch },
    }))
  }

  function toggleRow(id: string) {
    setExpandedId(prev => prev === id ? null : id)
  }

  async function handleSaveRow(s: LocationSetting) {
    const es = getEditState(s.id, s)
    patchEditState(s.id, { saving: true, error: null })
    try {
      const input: LocationSettingInput = {
        appraisalPresetId: es.enableAppraisal ? es.appraisalPresetId : null,
        rehabConfigJson: es.enableRehab ? es.rehabTable : null,
        dealParamsJson: es.enableDealParams ? es.dealParams : null,
        majorItemCostsJson: es.enableMajorItems ? es.majorItemCosts : null,
      }
      const updated = await updateLocationSetting(s.id, input)
      setSettings(prev => prev.map(x => x.id === s.id ? updated : x))
      setEditStates(prev => { const n = { ...prev }; delete n[s.id]; return n })
      setExpandedId(null)
    } catch (e: unknown) {
      patchEditState(s.id, { error: e instanceof Error ? e.message : 'Failed to save', saving: false })
    }
  }

  function handleCancelRow(id: string) {
    setEditStates(prev => { const n = { ...prev }; delete n[id]; return n })
    setExpandedId(null)
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this location override?')) return
    await deleteLocationSetting(id)
    setSettings(prev => prev.filter(s => s.id !== id))
    setExpandedId(null)
  }

  // Add flow
  function openAdd() {
    setAddStateCode('')
    setAddSubScope('state')
    setAddValue('')
    setAddValidationError(null)
    setAddOpen(true)
  }

  async function handleAdd() {
    if (!addStateCode) { setAddValidationError('Please select a state'); return }
    if (addSubScope === 'city' && !addValue.trim()) { setAddValidationError('City name is required'); return }
    if (addSubScope === 'zip' && !/^\d{5}$/.test(addValue.trim())) { setAddValidationError('Enter a valid 5-digit zip code'); return }
    setAddSaving(true)
    try {
      const input: LocationSettingInput = { state: addStateCode }
      if (addSubScope === 'city') input.city = addValue.trim()
      else if (addSubScope === 'zip') { input.zipCode = addValue.trim(); delete input.state }
      const created = await createLocationSetting(input)
      setSettings(prev => [...prev, created])
      setAddOpen(false)
      setExpandedId(created.id)
    } catch (e: unknown) {
      setAddValidationError(e instanceof Error ? e.message : 'Failed to create')
    } finally {
      setAddSaving(false)
    }
  }

  function updateRehabValue(id: string, s: LocationSetting, tier: ArvTier, idx: number, field: 'perSqft' | 'minProfit', value: number) {
    const es = getEditState(id, s)
    const newTable = JSON.parse(JSON.stringify(es.rehabTable)) as RehabTable
    newTable[tier][idx] = { ...newTable[tier][idx], [field]: value }
    patchEditState(id, { rehabTable: newTable })
  }

  // Group settings by scope for display
  const grouped = SCOPE_ORDER.map(scope => ({
    scope,
    items: settings.filter(s => getLocationType(s) === scope),
  })).filter(g => g.items.length > 0)

  // Check if a row has unsaved changes
  function isDirty(id: string, s: LocationSetting): boolean {
    if (!editStates[id]) return false
    const es = editStates[id]
    const orig = {
      enableAppraisal: !!s.appraisalPresetId,
      appraisalPresetId: s.appraisalPresetId ?? null,
      enableDealParams: s.hasDealParams,
      enableRehab: s.hasRehabConfig,
      enableMajorItems: s.hasMajorItemCosts,
    }
    return es.enableAppraisal !== orig.enableAppraisal ||
      es.appraisalPresetId !== orig.appraisalPresetId ||
      es.enableDealParams !== orig.enableDealParams ||
      es.enableRehab !== orig.enableRehab ||
      es.enableMajorItems !== orig.enableMajorItems
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="text-sm">Loading…</span>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {pageError && (
        <div className="text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md">{pageError}</div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1.5">
          <p className="text-sm text-muted-foreground">
            Set market-specific appraisal rules, rehab pricing, and deal parameters.
          </p>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Most specific wins:</span>
            {(['Zip', 'City, State', 'State', 'Your defaults'] as const).map((label, i, arr) => (
              <React.Fragment key={label}>
                <span className={i < arr.length - 1 ? 'font-semibold text-foreground px-1.5 py-0.5 rounded bg-muted' : 'text-muted-foreground'}>
                  {label}
                </span>
                {i < arr.length - 1 && <span className="text-muted-foreground/50">›</span>}
              </React.Fragment>
            ))}
          </div>
        </div>
        <Button size="sm" className="gap-1.5 flex-shrink-0" onClick={openAdd}>
          <Plus className="w-3.5 h-3.5" />
          Add Market
        </Button>
      </div>

      {/* Empty state */}
      {settings.length === 0 ? (
        <div className="border border-dashed rounded-lg py-14 flex flex-col items-center justify-center gap-3 text-center">
          <div className="p-3 rounded-full bg-muted">
            <MapPin className="w-5 h-5 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">No markets configured</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-xs">
              Add a state, city, or zip code to override your default evaluation settings for that market.
            </p>
          </div>
          <Button size="sm" variant="outline" className="gap-1.5 mt-1" onClick={openAdd}>
            <Plus className="w-3.5 h-3.5" />
            Add your first market
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {grouped.map(({ scope, items }) => (
            <div key={scope}>
              {/* Scope section header */}
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">{SCOPE_LABELS[scope].plural}</span>
                <div className="flex-1 h-px bg-border" />
              </div>

              <div className="border rounded-lg divide-y overflow-hidden">
                {items.map(s => {
                  const es = getEditState(s.id, s)
                  const expanded = expandedId === s.id
                  const dirty = isDirty(s.id, s)

                  return (
                    <div key={s.id}>
                      {/* Row header — always visible */}
                      <div
                        className={`flex items-center gap-3 px-4 py-3 cursor-pointer select-none transition-colors hover:bg-muted/40 ${expanded ? 'bg-muted/30' : ''}`}
                        onClick={() => toggleRow(s.id)}
                      >
                        {/* Scope icon */}
                        <div className={`flex-shrink-0 p-1.5 rounded-md ${expanded ? 'bg-primary/15' : 'bg-muted'}`}>
                          {scope === 'zip' ? <Hash className={`w-3.5 h-3.5 ${expanded ? 'text-primary' : 'text-muted-foreground'}`} /> :
                           scope === 'city' ? <Building2 className={`w-3.5 h-3.5 ${expanded ? 'text-primary' : 'text-muted-foreground'}`} /> :
                           <MapIcon className={`w-3.5 h-3.5 ${expanded ? 'text-primary' : 'text-muted-foreground'}`} />}
                        </div>

                        {/* Location name + summary */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-foreground">{getLocationValue(s)}</span>
                            {dirty && <Badge variant="outline" className="text-[10px] py-0 px-1.5 h-4 border-amber-400 text-amber-600">Unsaved</Badge>}
                          </div>
                          <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{overrideSummary(s)}</p>
                        </div>

                        {/* Active override chips */}
                        <div className="hidden sm:flex items-center gap-1 flex-shrink-0">
                          {es.enableAppraisal && (
                            <div className="w-2 h-2 rounded-full bg-blue-500" title="Appraisal preset active" />
                          )}
                          {es.enableRehab && (
                            <div className="w-2 h-2 rounded-full bg-green-500" title="Rehab pricing active" />
                          )}
                          {es.enableDealParams && (
                            <div className="w-2 h-2 rounded-full bg-purple-500" title="Deal params active" />
                          )}
                          {es.enableMajorItems && (
                            <div className="w-2 h-2 rounded-full bg-orange-500" title="Major item costs active" />
                          )}
                        </div>

                        {/* Expand chevron */}
                        <ChevronDown className={`w-4 h-4 text-muted-foreground flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                      </div>

                      {/* Expanded inline editor */}
                      {expanded && (
                        <div className="border-t bg-card px-4 pt-3 pb-4 space-y-3">
                          {es.error && (
                            <div className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded-md">{es.error}</div>
                          )}

                          {/* Tab bar */}
                          {(() => {
                            const tabs = [
                              { id: 'appraisal' as const, label: 'Appraisal', active: es.enableAppraisal, color: 'blue' },
                              { id: 'deal'      as const, label: 'Deal Params', active: es.enableDealParams, color: 'purple' },
                              { id: 'rehab'     as const, label: 'Rehab Pricing', active: es.enableRehab, color: 'green' },
                              { id: 'major'     as const, label: 'Major Items', active: es.enableMajorItems, color: 'orange' },
                            ] as const
                            const dotColor = { blue: 'bg-blue-500', purple: 'bg-purple-500', green: 'bg-green-500', orange: 'bg-orange-500' }
                            const activeTabStyle = { blue: 'border-blue-500 text-blue-600 dark:text-blue-400', purple: 'border-purple-500 text-purple-600 dark:text-purple-400', green: 'border-green-600 text-green-700 dark:text-green-400', orange: 'border-orange-500 text-orange-600 dark:text-orange-400' }

                            return (
                              <>
                                {/* Tabs */}
                                <div className="flex gap-0 border-b border-border">
                                  {tabs.map(tab => {
                                    const isActive = es.activeTab === tab.id
                                    return (
                                      <button
                                        key={tab.id}
                                        onClick={() => patchEditState(s.id, { activeTab: tab.id })}
                                        className={`flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
                                          isActive
                                            ? `${activeTabStyle[tab.color]} bg-background`
                                            : 'border-transparent text-muted-foreground hover:text-foreground'
                                        }`}
                                      >
                                        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${tab.active ? dotColor[tab.color] : 'bg-border'}`} />
                                        {tab.label}
                                      </button>
                                    )
                                  })}
                                </div>

                                {/* Tab panels */}
                                <div className="pt-1">

                                  {/* ── Appraisal Preset ── */}
                                  {es.activeTab === 'appraisal' && (
                                    <div className="space-y-3">
                                      <div className="flex items-center justify-between">
                                        <div>
                                          <p className="text-sm font-medium">Appraisal Preset</p>
                                          <p className="text-xs text-muted-foreground mt-0.5">Use a specific appraisal rule preset for this market</p>
                                        </div>
                                        <Switch
                                          checked={es.enableAppraisal}
                                          onCheckedChange={v => patchEditState(s.id, { enableAppraisal: v })}
                                          className="data-[state=checked]:bg-blue-500"
                                        />
                                      </div>
                                      {es.enableAppraisal ? (
                                        <select
                                          value={es.appraisalPresetId ?? ''}
                                          onChange={e => patchEditState(s.id, { appraisalPresetId: e.target.value || null })}
                                          className="w-full h-9 text-sm rounded-lg border border-input bg-background px-3 focus:outline-none focus:ring-2 focus:ring-primary/30"
                                        >
                                          <option value="">— Use account default —</option>
                                          {presets.map(p => (
                                            <option key={p.id} value={p.id}>{p.name}{p.isDefault ? ' ★' : ''}</option>
                                          ))}
                                        </select>
                                      ) : (
                                        <div className="rounded-lg bg-muted/40 border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
                                          Using your account default appraisal preset
                                        </div>
                                      )}
                                    </div>
                                  )}

                                  {/* ── Deal Parameters ── */}
                                  {es.activeTab === 'deal' && (
                                    <div className="space-y-3">
                                      <div className="flex items-center justify-between">
                                        <div>
                                          <p className="text-sm font-medium">Deal Parameters</p>
                                          <p className="text-xs text-muted-foreground mt-0.5">Override closing costs, carrying costs and fees for this market</p>
                                        </div>
                                        <Switch
                                          checked={es.enableDealParams}
                                          onCheckedChange={v => {
                                            const seed = v && !s.hasDealParams ? { dealParams: { ...(userDealParams ?? fallbackDealParams) } } : {}
                                            patchEditState(s.id, { enableDealParams: v, ...seed })
                                          }}
                                          className="data-[state=checked]:bg-purple-500"
                                        />
                                      </div>
                                      {es.enableDealParams ? (
                                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                                          {[
                                            { label: 'Closing Cost', field: 'closingCostsPercent' as const, max: 100, step: 0.5, suffix: '%' },
                                            { label: 'Carrying Cost', field: 'carryingCostsPercent' as const, max: 100, step: 0.5, suffix: '%' },
                                            { label: 'Wholesale Fee', field: 'wholesaleFee' as const, step: 500, prefix: '$' },
                                            { label: 'Min Profit', field: 'desiredProfit' as const, step: 1000, prefix: '$', placeholder: 'Tier default' },
                                          ].map(({ label, field, max, step, prefix, suffix, placeholder }) => (
                                            <div key={field} className="space-y-1.5">
                                              <label className="text-xs font-medium text-muted-foreground">{label}</label>
                                              <div className="flex items-center h-9 rounded-lg border border-input bg-background overflow-hidden focus-within:ring-2 focus-within:ring-primary/25 focus-within:border-primary/50 transition-colors">
                                                {prefix && <span className="text-sm text-muted-foreground pl-3 select-none">{prefix}</span>}
                                                <Input
                                                  type="number" min={0} max={max} step={step}
                                                  value={field === 'desiredProfit' ? (es.dealParams[field] ?? '') : es.dealParams[field]}
                                                  placeholder={placeholder}
                                                  onChange={e => {
                                                    const raw = e.target.value
                                                    const v = raw === '' ? null : parseFloat(raw)
                                                    patchEditState(s.id, { dealParams: { ...es.dealParams, [field]: v } })
                                                  }}
                                                  className="h-full border-0 shadow-none focus-visible:ring-0 bg-transparent text-sm tabular-nums px-2"
                                                />
                                                {suffix && <span className="text-sm text-muted-foreground pr-3 select-none">{suffix}</span>}
                                              </div>
                                            </div>
                                          ))}
                                        </div>
                                      ) : (
                                        <div className="rounded-lg bg-muted/40 border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
                                          Using your account default deal parameters
                                        </div>
                                      )}
                                    </div>
                                  )}

                                  {/* ── Rehab Pricing ── */}
                                  {es.activeTab === 'rehab' && (
                                    <div className="space-y-3">
                                      <div className="flex items-center justify-between">
                                        <div>
                                          <p className="text-sm font-medium">Rehab Pricing</p>
                                          <p className="text-xs text-muted-foreground mt-0.5">Set $/sqft and minimum profit per rehab level and ARV tier</p>
                                        </div>
                                        <Switch
                                          checked={es.enableRehab}
                                          onCheckedChange={v => {
                                            const seed = v && !s.hasRehabConfig ? { rehabTable: JSON.parse(JSON.stringify(userRehabTable ?? fallbackRehabTable)) } : {}
                                            patchEditState(s.id, { enableRehab: v, ...seed })
                                          }}
                                          className="data-[state=checked]:bg-green-600"
                                        />
                                      </div>
                                      {es.enableRehab ? (
                                        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
                                          {ARV_TIERS.map(tier => (
                                            <Card key={tier} className="border-border/50">
                                              <CardContent className="p-0">
                                                <div className="px-3 pt-3 pb-2 border-b border-border/40">
                                                  <CardTitle className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                                                    {ARV_TIER_LABELS[tier]}
                                                  </CardTitle>
                                                </div>
                                                <div className="grid grid-cols-[1fr_60px_80px] text-[9px] font-medium text-muted-foreground/60 uppercase tracking-wider px-3 py-1 border-b border-border/30">
                                                  <span>Level</span>
                                                  <span className="text-right">$/sqft</span>
                                                  <span className="text-right">Min $</span>
                                                </div>
                                                <div>
                                                  {REHAB_LEVEL_NAMES.map((lvl, idx) => (
                                                    <div key={lvl} className="grid grid-cols-[1fr_60px_80px] items-center gap-x-1.5 px-3 py-[3px] border-b border-border/20 last:border-0">
                                                      <span className="text-[11px] text-foreground/80 font-medium truncate" title={lvl}>{lvl}</span>
                                                      <div className="relative">
                                                        <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 text-[9px] pointer-events-none select-none">$</span>
                                                        <Input
                                                          type="number" min={0} step={1}
                                                          value={es.rehabTable[tier]?.[idx]?.perSqft ?? 0}
                                                          onChange={e => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 0) updateRehabValue(s.id, s, tier, idx, 'perSqft', v) }}
                                                          className="h-6 text-[11px] pl-4 pr-1 text-right tabular-nums rounded-sm border-border/50 bg-muted/30 focus:bg-background"
                                                        />
                                                      </div>
                                                      <div className="relative">
                                                        <span className="absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 text-[9px] pointer-events-none select-none">$</span>
                                                        <Input
                                                          type="number" min={0} step={1000}
                                                          value={es.rehabTable[tier]?.[idx]?.minProfit ?? 0}
                                                          onChange={e => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 0) updateRehabValue(s.id, s, tier, idx, 'minProfit', v) }}
                                                          className="h-6 text-[11px] pl-4 pr-1 text-right tabular-nums rounded-sm border-border/50 bg-muted/30 focus:bg-background"
                                                        />
                                                      </div>
                                                    </div>
                                                  ))}
                                                </div>
                                              </CardContent>
                                            </Card>
                                          ))}
                                        </div>
                                      ) : (
                                        <div className="rounded-lg bg-muted/40 border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
                                          Using your account default rehab pricing table
                                        </div>
                                      )}
                                    </div>
                                  )}

                                  {/* ── Major Item Costs ── */}
                                  {es.activeTab === 'major' && (
                                    <div className="space-y-3">
                                      <div className="flex items-center justify-between">
                                        <div>
                                          <p className="text-sm font-medium">Major Item Costs</p>
                                          <p className="text-xs text-muted-foreground mt-0.5">Override repair costs for major items specific to this market</p>
                                        </div>
                                        <Switch
                                          checked={es.enableMajorItems}
                                          onCheckedChange={v => {
                                            const seed = v && !s.hasMajorItemCosts
                                              ? { majorItemCosts: { ...(userMajorItemCosts ?? Object.fromEntries(MAJOR_ITEMS_DEFAULTS.map(i => [i.id, i.defaultCost]))) } }
                                              : {}
                                            patchEditState(s.id, { enableMajorItems: v, ...seed })
                                          }}
                                          className="data-[state=checked]:bg-orange-500"
                                        />
                                      </div>
                                      {es.enableMajorItems ? (
                                        <div className="rounded-lg border border-border/60 overflow-hidden">
                                          <div className="grid bg-muted/40 border-b border-border/50 px-4 py-2" style={{ gridTemplateColumns: '1fr 110px 110px 90px' }}>
                                            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Item</span>
                                            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground text-center">Default</span>
                                            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground text-center">Override</span>
                                            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground text-center">Age Trigger</span>
                                          </div>
                                          <div className="divide-y divide-border/30 bg-background">
                                            {MAJOR_ITEMS_DEFAULTS.map(item => {
                                              const tooltip = ITEM_TOOLTIPS[item.id]
                                              const currentCost = es.majorItemCosts[item.id] ?? item.defaultCost
                                              const isCustom = currentCost !== item.defaultCost
                                              return (
                                                <div key={item.id} className="grid items-center gap-x-3 px-4 py-2" style={{ gridTemplateColumns: '1fr 110px 110px 90px' }}>
                                                  <div className="flex items-center gap-1.5 min-w-0">
                                                    <span className="text-sm font-medium text-foreground">{item.name}</span>
                                                    {isCustom && <div className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0" title="Custom cost set" />}
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
                                                    <div className="flex items-center rounded-md border border-border/50 bg-muted/30 overflow-hidden focus-within:ring-1 focus-within:ring-primary/30 focus-within:border-primary/50">
                                                      <span className="text-xs text-muted-foreground pl-2 select-none">$</span>
                                                      <Input
                                                        type="number" min={0} step={500}
                                                        value={currentCost}
                                                        onChange={e => {
                                                          const v = parseInt(e.target.value, 10)
                                                          if (!isNaN(v) && v >= 0) patchEditState(s.id, { majorItemCosts: { ...es.majorItemCosts, [item.id]: v } })
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
                                      ) : (
                                        <div className="rounded-lg bg-muted/40 border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
                                          Using your global major item repair costs
                                        </div>
                                      )}
                                    </div>
                                  )}

                                </div>
                              </>
                            )
                          })()}

                          {/* Row actions */}
                          <div className="flex items-center justify-between pt-1">
                            <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive gap-1.5 h-7 px-2"
                              onClick={() => handleDelete(s.id)}>
                              <Trash2 className="w-3.5 h-3.5" />
                              Delete market
                            </Button>
                            <div className="flex gap-2">
                              <Button size="sm" variant="ghost" className="h-7 px-3" onClick={() => handleCancelRow(s.id)}>
                                Cancel
                              </Button>
                              <Button size="sm" className="h-7 px-3 gap-1.5"
                                disabled={es.saving}
                                onClick={() => handleSaveRow(s)}>
                                {es.saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                Save
                              </Button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add Market Dialog — progressive: state first, then narrow */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Market Override</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-1">

            {/* Step 1: State (always required) */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-foreground">State</label>
              <select
                value={addStateCode}
                onChange={e => {
                  setAddStateCode(e.target.value)
                  setAddSubScope('state')
                  setAddValue('')
                  setAddValidationError(null)
                }}
                className={`w-full h-9 text-sm rounded-md border bg-background px-2 ${addValidationError && !addStateCode ? 'border-destructive' : 'border-input'}`}
                autoFocus
              >
                <option value="">— Select a state —</option>
                {US_STATES.map(s => (
                  <option key={s.code} value={s.code}>{s.name} ({s.code})</option>
                ))}
              </select>
            </div>

            {/* Step 2: Narrow scope (only shown once state is selected) */}
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
                        onClick={() => { setAddSubScope(scope); setAddValue(''); setAddValidationError(null) }}
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

                {/* City input */}
                {addSubScope === 'city' && (
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">City name</label>
                    <Input
                      placeholder="e.g. Miami"
                      value={addValue}
                      onChange={e => { setAddValue(e.target.value); setAddValidationError(null) }}
                      onKeyDown={e => e.key === 'Enter' && handleAdd()}
                      className={`h-9 ${addValidationError ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                      autoFocus
                    />
                  </div>
                )}

                {/* Zip input */}
                {addSubScope === 'zip' && (
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium text-muted-foreground">Zip code</label>
                    <Input
                      placeholder="e.g. 33101"
                      value={addValue}
                      onChange={e => { setAddValue(e.target.value); setAddValidationError(null) }}
                      onKeyDown={e => e.key === 'Enter' && handleAdd()}
                      className={`h-9 ${addValidationError ? 'border-destructive focus-visible:ring-destructive' : ''}`}
                      autoFocus
                    />
                  </div>
                )}
              </div>
            )}

            {addValidationError && (
              <p className="text-xs text-destructive">{addValidationError}</p>
            )}

            <p className="text-[11px] text-muted-foreground">
              After adding, configure which settings to override for this market.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              onClick={handleAdd}
              disabled={addSaving || !addStateCode || (addSubScope === 'city' && !addValue.trim()) || (addSubScope === 'zip' && !addValue.trim())}
              className="gap-1.5"
            >
              {addSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
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
      <Tabs defaultValue="appraisal-rules">
        <TabsList className="h-9">
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
          <TabsTrigger value="major-item-costs" className="gap-1.5 text-xs">
            <Wrench className="w-3.5 h-3.5" />
            Major Items
          </TabsTrigger>
          <TabsTrigger value="location-overrides" className="gap-1.5 text-xs">
            <MapPin className="w-3.5 h-3.5" />
            Location Overrides
          </TabsTrigger>
        </TabsList>

        <TabsContent value="appraisal-rules" className="mt-5">
          <AppraisalRulesTab />
        </TabsContent>

        <TabsContent value="renovation-levels" className="mt-5">
          <RenovationLevelsTab />
        </TabsContent>

        <TabsContent value="deal-params" className="mt-5">
          <DealParamsTab />
        </TabsContent>

        <TabsContent value="major-item-costs" className="mt-5">
          <MajorItemCostsTab />
        </TabsContent>

        <TabsContent value="location-overrides" className="mt-5">
          <LocationOverridesTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
