'use client'

import { useState, type ReactNode } from 'react'
import { Check, X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { SubjectData, CompItem } from './shared-types'
import { AddressDisplay } from './AddressDisplay'
import {
  MATCH_TEXT,
  MISMATCH_TEXT,
  conditionLabel,
  conflictNote,
  fmtDeltaWords,
  fmtRuleValue,
  formatCurrency,
  formatFilterType,
  formatLotSize,
  formatShortDate,
  lotMatchColor,
  priceClassLabel,
  scopeLabel,
  scopeToneClass,
  sqftMatchColor,
  streetViewHref,
  titleCaseWords,
  trustLabel,
  trustTitle,
  widenedRules,
  widenedTitle,
  yearMatchColor,
} from './format-helpers'
import { compFeatureMatches, featureState } from './feature-match'
import { StreetViewImage } from './StreetViewImage'
import { RuleMatchDetails } from './RuleMatchDetails'
import type { ProximityConfig } from '@/lib/client-api'
import { PROXIMITY_DEFAULTS } from '@/lib/client-api'
import type { ProximityToggles } from '@/lib/recalc/types'

interface CompComparisonDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  subject: SubjectData | null
  comp: CompItem | null
  isSelected?: boolean
  onToggleSelection?: () => void
  arv?: number | null
  proximityConfig?: ProximityConfig | null
  /** Controlled proximity toggles — when provided with onProximityChange, switches drive the report's proximity deduction (updates ARV) */
  proximityToggles?: ProximityToggles | null
  onProximityChange?: (toggles: ProximityToggles) => void
}

// ─── Fact cell ──────────────────────────────────────────────────────────────

function StatCell({ label, value, sub, subClass, highlight, title, capitalize }: {
  label: string
  value: string | number | null | undefined
  /** Difference from the subject · its own line so it never truncates */
  sub?: string | null
  subClass?: string | null
  highlight?: 'match' | 'mismatch'
  title?: string
  /** Word values ("ranch") read as "Ranch" · never set on numbers with units ("9,540 sf") */
  capitalize?: boolean
}) {
  // Unpopulated fields say nothing · hide rather than render a dash. Zero is a value.
  if (value == null || value === '' || value === '-') return null
  return (
    <div
      className="py-2 px-1.5 sm:px-2 text-center border-r border-b border-border/50 [&:nth-child(4n)]:border-r-0 min-w-0"
      title={title}
    >
      <div className="text-[11px] text-foreground-tertiary truncate">{label}</div>
      <div className={cn(
        'text-[12px] font-medium mt-0.5 tabular-nums break-words',
        capitalize && 'capitalize',
        highlight === 'match' ? MATCH_TEXT : highlight === 'mismatch' ? MISMATCH_TEXT : 'text-foreground',
      )}>
        {String(value)}
      </div>
      {sub && <div className={cn('text-[11px] mt-0.5 leading-tight', subClass ?? 'text-foreground-tertiary')}>{sub}</div>}
    </div>
  )
}

/** "Label value" pair · gray label, strong value (same as the comp card) */
function Pair({ label, value, title }: { label: string; value: ReactNode; title?: string }) {
  return (
    <span className="whitespace-nowrap" title={title}>
      <span className="text-foreground-tertiary">{label}</span>{' '}
      <span className="font-medium text-foreground">{value}</span>
    </span>
  )
}

// ─── Main Dialog ─────────────────────────────────────────────────────────────

export function CompComparisonDialog({ open, onOpenChange, subject, comp, isSelected, onToggleSelection, arv, proximityConfig, proximityToggles: controlledToggles, onProximityChange }: CompComparisonDialogProps) {
  const [localToggles, setLocalToggles] = useState<ProximityToggles>({ siding: false, backing: false, fronting: false })
  const proximityToggles = controlledToggles ?? localToggles
  const setProximityToggle = (pos: keyof ProximityToggles, checked: boolean) => {
    const next = { ...proximityToggles, [pos]: checked }
    if (onProximityChange) onProximityChange(next)
    else setLocalToggles(next)
  }

  if (!comp) return null

  const filters = comp.appraisalRules?.filters ?? []
  const adjustments = comp.appraisalRules?.adjustments ?? []
  // Legacy payloads carry no status — ambiguous passed:true renders unverified.
  const filterStatus = (f: (typeof filters)[number]) => f.status ?? (f.passed ? 'not_verified' : 'failed')
  // Only evaluated filters count or show · a rule that never ran says nothing about this comp.
  const evaluatedFilters = filters.filter((f) => filterStatus(f) !== 'not_verified')
  const passedCount = evaluatedFilters.filter((f) => filterStatus(f) === 'passed').length
  const failedCount = evaluatedFilters.filter((f) => filterStatus(f) === 'failed').length
  const evaluatedCount = evaluatedFilters.length
  const filterSummary = `${passedCount} passed · ${failedCount} failed`

  // Per-feature verification vs subject — green/red, neutral when unverifiable
  const featureMatches = compFeatureMatches(comp, subject)
  const fm = (key: Parameters<typeof featureState>[1]): 'match' | 'mismatch' | undefined => {
    const s = featureState(featureMatches, key)
    return s === 'unknown' ? undefined : s
  }

  const fmt = (n: number | null | undefined) => n != null ? n.toLocaleString() : '-'

  // Manual traffic deduction · shown on its own line, never folded into the
  // server's sale, adjusted or total numbers.
  const config = proximityConfig ?? PROXIMITY_DEFAULTS
  const usePercent = (arv ?? 0) >= config.arvThreshold
  const deductionFor = (pos: keyof ProximityToggles) =>
    usePercent ? Math.round((arv ?? 0) * config[pos].percent / 100) : config[pos].flat
  let proximityDeduction = 0
  for (const pos of ['siding', 'backing', 'fronting'] as const) {
    if (proximityToggles[pos]) proximityDeduction += deductionFor(pos)
  }
  const hasAdjusted = comp.adjustedPrice != null && comp.adjustedPrice !== comp.salePrice
  const afterProximity = (comp.adjustedPrice ?? comp.salePrice ?? 0) - proximityDeduction

  // Subject comparison
  const sqftDiff = comp.squareFeet != null && subject?.squareFeet != null
    ? comp.squareFeet - subject.squareFeet : null
  const yearDiff = comp.yearBuilt != null && subject?.yearBuilt != null
    ? comp.yearBuilt - subject.yearBuilt : null
  const lotDiff = comp.lotSizeAcres != null && subject?.lotSizeAcres != null
    ? (comp.lotSizeAcres - subject.lotSizeAcres) * 43560 : null

  // Same words and tones as the comp card
  const scope = scopeLabel(comp, subject, featureMatches)
  const priceClass = priceClassLabel(comp.badges?.price)
  const trust = trustLabel(comp.badges?.trust)
  const widened = widenedRules(comp.badges)
  const conflict = conflictNote(comp)
  const streetViewUrl = streetViewHref(comp)
  const saleMeta = [
    comp.pricePerSqft ? `$${comp.pricePerSqft.toFixed(0)}/sf` : null,
    comp.saleDate ? formatShortDate(comp.saleDate) : null,
  ].filter(Boolean).join(' · ')

  const photo = (
    <StreetViewImage
      address={comp.address}
      latitude={comp.latitude}
      longitude={comp.longitude}
      width={640}
      height={300}
      className="w-full h-full object-cover"
    />
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[95vw] max-w-lg max-h-[90vh] overflow-y-auto p-0 gap-0 focus:outline-none"
        // Focus lands on the dialog itself (ring suppressed), not on the first
        // small control, so no stray focus ring is drawn.
        onOpenAutoFocus={(event) => { event.preventDefault(); (event.currentTarget as HTMLElement).focus() }}
      >
        {/* Header */}
        <DialogHeader className="px-4 sm:px-5 pt-4 sm:pt-5 pb-3 border-b border-border">
          <div className="flex items-center justify-between gap-3 pr-8">
            <DialogTitle className="text-sm sm:text-base font-semibold">Comparable Details</DialogTitle>
            {evaluatedCount > 0 && (
              <Badge
                variant="outline"
                className={cn(
                  'px-2 text-[11px] font-medium tabular-nums whitespace-nowrap',
                  passedCount === evaluatedCount
                    ? 'border-emerald-500/30 text-emerald-600 dark:text-emerald-400'
                    : 'border-amber-500/30 text-amber-600 dark:text-amber-400',
                )}
              >
                {filterSummary}
              </Badge>
            )}
          </div>
          <RuleMatchDetails comp={comp} />
        </DialogHeader>

        <div className="space-y-0">
          {/* ── Comp header · address left, scope and ARV selection right ── */}
          <div className="px-4 sm:px-5 py-3 border-b border-border text-[11px]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {comp.address ? (
                  <AddressDisplay address={comp.address} latitude={comp.latitude} longitude={comp.longitude} className="text-body-sm font-semibold" showStreetView={false} />
                ) : (
                  <span className="text-body-sm font-semibold">Unknown Address</span>
                )}
                <div className="flex flex-wrap items-center gap-x-2 mt-1 text-foreground-tertiary">
                  {streetViewUrl && (
                    <a
                      href={streetViewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-foreground-secondary underline-offset-2 hover:text-foreground hover:underline transition-colors"
                    >
                      Street View
                    </a>
                  )}
                  {comp.distanceMiles != null && <span className="tabular-nums">{comp.distanceMiles.toFixed(2)} mi</span>}
                  {scope.matchedName && <span className="truncate">{scope.matchedName}</span>}
                </div>
              </div>
              <div className="flex items-center gap-2.5 flex-shrink-0">
                <span className={cn('font-medium', scopeToneClass(scope.tone))} title={scope.title}>{scope.word}</span>
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
            </div>

            {/* Server verdicts · each on its own axis, same words as the card */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-2">
              <Pair label="Condition" value={conditionLabel(comp.badges?.condition)} title={comp.curbAppeal?.summary ?? undefined} />
              {priceClass && <Pair label="Price" value={priceClass} title={comp.classification?.reasoning || undefined} />}
              {trust && <Pair label="Trust" value={trust} title={trustTitle(comp.badges?.trust)} />}
              {widened.length > 0 && (
                <span className="font-medium text-amber-600 dark:text-amber-400" title={widenedTitle(widened)}>Widened</span>
              )}
            </div>
            {conflict && (
              <p className="mt-1 text-foreground-tertiary leading-snug" title={comp.classification?.reasoning || undefined}>{conflict}</p>
            )}
          </div>

          {/* ── Photo · clicks through to Street View ── */}
          <div className="relative h-40 bg-muted/30 overflow-hidden">
            {streetViewUrl ? (
              <a href={streetViewUrl} target="_blank" rel="noopener noreferrer" className="block w-full h-full" title="Open Street View">
                {photo}
              </a>
            ) : photo}
          </div>

          {/* ── Price · server numbers only; a manual deduction gets its own line ── */}
          {comp.salePrice != null && (
            <div className="px-4 sm:px-5 py-2.5 border-b border-border flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[11px]">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-foreground-tertiary">Sale</span>
                <span className="text-base font-bold text-foreground tabular-nums">${comp.salePrice.toLocaleString()}</span>
                {saleMeta && <span className="text-foreground-tertiary tabular-nums">{saleMeta}</span>}
              </div>
              {(hasAdjusted || proximityDeduction > 0) && (
                <div className="flex flex-wrap items-baseline gap-x-3">
                  {hasAdjusted && (
                    <span className="whitespace-nowrap">
                      <span className="text-foreground-tertiary">Adjusted</span>{' '}
                      <span className={cn('text-[13px] font-semibold tabular-nums', MATCH_TEXT)}>${comp.adjustedPrice!.toLocaleString()}</span>
                    </span>
                  )}
                  {proximityDeduction > 0 && (
                    <span className="whitespace-nowrap" title="Manual traffic deduction · not part of the server price">
                      <span className="text-foreground-tertiary">After proximity</span>{' '}
                      <span className="text-[13px] font-semibold tabular-nums text-amber-600 dark:text-amber-400">${afterProximity.toLocaleString()}</span>
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Property facts · one grid; empty cells hide ── */}
          <div className="border-b border-border overflow-hidden">
            <div className="grid grid-cols-4 bg-muted/40 -mb-px">
              <StatCell label="Beds" value={comp.bedrooms} highlight={fm('beds')} />
              <StatCell label="Baths" value={comp.bathrooms} highlight={fm('baths')} />
              <StatCell
                label="Sq Ft"
                value={fmt(comp.squareFeet)}
                sub={sqftDiff != null ? fmtDeltaWords(sqftDiff, 'sf') : null}
                subClass={sqftDiff != null ? sqftMatchColor(comp.squareFeet!, subject!.squareFeet!) : null}
              />
              <StatCell
                label="Year"
                value={comp.yearBuilt != null ? String(comp.yearBuilt) : null}
                sub={yearDiff != null ? fmtDeltaWords(yearDiff, 'yrs', 'newer', 'older') : null}
                subClass={yearDiff != null ? yearMatchColor(comp.yearBuilt!, subject!.yearBuilt!) : null}
              />
              <StatCell
                label="Lot"
                value={formatLotSize(comp.lotSizeAcres)}
                title={comp.lotSizeSquareFeet != null ? `${comp.lotSizeSquareFeet.toLocaleString('en-US')} sq ft` : undefined}
                sub={lotDiff != null ? fmtDeltaWords(lotDiff, 'sf') : null}
                subClass={lotDiff != null ? lotMatchColor(comp.lotSizeAcres!, subject!.lotSizeAcres!) : null}
              />
              <StatCell capitalize label="Style" value={comp.buildingStyle} highlight={fm('style')} />
              <StatCell capitalize label="Foundation" value={comp.foundationType} highlight={fm('foundation')} />
              <StatCell capitalize label="Construction" value={comp.constructionType} highlight={fm('construction')} />
              <StatCell capitalize label="Roof" value={comp.roofCover || comp.roofType} highlight={fm('roof')} />
              <StatCell capitalize label="Ext. Walls" value={comp.exteriorWalls} highlight={fm('construction')} />
              <StatCell label="Pool" value={comp.pool ? 'Yes' : null} highlight={fm('pool')} />
              <StatCell label="Garage" value={comp.garage ? (comp.garageSquareFeet ? `${comp.garageSquareFeet} sf` : 'Yes') : null} highlight={fm('garage')} />
              <StatCell label="Carport" value={comp.carport ? 'Yes' : null} highlight={fm('garage')} />
              <StatCell capitalize label="Stories" value={comp.storiesType || (comp.stories != null ? String(comp.stories) : null)} highlight={fm('stories')} />
              <StatCell capitalize label="Heat / AC" value={[comp.heating, comp.cooling].filter(Boolean).join(' / ') || null} highlight={fm('hvac')} />
              {/* One name for the area, as on the card: the neighborhood, or the subdivision when the neighborhood is missing */}
              <StatCell
                label="Neighborhood"
                value={comp.neighborhoodName ? titleCaseWords(comp.neighborhoodName) : comp.subdivision ? titleCaseWords(comp.subdivision) : null}
                highlight={comp.neighborhoodName ? fm('neighborhood') : fm('subdivision')}
              />
            </div>
          </div>

          {/* ── Filters + Adjustments ── */}
          <div className={cn('grid grid-cols-1 gap-0', evaluatedCount > 0 && 'sm:grid-cols-2')}>

            {/* Filters · evaluated rules only */}
            {evaluatedCount > 0 && (
              <div className="border-b sm:border-b-0 sm:border-r border-border">
                <div className="px-3 sm:px-4 py-2 bg-muted/30 border-b border-border/50">
                  <span className="text-[11px] font-semibold text-foreground uppercase tracking-wider">Filters</span>
                  <span className="text-[11px] text-foreground-tertiary ml-2 tabular-nums">{filterSummary}</span>
                </div>
                <div className="divide-y divide-border/20">
                  {evaluatedFilters.map((f) => {
                    const passed = filterStatus(f) === 'passed'
                    // The server's words for the area rule say "block group"; on comp surfaces it is "block"
                    const detail = f.actualValue != null && f.threshold != null
                      ? `${fmtRuleValue(f.actualValue)} / ${fmtRuleValue(f.threshold)}`.replace(/\bblock group\b/gi, 'block').replace(/\bsubdivision\b/gi, 'neighborhood')
                      : null
                    return (
                      <div
                        key={f.type}
                        className={cn(
                          'flex items-center justify-between gap-2 px-3 sm:px-4 py-2 border-l-2',
                          passed ? 'border-l-emerald-500' : 'border-l-red-500 bg-red-500/5',
                        )}
                      >
                        <span className={cn('text-[11px] font-medium flex-shrink-0', passed ? MATCH_TEXT : MISMATCH_TEXT)}>
                          {formatFilterType(f.type)}
                        </span>
                        <div className="flex items-center gap-1.5 min-w-0">
                          {detail && (
                            <span className="text-[11px] text-foreground-tertiary tabular-nums truncate" title={detail}>{detail}</span>
                          )}
                          {passed
                            ? <Check className={cn('w-3.5 h-3.5 flex-shrink-0', MATCH_TEXT)} aria-label="Passed" />
                            : <X className={cn('w-3.5 h-3.5 flex-shrink-0', MISMATCH_TEXT)} aria-label="Failed" />}
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
                <span className="text-[11px] font-semibold text-foreground uppercase tracking-wider">Adjustments</span>
              </div>
              <div className="divide-y divide-border/20">
                {adjustments.filter((a) => a.applied).map((a) => (
                  <div key={a.type} className="flex items-center justify-between px-3 sm:px-4 py-2 border-l-2 border-l-foreground/40">
                    <span className="text-[11px] font-medium text-foreground">{formatFilterType(a.type)}</span>
                    <span className={cn('text-[11px] font-semibold tabular-nums', a.amount >= 0 ? MATCH_TEXT : MISMATCH_TEXT)}>
                      {a.amount >= 0 ? '+' : ''}{formatCurrency(a.amount)}
                    </span>
                  </div>
                ))}
                {comp.appraisalRules?.totalAdjustment != null && (
                  <div className="flex items-center justify-between px-3 sm:px-4 py-2 bg-muted/20">
                    <span className="text-[11px] font-semibold text-foreground">Total</span>
                    <span className={cn('text-[11px] font-bold tabular-nums', comp.appraisalRules.totalAdjustment >= 0 ? MATCH_TEXT : MISMATCH_TEXT)}>
                      {comp.appraisalRules.totalAdjustment >= 0 ? '+' : ''}{formatCurrency(comp.appraisalRules.totalAdjustment)}
                    </span>
                  </div>
                )}
                {/* Proximity toggles · manual, kept apart from the server total */}
                <div className="px-3 sm:px-4 py-1.5 bg-muted/20 border-t border-border">
                  <span className="text-[11px] font-semibold text-foreground-tertiary uppercase tracking-wider">Traffic / Commercial</span>
                </div>
                {(['siding', 'backing', 'fronting'] as const).map((pos) => {
                  const label = pos === 'siding' ? 'Siding (beside)' : pos === 'backing' ? 'Backing (behind)' : 'Fronting (in front)'
                  const deduction = deductionFor(pos)
                  return (
                    <div key={pos} className="flex items-center justify-between px-3 sm:px-4 py-2 border-l-2 border-l-amber-500">
                      <div>
                        <span className="text-[11px] font-medium text-foreground">{label}</span>
                        {proximityToggles[pos] && deduction > 0 && (
                          <div className={cn('text-[11px] tabular-nums', MISMATCH_TEXT)}>-${deduction.toLocaleString()}</div>
                        )}
                      </div>
                      <Switch
                        checked={proximityToggles[pos]}
                        onCheckedChange={(checked) => setProximityToggle(pos, checked)}
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
