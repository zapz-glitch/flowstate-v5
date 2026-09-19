'use client'

import { useMemo, useState } from 'react'
import { ChevronRight, Check } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { subdivisionsMatch } from '@flowstate-api/shared'
import type { CompItem, SubjectData } from './shared-types'
import { StatCell } from './StatCell'
import { ClassificationBadge } from './ClassificationBadge'
import { PhotoGallery } from './PhotoGallery'
import { AddressDisplay } from './AddressDisplay'
import { formatFilterType, formatAdjustmentType, formatCurrency, getCompKey, fmtLotDelta, formatLotSize } from './format-helpers'
import { compFeatureMatches, featureState, matchDotClass, matchTextClass } from './feature-match'
import { StreetViewImage } from './StreetViewImage'
import { RuleMatchDetails } from './RuleMatchDetails'

export interface CompCardProps {
  comp: CompItem
  index: number
  /** Full subject data — enables per-feature match indicators */
  subject?: SubjectData | null
  /** @deprecated prefer `subject` — subject subdivision name */
  subjectSubdivision?: string | null
  /** Subject lot size in acres — enables the lot delta display */
  subjectLotAcres?: number | null
  isExpanded?: boolean
  onToggle?: () => void
  isSelectedForArv?: boolean
  onToggleArv?: () => void
}

export function CompCard({
  comp,
  index,
  subject,
  subjectSubdivision,
  subjectLotAcres,
  isExpanded: controlledExpanded,
  onToggle: controlledOnToggle,
  isSelectedForArv,
  onToggleArv,
}: CompCardProps) {
  const [internalExpanded, setInternalExpanded] = useState(false)

  const isControlled = controlledExpanded !== undefined
  const isExpanded = isControlled ? controlledExpanded : internalExpanded
  // When permanently expanded (no onToggle callback), disable collapsing
  const isAlwaysExpanded = isControlled && !controlledOnToggle
  const handleToggle = isAlwaysExpanded
    ? undefined
    : isControlled
      ? () => controlledOnToggle?.()
      : () => setInternalExpanded((p) => !p)

  const hasArvSelection = isSelectedForArv !== undefined
  const isEnabled = hasArvSelection ? isSelectedForArv : comp.isEnabled !== false

  // Bucket label = Jev's classification (higher truth wins; tie → no
  // bucket) — shown for every scored comp, not only the counted set.
  // compGroup (the server's counted group) is the fallback when scores
  // are absent.
  const bucket = comp.jevArvTruth != null && comp.jevInvestmentTruth != null
    ? (comp.jevArvTruth > comp.jevInvestmentTruth ? 'arv'
      : comp.jevInvestmentTruth > comp.jevArvTruth ? 'as_is' : null)
    : comp.compGroup ?? null

  const subjectSubdiv = subject?.subdivision ?? subjectSubdivision
  const hasSubdivisionMatch = !!(
    subjectSubdiv &&
    comp.subdivision &&
    subdivisionsMatch(subjectSubdiv, comp.subdivision)
  )

  // Feature-vs-subject verification — green/red/neutral per displayable field
  const featureMatches = useMemo(() => compFeatureMatches(comp, subject), [comp, subject])
  const fm = (key: Parameters<typeof featureState>[1]) => featureState(featureMatches, key)

  const cardKey = getCompKey(comp, index)

  return (
    <div
      data-card-key={cardKey}
      className={cn(
        'transition-all duration-300 border border-border rounded-lg',
        comp.isBestComp && isEnabled && 'border-amber-500/40 ring-1 ring-amber-500/20',
        isEnabled ? 'border-l-2 border-l-emerald-500/50' : 'opacity-70'
      )}
    >
      <div className="px-4 py-3">
        {/* Row 1: Address + Price */}
        <div className={cn('flex items-center justify-between gap-3', !isAlwaysExpanded && 'cursor-pointer')} onClick={handleToggle}>
          <div className="flex items-center gap-2.5 flex-1 min-w-0">
            <div className={cn(
              'w-6 h-6 rounded flex items-center justify-center text-[11px] font-bold flex-shrink-0',
              isEnabled ? 'bg-emerald-500/15 text-emerald-600' : 'bg-muted text-foreground-tertiary'
            )}>
              {index + 1}
            </div>
            {comp.jevArvTruth != null && (
              <div
                className={cn(
                  'h-6 px-1.5 rounded flex items-center text-[10px] font-bold tabular-nums flex-shrink-0',
                  comp.jevArvTruth >= 0.7 ? 'bg-emerald-500/15 text-emerald-600'
                    : comp.jevArvTruth >= 0.4 ? 'bg-amber-500/15 text-amber-600'
                    : 'bg-red-500/15 text-red-500'
                )}
                title={`ARV truth ${(comp.jevArvTruth * 100).toFixed(0)}% — Jev's probability this comp is reliable evidence of the subject's after-renovation retail value`}
              >
                A·{(comp.jevArvTruth * 100).toFixed(0)}%
              </div>
            )}
            {comp.jevInvestmentTruth != null && (
              <div
                className={cn(
                  'h-6 px-1.5 rounded flex items-center text-[10px] font-bold tabular-nums flex-shrink-0',
                  comp.jevInvestmentTruth >= 0.7 ? 'bg-emerald-500/15 text-emerald-600'
                    : comp.jevInvestmentTruth >= 0.4 ? 'bg-amber-500/15 text-amber-600'
                    : 'bg-red-500/15 text-red-500'
                )}
                title={`Investment truth ${(comp.jevInvestmentTruth * 100).toFixed(0)}% — Jev's probability this comp is reliable evidence of the subject's as-is investor value`}
              >
                I·{(comp.jevInvestmentTruth * 100).toFixed(0)}%
              </div>
            )}
            {bucket && (
              <div
                className={cn(
                  'h-6 px-1.5 rounded flex items-center text-[10px] font-bold flex-shrink-0',
                  bucket === 'arv' ? 'bg-emerald-500/15 text-emerald-600' : 'bg-amber-500/15 text-amber-600'
                )}
                title={bucket === 'arv'
                  ? 'Jev classified this comp as ARV (after-renovation) evidence — enabled comps in this bucket count toward the ARV'
                  : 'Jev classified this comp as as-is (investment) evidence — enabled comps in this bucket count toward the as-is average'}
              >
                {bucket === 'arv' ? 'ARV' : 'AS-IS'}
              </div>
            )}
            {comp.flip && (
              <div
                className="h-6 px-1.5 rounded flex items-center text-[10px] font-bold bg-violet-500/15 text-violet-500 flex-shrink-0"
                title={`Verified flip — bought $${comp.flip.priorSalePrice.toLocaleString()} ${comp.flip.daysHeld}d prior, resold +${comp.flip.gainPct}%`}
              >
                FLIP
              </div>
            )}
            <div className="flex-1 min-w-0">
              {comp.address ? (
                <AddressDisplay address={comp.address} latitude={comp.latitude} longitude={comp.longitude} className="text-body-sm font-medium" />
              ) : (
                <span className="text-body-sm font-medium">Unknown Address</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="text-right">
              <div className="text-body-sm font-bold tabular-nums">${comp.salePrice?.toLocaleString() || '-'}</div>
              {comp.saleReconciled?.previousPrice != null && (
                <div className="text-[10px] text-violet-500" title={`Provider record was stale — corrected to the newer Zillow sale`}>
                  was ${comp.saleReconciled.previousPrice.toLocaleString()}
                </div>
              )}
              <div className="text-[10px] text-foreground-tertiary">
                {comp.pricePerSqft ? `$${comp.pricePerSqft.toFixed(0)}/sqft` : ''}
                {comp.pricePerSqft && comp.saleDate ? ' · ' : ''}
                {comp.saleDate ? new Date(comp.saleDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : ''}
              </div>
            </div>
            {hasArvSelection && onToggleArv && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onToggleArv() }}
                title={isSelectedForArv ? 'Remove from ARV' : 'Add to ARV'}
                aria-label={comp.selectionPending ? 'Updating ARV selection' : isSelectedForArv ? 'Remove from ARV' : 'Add to ARV'}
                aria-pressed={isSelectedForArv}
                disabled={comp.selectionPending}
                className="w-11 h-11 flex items-center justify-center flex-shrink-0 disabled:cursor-wait"
              >
                <span className={cn(
                  'w-5 h-5 rounded border-2 flex items-center justify-center transition-all',
                  isSelectedForArv
                    ? 'bg-emerald-500 border-emerald-500 text-white'
                    : 'border-foreground/25 bg-foreground/8 text-foreground/30 hover:border-emerald-500'
                )}>
                  <Check className="w-3 h-3" />
                </span>
              </button>
            )}
            {!isAlwaysExpanded && (
              <ChevronRight className={cn('w-3.5 h-3.5 text-foreground-tertiary transition-transform', isExpanded && 'rotate-90')} />
            )}
          </div>
        </div>

        {/* Row 1b: Feature-match strip — green/red/gray per feature vs subject */}
        {featureMatches.length > 0 && (
          <div className="flex items-center gap-1 mt-1 pl-8">
            {featureMatches.map((m) => (
              <span
                key={m.key}
                title={`${m.label}: ${m.state === 'match' ? 'match' : m.state === 'mismatch' ? 'mismatch' : 'no data'}${m.detail ? ` — ${m.detail}` : ''}`}
                className={cn('w-2 h-2 rounded-full flex-shrink-0', matchDotClass(m.state))}
              />
            ))}
          </div>
        )}

        {/* Row 2: Meta — distance, date, subdivision, adjusted price */}
        <div className="flex items-center gap-2 mt-1 text-[10px] text-foreground-tertiary flex-wrap pl-8">
          {comp.distanceMiles != null && <span>{comp.distanceMiles.toFixed(2)} mi</span>}
          {comp.subdivision && (
            <>
              <span className="text-border">·</span>
              <span className={cn(hasSubdivisionMatch && 'text-emerald-500', subjectSubdiv && comp.subdivision && !hasSubdivisionMatch && 'text-red-400')}>
                {comp.subdivision}
              </span>
            </>
          )}
          {comp.adjustedPrice && comp.salePrice !== comp.adjustedPrice && (
            <><span className="text-border">·</span><span className="text-emerald-600">Adj: ${comp.adjustedPrice.toLocaleString()}</span></>
          )}
          {hasSubdivisionMatch && <span className="text-emerald-500">✓ Subdivision</span>}
        </div>
        <RuleMatchDetails comp={comp} />
      </div>

      {/* Stats grid */}
      <div className={cn('flex flex-wrap bg-muted/40 border-t border-border/30', !isAlwaysExpanded && 'cursor-pointer')} onClick={handleToggle}>
        <StatCell label="Beds" value={comp.bedrooms ?? '-'} match={fm('beds')} />
        <StatCell label="Baths" value={comp.bathrooms ?? '-'} match={fm('baths')} />
        <StatCell label="Sq Ft" value={comp.squareFeet?.toLocaleString() || '-'} match={fm('sqft')} />
        <StatCell label="Year" value={comp.yearBuilt || '-'} match={fm('year')} />
        <StatCell
          label="Lot"
          match={fm('lot')}
          value={
            comp.lotSizeAcres != null
              ? `${formatLotSize(comp.lotSizeAcres)}${subjectLotAcres != null ? ` (${fmtLotDelta(comp.lotSizeAcres, subjectLotAcres)})` : ''}`
              : '-'
          }
        />
        <StatCell label="Style" value={comp.buildingStyle || '-'} match={fm('style')} />
      </div>

      {isExpanded && (
        <div className="px-5 pb-4 pt-2 space-y-4">
          {/* Full property details — everything valid for comparison */}
          <div>
            <div className="text-caption font-medium text-foreground-secondary mb-1.5">Property Details</div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-foreground-tertiary">Foundation</span>
                <span className={cn('font-medium truncate ml-2', matchTextClass(fm('foundation')))}>{comp.foundationType || '-'}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-foreground-tertiary">Construction</span>
                <span className={cn('font-medium truncate ml-2', matchTextClass(fm('construction')))}>{comp.constructionType || '-'}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-foreground-tertiary">Ext. Walls</span>
                <span className={cn('font-medium truncate ml-2', matchTextClass(fm('construction')))}>{comp.exteriorWalls || '-'}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-foreground-tertiary">Roof</span>
                <span className={cn('font-medium truncate ml-2', matchTextClass(fm('roof')))}>{comp.roofCover || comp.roofType || '-'}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-foreground-tertiary">Stories</span>
                <span className={cn('font-medium truncate ml-2', matchTextClass(fm('stories')))}>{comp.storiesType || (comp.stories != null ? String(comp.stories) : '-')}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-foreground-tertiary">Heat / AC</span>
                <span className={cn('font-medium truncate ml-2', matchTextClass(fm('hvac')))}>{[comp.heating, comp.cooling].filter(Boolean).join(' / ') || '-'}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-foreground-tertiary">Assessor Cond.</span>
                <span className={cn('font-medium truncate ml-2', matchTextClass(fm('condition')))}>{comp.buildingCondition || '-'}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-foreground-tertiary">Condition</span>
                <span className={cn(
                  'font-medium truncate ml-2',
                  comp.curbAppeal?.condition === 'renovated' && 'text-emerald-500',
                  comp.curbAppeal?.condition === 'dated' && 'text-amber-500',
                  comp.curbAppeal?.condition === 'distressed' && 'text-red-400',
                )} title={comp.curbAppeal?.summary ?? undefined}>
                  {comp.curbAppeal && comp.curbAppeal.condition !== 'unknown'
                    ? comp.curbAppeal.condition === 'renovated' ? 'Renovated' : comp.curbAppeal.condition === 'dated' ? 'Dated' : 'Distressed'
                    : '-'}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-foreground-tertiary">Pool</span>
                <span className={cn('font-medium', matchTextClass(fm('pool')))}>{comp.pool ? 'Yes' : '-'}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-foreground-tertiary">Garage</span>
                <span className={cn('font-medium truncate ml-2', matchTextClass(fm('garage')))} title={[comp.garage, comp.carport].filter(Boolean).join(' + ') || undefined}>
                  {comp.garage
                    ? `${comp.garage}${comp.garageSquareFeet ? ` ${comp.garageSquareFeet} sf` : ''}${comp.carport ? ` + ${comp.carport}` : ''}`
                    : comp.carport ?? '-'}
                </span>
              </div>
            </div>
          </div>

          {comp.classification && (
            <div>
              <div className="text-caption text-foreground-tertiary flex items-center gap-2 mb-1">
                Classification <ClassificationBadge classification={comp.classification} />
              </div>
              {comp.classification.reasoning && (
                <div className="text-body-sm text-foreground-secondary mt-1">{comp.classification.reasoning}</div>
              )}
              {comp.weightInArv != null && (
                <div className="text-caption-sm text-foreground-tertiary mt-1">
                  ARV Weight: {(comp.weightInArv * 100).toFixed(1)}%
                </div>
              )}
            </div>
          )}

          {comp.keyFeatures && comp.keyFeatures.length > 0 && (
            <div>
              <div className="text-caption text-foreground-tertiary mb-2">Key Features</div>
              <div className="flex flex-wrap gap-1.5">
                {comp.keyFeatures.map((feature, i) => (
                  <Badge key={i} variant="outline" className="text-caption-sm">{feature}</Badge>
                ))}
              </div>
            </div>
          )}

          {comp.appraisalRules && (
            <div className="space-y-3">
              <div className="text-caption font-medium text-foreground-secondary">Appraisal Rules</div>
              <div className="space-y-1.5">
                <div className="text-caption-sm text-foreground-tertiary">Filters Applied</div>
                <div className="grid gap-1.5">
                  {comp.appraisalRules.filters.map((filter, i) => (
                    <div
                      key={i}
                      className={cn(
                        'text-caption-sm px-2.5 py-1.5 rounded-lg flex items-center justify-between',
                        filter.passed ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-red-500/10 text-red-700 dark:text-red-400'
                      )}
                    >
                      <span className="font-medium">{formatFilterType(filter.type)}</span>
                      <span>
                        {filter.passed ? '✓' : '✗'}
                        {filter.actualValue != null && (
                          <span className="ml-1 opacity-70">
                            ({String(filter.actualValue)}{filter.threshold ? ` / ${filter.threshold}` : ''})
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              {comp.appraisalRules.adjustments.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-caption-sm text-foreground-tertiary">Price Adjustments</div>
                  <div className="grid gap-1.5">
                    {comp.appraisalRules.adjustments.map((adj, i) => (
                      <div
                        key={i}
                        className="text-caption-sm px-2.5 py-1.5 rounded-lg bg-blue-500/10 text-blue-700 dark:text-blue-400 flex items-center justify-between"
                      >
                        <span className="font-medium">{formatAdjustmentType(adj.type)}</span>
                        <span className={adj.amount >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
                          {adj.amount >= 0 ? '+' : ''}{formatCurrency(adj.amount)}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="text-caption-sm text-right text-foreground-tertiary">
                    Total Adjustment:{' '}
                    <span className={comp.appraisalRules.totalAdjustment >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
                      {comp.appraisalRules.totalAdjustment >= 0 ? '+' : ''}
                      {formatCurrency(comp.appraisalRules.totalAdjustment)}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          <StreetViewImage
            photos={comp.photos}
            address={[comp.address, comp.city, comp.state, comp.zipCode].filter(Boolean).join(', ')}
            latitude={comp.latitude}
            longitude={comp.longitude}
            width={640}
            height={360}
            className="w-full aspect-video object-cover bg-muted"
          />
          {comp.photos && comp.photos.length > 0 && (
            <div>
              <div className="text-caption text-foreground-tertiary mb-2">Photos</div>
              <PhotoGallery photos={comp.photos} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
