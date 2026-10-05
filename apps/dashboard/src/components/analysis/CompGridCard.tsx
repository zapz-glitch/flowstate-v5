'use client'

import { memo, useMemo } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CompItem, SubjectData } from './shared-types'
import { StreetViewImage } from './StreetViewImage'
import { RuleMatchDetails } from './RuleMatchDetails'
import { sqftMatchColor, yearMatchColor, lotMatchColor, fmtDeltaWords, formatShortDate, formatLotSize } from './format-helpers'
import { compFeatureMatches, featureState, matchTextClass } from './feature-match'

export interface CompGridCardProps {
  comp: CompItem
  index: number
  subject?: SubjectData | null
  isSelectedForArv?: boolean
  /** Called with the card's comp key · stable identity lets the card memoize */
  onToggleArv?: (key: string) => void
  /** Pin this comp to a tier · 'arv' | 'as_is' | null clears. Present only when a jobId is available (Property Search). */
  onAssignTier?: (comp: CompItem, tier: 'arv' | 'as_is' | null) => void
  /** A tier assignment is in flight */
  tierPending?: boolean
  onCompClick?: (comp: CompItem) => void
  /** Called with the card's comp key on enter, null on leave */
  onHover?: (key: string | null) => void
  isHighlighted?: boolean
}


function CompGridCardInner({
  comp,
  index,
  subject,
  isSelectedForArv,
  onToggleArv,
  onAssignTier,
  tierPending,
  onCompClick,
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
  const lotDelta = comp.lotSizeAcres != null && subject?.lotSizeAcres != null
    ? comp.lotSizeAcres - subject.lotSizeAcres : null

  const sqftColor = sqftDelta != null && subject?.squareFeet
    ? sqftMatchColor(comp.squareFeet!, subject.squareFeet) : null
  const yearColor = yearDelta != null && subject?.yearBuilt != null
    ? yearMatchColor(comp.yearBuilt!, subject.yearBuilt) : null
  const lotColor = lotDelta != null
    ? lotMatchColor(comp.lotSizeAcres!, subject!.lotSizeAcres!) : null

  // Feature-vs-subject verification · every card-visible field, green/red/gray
  const featureMatches = useMemo(() => compFeatureMatches(comp, subject), [comp, subject])

  // Build external links
  const streetViewUrl = comp.latitude && comp.longitude
    ? `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${comp.latitude},${comp.longitude}`
    : comp.address
      ? `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${encodeURIComponent(comp.address + (comp.city ? `, ${comp.city}` : '') + (comp.state ? `, ${comp.state}` : ''))}`
      : null

  return (
    <div
      data-card-key={cardKey}
      onMouseEnter={() => onHover?.(cardKey)}
      onMouseLeave={() => onHover?.(null)}
      className={cn(
        'border border-border rounded-sm overflow-hidden transition-all duration-200 group',
        isEnabled ? 'hover:border-foreground/20' : 'opacity-50 hover:opacity-70',
        comp.isBestComp && isEnabled && 'ring-1 ring-amber-500/30',
        isHighlighted && 'ring-2 ring-primary/50 shadow-lg shadow-primary/5',
      )}
    >
      {/* Image with price overlay · clicks to Street View */}
      <div className="relative aspect-[3/2] bg-muted/30 overflow-hidden">
        {streetViewUrl ? (
          <a href={streetViewUrl} target="_blank" rel="noopener noreferrer" className="block w-full h-full">
            <StreetViewImage
              photos={comp.photos}
              address={[comp.address, comp.city, comp.state, comp.zipCode].filter(Boolean).join(', ')}
              latitude={comp.latitude}
              longitude={comp.longitude}
              width={640}
              height={427}
              className="w-full h-full object-cover"
            />
          </a>
        ) : (
          <StreetViewImage
            photos={comp.photos}
            address={[comp.address, comp.city, comp.state, comp.zipCode].filter(Boolean).join(', ')}
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

          {comp.flip && (
            <div
              className="h-6 px-1.5 rounded-sm flex items-center text-[10px] font-bold bg-violet-500 text-white"
              title={`Verified flip · bought $${comp.flip.priorSalePrice.toLocaleString()} ${comp.flip.daysHeld}d prior, resold +${comp.flip.gainPct}%`}
            >
              FLIP
            </div>
          )}

          {comp.bRole && (
            <div
              className={cn(
                'h-6 px-1.5 rounded-sm flex items-center text-[10px] font-bold',
                comp.bRole === 'anchor' ? 'bg-amber-500/90 text-white ring-1 ring-amber-300/60'
                  : comp.bRole === 'driver' ? 'bg-emerald-500/90 text-white'
                  : comp.bRole === 'pool' ? 'bg-neutral-600/90 text-white/80'
                  : 'bg-neutral-700/80 text-white/50'
              )}
              title={
                comp.bRole === 'anchor' ? 'The verified sale the ARV is priced off'
                  : comp.bRole === 'driver' ? 'Verified evidence inside the ARV answer'
                  : comp.bRole === 'pool' ? 'Evaluated · supports the answer without setting it'
                  : 'Excluded from the ARV evidence'
              }
            >
              {comp.bRole === 'anchor' ? 'ARV'
                : comp.bRole === 'driver' ? 'EVIDENCE'
                : comp.bRole === 'pool' ? 'SUPPORT'
                : 'excluded'}
            </div>
          )}

          {comp.badges?.price && (
            <div
              className={cn(
                'h-6 px-1.5 rounded-sm flex items-center text-[10px] font-bold ring-1',
                comp.badges.price === 'renovated' ? 'bg-emerald-500 text-white ring-emerald-300/60'
                  : comp.badges.price === 'as_is' ? 'bg-orange-500 text-white ring-orange-300/60'
                  : 'bg-blue-600 text-white ring-blue-300/60'
              )}
              title={comp.classification?.reasoning || `Price: ${comp.badges.price}`}
            >
              {comp.badges.price === 'renovated' ? 'RENOVATED'
                : comp.badges.price === 'as_is' ? 'AS-IS'
                : 'MEDIAN'}
            </div>
          )}
          {comp.badges?.trust && comp.badges.trust !== 'verified' && (
            <div
              className={cn(
                'h-6 px-1.5 rounded-sm flex items-center text-[9px] font-bold',
                comp.badges.trust === 'partial' ? 'bg-amber-500/90 text-white' : 'bg-red-500/90 text-white'
              )}
              title={
                comp.badges.trust === 'partial' ? 'Partially verified · some checks missing'
                  : 'Unverified · an evidence check failed'
              }
            >
              {comp.badges.trust === 'partial' ? 'PARTIAL' : 'UNVERIFIED'}
            </div>
          )}
        </div>
        {/* Price lives inside the card · the photo carries only the verdict chips */}
        {/* ARV checkbox */}
        {hasArvSelection && onToggleArv && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onToggleArv(cardKey) }}
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

      {/* Body · bottom section clicks to open detail modal */}
      <div className="px-3 py-2.5 cursor-pointer" onClick={() => onCompClick?.(comp)}>
        {/* Address left + sale price right · the two things that matter */}
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-[12px] text-foreground-secondary truncate" title={comp.address || undefined}>
            {comp.address || 'Unknown'}
          </div>
          <span className="text-[13px] font-bold text-foreground tabular-nums flex-shrink-0">
            ${comp.salePrice?.toLocaleString() || '-'}
          </span>
        </div>
        {/* Geo line · matching name on the left, match level word on the
            right. A mismatched neighborhood stays in the detail dialog. */}
        {comp.badges && (comp.badges.pocketVia || comp.badges.pocket) && comp.badges.pocket !== 'unknown' && (
          <div className="flex items-center justify-between gap-2 mt-0.5 text-[11px]">
            <span className="text-foreground-tertiary truncate">
              {comp.badges.pocketVia === 'name' ? (comp.subdivision || comp.neighborhoodName) : ''}
            </span>
            <span className={cn(
              'font-medium flex-shrink-0',
              comp.badges.pocket === 'in' ? 'text-emerald-500'
                : comp.badges.pocket === 'equal' ? 'text-blue-400'
                : 'text-foreground-tertiary'
            )}>
              {comp.badges.pocket === 'in'
                ? (comp.badges.pocketVia === 'tract' ? 'Tract' : comp.badges.pocketVia === 'block' ? 'Group' : 'Neighborhood')
                : `Out ${comp.badges.pocket === 'equal' ? '=' : comp.badges.pocket === 'above' ? '>' : '<'}`}
            </span>
          </div>
        )}
        {/* Server verdicts · Condition (photos) · Price (the sale) */}
        {comp.badges && (comp.badges.condition || comp.badges.price) && (
          <div className="flex items-center gap-3 mt-0.5 text-[12px]">
            {comp.badges.condition && (
              <span><span className="text-foreground-tertiary">Condition</span>{' '}<span className="text-foreground-secondary font-medium">{
                comp.badges.condition === 'reno' ? 'Reno'
                  : comp.badges.condition === 'distressed' ? 'Distressed'
                  : comp.badges.condition === 'unverified' ? 'Unverified'
                  : 'Dated'
              }</span></span>
            )}
            {comp.badges.price && (
              <span><span className="text-foreground-tertiary">Price</span>{' '}<span className="text-foreground-secondary font-medium">{
                comp.badges.price === 'renovated' ? 'Renovated'
                  : comp.badges.price === 'as_is' ? 'As-is'
                  : 'Median'
              }</span></span>
            )}
            {comp.badges.widenedOn.length > 0 && (
              <span className="text-amber-500 text-[10px] font-medium" title={`widened in on: ${comp.badges.widenedOn.join(', ')}`}>widened</span>
            )}
          </div>
        )}

        {/* Distance + Adj price */}
        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
          {comp.distanceMiles != null && (
            <span className="text-[9px] text-foreground-tertiary tabular-nums">{comp.distanceMiles.toFixed(2)} mi</span>
          )}
          {comp.adjustedPrice != null && comp.adjustedPrice !== comp.salePrice && (
            <span className="text-[10px] font-medium text-emerald-500 tabular-nums ml-auto">Adjusted ${comp.adjustedPrice.toLocaleString()}</span>
          )}
        </div>

        <RuleMatchDetails comp={comp} />

        {/* Stats grid · collapsed essentials; full detail in the expand dialog */}
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-2">
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-foreground-tertiary">Bed/Bath</span>
            <span className="font-medium">{comp.bedrooms ?? '-'}/{comp.bathrooms ?? '-'}</span>
          </div>
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-foreground-tertiary">Sq Ft</span>
            <span className="font-medium tabular-nums">
              {comp.squareFeet?.toLocaleString() || '-'}
              {sqftDelta != null && <span className={cn('ml-1 text-[9px]', sqftColor)}>({fmtDeltaWords(sqftDelta, 'sf')})</span>}
            </span>
          </div>
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-foreground-tertiary">Year</span>
            <span className="font-medium">
              {comp.yearBuilt ?? '-'}
              {yearDelta != null && <span className={cn('ml-1 text-[9px]', yearColor)}>({fmtDeltaWords(yearDelta, 'yrs', 'older', 'newer')})</span>}
            </span>
          </div>
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-foreground-tertiary">Lot</span>
            <span className="font-medium tabular-nums">
              {formatLotSize(comp.lotSizeAcres)}
              {lotDelta != null && <span className={cn('ml-1 text-[9px]', lotColor)}>({fmtDeltaWords(lotDelta! * 43560, 'sf')})</span>}
            </span>
          </div>
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-foreground-tertiary">Style</span>
            <span className={cn('font-medium truncate ml-2', matchTextClass(featureState(featureMatches, 'style')))}>{comp.buildingStyle || '-'}</span>
          </div>
          <div className="flex items-center justify-between text-[12px]">
            <span className="text-foreground-tertiary">Lot SqFt</span>
            <span className="font-medium tabular-nums">{comp.lotSizeSquareFeet != null ? comp.lotSizeSquareFeet.toLocaleString('en-US') : '-'}</span>
          </div>
          {comp.curbAppeal?.condition && comp.curbAppeal.condition !== 'unknown' && (
            <div className="flex items-center justify-between text-[12px]">
              <span className="text-foreground-tertiary">Condition</span>
              <span
                className={cn(
                  'font-medium capitalize',
                  comp.curbAppeal.condition === 'renovated' && 'text-emerald-500',
                  comp.curbAppeal.condition === 'dated' && 'text-amber-500',
                  comp.curbAppeal.condition === 'distressed' && 'text-red-400',
                )}
                title={comp.curbAppeal.summary ?? undefined}
              >
                {comp.curbAppeal.condition}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Memoized · a comp list can hold ~100 cards; without this any parent state
// change (pin, hover, sort) re-renders every card's image/detail subtree.
export const CompGridCard = memo(CompGridCardInner)
