'use client'

import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CompItem, SubjectData } from './shared-types'
import { StreetViewImage } from './StreetViewImage'
import { normalizeSubdivision } from './format-helpers'

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

function sqftMatchColor(compSf: number, subSf: number): string {
  const pct = Math.abs(compSf - subSf) / subSf
  if (pct <= 0.10) return 'text-emerald-500'
  if (pct <= 0.20) return 'text-foreground-tertiary'
  return 'text-red-400'
}

function yearMatchColor(compYr: number, subYr: number): string {
  if (compYr <= 1940 && subYr <= 1940) return 'text-emerald-500'
  const diff = Math.abs(compYr - subYr)
  if (diff <= 5) return 'text-emerald-500'
  if (diff <= 10) return 'text-foreground-tertiary'
  return 'text-red-400'
}

function fmtDelta(diff: number): string {
  return diff > 0 ? `+${diff.toLocaleString()}` : diff.toLocaleString()
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
  const isEnabled = hasArvSelection ? isSelectedForArv : comp.isEnabled !== false
  const cardKey = comp.address || `comp-${index}`

  const sqftDelta = comp.squareFeet != null && subject?.squareFeet != null
    ? comp.squareFeet - subject.squareFeet : null
  const yearDelta = comp.yearBuilt != null && subject?.yearBuilt != null
    ? comp.yearBuilt - subject.yearBuilt : null

  const sqftColor = sqftDelta != null && subject?.squareFeet
    ? sqftMatchColor(comp.squareFeet!, subject.squareFeet) : null
  const yearColor = yearDelta != null && subject?.yearBuilt != null
    ? yearMatchColor(comp.yearBuilt!, subject.yearBuilt) : null

  return (
    <div
      data-card-key={cardKey}
      onClick={onClick}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      className={cn(
        'border border-border overflow-hidden transition-all duration-200 cursor-pointer group',
        isEnabled ? 'hover:border-foreground/20' : 'opacity-50 hover:opacity-70',
        comp.isBestComp && isEnabled && 'ring-1 ring-amber-500/30',
        isHighlighted && 'ring-2 ring-primary/50 shadow-lg shadow-primary/5',
      )}
    >
      {/* Image with price overlay */}
      <div className="relative h-28 bg-muted/30 overflow-hidden">
        <StreetViewImage
          address={comp.address}
          latitude={comp.latitude}
          longitude={comp.longitude}
          width={400}
          height={200}
          className="w-full h-full object-cover"
        />
        {/* Index */}
        <div className={cn(
          'absolute top-2 left-2 w-6 h-6 rounded-sm flex items-center justify-center text-[11px] font-bold',
          isEnabled ? 'bg-emerald-500 text-white' : 'bg-neutral-600 text-white/70'
        )}>
          {index + 1}
        </div>
        {/* Bottom: price + date */}
        <div className="absolute bottom-0 left-0 right-0 px-2 py-1.5 bg-gradient-to-t from-black/70 to-transparent flex items-end justify-between">
          <span className="text-sm font-bold text-white tabular-nums">
            ${comp.salePrice?.toLocaleString() || '-'}
          </span>
          <span className="text-[9px] text-white/80 font-medium">
            {comp.saleDate ? new Date(comp.saleDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''}
          </span>
        </div>
        {/* ARV checkbox */}
        {hasArvSelection && onToggleArv && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleArv() }}
            title={isSelectedForArv ? 'Remove from ARV' : 'Add to ARV'}
            className={cn(
              'absolute top-2 right-2 w-5 h-5 rounded-sm border-2 flex items-center justify-center transition-all',
              isSelectedForArv
                ? 'bg-emerald-500 border-emerald-500 text-white'
                : 'border-white/50 bg-black/30 text-white/50 hover:border-emerald-400'
            )}
          >
            <Check className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Body */}
      <div className="px-3 py-2.5">
        {/* Address line with $/sf right-aligned */}
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-[11px] text-foreground-secondary truncate" title={comp.address || undefined}>
            {comp.address || 'Unknown'}
          </div>
          {comp.pricePerSqft && (
            <span className="text-[10px] text-foreground-tertiary tabular-nums flex-shrink-0">${comp.pricePerSqft.toFixed(0)}/sf</span>
          )}
        </div>
        {/* Subdivision pill */}
        {comp.subdivision && (() => {
          const isMatch = !!(subject?.subdivision && normalizeSubdivision(comp.subdivision) === normalizeSubdivision(subject.subdivision))
          const hasSubject = !!subject?.subdivision
          return (
            <div className={cn(
              'inline-flex items-center gap-1 mt-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-medium truncate max-w-full',
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
              <span className="truncate">{comp.subdivision}</span>
            </div>
          )
        })()}
        {/* Adj price + distance */}
        <div className="flex items-baseline justify-between mt-0.5">
          {comp.distanceMiles != null ? (
            <span className="text-[9px] text-foreground-tertiary tabular-nums">{comp.distanceMiles.toFixed(2)} mi away</span>
          ) : <span />}
          {comp.adjustedPrice != null && comp.adjustedPrice !== comp.salePrice && (
            <span className="text-[10px] font-medium text-emerald-500 tabular-nums">Adj ${comp.adjustedPrice.toLocaleString()}</span>
          )}
        </div>

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
        </div>
      </div>
    </div>
  )
}
