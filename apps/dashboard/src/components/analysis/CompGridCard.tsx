'use client'

import { memo, useMemo } from 'react'
import { Check, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { subdivisionsMatch } from '@flowstate-api/shared'
import { CopyButton } from '@/components/ui/copy-button'
import type { CompItem, SubjectData } from './shared-types'
import { StreetViewImage } from './StreetViewImage'
import { RuleMatchDetails } from './RuleMatchDetails'
import { sqftMatchColor, yearMatchColor, lotMatchColor, fmtDelta, fmtLotDelta, formatShortDate, formatLotSize } from './format-helpers'
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

  // Jev score /100 — the exam score when the comp was cross-examined, else
  // the raw-data screen score. poolRank 1 = closest to the rule truth.
  const jevScore = comp.jevHybrid?.score ?? null
  const isTopMatch = comp.jevHybrid?.poolRank === 1

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
          {jevScore != null && (
            <div
              className={cn(
                'h-6 px-1.5 rounded-sm flex items-center text-[10px] font-bold tabular-nums',
                jevScore >= 70 ? 'bg-emerald-500/90 text-white'
                  : jevScore >= 40 ? 'bg-amber-500/90 text-white'
                  : 'bg-red-500/80 text-white'
              )}
              title={`Jev score ${jevScore}/100 — ${comp.jevHybrid?.test2 ? (comp.jevHybrid.test2.passed ? 'passed test 2 — eligible for the core set' : 'failed test 2 — scored on distance to subject') : comp.jevHybrid?.test1 ? 'failed test 1' : 'not tested'}${comp.jevHybrid?.test2?.confidence != null ? ` · confidence ${Math.round(comp.jevHybrid.test2.confidence * 100)}%` : ''}`}
            >
              {jevScore}
            </div>
          )}
          {isTopMatch && (
            <div
              className="h-6 px-1.5 rounded-sm flex items-center text-[10px] font-bold bg-primary/90 text-white"
              title="Highest-scoring comp in the Jev cross-examination — closest to the appraisal-rule truth"
            >
              TOP
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
              title={`You pinned this comp as ${comp.userTier === 'arv' ? 'ARV' : 'as-is'} — Jev classified it ${comp.jevHybrid?.priceTier === 'arv' ? 'ARV' : comp.jevHybrid?.priceTier === 'as_is' ? 'as-is' : 'unclassified'}`}
            >
              {comp.userTier === 'arv' ? 'ARV' : 'AS-IS'}·YOU
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
        {/* Distance + Adj price */}
        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
          {comp.distanceMiles != null && (
            <span className="text-[9px] text-foreground-tertiary tabular-nums">{comp.distanceMiles.toFixed(2)} mi</span>
          )}
          {comp.adjustedPrice != null && comp.adjustedPrice !== comp.salePrice && (
            <span className="text-[10px] font-medium text-emerald-500 tabular-nums ml-auto">Adj ${comp.adjustedPrice.toLocaleString()}</span>
          )}
        </div>

        {/* Manual tier pin — reviewer's call, rides alongside Jev's */}
        {onAssignTier && comp.id && (
          <div
            className="flex items-center gap-1 mt-1.5"
            onClick={(e) => e.stopPropagation()}
          >
            {(['arv', 'as_is'] as const).map((tier) => {
              const active = comp.userTier === tier
              return (
                <button
                  key={tier}
                  type="button"
                  disabled={tierPending}
                  onClick={() => onAssignTier(comp, active ? null : tier)}
                  title={active ? 'Clear your pin' : `Pin as ${tier === 'arv' ? 'ARV' : 'as-is'}${comp.id ? ` — comp ${comp.id}` : ''}`}
                  className={cn(
                    'h-5 px-1.5 rounded text-[9px] font-bold transition-colors disabled:opacity-50',
                    active
                      ? tier === 'arv' ? 'bg-emerald-500 text-white' : 'bg-amber-500 text-white'
                      : 'bg-foreground/8 text-foreground-tertiary hover:bg-foreground/15'
                  )}
                >
                  {tier === 'arv' ? 'ARV' : 'AS-IS'}
                </button>
              )
            })}
            {comp.id && (
              <span className="text-[8px] text-foreground-tertiary tabular-nums ml-auto" title="Provider comp ID">
                #{comp.id}
              </span>
            )}
          </div>
        )}

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
            <span className="text-foreground-tertiary">Lot</span>
            <span className="font-medium tabular-nums">
              {formatLotSize(comp.lotSizeAcres)}
              {lotDelta != null && <span className={cn('ml-1 text-[9px]', lotColor)}>({fmtLotDelta(comp.lotSizeAcres!, subject!.lotSizeAcres!)})</span>}
            </span>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-foreground-tertiary">Style</span>
            <span className={cn('font-medium truncate ml-2', matchTextClass(featureState(featureMatches, 'style')))}>{comp.buildingStyle || '-'}</span>
          </div>
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
