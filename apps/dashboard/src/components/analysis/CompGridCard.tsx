'use client'

import { memo, useMemo, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CopyButton } from '@/components/ui/copy-button'
import type { CompItem, SubjectData } from './shared-types'
import { StreetViewImage } from './StreetViewImage'
import { RuleMatchDetails } from './RuleMatchDetails'
import {
  MATCH_TEXT,
  PRICE_STAMP_CLASS,
  ROLE_STAMP_CLASS,
  VERDICT_EDGE_CLASS,
  conditionLabel,
  conflictNote,
  fmtDeltaWords,
  formatAddressCasing,
  formatLotSize,
  formatShortDate,
  lotMatchColor,
  priceClassLabel,
  roleTitle,
  roleWord,
  scopeLabel,
  scopeToneClass,
  sqftMatchColor,
  streetViewHref,
  trustLabel,
  trustTitle,
  verdictOf,
  widenedRules,
  widenedTitle,
  yearMatchColor,
  zillowHref,
} from './format-helpers'
import { compFeatureMatches, featureState, matchTextClass } from './feature-match'

export interface CompGridCardProps {
  comp: CompItem
  index: number
  subject?: SubjectData | null
  isSelectedForArv?: boolean
  /** Called with the card's comp key · stable identity lets the card memoize */
  onToggleArv?: (key: string) => void
  onCompClick?: (comp: CompItem) => void
  /** Called with the card's comp key on enter, null on leave */
  onHover?: (key: string | null) => void
  isHighlighted?: boolean
}

/** Photo stamp · opaque colored chip with white text so it reads on any photo */
const STAMP = 'h-[22px] px-1.5 rounded-sm flex items-center text-[11px] font-bold tracking-wide shadow-sm'

/** "Label value" pair on one line · gray label, strong value */
function Pair({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <span className="whitespace-nowrap" title={title}>
      <span className="text-foreground-tertiary">{label}</span>{' '}
      <span className="font-medium text-foreground">{value}</span>
    </span>
  )
}

/** One property fact · the difference from the subject sits on its own line
 *  under the value so it never truncates in a narrow card. */
function Fact({ label, value, valueClass, title, delta, deltaClass }: {
  label: string
  value: ReactNode
  valueClass?: string
  title?: string
  delta?: string | null
  deltaClass?: string | null
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-foreground-tertiary flex-shrink-0">{label}</span>
        <span className={cn('font-medium tabular-nums truncate', valueClass)} title={title}>{value}</span>
      </div>
      {delta && (
        <div className={cn('text-right whitespace-nowrap leading-tight', deltaClass ?? 'text-foreground-tertiary')}>{delta}</div>
      )}
    </div>
  )
}

function CompGridCardInner({
  comp,
  index,
  subject,
  isSelectedForArv,
  onToggleArv,
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

  // Feature-vs-subject verification · drives the Style tone and the scope name
  const featureMatches = useMemo(() => compFeatureMatches(comp, subject), [comp, subject])
  const scope = useMemo(() => scopeLabel(comp, subject, featureMatches), [comp, subject, featureMatches])

  const verdict = verdictOf(comp.bRole, isEnabled)
  const role = roleWord(comp.bRole)
  const priceClass = priceClassLabel(comp.badges?.price)
  const trust = trustLabel(comp.badges?.trust)
  const widened = widenedRules(comp.badges)
  const conflict = conflictNote(comp)
  const hasAdjusted = comp.adjustedPrice != null && comp.adjustedPrice !== comp.salePrice
  const streetViewUrl = streetViewHref(comp)
  const zillowUrl = zillowHref(comp)
  const fullAddress = [comp.address, comp.city, comp.state, comp.zipCode].filter(Boolean).join(', ')
  const meta = [
    comp.distanceMiles != null ? `${comp.distanceMiles.toFixed(2)} mi` : null,
    comp.pricePerSqft ? `$${comp.pricePerSqft.toFixed(0)}/sf` : null,
  ].filter(Boolean).join(' · ')

  const photo = (
    <StreetViewImage
      photos={comp.photos}
      address={fullAddress}
      latitude={comp.latitude}
      longitude={comp.longitude}
      width={640}
      height={427}
      className="w-full h-full object-cover"
    />
  )

  return (
    <div
      data-card-key={cardKey}
      data-verdict={verdict}
      onMouseEnter={() => onHover?.(cardKey)}
      onMouseLeave={() => onHover?.(null)}
      className={cn(
        // isolate · the edge and stamps layer inside the card, never over the sticky valuation box
        'relative isolate border border-border rounded-sm overflow-hidden transition-all duration-200 group',
        isEnabled ? 'hover:border-foreground/20' : 'opacity-70 hover:opacity-100',
        comp.isBestComp && isEnabled && 'ring-1 ring-emerald-500/40',
        isHighlighted && 'ring-2 ring-primary/50 shadow-lg shadow-primary/5',
      )}
    >
      {/* Verdict edge · green feeds the ARV, gray supports it, hatched is out.
          A positioned strip (not a border) so hover and rings never repaint it. */}
      <span
        aria-hidden
        data-verdict-edge
        className={cn('absolute inset-y-0 left-0 w-[3px] z-10 pointer-events-none', VERDICT_EDGE_CLASS[verdict])}
      />

      {/* Photo · clicks through to Street View. A wide 2:1 crop keeps the
          house and its curb appeal in frame while the card stays short. */}
      <div className="relative aspect-[2/1] bg-muted/30 overflow-hidden">
        {streetViewUrl ? (
          <a href={streetViewUrl} target="_blank" rel="noopener noreferrer" className="block w-full h-full" title="Open Street View">
            {photo}
          </a>
        ) : photo}

        {/* Stamps · number, role, flip, price class. Kept clear of the checkbox. */}
        <div className="absolute top-2 left-2.5 flex flex-wrap items-center gap-1 max-w-[calc(100%-3.25rem)] pointer-events-none">
          {/* Number · green when the comp is in the ARV, gray when it is not */}
          <div className={cn(STAMP, 'w-[22px] px-0 justify-center tabular-nums', isEnabled ? 'bg-emerald-600 text-white' : 'bg-neutral-600 text-white')}>
            {index + 1}
          </div>
          {role && comp.bRole && (
            <div className={cn(STAMP, ROLE_STAMP_CLASS[comp.bRole])} title={roleTitle(comp.bRole)}>{role}</div>
          )}
          {comp.flip && (
            <div
              className={cn(STAMP, 'bg-violet-600 text-white')}
              title={`Verified flip · bought $${comp.flip.priorSalePrice.toLocaleString()} ${comp.flip.daysHeld}d prior, resold +${comp.flip.gainPct}%`}
            >
              FLIP
            </div>
          )}
          {comp.badges?.price && priceClass && (
            <div
              className={cn(STAMP, PRICE_STAMP_CLASS[comp.badges.price])}
              title={comp.classification?.reasoning || `Price class ${priceClass}`}
            >
              {priceClass.toUpperCase()}
            </div>
          )}
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
                ? 'bg-emerald-600 border-emerald-600 text-white'
                : 'border-white/90 bg-neutral-900/70 text-white/60 shadow-sm hover:border-emerald-400'
            )}>
              <Check className="w-3 h-3" />
            </span>
          </button>
        )}
      </div>

      {/* Body · clicks open the full comp detail */}
      <div className="pl-3.5 pr-3 py-2.5 cursor-pointer text-[11px]" onClick={() => onCompClick?.(comp)}>
        {/* Address (Zillow link + copy) left, sale price right */}
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0 flex items-center gap-1">
            {comp.address && zillowUrl ? (
              <a
                href={zillowUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-body-sm font-semibold text-foreground truncate rounded px-0.5 -mx-0.5 transition-colors hover:text-emerald-600 hover:bg-emerald-500/10 active:scale-[0.98] dark:hover:text-emerald-400"
                title={`${formatAddressCasing(comp.address)} · open on Zillow`}
              >
                {formatAddressCasing(comp.address)}
              </a>
            ) : (
              <span className="text-body-sm font-semibold text-foreground truncate" title={comp.address || undefined}>
                {comp.address ? formatAddressCasing(comp.address) : 'Unknown'}
              </span>
            )}
            {comp.address && <CopyButton text={comp.address} title="Copy address" className="flex-shrink-0" />}
          </div>
          <span className="text-sm font-bold text-foreground tabular-nums flex-shrink-0">
            {comp.salePrice != null ? `$${comp.salePrice.toLocaleString()}` : '-'}
          </span>
        </div>

        {/* Scope · matching name left, tightest scope word right */}
        <div className="flex items-center justify-between gap-2 mt-0.5">
          <span className="text-foreground-tertiary truncate">{scope.matchedName ?? ''}</span>
          <span className={cn('font-medium flex-shrink-0', scopeToneClass(scope.tone))} title={scope.title}>
            {scope.word}
          </span>
        </div>

        {/* Server verdicts · each on its own axis */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1.5">
          <Pair label="Condition" value={conditionLabel(comp.badges?.condition)} title={comp.curbAppeal?.summary ?? undefined} />
          {priceClass && <Pair label="Price" value={priceClass} title={comp.classification?.reasoning || undefined} />}
          {trust && <Pair label="Trust" value={trust} title={trustTitle(comp.badges?.trust)} />}
        </div>

        {/* Distance and rate left, relaxed-rule flag, adjusted value right */}
        {(meta || widened.length > 0 || hasAdjusted) && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
            {meta && <span className="text-foreground-tertiary tabular-nums">{meta}</span>}
            {widened.length > 0 && (
              <span className="font-medium text-amber-600 dark:text-amber-400" title={widenedTitle(widened)}>Widened</span>
            )}
            {hasAdjusted && (
              <span className={cn('ml-auto font-medium tabular-nums', MATCH_TEXT)}>
                Adjusted ${comp.adjustedPrice!.toLocaleString()}
              </span>
            )}
          </div>
        )}

        {conflict && (
          <p className="mt-0.5 text-foreground-tertiary leading-snug" title={comp.classification?.reasoning || undefined}>
            {conflict}
          </p>
        )}

        <RuleMatchDetails comp={comp} />

        {/* Property facts · three rows, differences from the subject underneath */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2 pt-2 border-t border-border/60">
          <Fact label="Bed/Bath" value={`${comp.bedrooms ?? '-'}/${comp.bathrooms ?? '-'}`} />
          <Fact
            label="Sq Ft"
            value={comp.squareFeet?.toLocaleString() || '-'}
            delta={sqftDelta != null ? fmtDeltaWords(sqftDelta, 'sf') : null}
            deltaClass={sqftColor}
          />
          <Fact
            label="Year"
            value={comp.yearBuilt ?? '-'}
            delta={yearDelta != null ? fmtDeltaWords(yearDelta, 'yrs', 'newer', 'older') : null}
            deltaClass={yearColor}
          />
          <Fact
            label="Lot"
            value={formatLotSize(comp.lotSizeAcres)}
            title={comp.lotSizeSquareFeet != null ? `${comp.lotSizeSquareFeet.toLocaleString('en-US')} sq ft` : undefined}
            delta={lotDelta != null ? fmtDeltaWords(lotDelta * 43560, 'sf') : null}
            deltaClass={lotColor}
          />
          <Fact
            label="Style"
            value={comp.buildingStyle || '-'}
            valueClass={cn('capitalize', matchTextClass(featureState(featureMatches, 'style')))}
            title={comp.buildingStyle || undefined}
          />
          <Fact label="Sold" value={formatShortDate(comp.saleDate)} />
        </div>
      </div>
    </div>
  )
}

// Memoized · a comp list can hold ~100 cards; without this any parent state
// change (hover, tier, selection) re-renders every card's image/detail subtree.
export const CompGridCard = memo(CompGridCardInner)
