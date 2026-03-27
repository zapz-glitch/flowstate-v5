'use client'

import { useState } from 'react'
import { Star, ChevronDown, ChevronRight, Check, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { CompItem, SubjectData } from './shared-types'
import { StatCell } from './StatCell'
import { ClassificationBadge } from './ClassificationBadge'
import { PhotoGallery } from './PhotoGallery'
import { AddressDisplay } from './AddressDisplay'
import { formatFilterType, formatAdjustmentType, formatCurrency, normalizeSubdivision } from './format-helpers'

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
      <div className="p-4 md:p-5">
        <div className="flex items-start justify-between gap-4">
          <div className={cn('flex items-start gap-3 flex-1 min-w-0', !isAlwaysExpanded && 'cursor-pointer')} onClick={handleToggle}>
            <div className={cn(
              'mt-0.5 w-7 h-7 rounded-lg flex items-center justify-center text-caption font-semibold flex-shrink-0',
              isEnabled ? 'bg-emerald-500/15 text-emerald-700' : 'bg-muted text-foreground-tertiary'
            )}>
              {index + 1}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                {comp.address ? (
                  <AddressDisplay address={comp.address} latitude={comp.latitude} longitude={comp.longitude} className="text-body font-medium" showStreetView={false} />
                ) : (
                  <span className="text-body font-medium">Unknown Address</span>
                )}
                {comp.isBestComp && (
                  <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30 text-caption-sm">
                    <Star className="w-3 h-3 mr-1" />Best
                  </Badge>
                )}
                {hasSubdivisionMatch ? (
                  <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30 text-caption-sm">
                    <Check className="w-3 h-3 mr-1" />Subdivision
                  </Badge>
                ) : subjectSubdivision && comp.subdivision ? (
                  <Badge variant="outline" className="bg-red-500/5 text-red-500 border-red-500/20 text-caption-sm">
                    <X className="w-3 h-3 mr-1" />Subdivision
                  </Badge>
                ) : null}
              </div>
              <div className="flex items-center gap-2 text-caption text-foreground-tertiary">
                {comp.distanceMiles != null && (
                  <span>{comp.distanceMiles.toFixed(2)} mi away</span>
                )}
                {comp.subdivision && (
                  <>
                    <span className="text-border">·</span>
                    <span>{comp.subdivision}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-start gap-3 flex-shrink-0">
            <div className={cn('text-right', !isAlwaysExpanded && 'cursor-pointer')} onClick={handleToggle}>
              {comp.saleDate && (
                <div className="text-caption-sm text-foreground-tertiary">
                  {new Date(comp.saleDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </div>
              )}
              <div className="text-heading-sm font-bold">${comp.salePrice?.toLocaleString() || '-'}</div>
              {comp.pricePerSqft && (
                <div className="text-caption text-foreground-tertiary">${comp.pricePerSqft.toFixed(0)}/sqft</div>
              )}
              {comp.adjustedPrice && comp.salePrice !== comp.adjustedPrice && (
                <div className="text-caption text-emerald-600">Adj: ${comp.adjustedPrice.toLocaleString()}</div>
              )}
            </div>

            {hasArvSelection && onToggleArv && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onToggleArv() }}
                title={isSelectedForArv ? 'Remove from ARV calculation' : 'Add to ARV calculation'}
                className={cn(
                  'mt-0.5 w-6 h-6 rounded border-2 flex items-center justify-center flex-shrink-0 transition-all',
                  isSelectedForArv
                    ? 'bg-emerald-500 border-emerald-500 text-white'
                    : 'border-foreground/25 bg-foreground/8 text-foreground/30 hover:border-emerald-500 hover:bg-emerald-500/15 hover:text-emerald-500'
                )}
              >
                <Check className="w-3.5 h-3.5" />
              </button>
            )}

            {!isAlwaysExpanded && (
              <div className="text-foreground-tertiary mt-0.5 cursor-pointer" onClick={handleToggle}>
                {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </div>
            )}
          </div>
        </div>

        <div className={cn('flex flex-wrap mt-3 bg-muted/40', !isAlwaysExpanded && 'cursor-pointer')} onClick={handleToggle}>
          <StatCell label="Beds" value={comp.bedrooms ?? '-'} />
          <StatCell label="Baths" value={comp.bathrooms ?? '-'} />
          <StatCell label="Sq Ft" value={comp.squareFeet?.toLocaleString() || '-'} />
          <StatCell label="Year" value={comp.yearBuilt || '-'} />
          <StatCell label="Lot" value={comp.lotSizeAcres ? `${Number(comp.lotSizeAcres).toFixed(3)} ac` : '-'} />
          <StatCell label="Foundation" value={comp.foundationType || '-'} />
          <StatCell label="House Style" value={comp.buildingStyle || '-'} />
        </div>

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
