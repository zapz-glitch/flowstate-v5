'use client'

import { useState } from 'react'
import { Check, X, Minus, MapPin, ExternalLink } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { subdivisionsMatch } from '@flowstate-api/shared'
import type { SubjectData, CompItem } from './shared-types'
import { AddressDisplay } from './AddressDisplay'
import { formatFilterType, formatCurrency, formatLotSize, fmtLotDelta } from './format-helpers'
import { compFeatureMatches, featureState } from './feature-match'
import { StreetViewImage } from './StreetViewImage'
import { RuleMatchDetails } from './RuleMatchDetails'
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

// ─── Stat cell ──────────────────────────────────────────────────────────────

function StatCell({ label, value, highlight }: { label: string; value: string | number | null | undefined; highlight?: 'match' | 'mismatch' }) {
  return (
    <div className="py-2 px-1.5 sm:px-2 text-center border-r border-border/50 last:border-r-0 overflow-hidden">
      <div className="text-[9px] text-foreground-tertiary truncate">{label}</div>
      <div className={cn('text-[11px] font-medium mt-0.5 tabular-nums truncate', highlight === 'match' ? 'text-emerald-500' : highlight === 'mismatch' ? 'text-red-400' : '')}>
        {value || '—'}
      </div>
    </div>
  )
}

// ─── Main Dialog ─────────────────────────────────────────────────────────────

export function CompComparisonDialog({ open, onOpenChange, subject, comp, isSelected, onToggleSelection, arv, proximityConfig }: CompComparisonDialogProps) {
  const [proximityToggles, setProximityToggles] = useState({ siding: false, backing: false, fronting: false })

  if (!comp) return null

  const filters = comp.appraisalRules?.filters ?? []
  const adjustments = comp.appraisalRules?.adjustments ?? []
  const filterStatus = (f: (typeof filters)[number]) => f.status ?? (f.passed ? 'passed' : 'failed')
  const passedCount = filters.filter((f) => filterStatus(f) === 'passed').length
  const totalFilters = filters.length

  // Per-feature verification vs subject — green/red, gray when unverifiable
  const featureMatches = compFeatureMatches(comp, subject)
  const fm = (key: Parameters<typeof featureState>[1]): 'match' | 'mismatch' | undefined => {
    const s = featureState(featureMatches, key)
    return s === 'unknown' ? undefined : s
  }

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

  // Subject comparison helpers
  const subdivMatch = subject?.subdivision && comp.subdivision
    ? subdivisionsMatch(comp.subdivision, subject.subdivision) : null
  const sqftDiff = comp.squareFeet != null && subject?.squareFeet != null
    ? comp.squareFeet - subject.squareFeet : null
  const yearDiff = comp.yearBuilt != null && subject?.yearBuilt != null
    ? comp.yearBuilt - subject.yearBuilt : null
  const lotDiff = comp.lotSizeAcres != null && subject?.lotSizeAcres != null
    ? fmtLotDelta(comp.lotSizeAcres, subject.lotSizeAcres) : null

  // External links
  const streetViewUrl = comp.latitude && comp.longitude
    ? `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${comp.latitude},${comp.longitude}`
    : comp.address
      ? `https://www.google.com/maps/search/${encodeURIComponent(comp.address)}/@?entry=ttu&layer=c`
      : null

  const zillowUrl = comp.zillowUrl || (comp.address
    ? `https://www.zillow.com/homes/${encodeURIComponent(comp.address + (comp.city ? ` ${comp.city}` : '') + (comp.state ? ` ${comp.state}` : ''))}_rb/`
    : null)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] max-w-lg max-h-[90vh] overflow-y-auto p-0 gap-0">
        {/* Header */}
        <DialogHeader className="px-4 sm:px-5 pt-4 sm:pt-5 pb-3 border-b border-border">
          <div className="flex items-center justify-between pr-6">
            <DialogTitle className="text-sm sm:text-base font-semibold">Comparable Details</DialogTitle>
            <div className="flex items-center gap-2">
              {totalFilters > 0 && (
                <Badge
                  variant="outline"
                  className={`text-[10px] ${passedCount === totalFilters ? 'border-emerald-500/30 text-emerald-500' : 'border-amber-500/30 text-amber-500'}`}
                >
                  {passedCount}/{totalFilters} filters
                </Badge>
              )}
              {comp.compGroup && (
                <Badge variant="outline" className={`text-[10px] ${comp.compGroup === 'arv' ? 'border-emerald-500/30 text-emerald-500' : 'border-amber-500/30 text-amber-500'}`}>
                  {comp.compGroup === 'arv' ? 'ARV' : 'As-Is'}
                </Badge>
              )}
            </div>
          </div>
          <RuleMatchDetails comp={comp} />
        </DialogHeader>

        <div className="space-y-0">
          {/* ── Comp card header ── */}
          <div className="px-4 py-3 border-b border-border">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Badge variant="outline" className={`text-caption-sm font-normal p-1 ${isSelected !== false ? 'border-emerald-500/30 text-emerald-500' : 'border-border text-foreground-tertiary'}`}>
                  <MapPin className="w-3 h-3" />
                </Badge>
                {isSelected !== false ? (
                  <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-emerald-500/30 text-emerald-500">Selected</Badge>
                ) : (
                  <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-red-500/30 text-red-500">Excluded</Badge>
                )}
              </div>
              {onToggleSelection && (
                <button
                  type="button"
                  onClick={event => { event.stopPropagation(); onToggleSelection() }}
                  title={isSelected ? 'Remove from ARV' : 'Add to ARV'}
                  aria-label={comp.selectionPending ? 'Updating ARV selection' : isSelected ? 'Remove from ARV' : 'Add to ARV'}
                  aria-pressed={isSelected}
                  disabled={comp.selectionPending}
                  className={`w-6 h-6 rounded border-2 flex items-center justify-center flex-shrink-0 transition-all ${
                    isSelected
                      ? 'bg-emerald-500 border-emerald-500 text-white'
                      : 'border-foreground/25 bg-foreground/8 text-foreground/30 hover:border-emerald-500'
                  }`}
                >
                  <Check className="w-3 h-3" />
                </button>
              )}
            </div>
            <div className="mt-1.5">
              {comp.address ? (
                <AddressDisplay address={comp.address} latitude={comp.latitude} longitude={comp.longitude} className="text-xs sm:text-sm font-semibold" showStreetView={false} />
              ) : (
                <span className="text-xs sm:text-sm font-semibold">Unknown Address</span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              {streetViewUrl && (
                <a href={streetViewUrl} target="_blank" rel="noopener noreferrer"
                  className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500 hover:bg-blue-500/20 transition-colors inline-flex items-center gap-1">
                  Street View <ExternalLink className="w-2.5 h-2.5" />
                </a>
              )}
              {zillowUrl && (
                <a href={zillowUrl} target="_blank" rel="noopener noreferrer"
                  className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-secondary text-foreground-secondary hover:bg-accent transition-colors inline-flex items-center gap-1">
                  Zillow <ExternalLink className="w-2.5 h-2.5" />
                </a>
              )}
              {comp.distanceMiles != null && (
                <span className="text-[10px] text-foreground-tertiary">{comp.distanceMiles.toFixed(2)} mi</span>
              )}
              {comp.subdivision && (
                <span className={`inline-flex items-center gap-0.5 text-[10px] ${subdivMatch === true ? 'text-emerald-500' : subdivMatch === false ? 'text-red-400' : 'text-foreground-tertiary'}`}>
                  {subdivMatch === true ? <Check className="w-2.5 h-2.5" /> : subdivMatch === false ? <X className="w-2.5 h-2.5" /> : null}
                  {comp.subdivision}
                </span>
              )}
            </div>
          </div>

          {/* ── Street view image ── */}
          <div className="relative h-40 bg-muted/30 overflow-hidden">
            <StreetViewImage
              address={comp.address}
              latitude={comp.latitude}
              longitude={comp.longitude}
              width={640}
              height={300}
              className="w-full h-full object-cover"
            />
            <div className="absolute bottom-0 left-0 right-0 px-3 py-2 bg-gradient-to-t from-black/70 to-transparent flex items-end justify-between">
              <div>
                <span className="text-base font-bold text-white tabular-nums">${comp.salePrice?.toLocaleString() || '-'}</span>
                {(comp.adjustedPrice != null && comp.adjustedPrice !== comp.salePrice || proximityDeduction > 0) && (
                  <span className="ml-2 text-[11px] text-emerald-400 font-medium">Adj: ${finalPrice.toLocaleString()}</span>
                )}
              </div>
              <span className="text-[10px] text-white/80 font-medium">
                {comp.pricePerSqft ? `$${comp.pricePerSqft.toFixed(0)}/sf` : ''}
                {comp.pricePerSqft && comp.saleDate ? ' · ' : ''}
                {comp.saleDate ? new Date(comp.saleDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''}
              </span>
            </div>
          </div>

          {/* ── Property Details (grid layout) ── */}
          <div className="border-b border-border">
            <div className="grid grid-cols-4 bg-muted/40 border-b border-border/30">
              <StatCell label="Beds" value={comp.bedrooms ?? '-'} highlight={fm('beds')} />
              <StatCell label="Baths" value={comp.bathrooms ?? '-'} highlight={fm('baths')} />
              <StatCell
                label="Sq Ft"
                value={`${fmt(comp.squareFeet)}${sqftDiff != null ? ` (${sqftDiff > 0 ? '+' : ''}${sqftDiff.toLocaleString()})` : ''}`}
                highlight={sqftDiff != null ? (Math.abs(sqftDiff) <= 300 ? 'match' : 'mismatch') : undefined}
              />
              <StatCell
                label="Year"
                value={`${comp.yearBuilt ?? '-'}${yearDiff != null ? ` (${yearDiff > 0 ? '+' : ''}${yearDiff})` : ''}`}
                highlight={yearDiff != null ? (Math.abs(yearDiff) <= 10 ? 'match' : 'mismatch') : undefined}
              />
            </div>
            <div className="grid grid-cols-3 bg-muted/40 border-b border-border/30">
              <StatCell label="Lot" value={`${formatLotSize(comp.lotSizeAcres)}${lotDiff ? ` (${lotDiff})` : ''}`} highlight={fm('lot')} />
              <StatCell label="Style" value={comp.buildingStyle || '-'} highlight={fm('style')} />
              <StatCell label="Foundation" value={comp.foundationType || '-'} highlight={fm('foundation')} />
            </div>
            <div className="grid grid-cols-3 bg-muted/40 border-b border-border/30">
              <StatCell label="Construction" value={comp.constructionType || '-'} highlight={fm('construction')} />
              <StatCell label="Roof" value={comp.roofCover || comp.roofType || '-'} highlight={fm('roof')} />
              <StatCell label="Ext. Walls" value={comp.exteriorWalls || '-'} highlight={fm('construction')} />
            </div>
            <div className="grid grid-cols-4 bg-muted/40 border-b border-border/30">
              <StatCell label="Pool" value={comp.pool ? 'Yes' : '-'} highlight={fm('pool')} />
              <StatCell label="Garage" value={comp.garage ? (comp.garageSquareFeet ? `${comp.garageSquareFeet} sf` : 'Yes') : '-'} highlight={fm('garage')} />
              <StatCell label="Carport" value={comp.carport ? 'Yes' : '-'} highlight={fm('garage')} />
              <StatCell label="Stories" value={comp.storiesType || (comp.stories != null ? String(comp.stories) : '-')} highlight={fm('stories')} />
            </div>
            <div className="grid grid-cols-3 bg-muted/40">
              <StatCell label="Heat / AC" value={[comp.heating, comp.cooling].filter(Boolean).join(' / ') || '-'} highlight={fm('hvac')} />
              <StatCell label="Assessor Cond." value={comp.buildingCondition || '-'} highlight={fm('condition')} />
              <StatCell
                label="Condition"
                value={
                  comp.curbAppeal && comp.curbAppeal.condition !== 'unknown'
                    ? comp.curbAppeal.condition === 'renovated' ? 'Renovated' : comp.curbAppeal.condition === 'dated' ? 'Dated' : 'Distressed'
                    : '-'
                }
                highlight={
                  comp.curbAppeal && comp.curbAppeal.condition !== 'unknown'
                    ? comp.curbAppeal.condition === 'renovated' ? 'match' : 'mismatch'
                    : undefined
                }
              />
            </div>
          </div>

          {/* ── AI Analysis (if available) ── */}
          {(comp.selectionReason || comp.keyFeatures?.length) && (
            <div className="border-b border-border">
              <div className="px-3 sm:px-4 py-2 bg-muted/30 border-b border-border/50">
                <span className="text-[10px] font-semibold text-foreground uppercase tracking-wider">AI Analysis</span>
              </div>
              <div className="px-3 sm:px-4 py-2.5 space-y-1.5">
                {comp.selectionReason && (
                  <p className="text-[11px] text-foreground-secondary leading-relaxed">{comp.selectionReason}</p>
                )}
                {comp.keyFeatures && comp.keyFeatures.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {comp.keyFeatures.map((f, i) => (
                      <span key={i} className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-foreground-tertiary">{f}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Filters + Adjustments ── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-0 sm:gap-0">

            {/* Filters */}
            {filters.length > 0 && (
              <div className="border-b sm:border-b-0 sm:border-r border-border">
                <div className="px-3 sm:px-4 py-2 bg-muted/30 border-b border-border/50">
                  <span className="text-[10px] font-semibold text-foreground uppercase tracking-wider">Filters</span>
                  <span className="text-[10px] text-foreground-tertiary ml-2">{passedCount}/{totalFilters}</span>
                </div>
                <div className="divide-y divide-border/20">
                  {filters.map((f) => {
                    const status = filterStatus(f)
                    return (
                    <div
                      key={f.type}
                      className={`flex items-center justify-between px-3 sm:px-4 py-2 ${status === 'passed' ? 'border-l-2 border-l-emerald-500' : status === 'failed' ? 'border-l-2 border-l-red-500 bg-red-500/5' : 'border-l-2 border-l-border'}`}
                    >
                      <span className={`text-[11px] font-medium ${status === 'passed' ? 'text-emerald-500' : status === 'failed' ? 'text-red-500' : 'text-foreground-tertiary'}`}>
                        {formatFilterType(f.type)}
                      </span>
                      <div className="flex items-center gap-1">
                        {status === 'passed' ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : status === 'failed' ? <X className="w-3.5 h-3.5 text-red-500" /> : <Minus className="w-3.5 h-3.5 text-foreground-tertiary" />}
                        {f.actualValue != null && f.threshold != null && (
                          <span className="text-[10px] text-foreground-tertiary tabular-nums">
                            ({String(f.actualValue)}/{String(f.threshold)})
                          </span>
                        )}
                      </div>
                    </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Adjustments + Proximity */}
            <div className="border-b border-border">
              <div className="px-3 sm:px-4 py-2 bg-muted/30 border-b border-border/50">
                <span className="text-[10px] font-semibold text-foreground uppercase tracking-wider">Adjustments</span>
              </div>
              <div className="divide-y divide-border/20">
                {adjustments.filter((a) => a.applied).map((a) => (
                  <div key={a.type} className="flex items-center justify-between px-3 sm:px-4 py-2 border-l-2 border-l-blue-500">
                    <span className="text-[11px] font-medium text-foreground">{formatFilterType(a.type)}</span>
                    <span className={`text-[11px] font-semibold tabular-nums ${a.amount >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                      {a.amount >= 0 ? '+' : ''}{formatCurrency(a.amount)}
                    </span>
                  </div>
                ))}
                {/* Proximity toggles */}
                <div className="px-3 sm:px-4 py-1.5 bg-muted/20 border-t border-border">
                  <span className="text-[9px] font-semibold text-foreground-tertiary uppercase tracking-wider">Traffic / Commercial</span>
                </div>
                {(['siding', 'backing', 'fronting'] as const).map((pos) => {
                  const label = pos === 'siding' ? 'Siding (beside)' : pos === 'backing' ? 'Backing (behind)' : 'Fronting (in front)'
                  const deduction = usePercent
                    ? Math.round((arv ?? 0) * config[pos].percent / 100)
                    : config[pos].flat
                  return (
                    <div key={pos} className="flex items-center justify-between px-3 sm:px-4 py-2 border-l-2 border-l-amber-500">
                      <div>
                        <span className="text-[11px] font-medium text-foreground">{label}</span>
                        {proximityToggles[pos] && deduction > 0 && (
                          <div className="text-[9px] text-red-500 tabular-nums">-${deduction.toLocaleString()}</div>
                        )}
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
                  <span className="text-[11px] font-semibold text-foreground">Total</span>
                  <span className={`text-[11px] font-bold tabular-nums ${((comp.appraisalRules?.totalAdjustment ?? 0) - proximityDeduction) >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                    {((comp.appraisalRules?.totalAdjustment ?? 0) - proximityDeduction) >= 0 ? '+' : ''}{formatCurrency((comp.appraisalRules?.totalAdjustment ?? 0) - proximityDeduction)}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* ── Final price summary ── */}
          {comp.salePrice != null && (
            <div className="px-3 sm:px-4 py-3 flex items-center justify-between bg-emerald-500/5 border-t border-emerald-500/20">
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
