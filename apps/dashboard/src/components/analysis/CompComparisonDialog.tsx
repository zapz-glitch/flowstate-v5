'use client'

import { useState } from 'react'
import { Check, X, MapPin } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import type { SubjectData, CompItem } from './shared-types'
import { AddressDisplay } from './AddressDisplay'
import { formatFilterType, formatCurrency } from './format-helpers'
import { StreetViewImage } from './StreetViewImage'
import type { ProximityConfig } from '@/lib/client-api'
import { PROXIMITY_DEFAULTS } from '@/lib/client-api'

interface CompComparisonDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  subject: SubjectData | null
  comp: CompItem | null
  isSelected?: boolean
  onToggleSelection?: () => void
  arv?: number | null
  proximityConfig?: ProximityConfig | null
}

// ─── Diff helper: highlight mismatches ───────────────────────────────────────

function DiffStatCell({ label, value, compareValue, compareLabel = 'subj' }: {
  label: string
  value: string | number
  compareValue: string | number
  compareLabel?: string
}) {
  const valStr = String(value || '—')
  const cmpStr = String(compareValue || '—')
  const isMatch = valStr === cmpStr
  const showHighlight = !isMatch && valStr !== '—' && cmpStr !== '—'

  return (
    <div className={`py-2 px-1.5 sm:px-2 text-center border-r border-border/50 last:border-r-0 overflow-hidden ${showHighlight ? 'bg-amber-500/5' : ''}`}>
      <div className="text-caption-sm text-foreground-tertiary truncate">{label}</div>
      <div className="text-[11px] sm:text-body-sm font-medium mt-0.5 tabular-nums truncate">{value || '—'}</div>
      {!isMatch && valStr !== '—' && cmpStr !== '—' && (
        <div className="text-[8px] sm:text-[9px] text-foreground-tertiary mt-0.5 truncate">{compareLabel}: {compareValue}</div>
      )}
    </div>
  )
}

// ─── Main Dialog ─────────────────────────────────────────────────────────────

export function CompComparisonDialog({ open, onOpenChange, subject, comp, isSelected, onToggleSelection, arv, proximityConfig }: CompComparisonDialogProps) {
  const [proximityToggles, setProximityToggles] = useState({ siding: false, backing: false, fronting: false })

  if (!subject || !comp) return null

  const filters = comp.appraisalRules?.filters ?? []
  const adjustments = comp.appraisalRules?.adjustments ?? []

  const passedCount = filters.filter((f) => f.passed).length
  const totalFilters = filters.length

  const fmt = (n: number | null | undefined) => n != null ? n.toLocaleString() : '-'

  // Proximity deduction calculation
  const config = proximityConfig ?? PROXIMITY_DEFAULTS
  const basePrice = comp.adjustedPrice ?? comp.salePrice ?? 0
  const usePercent = (arv ?? 0) >= config.arvThreshold
  let proximityDeduction = 0
  for (const pos of ['siding', 'backing', 'fronting'] as const) {
    if (!proximityToggles[pos]) continue
    proximityDeduction += usePercent
      ? Math.round((arv ?? 0) * config[pos].percent / 100)
      : config[pos].flat
  }
  const finalPrice = basePrice - proximityDeduction

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] max-w-4xl max-h-[90vh] overflow-y-auto p-0 gap-0">
        {/* Header */}
        <DialogHeader className="px-4 sm:px-5 pt-4 sm:pt-5 pb-3 border-b border-border">
          <div className="flex items-center justify-between pr-6">
            <DialogTitle className="text-sm sm:text-base font-semibold">Subject vs Comparable</DialogTitle>
            {totalFilters > 0 && (
              <Badge
                variant="outline"
                className={`text-[10px] hidden sm:flex ${passedCount === totalFilters ? 'border-emerald-500/30 text-emerald-500' : 'border-amber-500/30 text-amber-500'}`}
              >
                {passedCount}/{totalFilters} filters passed
              </Badge>
            )}
          </div>
        </DialogHeader>

        <div className="p-3 sm:p-4 space-y-3">

          {/* ── Subject + Comparable side by side ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">

            {/* ── Subject Property Card ── */}
            <div className="border border-primary/30 border-l-[3px] border-l-primary overflow-hidden rounded-none">
              <div className="px-3 sm:px-4 py-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="text-caption-sm font-normal p-1 border-primary/30 text-primary">
                    <MapPin className="w-3 h-3" />
                  </Badge>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-primary">Subject</span>
                </div>
                <div className="mt-1">
                  {subject.address ? (
                    <AddressDisplay address={subject.address} latitude={subject.latitude} longitude={subject.longitude} className="text-xs sm:text-sm font-semibold" />
                  ) : (
                    <span className="text-xs sm:text-sm font-semibold">Unknown Address</span>
                  )}
                </div>
                {subject.subdivision && (
                  <div className="text-[10px] text-foreground-tertiary mt-1">
                    <span className="text-foreground-tertiary/60">Subdivision:</span> {subject.subdivision}
                  </div>
                )}
                {subject.lastSale?.price && (
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold tabular-nums">${subject.lastSale.price.toLocaleString()}</span>
                    <span className="text-[10px] text-foreground-tertiary">
                      {subject.lastSale.pricePerSqft ? `$${subject.lastSale.pricePerSqft.toFixed(0)}/sqft` : ''}
                      {subject.lastSale.pricePerSqft && subject.lastSale.date ? ' · ' : ''}
                      {subject.lastSale.date ?? ''}
                    </span>
                  </div>
                )}
              </div>
              <StreetViewImage
                address={subject.address}
                latitude={subject.latitude}
                longitude={subject.longitude}
                width={640}
                height={200}
                className="w-full h-32 object-cover border-t border-border/30"
              />
              <div className="grid grid-cols-4 bg-muted/40 border-t border-border/30">
                <DiffStatCell label="Beds" value={subject.bedrooms ?? '-'} compareValue={comp.bedrooms ?? '-'} compareLabel="comp" />
                <DiffStatCell label="Baths" value={subject.bathrooms ?? '-'} compareValue={comp.bathrooms ?? '-'} compareLabel="comp" />
                <DiffStatCell label="Sq Ft" value={fmt(subject.squareFeet)} compareValue={fmt(comp.squareFeet)} compareLabel="comp" />
                <DiffStatCell label="Year" value={subject.yearBuilt || '-'} compareValue={comp.yearBuilt || '-'} compareLabel="comp" />
              </div>
              <div className="grid grid-cols-3 bg-muted/40 border-t border-border/30">
                <DiffStatCell label="Lot" value={subject.lotSizeAcres ? `${Number(subject.lotSizeAcres).toFixed(2)} ac` : '-'} compareValue={comp.lotSizeAcres ? `${Number(comp.lotSizeAcres).toFixed(2)} ac` : '-'} compareLabel="comp" />
                <DiffStatCell label="Foundation" value={subject.foundationType || '-'} compareValue={comp.foundationType || '-'} compareLabel="comp" />
                <DiffStatCell label="Style" value={subject.buildingStyle || '-'} compareValue={comp.buildingStyle || '-'} compareLabel="comp" />
              </div>
            </div>

            {/* ── Comparable Property Card ── */}
            <div className={`border overflow-hidden rounded-none ${isSelected !== false ? 'border-emerald-500/30 border-l-[3px] border-l-emerald-500' : 'border-border border-l-[3px] border-l-foreground-tertiary/30 opacity-80'}`}>
              <div className="px-3 sm:px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 flex-wrap min-w-0">
                    <Badge variant="outline" className={`text-caption-sm font-normal p-1 ${isSelected !== false ? 'border-emerald-500/30 text-emerald-500' : 'border-border text-foreground-tertiary'}`}>
                      <MapPin className="w-3 h-3" />
                    </Badge>
                    <span className={`text-[10px] font-bold uppercase tracking-wider ${isSelected !== false ? 'text-emerald-600' : 'text-foreground-tertiary'}`}>Comparable</span>
                    {isSelected !== false ? (
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-emerald-500/30 text-emerald-500">Selected</Badge>
                    ) : (
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-red-500/30 text-red-500">Excluded</Badge>
                    )}
                  </div>
                  {onToggleSelection && (
                    <button
                      type="button"
                      onClick={onToggleSelection}
                      title={isSelected ? 'Remove from ARV' : 'Add to ARV'}
                      className={`w-6 h-6 sm:w-5 sm:h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-all ${
                        isSelected
                          ? 'bg-emerald-500 border-emerald-500 text-white'
                          : 'border-foreground/25 bg-foreground/8 text-foreground/30 hover:border-emerald-500'
                      }`}
                    >
                      <Check className="w-3 h-3" />
                    </button>
                  )}
                </div>
                <div className="mt-1">
                  {comp.address ? (
                    <AddressDisplay address={comp.address} latitude={comp.latitude} longitude={comp.longitude} className="text-xs sm:text-sm font-semibold" />
                  ) : (
                    <span className="text-xs sm:text-sm font-semibold">Unknown Address</span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-1 text-[10px] text-foreground-tertiary flex-wrap">
                  {comp.distanceMiles != null && <span>{comp.distanceMiles.toFixed(2)} mi from subject</span>}
                  {comp.subdivision && <><span className="text-border">·</span><span>{comp.subdivision}</span></>}
                </div>
                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-bold tabular-nums">${comp.salePrice?.toLocaleString() || '-'}</span>
                  <span className="text-[10px] text-foreground-tertiary">
                    {comp.pricePerSqft ? `$${comp.pricePerSqft.toFixed(0)}/sqft` : ''}
                    {comp.pricePerSqft && comp.saleDate ? ' · ' : ''}
                    {comp.saleDate ? new Date(comp.saleDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : ''}
                  </span>
                  {(comp.adjustedPrice != null && comp.adjustedPrice !== comp.salePrice || proximityDeduction > 0) && (
                    <span className="text-[10px] text-emerald-600 font-medium">Adj: ${finalPrice.toLocaleString()}</span>
                  )}
                </div>
              </div>
              <StreetViewImage
                address={comp.address}
                latitude={comp.latitude}
                longitude={comp.longitude}
                width={640}
                height={200}
                className="w-full h-32 object-cover border-t border-border/30"
              />
              <div className="grid grid-cols-4 bg-muted/40 border-t border-border/30">
                <DiffStatCell label="Beds" value={comp.bedrooms ?? '-'} compareValue={subject.bedrooms ?? '-'} />
                <DiffStatCell label="Baths" value={comp.bathrooms ?? '-'} compareValue={subject.bathrooms ?? '-'} />
                <DiffStatCell label="Sq Ft" value={fmt(comp.squareFeet)} compareValue={fmt(subject.squareFeet)} />
                <DiffStatCell label="Year" value={comp.yearBuilt || '-'} compareValue={subject.yearBuilt || '-'} />
              </div>
              <div className="grid grid-cols-3 bg-muted/40 border-t border-border/30">
                <DiffStatCell label="Lot" value={comp.lotSizeAcres ? `${Number(comp.lotSizeAcres).toFixed(2)} ac` : '-'} compareValue={subject.lotSizeAcres ? `${Number(subject.lotSizeAcres).toFixed(2)} ac` : '-'} />
                <DiffStatCell label="Foundation" value={comp.foundationType || '-'} compareValue={subject.foundationType || '-'} />
                <DiffStatCell label="Style" value={comp.buildingStyle || '-'} compareValue={subject.buildingStyle || '-'} />
              </div>
            </div>

          </div>

          {/* ── Filters + Adjustments — side by side on desktop, stacked on mobile ── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">

            {/* Filters Applied */}
            {filters.length > 0 && (
              <div className="border border-border overflow-hidden rounded-none">
                <div className="px-3 sm:px-4 py-2 bg-muted/30 border-b border-border">
                  <span className="text-[10px] font-semibold text-foreground uppercase tracking-wider">Filters</span>
                  {/* Mobile filter count */}
                  <span className="sm:hidden text-[10px] text-foreground-tertiary ml-2">
                    {passedCount}/{totalFilters} passed
                  </span>
                </div>
                <div className="divide-y divide-border/20">
                  {filters.map((f) => (
                    <div
                      key={f.type}
                      className={`flex items-center justify-between px-3 sm:px-4 py-2 ${f.passed ? 'border-l-2 border-l-emerald-500' : 'border-l-2 border-l-red-500 bg-red-500/5'}`}
                    >
                      <span className={`text-[11px] sm:text-xs font-medium ${f.passed ? 'text-emerald-500' : 'text-red-500'}`}>
                        {formatFilterType(f.type)}
                      </span>
                      <div className="flex items-center gap-1">
                        {f.passed ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <X className="w-3.5 h-3.5 text-red-500" />}
                        {f.actualValue != null && f.threshold != null && (
                          <span className="text-[9px] sm:text-[10px] text-foreground-tertiary tabular-nums hidden sm:inline">
                            ({String(f.actualValue)}/{String(f.threshold)})
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Price Adjustments + Proximity */}
              <div className="border border-border overflow-hidden rounded-none">
                <div className="px-3 sm:px-4 py-2 bg-muted/30 border-b border-border">
                  <span className="text-[10px] font-semibold text-foreground uppercase tracking-wider">Adjustments</span>
                </div>
                <div className="divide-y divide-border/20">
                  {adjustments.filter((a) => a.applied).map((a) => (
                    <div key={a.type} className="flex items-center justify-between px-3 sm:px-4 py-2 border-l-2 border-l-blue-500">
                      <span className="text-[11px] sm:text-xs font-medium text-foreground">{formatFilterType(a.type)}</span>
                      <span className={`text-[11px] sm:text-xs font-semibold tabular-nums ${a.amount >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                        {a.amount >= 0 ? '+' : ''}{formatCurrency(a.amount)}
                      </span>
                    </div>
                  ))}
                  {/* Proximity — Traffic / Commercial */}
                  <div className="px-3 sm:px-4 py-1.5 bg-muted/20 border-t border-border">
                    <span className="text-[9px] font-semibold text-foreground-tertiary uppercase tracking-wider">Traffic / Commercial (what-if)</span>
                  </div>
                  {(['siding', 'backing', 'fronting'] as const).map((pos) => {
                    const label = pos === 'siding' ? 'Siding (beside)' : pos === 'backing' ? 'Backing (behind)' : 'Fronting (in front)'
                    const deduction = usePercent
                      ? Math.round((arv ?? 0) * config[pos].percent / 100)
                      : config[pos].flat
                    return (
                      <div key={pos} className="flex items-center justify-between px-3 sm:px-4 py-2 border-l-2 border-l-amber-500">
                        <div>
                          <div>
                            <span className="text-[11px] sm:text-xs font-medium text-foreground">{label}</span>
                            {proximityToggles[pos] && deduction > 0 && (
                              <div className="text-[9px] text-red-500 tabular-nums">−${deduction.toLocaleString()}</div>
                            )}
                          </div>
                        </div>
                        <Switch
                          checked={proximityToggles[pos]}
                          onCheckedChange={(checked) => setProximityToggles((prev) => ({ ...prev, [pos]: checked }))}
                        />
                      </div>
                    )
                  })}
                </div>
                {(comp.appraisalRules?.totalAdjustment != null || proximityDeduction > 0) && (
                  <div className="flex items-center justify-between px-3 sm:px-4 py-2 border-t border-border bg-muted/20">
                    <span className="text-[11px] sm:text-xs font-semibold text-foreground">Total</span>
                    <span className={`text-[11px] sm:text-xs font-bold tabular-nums ${((comp.appraisalRules?.totalAdjustment ?? 0) - proximityDeduction) >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                      {((comp.appraisalRules?.totalAdjustment ?? 0) - proximityDeduction) >= 0 ? '+' : ''}{formatCurrency((comp.appraisalRules?.totalAdjustment ?? 0) - proximityDeduction)}
                    </span>
                  </div>
                )}
              </div>
          </div>

          {/* ── Final price summary ── */}
          {comp.salePrice != null && (
            <div className="rounded-none border border-emerald-500/20 bg-emerald-500/5 px-3 sm:px-4 py-3 flex items-center justify-between">
              <div>
                <div className="text-[10px] text-foreground-tertiary uppercase tracking-wider">
                  {proximityDeduction > 0 ? 'Final Price' : 'Adjusted Price'}
                </div>
                <div className="text-sm font-bold text-emerald-600 tabular-nums">
                  ${proximityDeduction > 0 ? finalPrice.toLocaleString() : (comp.adjustedPrice ?? comp.salePrice).toLocaleString()}
                </div>
              </div>
              <div className="text-right space-y-0.5">
                {comp.adjustedPrice != null && comp.adjustedPrice !== comp.salePrice && (
                  <div>
                    <div className="text-[9px] text-foreground-tertiary">Appraisal Adj</div>
                    <div className="text-[11px] text-foreground-secondary tabular-nums">${comp.adjustedPrice.toLocaleString()}</div>
                  </div>
                )}
                <div>
                  <div className="text-[9px] text-foreground-tertiary">Original</div>
                  <div className="text-[11px] text-foreground-secondary tabular-nums">${comp.salePrice.toLocaleString()}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
