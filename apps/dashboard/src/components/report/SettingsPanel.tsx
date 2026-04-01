'use client'

import {
  RotateCcw,
  ChevronDown,
  ChevronRight,
  Info,
  Wrench,
  Scale,
  DollarSign,
  Hammer,
  Package,
  Filter,
  Sliders,
  Navigation,
} from 'lucide-react'
import { useState } from 'react'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { UseReportSettingsReturn } from '@/hooks/use-report-settings'
import type { RecalcResult } from '@/lib/recalc'
import { getTierLabel } from '@/lib/client-api'

// ─── Config ──────────────────────────────────────────────────────────────────

const FILTER_LABELS: Record<string, { label: string; unit: string; hint: string }> = {
  subdivision_match: { label: 'Subdivision Match', unit: '', hint: 'Same subdivision required' },
  building_style_match: { label: 'Building Style', unit: '', hint: 'Same building style required' },
  sale_age: { label: 'Sale Age', unit: 'days', hint: 'Max days since sold' },
  sqft_diff: { label: 'Sqft Difference', unit: '%', hint: 'Max ±% sqft variance' },
  year_built_diff: { label: 'Year Built Diff', unit: 'yrs', hint: 'Max year variance' },
  distance: { label: 'Distance', unit: 'mi', hint: 'Max miles from subject' },
}

const ADJUSTMENT_LABELS: Record<string, { label: string; isPercentage?: boolean; unavailable?: boolean }> = {
  old_comp_discount: { label: 'Old Comp Discount', isPercentage: true },
  bedroom: { label: 'Bedroom' },
  bathroom: { label: 'Bathroom' },
  pool: { label: 'Pool', unavailable: true },
  garage: { label: 'Garage', unavailable: true },
  carport: { label: 'Carport', unavailable: true },
}

const ARV_TIER_LABELS: Record<string, string> = {
  under501k: 'Under $501K',
  '501kTo999k': '$501K–$999K',
  '1mTo3m': '$1M–$3M',
  over3m: 'Over $3M',
}

const LEVEL_NAMES = ['Lipstick', 'Light Cosmetic', 'Full Cosmetic', 'Heavy Rehab', 'Down to Stud']

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(amount: number | null | undefined): string {
  if (amount == null || Number.isNaN(amount)) return '$-'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount)
}

// ─── Section Wrapper ─────────────────────────────────────────────────────────

function Section({
  icon: Icon,
  title,
  badge,
  defaultOpen = true,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  badge?: React.ReactNode
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-5 py-3.5 hover:bg-secondary/40 transition-colors"
      >
        <Icon className="w-4 h-4 text-foreground-tertiary flex-shrink-0" />
        <span className="text-body-sm font-semibold text-foreground flex-1 text-left">{title}</span>
        {badge && <span className="mr-1">{badge}</span>}
        {open
          ? <ChevronDown className="w-3.5 h-3.5 text-foreground-tertiary flex-shrink-0" />
          : <ChevronRight className="w-3.5 h-3.5 text-foreground-tertiary flex-shrink-0" />
        }
      </button>
      {open && (
        <div className="px-5 pb-5 pt-1">
          {children}
        </div>
      )}
    </div>
  )
}

// ─── Inline Row ──────────────────────────────────────────────────────────────

function SettingRow({
  label,
  enabled,
  onToggle,
  disabled,
  children,
  badge,
}: {
  label: string
  enabled: boolean
  onToggle: (v: boolean) => void
  disabled?: boolean
  children?: React.ReactNode
  badge?: React.ReactNode
}) {
  return (
    <div className={cn(
      'flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors',
      enabled ? 'bg-secondary/40' : 'bg-transparent'
    )}>
      <Switch
        checked={enabled}
        onCheckedChange={onToggle}
        disabled={disabled}
        className="flex-shrink-0 scale-90"
      />
      <div className="flex-1 min-w-0 flex items-center justify-between gap-2">
        <span className={cn(
          'text-caption font-medium truncate',
          enabled ? 'text-foreground' : 'text-foreground-tertiary'
        )}>
          {label}
        </span>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {badge}
          {children}
        </div>
      </div>
    </div>
  )
}

// ─── Compact Input ───────────────────────────────────────────────────────────

function CompactInput({
  value,
  onChange,
  disabled,
  prefix,
  suffix,
  step,
  width = 'w-16',
  placeholder,
}: {
  value: number | string
  onChange: (v: string) => void
  disabled?: boolean
  prefix?: string
  suffix?: string
  step?: number
  width?: string
  placeholder?: string
}) {
  return (
    <div className="flex items-center gap-1">
      {prefix && <span className="text-caption-sm text-foreground-tertiary">{prefix}</span>}
      <Input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className={cn('h-7 text-caption px-2 text-right tabular-nums', width)}
        step={step}
      />
      {suffix && <span className="text-caption-sm text-foreground-tertiary min-w-[2ch]">{suffix}</span>}
    </div>
  )
}

// ─── Settings Panel ──────────────────────────────────────────────────────────

interface SettingsPanelProps {
  settingsHook: UseReportSettingsReturn
  recalcData: RecalcResult | null
}

export function SettingsPanel({ settingsHook, recalcData }: SettingsPanelProps) {
  const {
    settings,
    loading,
    updateFilter,
    updateAdjustment,
    updateDealParams,
    selectRehabLevel,
    updateRehabTableEntry,
    updateMajorItem,
    updateProximityAdjustments,
    resetToDefaults,
  } = settingsHook

  const activeTier = recalcData?.valuation.arvTier ?? settingsHook.settings.tierRanges?.[0]?.key ?? 'under501k'
  const enabledMajorItems = settings.majorItems.filter((item) => item.enabled)
  const majorItemsTotal = enabledMajorItems.reduce((sum, item) => sum + item.cost, 0)

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <div className="flex items-center gap-2 text-body-sm text-foreground-tertiary">
          <div className="w-4 h-4 border-2 border-foreground-tertiary/30 border-t-foreground-tertiary rounded-full animate-spin" />
          Loading settings...
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Quick Stats Bar */}
      {recalcData && (
        <div className="px-5 py-3 border-b border-border bg-secondary/20">
          <div className="grid grid-cols-3 gap-3">
            <div className="text-center">
              <div className="text-caption-sm text-foreground-tertiary">ARV</div>
              <div className="text-caption font-bold text-primary tabular-nums">{fmt(recalcData.valuation.arv)}</div>
            </div>
            <div className="text-center">
              <div className="text-caption-sm text-foreground-tertiary">Max Buy Price</div>
              <div className="text-caption font-bold tabular-nums">{fmt(recalcData.valuation.buyPrice)}</div>
            </div>
            <div className="text-center">
              <div className="text-caption-sm text-foreground-tertiary">Profit</div>
              <div className={cn(
                'text-caption font-bold tabular-nums',
                recalcData.valuation.projectedProfit > 0 ? 'text-emerald-600' : 'text-red-600'
              )}>
                {fmt(recalcData.valuation.projectedProfit)}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Scrollable Content */}
      <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-border/30">

        {/* ── Appraisal Rules (Filters + Adjustments) ────────────────────── */}
        <Section icon={Scale} title="Appraisal Rules" defaultOpen={false}>
          {/* Filters sub-group */}
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <Filter className="w-3 h-3 text-foreground-tertiary" />
              <span className="text-caption-sm font-semibold text-foreground-tertiary uppercase tracking-wider">Filters</span>
            </div>
            <div className="space-y-1">
              {settings.filters.map((filter) => {
                const meta = FILTER_LABELS[filter.type] || { label: filter.type, unit: '', hint: '' }
                const isSubdivision = filter.type === 'subdivision_match' || filter.type === 'building_style_match'

                return (
                  <SettingRow
                    key={filter.type}
                    label={meta.label}
                    enabled={filter.enabled}
                    onToggle={(checked) => updateFilter(filter.type, { enabled: checked })}
                  >
                    {!isSubdivision && (
                      <CompactInput
                        value={filter.value}
                        onChange={(v) => updateFilter(filter.type, { value: parseFloat(v) || 0 })}
                        disabled={!filter.enabled}
                        suffix={meta.unit}
                        step={filter.type === 'distance' ? 0.1 : filter.type === 'sqft_diff' ? 5 : 1}
                      />
                    )}
                  </SettingRow>
                )
              })}
            </div>
          </div>

          {/* Adjustments sub-group */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Sliders className="w-3 h-3 text-foreground-tertiary" />
              <span className="text-caption-sm font-semibold text-foreground-tertiary uppercase tracking-wider">Adjustments</span>
            </div>
            <div className="space-y-1">
              {settings.adjustments.map((adj) => {
                const meta = ADJUSTMENT_LABELS[adj.type] || { label: adj.type }

                return (
                  <SettingRow
                    key={adj.type}
                    label={meta.label}
                    enabled={adj.enabled}
                    onToggle={(checked) => updateAdjustment(adj.type, { enabled: checked })}
                    disabled={meta.unavailable}
                    badge={meta.unavailable ? (
                      <Badge variant="outline" className="text-[10px] leading-none px-1.5 py-0.5 bg-amber-500/10 text-amber-600 border-amber-500/20 font-normal">
                        N/A
                      </Badge>
                    ) : undefined}
                  >
                    {!meta.unavailable && (
                      meta.isPercentage ? (
                        <CompactInput
                          value={adj.percent ?? 15}
                          onChange={(v) => updateAdjustment(adj.type, { percent: parseFloat(v) || 0 })}
                          disabled={!adj.enabled}
                          suffix="%"
                          step={1}
                        />
                      ) : (
                        <CompactInput
                          value={adj.amount}
                          onChange={(v) => updateAdjustment(adj.type, { amount: parseFloat(v) || 0 })}
                          disabled={!adj.enabled}
                          prefix="$"
                          step={1000}
                          width="w-20"
                        />
                      )
                    )}
                  </SettingRow>
                )
              })}
            </div>
          </div>
        </Section>

        {/* ── Thresholds ───────────────────────────────────────────────── */}
        <Section icon={Sliders} title="Thresholds" defaultOpen={false}>
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-lg bg-secondary/30 px-3 py-2.5">
              <div>
                <span className="text-caption font-medium text-foreground">As-Is Threshold</span>
                <div className="text-[10px] text-foreground-tertiary">Comps below this % of ARV = as-is</div>
              </div>
              <CompactInput
                value={settings.dealParams.asIsThresholdPercent ?? 70}
                onChange={(v) => updateDealParams({ asIsThresholdPercent: parseFloat(v) || 70 })}
                suffix="%"
                step={5}
              />
            </div>
            <div className="text-[10px] text-foreground-tertiary px-1">
              ARV threshold is configured in <span className="font-medium text-foreground-secondary">Evaluation Settings</span> page.
            </div>
          </div>
        </Section>

        {/* ── Deal Parameters ─────────────────────────────────────────── */}
        <Section icon={DollarSign} title="Deal Parameters" defaultOpen={false}>
          <div className="space-y-3">
            <div className="flex items-center justify-between rounded-lg bg-secondary/30 px-3 py-2.5">
              <span className="text-caption font-medium text-foreground">Closing Costs</span>
              <CompactInput
                value={settings.dealParams.closingCostsPercent}
                onChange={(v) => updateDealParams({ closingCostsPercent: parseFloat(v) || 0 })}
                suffix="%"
                step={0.5}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg bg-secondary/30 px-3 py-2.5">
              <span className="text-caption font-medium text-foreground">Carrying Costs</span>
              <CompactInput
                value={settings.dealParams.carryingCostsPercent}
                onChange={(v) => updateDealParams({ carryingCostsPercent: parseFloat(v) || 0 })}
                suffix="%"
                step={0.5}
              />
            </div>
            <div className="flex items-center justify-between rounded-lg bg-secondary/30 px-3 py-2.5">
              <span className="text-caption font-medium text-foreground">Wholesale Fee</span>
              <CompactInput
                value={settings.dealParams.wholesaleFee}
                onChange={(v) => updateDealParams({ wholesaleFee: parseFloat(v) || 0 })}
                prefix="$"
                step={1000}
                width="w-24"
              />
            </div>
          </div>
        </Section>

        {/* ── Proximity Adjustment ──────────────────────────────────── */}
        <Section
          icon={Navigation}
          title="Proximity Adjustment"
          defaultOpen={false}
          badge={
            recalcData && recalcData.valuation.proximityDeduction > 0
              ? <Badge variant="outline" className="text-[10px] leading-none px-1.5 py-0.5 font-normal text-red-500 border-red-500/30">
                  −{fmt(recalcData.valuation.proximityDeduction)}
                </Badge>
              : undefined
          }
        >
          <div className="space-y-2">
            <div className="text-[10px] text-foreground-tertiary mb-2">
              Apply a deduction if the property is near traffic or commercial areas.
            </div>
            {(['siding', 'backing', 'fronting'] as const).map((pos) => {
              const label = pos === 'siding' ? 'Siding (beside)' : pos === 'backing' ? 'Backing (behind)' : 'Fronting (in front)'
              const isEnabled = settings.proximityAdjustments?.[pos] ?? false
              const config = settings.proximityConfig
              const arv = recalcData?.valuation.arv ?? 0
              const deduction = config
                ? (arv >= config.arvThreshold ? Math.round(arv * config[pos].percent / 100) : config[pos].flat)
                : 0
              return (
                <div key={pos} className="flex items-center justify-between rounded-lg bg-secondary/30 px-3 py-2.5">
                  <div>
                    <span className="text-caption font-medium text-foreground">{label}</span>
                    {isEnabled && deduction > 0 && (
                      <div className="text-[10px] text-red-500 tabular-nums">−${deduction.toLocaleString()}</div>
                    )}
                  </div>
                  <Switch
                    checked={isEnabled}
                    onCheckedChange={(checked) => {
                      const current = settings.proximityAdjustments ?? { siding: false, backing: false, fronting: false }
                      updateProximityAdjustments({ ...current, [pos]: checked })
                    }}
                  />
                </div>
              )
            })}
          </div>
        </Section>

        {/* ── Renovation Levels ─────────────────────────────────────── */}
        <Section
          icon={Hammer}
          title="Renovation Levels"
          badge={
            <Badge variant="outline" className="text-[10px] leading-none px-1.5 py-0.5 font-normal">
              {getTierLabel(activeTier, settings.tierRanges)}
            </Badge>
          }
          defaultOpen={false}
        >
          <p className="text-caption-sm text-foreground-tertiary mb-3">
            Select a rehab level and customize $/sqft and min profit.
          </p>
          <div className="space-y-1.5">
            {(settings.rehabTable[activeTier] ?? []).map((entry, index) => {
              const isSelected = settings.rehabLevelIndex === index
              return (
                <div
                  key={index}
                  className={cn(
                    'rounded-lg px-3 py-2.5 transition-all',
                    isSelected
                      ? 'bg-primary/8 ring-1 ring-primary/25'
                      : 'bg-secondary/20 hover:bg-secondary/40'
                  )}
                >
                  <button
                    type="button"
                    onClick={() => selectRehabLevel(index)}
                    className="flex items-center gap-2 mb-2 w-full cursor-pointer"
                  >
                    <div className={cn(
                      'w-1.5 h-1.5 rounded-full transition-colors',
                      isSelected ? 'bg-primary' : 'bg-foreground-tertiary/30'
                    )} />
                    <span className={cn('text-caption font-medium', isSelected && 'text-primary')}>
                      {LEVEL_NAMES[index]}
                    </span>
                  </button>
                  <div className="flex items-center gap-4 ml-5">
                    <CompactInput
                      value={entry.perSqft}
                      onChange={(v) => updateRehabTableEntry(activeTier, index, { perSqft: parseFloat(v) || 0 })}
                      prefix="$"
                      suffix="/sqft"
                      step={5}
                    />
                    <CompactInput
                      value={entry.minProfit}
                      onChange={(v) => updateRehabTableEntry(activeTier, index, { minProfit: parseFloat(v) || 0 })}
                      prefix="Min $"
                      step={5000}
                      width="w-20"
                    />
                  </div>
                </div>
              )
            })}
          </div>

          {/* Major Repair Items (inline) */}
          <div className="mt-4 pt-4 border-t border-border/50">
            <div className="flex items-center gap-2 mb-2">
              <Package className="w-3 h-3 text-foreground-tertiary" />
              <span className="text-caption-sm font-semibold text-foreground-tertiary uppercase tracking-wider">Major Items</span>
              {majorItemsTotal > 0 && (
                <Badge variant="outline" className="text-[10px] leading-none px-1.5 py-0.5 bg-emerald-500/10 text-emerald-600 border-emerald-500/20 font-medium tabular-nums ml-auto">
                  +{fmt(majorItemsTotal)}
                </Badge>
              )}
            </div>
            <div className="space-y-1">
              {settings.majorItems.map((item) => (
                <SettingRow
                  key={item.id}
                  label={item.name}
                  enabled={item.enabled}
                  onToggle={(checked) => updateMajorItem(item.id, { enabled: checked })}
                >
                  <CompactInput
                    value={item.cost}
                    onChange={(v) => updateMajorItem(item.id, { cost: parseFloat(v) || 0 })}
                    disabled={!item.enabled}
                    prefix="$"
                    step={500}
                    width="w-20"
                  />
                </SettingRow>
              ))}
            </div>
          </div>
        </Section>

      </div>

      {/* Footer */}
      <div className="border-t border-border p-4 bg-background/50">
        <button
          type="button"
          onClick={resetToDefaults}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-body-sm font-medium text-foreground-secondary hover:text-foreground hover:bg-secondary rounded-lg transition-colors border border-border"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          Reset to My Defaults
        </button>
      </div>
    </div>
  )
}
