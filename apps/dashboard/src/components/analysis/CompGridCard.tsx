'use client'

import { memo, useMemo } from 'react'
import { Check, X, CheckCircle2, AlertTriangle, XCircle, MapPin, Ruler, Clock, TrendingUp, Expand } from 'lucide-react'
import { cn } from '@/lib/utils'
import { subdivisionsMatch } from '@flowstate-api/shared'
import { CopyButton } from '@/components/ui/copy-button'
import type { CompItem, SubjectData } from './shared-types'
import { StreetViewImage } from './StreetViewImage'
import { RuleMatchDetails } from './RuleMatchDetails'
import { sqftMatchColor, yearMatchColor, lotMatchColor, fmtDeltaWords, formatShortDate, formatLotSize } from './format-helpers'
import { compFeatureMatches, featureState, matchDotClass, matchTextClass } from './feature-match'

export interface CompGridCardProps {
  comp: CompItem
  index: number
  subject?: SubjectData | null
  isSelectedForArv?: boolean
  /** Called with the card's comp key — stable identity lets the card memoize */
  onToggleArv?: (key: string) => void
  /** Pin this comp to a tier — 'arv' | 'as_is' | null clears. Present only when a jobId is available (Property Search). */
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

  // Feature-vs-subject verification — every card-visible field, green/red/gray
  const featureMatches = useMemo(() => compFeatureMatches(comp, subject), [comp, subject])
  const verifiedCount = featureMatches.filter((m) => m.state !== 'unknown').length
  const matchCount = featureMatches.filter((m) => m.state === 'match').length

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
      onMouseEnter={() => onHover?.(cardKey)}
      onMouseLeave={() => onHover?.(null)}
      className={cn(
        'border border-border rounded-sm overflow-hidden transition-all duration-200 group',
        isEnabled ? 'hover:border-foreground/20' : 'opacity-50 hover:opacity-70',
        comp.isBestComp && isEnabled && 'ring-1 ring-amber-500/30',
        isHighlighted && 'ring-2 ring-primary/50 shadow-lg shadow-primary/5',
      )}
    >
      {/* Image with price overlay — clicks to Street View */}
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
                  : comp.bRole === 'pool' ? 'Evaluated — supports the answer without setting it'
                  : 'Excluded from the ARV evidence'
              }
            >
              {comp.bRole === 'anchor' ? 'ARV'
                : comp.bRole === 'driver' ? 'EVIDENCE'
                : comp.bRole === 'pool' ? 'SUPPORT'
                : 'excluded'}
            </div>
          )}

          {comp.flip && (
            <div
              className="h-6 px-1.5 rounded-sm flex items-center text-[10px] font-bold bg-violet-500/90 text-white"
              title={`Verified flip — bought $${comp.flip.priorSalePrice.toLocaleString()} ${comp.flip.daysHeld}d prior, resold +${comp.flip.gainPct}%`}
            >
              FLIP
            </div>
          )}
          {comp.userTier && (
            <div
              className={cn(
                'h-6 px-1.5 rounded-sm flex items-center text-[10px] font-bold',
                comp.userTier === 'arv' ? 'bg-emerald-500/90 text-white' : 'bg-amber-500/90 text-white'
              )}
              title={`You pinned this comp as ${comp.userTier === 'arv' ? 'ARV' : 'as-is'}`}
            >
              {comp.userTier === 'arv' ? 'ARV' : 'AS-IS'}·YOU
            </div>
          )}
          {comp.badges?.price && (
            <div
              className={cn(
                'h-6 px-1.5 rounded-sm flex items-center text-[10px] font-bold',
                comp.badges.price === 'renovated' ? 'bg-emerald-500/90 text-white'
                  : comp.badges.price === 'as_is' ? 'bg-orange-500/90 text-white'
                  : 'bg-blue-500/90 text-white'
              )}
              title={comp.classification?.reasoning || `Price: ${comp.badges.price}`}
            >
              {comp.badges.price === 'renovated' ? 'RENOVATED'
                : comp.badges.price === 'as_is' ? 'AS-IS'
                : 'MEDIAN'}
            </div>
          )}
          {comp.badges?.trust && (
            <div
              className={cn(
                'h-6 w-6 rounded-sm flex items-center justify-center',
                comp.badges.trust === 'verified' ? 'text-emerald-400'
                  : comp.badges.trust === 'partial' ? 'text-amber-400'
                  : 'text-red-400'
              )}
              title={
                comp.badges.trust === 'verified' ? 'Verified — evidence checks passed'
                  : comp.badges.trust === 'partial' ? 'Partially verified — some checks missing'
                  : 'Unverified — an evidence check failed'
              }
            >
              {comp.badges.trust === 'verified' ? <CheckCircle2 className="w-4 h-4" />
                : comp.badges.trust === 'partial' ? <AlertTriangle className="w-4 h-4" />
                : <XCircle className="w-4 h-4" />}
            </div>
          )}
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

      {/* Body — bottom section clicks to open detail modal */}
      <div className="px-3 py-2.5 cursor-pointer" onClick={() => onCompClick?.(comp)}>
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
            <CopyButton text={comp.address ?? ''} title="Copy address" />
          </span>
        </div>
        {/* Location badges — own line directly under the address */}
        <div className="flex items-center gap-1 mt-1 flex-wrap">
          {comp.subdivision && (() => {
            const isMatch = !!(subject?.subdivision && subdivisionsMatch(comp.subdivision, subject.subdivision))
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
        </div>
        {/* Server verdicts — Condition (photos) · Price (the sale) */}
        {comp.badges && (comp.badges.condition || comp.badges.price) && (
          <div className="flex items-center gap-2 mt-1 text-[10px] tabular-nums">
            {comp.badges.condition && (
              <span className="text-foreground-tertiary">Condition — <span className="text-foreground-secondary font-medium">{
                comp.badges.condition === 'reno' ? 'Reno'
                  : comp.badges.condition === 'distressed' ? 'Distressed'
                  : comp.badges.condition === 'unverified' ? 'Unverified'
                  : 'Dated'
              }</span></span>
            )}
            {comp.badges.price && (
              <span className="text-foreground-tertiary">Price — <span className="text-foreground-secondary font-medium">{
                comp.badges.price === 'renovated' ? 'Renovated'
                  : comp.badges.price === 'as_is' ? 'As-is'
                  : 'Median'
              }</span></span>
            )}
            {comp.badges.pocket && comp.badges.pocket !== 'unknown' && (
              <span
                className={cn(
                  'ml-auto inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-medium',
                  comp.badges.pocket === 'in' ? 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20'
                    : comp.badges.pocket === 'equal' ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                    : 'bg-muted text-foreground-tertiary border border-border'
                )}
                title={
                  comp.badges.pocket === 'in' ? 'In the pocket — census tract or block-group match'
                    : comp.badges.pocket === 'equal' ? "Out of pocket — trades at the subject\u2019s level"
                    : comp.badges.pocket === 'above' ? "Out of pocket — trades above the subject\u2019s market"
                    : "Out of pocket — trades below the subject\u2019s market"
                }
              >
                <MapPin className="w-2.5 h-2.5" />
                {comp.badges.pocket === 'in' ? 'Pocket' : `Out ${comp.badges.pocket === 'equal' ? '=' : comp.badges.pocket === 'above' ? '>' : '<'}`}
              </span>
            )}
          </div>
        )}

        {/* Check ribbon — the scannable passes; dim = failed or unverified */}
        {comp.badges && (
          <div className="flex items-center gap-1.5 mt-1" title={[
            `${comp.badges.checks.pocket === true ? '✓' : '✗'} pocket`,
            `${comp.badges.checks.size === true ? '✓' : '✗'} size`,
            `${comp.badges.checks.fresh === true ? '✓' : '✗'} fresh sale`,
            `${comp.badges.checks.priceFit === true ? '✓' : '✗'} price fits`,
            ...(comp.badges.widenedOn.length ? [`widened in on: ${comp.badges.widenedOn.join(', ')}`] : []),
          ].join('\n')}>
            <MapPin className={cn('w-3 h-3', comp.badges.checks.pocket === true ? 'text-emerald-500' : 'text-foreground-tertiary/30')} />
            <Ruler className={cn('w-3 h-3', comp.badges.checks.size === true ? 'text-emerald-500' : 'text-foreground-tertiary/30')} />
            <Clock className={cn('w-3 h-3', comp.badges.checks.fresh === true ? 'text-emerald-500' : 'text-foreground-tertiary/30')} />
            <TrendingUp className={cn('w-3 h-3', comp.badges.checks.priceFit === true ? 'text-emerald-500' : 'text-foreground-tertiary/30')} />
            {comp.badges.widenedOn.length > 0 && (
              <Expand className="w-3 h-3 text-amber-500 ml-0.5" />
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

        {/* Stats grid — collapsed essentials; full detail in the expand dialog */}
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 mt-2">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-foreground-tertiary">Bed/Bath</span>
            <span className="font-medium">{comp.bedrooms ?? '-'}/{comp.bathrooms ?? '-'}</span>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-foreground-tertiary">Sq Ft</span>
            <span className="font-medium tabular-nums">
              {comp.squareFeet?.toLocaleString() || '-'}
              {sqftDelta != null && <span className={cn('ml-1 text-[9px]', sqftColor)}>({fmtDeltaWords(sqftDelta, 'sf')})</span>}
            </span>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-foreground-tertiary">Year</span>
            <span className="font-medium">
              {comp.yearBuilt ?? '-'}
              {yearDelta != null && <span className={cn('ml-1 text-[9px]', yearColor)}>({fmtDeltaWords(yearDelta, 'yrs', 'older', 'newer')})</span>}
            </span>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-foreground-tertiary">Lot</span>
            <span className="font-medium tabular-nums">
              {formatLotSize(comp.lotSizeAcres)}
              {lotDelta != null && <span className={cn('ml-1 text-[9px]', lotColor)}>({fmtDeltaWords(lotDelta! * 43560, 'sf')})</span>}
            </span>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-foreground-tertiary">Style</span>
            <span className={cn('font-medium truncate ml-2', matchTextClass(featureState(featureMatches, 'style')))}>{comp.buildingStyle || '-'}</span>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-foreground-tertiary">Lot SqFt</span>
            <span className="font-medium tabular-nums">{comp.lotSizeSquareFeet != null ? comp.lotSizeSquareFeet.toLocaleString('en-US') : '-'}</span>
          </div>
          {comp.curbAppeal?.condition && comp.curbAppeal.condition !== 'unknown' && (
            <div className="flex items-center justify-between text-[11px]">
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

        {/* Feature-match strip — one dot per compared feature vs subject.
            Green = match, red = verified mismatch, gray = no data to verify. */}
        {featureMatches.length > 0 && (
          <div className="flex items-center gap-1 mt-1.5" title={`${matchCount}/${verifiedCount} verified features match the subject`}>
            {featureMatches.map((m) => (
              <span
                key={m.key}
                title={`${m.label}: ${m.state === 'match' ? 'match' : m.state === 'mismatch' ? 'mismatch' : 'no data'}${m.detail ? ` — ${m.detail}` : ''}`}
                className={cn('w-2 h-2 rounded-full flex-shrink-0', matchDotClass(m.state))}
              />
            ))}
            <span className="text-[9px] text-foreground-tertiary tabular-nums ml-auto">{matchCount}/{verifiedCount}</span>
          </div>
        )}
      </div>
    </div>
  )
}

// Memoized — a comp list can hold ~100 cards; without this any parent state
// change (pin, hover, sort) re-renders every card's image/detail subtree.
export const CompGridCard = memo(CompGridCardInner)
