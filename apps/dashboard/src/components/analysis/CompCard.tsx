'use client'

import { useState } from 'react'
import { ChevronRight, Check } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { CompItem, SubjectData } from './shared-types'
import { StatCell } from './StatCell'
import { ClassificationBadge } from './ClassificationBadge'
import { PhotoGallery } from './PhotoGallery'
import { AddressDisplay } from './AddressDisplay'
import { formatFilterType, formatAdjustmentType, formatCurrency, normalizeSubdivision } from './format-helpers'
import { StreetViewImage } from './StreetViewImage'

export interface CompCardProps {
  comp: CompItem
  index: number
  subject?: SubjectData | null
  subjectSubdivision?: string | null
  isExpanded?: boolean
  onToggle?: () => void
  isSelectedForArv?: boolean
  onToggleArv?: () => void
}

export function CompCard({
  comp,
  index,
  subject: _subject,
  subjectSubdivision,
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

  const hasSubdivisionMatch = !!(
    subjectSubdivision &&
    comp.subdivision &&
    normalizeSubdivision(subjectSubdivision) === normalizeSubdivision(comp.subdivision)
  )

  const cardKey = comp.address || `comp-${index}`

  return (
    <div
      data-card-key={cardKey}
      className={cn(
        'transition-all duration-300 border border-border',
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
                className={cn(
                  'w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-all',
                  isSelectedForArv
                    ? 'bg-emerald-500 border-emerald-500 text-white'
                    : 'border-foreground/25 bg-foreground/8 text-foreground/30 hover:border-emerald-500'
                )}
              >
                <Check className="w-3 h-3" />
              </button>
            )}
            {!isAlwaysExpanded && (
              <ChevronRight className={cn('w-3.5 h-3.5 text-foreground-tertiary transition-transform', isExpanded && 'rotate-90')} />
            )}
          </div>
        </div>

        {/* Row 2: Meta — distance, date, subdivision, adjusted price */}
        <div className="flex items-center gap-2 mt-1 text-[10px] text-foreground-tertiary flex-wrap pl-8">
          {comp.distanceMiles != null && <span>{comp.distanceMiles.toFixed(2)} mi</span>}
          {comp.subdivision && <><span className="text-border">·</span><span>{comp.subdivision}</span></>}
          {comp.adjustedPrice && comp.salePrice !== comp.adjustedPrice && (
            <><span className="text-border">·</span><span className="text-emerald-600">Adj: ${comp.adjustedPrice.toLocaleString()}</span></>
          )}
          {hasSubdivisionMatch && <span className="text-emerald-500">✓ Subdivision</span>}
        </div>
      </div>

      {/* Stats grid */}
      <div className={cn('flex flex-wrap bg-muted/40 border-t border-border/30', !isAlwaysExpanded && 'cursor-pointer')} onClick={handleToggle}>
        <StatCell label="Beds" value={comp.bedrooms ?? '-'} />
        <StatCell label="Baths" value={comp.bathrooms ?? '-'} />
        <StatCell label="Sq Ft" value={comp.squareFeet?.toLocaleString() || '-'} />
        <StatCell label="Year" value={comp.yearBuilt || '-'} />
        <StatCell label="Lot" value={comp.lotSizeAcres ? `${Number(comp.lotSizeAcres).toFixed(3)} ac` : '-'} />
        <StatCell label="Foundation" value={comp.foundationType || '-'} />
        <StatCell label="House Style" value={comp.buildingStyle || '-'} />
      </div>

      {isExpanded && (
        <div className="px-5 pb-4 pt-2 space-y-4">
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

          {comp.photos && comp.photos.length > 0 ? (
            <div>
              <div className="text-caption text-foreground-tertiary mb-2">Photos</div>
              <PhotoGallery photos={comp.photos} />
            </div>
          ) : (
            <StreetViewImage
              address={comp.address}
              latitude={comp.latitude}
              longitude={comp.longitude}
              width={400}
              height={200}
              className="w-full h-auto max-h-[160px] object-cover bg-muted"
            />
          )}
        </div>
      )}
    </div>
  )
}
