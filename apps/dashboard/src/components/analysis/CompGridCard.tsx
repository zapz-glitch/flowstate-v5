'use client'

import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CompItem, SubjectData } from './shared-types'
import { StreetViewImage } from './StreetViewImage'
import { RuleMatchDetails } from './RuleMatchDetails'
import { normalizeSubdivision, sqftMatchColor, yearMatchColor, fmtDelta, formatShortDate } from './format-helpers'

export interface CompGridCardProps {
  comp: CompItem
  index: number
  subject?: SubjectData | null
  isSelectedForArv?: boolean
  onToggleArv?: () => void
  onClick?: () => void
  onHover?: (hovering: boolean) => void
  isHighlighted?: boolean
}


export function CompGridCard({
  comp,
  index,
  subject,
  isSelectedForArv,
  onToggleArv,
  onClick,
  onHover,
  isHighlighted,
}: CompGridCardProps) {
  const hasArvSelection = isSelectedForArv !== undefined
  const isEnabled = hasArvSelection ? isSelectedForArv : comp.isEnabled === true
  const cardKey = comp.address || `comp-${index}`

  const sqftDelta = comp.squareFeet != null && subject?.squareFeet != null
    ? comp.squareFeet - subject.squareFeet : null
  const yearDelta = comp.yearBuilt != null && subject?.yearBuilt != null
    ? comp.yearBuilt - subject.yearBuilt : null

  const sqftColor = sqftDelta != null && subject?.squareFeet
    ? sqftMatchColor(comp.squareFeet!, subject.squareFeet) : null
  const yearColor = yearDelta != null && subject?.yearBuilt != null
    ? yearMatchColor(comp.yearBuilt!, subject.yearBuilt) : null

  // Build external links
  const streetViewUrl = comp.latitude && comp.longitude
    ? `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${comp.latitude},${comp.longitude}`
    : comp.address
      ? `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${encodeURIComponent(comp.address + (comp.city ? `, ${comp.city}` : '') + (comp.state ? `, ${comp.state}` : ''))}`
      : null

  const zillowUrl = comp.zillowUrl || (comp.address
    ? `https://www.zillow.com/homes/${encodeURIComponent(comp.address + (comp.city ? ` ${comp.city}` : '') + (comp.state ? ` ${comp.state}` : '') + (comp.zipCode ? ` ${comp.zipCode}` : ''))}_rb/`
    : null)

  return (
    <div
      data-card-key={cardKey}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      className={cn(
        'border border-border rounded-sm overflow-hidden transition-all duration-200 group',
        isEnabled ? 'hover:border-foreground/20' : 'opacity-50 hover:opacity-70',
        comp.isBestComp && isEnabled && 'ring-1 ring-amber-500/30',
        isHighlighted && 'ring-2 ring-primary/50 shadow-lg shadow-primary/5',
      )}
    >
      {/* Image with price overlay — clicks to Street View */}
      <div className="relative h-28 bg-muted/30 overflow-hidden">
        {streetViewUrl ? (
          <a href={streetViewUrl} target="_blank" rel="noopener noreferrer" className="block w-full h-full">
            <StreetViewImage
              photos={comp.photos}
              address={comp.address}
              latitude={comp.latitude}
              longitude={comp.longitude}
              width={400}
              height={200}
              className="w-full h-full object-cover"
            />
          </a>
        ) : (
          <StreetViewImage
            photos={comp.photos}
            address={comp.address}
            latitude={comp.latitude}
            longitude={comp.longitude}
            width={400}
            height={200}
            className="w-full h-full object-cover"
          />
        )}
        {/* Index badge */}
        <div className="absolute top-2 left-2 flex items-center gap-1 pointer-events-none">
          <div className={cn(
            'w-6 h-6 rounded-sm flex items-center justify-center text-[11px] font-bold',
            isEnabled ? 'bg-emerald-500 text-white' : 'bg-neutral-600 text-white/70'
          )}>
            {index + 1}
          </div>
        </div>
        {/* Bottom: price + date */}
        <div className="absolute bottom-0 left-0 right-0 px-2 py-1.5 bg-gradient-to-t from-black/70 to-transparent flex items-end justify-between pointer-events-none">
          <span className="text-sm font-bold text-white tabular-nums">
            ${comp.salePrice?.toLocaleString() || '-'}
          </span>
          <span className="text-[9px] text-white/80 font-medium">
            {comp.saleDate ? formatShortDate(comp.saleDate) : ''}
          </span>
        </div>
        {/* ARV checkbox */}
        {hasArvSelection && onToggleArv && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleArv() }}
            title={isSelectedForArv ? 'Remove from ARV' : 'Add to ARV'}
            aria-label={comp.selectionPending ? 'Updating ARV selection' : isSelectedForArv ? 'Remove from ARV' : 'Add to ARV'}
            aria-pressed={isSelectedForArv}
            disabled={comp.selectionPending}
            className="absolute top-0 right-0 w-11 h-11 flex items-center justify-center disabled:cursor-wait"
          >
            <span className={cn(
              'w-5 h-5 rounded-sm border-2 flex items-center justify-center transition-all',
              isSelectedForArv
                ? 'bg-emerald-500 border-emerald-500 text-white'
                : 'border-white/50 bg-black/30 text-white/50 hover:border-emerald-400'
            )}>
              <Check className="w-3 h-3" />
            </span>
          </button>
        )}
      </div>

      {/* Body — bottom section clicks to open detail modal */}
      <div className="px-3 py-2.5 cursor-pointer" onClick={onClick}>
        {/* Address line with $/sf right-aligned */}
        <div className="flex items-baseline justify-between gap-2">
          {zillowUrl ? (
            <a
              href={zillowUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-[11px] text-foreground-secondary truncate hover:text-primary hover:underline"
              title={comp.address || undefined}
            >
              {comp.address || 'Unknown'}
            </a>
          ) : (
            <div className="text-[11px] text-foreground-secondary truncate" title={comp.address || undefined}>
              {comp.address || 'Unknown'}
            </div>
          )}
          <span className="flex items-center gap-1.5 flex-shrink-0">
            {comp.pricePerSqft && (
              <span className="text-[10px] text-foreground-tertiary tabular-nums">${comp.pricePerSqft.toFixed(0)}/sf</span>
            )}
          </span>
        </div>
        {/* Distance + Subdivision + Adj price */}
        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
          {comp.distanceMiles != null && (
            <span className="text-[9px] text-foreground-tertiary tabular-nums">{comp.distanceMiles.toFixed(2)} mi</span>
          )}
          {comp.subdivision && (() => {
            const isMatch = !!(subject?.subdivision && normalizeSubdivision(comp.subdivision) === normalizeSubdivision(subject.subdivision))
            const hasSubject = !!subject?.subdivision
            return (
              <span className={cn(
                'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-medium',
                hasSubject
                  ? isMatch
                    ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20'
                    : 'bg-red-500/10 text-red-400 border border-red-500/20'
                  : 'bg-muted text-foreground-tertiary'
              )}>
                {hasSubject && (isMatch
                  ? <Check className="w-2.5 h-2.5 flex-shrink-0" />
                  : <X className="w-2.5 h-2.5 flex-shrink-0" />
                )}
                <span>{comp.subdivision}</span>
              </span>
            )
          })()}
          {comp.adjustedPrice != null && comp.adjustedPrice !== comp.salePrice && (
            <span className="text-[10px] font-medium text-emerald-500 tabular-nums ml-auto">Adj ${comp.adjustedPrice.toLocaleString()}</span>
          )}
        </div>

        <RuleMatchDetails comp={comp} />

        {/* Stats grid — 2 columns */}
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-2">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-foreground-tertiary">Bed/Bath</span>
            <span className="font-medium">{comp.bedrooms ?? '-'}/{comp.bathrooms ?? '-'}</span>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-foreground-tertiary">Sq Ft</span>
            <span className="font-medium tabular-nums">
              {comp.squareFeet?.toLocaleString() || '-'}
              {sqftDelta != null && <span className={cn('ml-1 text-[9px]', sqftColor)}>({fmtDelta(sqftDelta)})</span>}
            </span>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-foreground-tertiary">Year</span>
            <span className="font-medium">
              {comp.yearBuilt ?? '-'}
              {yearDelta != null && <span className={cn('ml-1 text-[9px]', yearColor)}>({fmtDelta(yearDelta)})</span>}
            </span>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-foreground-tertiary">Style</span>
            <span className="font-medium truncate ml-2">{comp.buildingStyle || '-'}</span>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-foreground-tertiary">Foundation</span>
            <span className="font-medium truncate ml-2">{comp.foundationType || '-'}</span>
          </div>
          {comp.curbAppeal && comp.curbAppeal.condition !== 'unknown' && (
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-foreground-tertiary">Condition</span>
              <span className={cn(
                'font-medium truncate ml-2',
                comp.curbAppeal.condition === 'renovated' && 'text-emerald-500',
                comp.curbAppeal.condition === 'dated' && 'text-amber-500',
                comp.curbAppeal.condition === 'distressed' && 'text-red-400',
              )} title={comp.curbAppeal.summary ?? undefined}>
                {comp.curbAppeal.condition === 'renovated' ? 'Renovated' : comp.curbAppeal.condition === 'dated' ? 'Dated' : 'Distressed'}
                {comp.curbAppeal.source === 'price' && <span className="text-[8px] text-foreground-tertiary font-normal"> (by price)</span>}
              </span>
            </div>
          )}
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-foreground-tertiary">Pool</span>
            <span className="font-medium">{comp.pool ? 'Yes' : '-'}</span>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-foreground-tertiary">Garage</span>
            <span className="font-medium">{comp.garage ? 'Yes' : '-'}</span>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-foreground-tertiary">Carport</span>
            <span className="font-medium">{comp.carport ? 'Yes' : '-'}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
