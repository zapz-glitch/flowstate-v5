'use client'

import { memo, useMemo, useState } from 'react'
import { ChevronRight, Check, Loader2, CheckCircle2, AlertTriangle, XCircle, MapPin, Ruler, Clock, TrendingUp, Expand } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { subdivisionsMatch } from '@flowstate-api/shared'
import type { CompItem, SubjectData } from './shared-types'
import { StatCell } from './StatCell'
import { ClassificationBadge } from './ClassificationBadge'
import { PhotoGallery } from './PhotoGallery'
import { AddressDisplay } from './AddressDisplay'
import { formatFilterType, formatAdjustmentType, formatCurrency, getCompKey, fmtDeltaWords, formatLotSize } from './format-helpers'
import { compFeatureMatches, featureState, matchDotClass, matchTextClass } from './feature-match'
import { StreetViewImage } from './StreetViewImage'
import { RuleMatchDetails } from './RuleMatchDetails'
import { PhysicalCharacteristicsLine } from './PhysicalCharacteristicsLine'

function formatCensusTract(value?: string | null): string {
  if (!value) return '—'
  const tract = value.length >= 6 ? value.slice(-6) : value.padStart(6, '0')
  return `${tract.slice(0, 4)}.${tract.slice(4)}`
}

function formatBlockGroup(value?: string | null): string {
  return value ? value.slice(-1) : '—'
}

const normalizeGeoName = (value?: string | null) =>
  value?.toLowerCase().replace(/[^a-z0-9]/g, '') || null

function filterStatusLabel(status?: 'passed' | 'failed' | 'not_verified'): string {
  if (status === 'passed') return '✓ passed'
  if (status === 'failed') return '✗ failed'
  if (status === 'not_verified') return 'not verified'
  return 'not reported'
}

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
  /** Called with the card's comp key — stable identity lets the card memoize */
  onToggle?: (key: string) => void
  isSelectedForArv?: boolean
  /** Called with the card's comp key — stable identity lets the card memoize */
  onToggleArv?: (key: string) => void
  /** Pin this comp to a tier — 'arv' | 'as_is' | null clears. Present only when a jobId is available (Property Search). */
  onAssignTier?: (comp: CompItem, tier: 'arv' | 'as_is' | null) => void
  /** A tier assignment is in flight */
  tierPending?: boolean
}

function CompCardInner({
  comp,
  index,
  subject,
  subjectSubdivision,
  subjectLotAcres,
  isExpanded: controlledExpanded,
  onToggle: controlledOnToggle,
  isSelectedForArv,
  onToggleArv,
  onAssignTier,
  tierPending,
}: CompCardProps) {
  const [internalExpanded, setInternalExpanded] = useState(false)
  const cardKey = getCompKey(comp, index)

  const isControlled = controlledExpanded !== undefined
  const isExpanded = isControlled ? controlledExpanded : internalExpanded
  // When permanently expanded (no onToggle callback), disable collapsing
  const isAlwaysExpanded = isControlled && !controlledOnToggle
  const handleToggle = isAlwaysExpanded
    ? undefined
    : isControlled
      ? () => controlledOnToggle?.(cardKey)
      : () => setInternalExpanded((p) => !p)

  const hasArvSelection = isSelectedForArv !== undefined
  const isEnabled = hasArvSelection ? isSelectedForArv : comp.isEnabled !== false

  const subjectSubdiv = subject?.subdivision ?? subjectSubdivision
  const hasSubdivisionMatch = !!(
    subjectSubdiv &&
    comp.subdivision &&
    subdivisionsMatch(subjectSubdiv, comp.subdivision)
  )

  // Feature-vs-subject verification — green/red/neutral per displayable field
  const featureMatches = useMemo(() => compFeatureMatches(comp, subject), [comp, subject])
  const fm = (key: Parameters<typeof featureState>[1]) => featureState(featureMatches, key)
  const tractMatches = !!(subject?.censusTract && comp.censusTract === subject.censusTract)
  const blockGroupMatches = !!(
    subject?.censusBlockGroup && comp.censusBlockGroup === subject.censusBlockGroup
  ) || comp.sameBlockGroup === true
  const neighborhoodMatches = !!(
    subject?.neighborhoodName
    && comp.neighborhoodName
    && normalizeGeoName(subject.neighborhoodName) === normalizeGeoName(comp.neighborhoodName)
  )
  const geoMatched = tractMatches || blockGroupMatches || neighborhoodMatches || hasSubdivisionMatch

  return (
    <div
      data-card-key={cardKey}
      data-geo-matched={geoMatched ? 'true' : 'false'}
      className={cn(
        'transition-all duration-300 border border-border rounded-lg border-l-4',
        comp.bRole === 'anchor' || comp.bRole === 'driver' ? 'border-l-emerald-500'
          : comp.bRole === 'pool' ? 'border-l-sky-500'
          : 'border-l-neutral-600',
        comp.isBestComp && isEnabled && 'border-amber-500/40 ring-1 ring-amber-500/20',
        !isEnabled && 'opacity-70'
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

            {comp.bRole && (
              <div
                className={cn(
                  'h-6 px-1.5 rounded flex items-center text-[10px] font-bold flex-shrink-0',
                  comp.bRole === 'anchor' ? 'bg-amber-500/20 text-amber-500 ring-1 ring-amber-500/40'
                    : comp.bRole === 'driver' ? 'bg-emerald-500/15 text-emerald-600'
                    : comp.bRole === 'pool' ? 'bg-foreground/8 text-foreground-secondary'
                    : 'bg-muted text-foreground-tertiary'
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
                className="h-6 px-1.5 rounded flex items-center text-[10px] font-bold bg-violet-500/15 text-violet-500 flex-shrink-0"
                title={`Verified flip — bought $${comp.flip.priorSalePrice.toLocaleString()} ${comp.flip.daysHeld}d prior, resold +${comp.flip.gainPct}%`}
              >
                FLIP
              </div>
            )}
            {comp.userTier && (
              <div
                className={cn(
                  'h-6 px-1.5 rounded flex items-center text-[10px] font-bold flex-shrink-0',
                  comp.userTier === 'arv' ? 'bg-emerald-500/15 text-emerald-600' : 'bg-amber-500/15 text-amber-600'
                )}
                title={`You pinned this comp as ${comp.userTier === 'arv' ? 'ARV' : 'as-is'}`}
              >
                {comp.userTier === 'arv' ? 'ARV' : 'AS-IS'}·YOU
              </div>
            )}
            {comp.badges?.price && (
              <div
                className={cn(
                  'h-6 px-1.5 rounded flex items-center text-[10px] font-bold flex-shrink-0',
                  comp.badges.price === 'renovated' ? 'bg-emerald-500/15 text-emerald-600'
                    : comp.badges.price === 'as_is' ? 'bg-orange-500/15 text-orange-600'
                    : 'bg-blue-500/15 text-blue-600'
                )}
                title={comp.classification?.reasoning || `Sale price is ${comp.badges.price === 'renovated' ? 'ARV-grade' : comp.badges.price} evidence`}
              >
                {comp.badges.price === 'renovated' ? 'ARV'
                  : comp.badges.price === 'as_is' ? 'AS-IS'
                  : 'MEDIAN'}
              </div>
            )}
            {comp.badges?.trust && (
              <div
                className={cn(
                  'h-6 w-6 rounded flex items-center justify-center flex-shrink-0',
                  comp.badges.trust === 'verified' ? 'text-emerald-500'
                    : comp.badges.trust === 'partial' ? 'text-amber-500'
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
            {comp.badges?.pocket && comp.badges.pocket !== 'unknown' && (
              <span
                className={cn(
                  'h-6 px-1.5 rounded inline-flex items-center gap-0.5 text-[10px] font-medium flex-shrink-0',
                  comp.badges.pocket === 'in' ? 'bg-emerald-500/10 text-emerald-500'
                    : comp.badges.pocket === 'equal' ? 'bg-blue-500/10 text-blue-400'
                    : 'bg-muted text-foreground-tertiary'
                )}
                title={
                  comp.badges.pocket === 'in' ? 'In the pocket — census tract or block-group match'
                    : comp.badges.pocket === 'equal' ? 'Out of pocket — trades at the subject\u2019s level'
                    : comp.badges.pocket === 'above' ? 'Out of pocket — trades above the subject\u2019s market'
                    : 'Out of pocket — trades below the subject\u2019s market'
                }
              >
                <MapPin className="w-3 h-3" />
                {comp.badges.pocket === 'in' ? 'Pocket' : `Out ${comp.badges.pocket === 'equal' ? '=' : comp.badges.pocket === 'above' ? '>' : '<'}`}
              </span>
            )}
            {comp.badges && (
              <span
                className="h-6 px-1 rounded inline-flex items-center gap-1 flex-shrink-0"
                title={[
                  `${comp.badges.checks.pocket === true ? '✓' : '✗'} pocket`,
                  `${comp.badges.checks.size === true ? '✓' : '✗'} size`,
                  `${comp.badges.checks.fresh === true ? '✓' : '✗'} fresh sale`,
                  `${comp.badges.checks.priceFit === true ? '✓' : '✗'} price fits`,
                  ...(comp.badges.widenedOn.length ? [`widened in on: ${comp.badges.widenedOn.join(', ')}`] : []),
                ].join('\n')}
              >
                <Ruler className={cn('w-3 h-3', comp.badges.checks.size === true ? 'text-emerald-500' : 'text-foreground-tertiary/30')} />
                <Clock className={cn('w-3 h-3', comp.badges.checks.fresh === true ? 'text-emerald-500' : 'text-foreground-tertiary/30')} />
                <TrendingUp className={cn('w-3 h-3', comp.badges.checks.priceFit === true ? 'text-emerald-500' : 'text-foreground-tertiary/30')} />
                {comp.badges.widenedOn.length > 0 && <Expand className="w-3 h-3 text-amber-500" />}
              </span>
            )}
            {comp.curbAppeal && comp.curbAppeal.condition && comp.curbAppeal.condition !== 'unknown' && (
              <div
                className={cn(
                  'h-6 px-1.5 rounded flex items-center text-[10px] font-bold flex-shrink-0',
                  comp.curbAppeal.condition === 'renovated' ? 'bg-emerald-500/15 text-emerald-600'
                    : comp.curbAppeal.condition === 'dated' ? 'bg-amber-500/15 text-amber-600'
                    : 'bg-red-500/15 text-red-400'
                )}
                title={comp.curbAppeal.summary ?? `Clef condition: ${comp.curbAppeal.condition}`}
              >
                {comp.curbAppeal.condition === 'renovated' ? 'RENO'
                  : comp.curbAppeal.condition === 'dated' ? 'DATED'
                  : 'DISTRESSED'}
              </div>
            )}
            {comp.evidenceVerification &&
              (comp.evidenceVerification.priceCheck !== 'corroborated' || comp.evidenceVerification.staleness === 'stale') && (
              <div
                className={cn(
                  'h-6 px-1.5 rounded flex items-center text-[10px] font-bold flex-shrink-0',
                  comp.evidenceVerification.staleness === 'stale' ? 'bg-amber-500/15 text-amber-600'
                    : 'bg-red-500/15 text-red-400'
                )}
                title={(comp.evidenceVerification.flags ?? []).join('\n') || `Evidence: ${comp.evidenceVerification.priceCheck ?? ''} ${comp.evidenceVerification.staleness ?? ''}`}
              >
                {comp.evidenceVerification.staleness === 'stale' ? 'STALE'
                  : comp.evidenceVerification.priceCheck === 'divergent' ? 'DIVERGENT'
                  : comp.evidenceVerification.priceCheck === 'below_pocket' ? 'LOW'
                  : comp.evidenceVerification.priceCheck === 'above_pocket' ? 'HIGH'
                  : 'UNVERIFIED'}
              </div>
            )}
            {comp.sqftEvidence?.conflict && (
              <div
                className={cn(
                  'h-6 px-1.5 rounded flex items-center text-[10px] font-bold flex-shrink-0',
                  comp.sqftEvidence.resolution === 'unpermitted' ? 'bg-red-500/15 text-red-400' : 'bg-amber-500/15 text-amber-600'
                )}
                title={comp.sqftEvidence.note ?? `Sqft conflict: tax ${comp.sqftEvidence.provider ?? '?'}sf vs marketed ${comp.sqftEvidence.listing ?? '?'}sf`}
              >
                {comp.sqftEvidence.resolution === 'unpermitted' ? 'SQFT-EXCLUDED' : 'SQFT?'}
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
                onClick={(e) => { e.stopPropagation(); onToggleArv(cardKey) }}
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

        {/* Row 2: distance, subdivision, and actual geography values */}
        <div className="flex items-center gap-2 mt-1 text-[10px] text-foreground-tertiary flex-wrap pl-8">
          {comp.distanceMiles != null && <span>{comp.distanceMiles.toFixed(2)} mi</span>}
          {comp.subdivision && (
            <>
              <span className="text-border">·</span>
              <span className={cn(hasSubdivisionMatch && 'text-emerald-500')}>
                {hasSubdivisionMatch && '✓ '}{comp.subdivision}
              </span>
            </>
          )}
          {comp.adjustedPrice && comp.salePrice !== comp.adjustedPrice && (
            <><span className="text-border">·</span><span className="text-emerald-600">Adj: ${comp.adjustedPrice.toLocaleString()}</span></>
          )}
          <span className="text-border">·</span>
          <span className={cn(tractMatches && 'text-emerald-500')} title={comp.censusTract ?? 'Census tract unavailable'}>
            {tractMatches && '✓ '}Tract {formatCensusTract(comp.censusTract)}
          </span>
          <span className="text-border">·</span>
          <span className={cn(blockGroupMatches && 'text-emerald-500')} title={comp.censusBlockGroup ?? 'Census block group unavailable'}>
            {blockGroupMatches && '✓ '}BG {formatBlockGroup(comp.censusBlockGroup)}
          </span>
          <span className="text-border">·</span>
          <span className={cn(neighborhoodMatches && 'text-emerald-500')}>
            {neighborhoodMatches && '✓ '}Neighborhood {comp.neighborhoodName || '—'}
          </span>
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
              ? `${formatLotSize(comp.lotSizeAcres)}${subjectLotAcres != null ? ` (${fmtDeltaWords((comp.lotSizeAcres - subjectLotAcres) * 43560, 'sf')})` : ''}`
              : '-'
          }
        />
        <StatCell label="Style" value={comp.buildingStyle || '-'} match={fm('style')} />
        <StatCell label="Lot SqFt" value={comp.lotSizeSquareFeet != null ? comp.lotSizeSquareFeet.toLocaleString('en-US') : '-'} match={fm('lot')} />
      </div>

      {isExpanded && (
        <div className="px-5 pb-4 pt-2 space-y-4">
          {/* Manual tier pin — reviewer's call */}
          {comp.id && (
            <div className="flex items-center justify-between gap-3">
              {onAssignTier ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-caption text-foreground-tertiary mr-1">Assign</span>
                  {(['arv', 'as_is'] as const).map((tier) => {
                    const active = comp.userTier === tier
                    return (
                      <button
                        key={tier}
                        type="button"
                        disabled={tierPending}
                        onClick={() => onAssignTier(comp, active ? null : tier)}
                        title={active ? 'Clear your pin' : `Pin as ${tier === 'arv' ? 'ARV' : 'as-is'}`}
                        className={cn(
                          'h-6 px-2 rounded text-[10px] font-bold transition-colors disabled:opacity-50',
                          active
                            ? tier === 'arv' ? 'bg-emerald-500 text-white' : 'bg-amber-500 text-white'
                            : 'bg-foreground/8 text-foreground-secondary hover:bg-foreground/15'
                        )}
                      >
                        {tier === 'arv' ? 'ARV' : 'AS-IS'}
                      </button>
                    )
                  })}
                  {tierPending && <Loader2 className="w-3 h-3 animate-spin text-foreground-tertiary" />}
                </div>
              ) : <span />}
              {comp.id && (
                <span className="text-[10px] text-foreground-tertiary tabular-nums" title="Provider comp ID — reference this when flagging the comp">
                  #{comp.id}
                </span>
              )}
            </div>
          )}
          {/* Full property details — everything valid for comparison */}
          <div>
            <div className="text-caption font-medium text-foreground-secondary mb-1.5">Property Details</div>
            <div className="mb-2">
              <PhysicalCharacteristicsLine
                characteristics={comp.physicalCharacteristics}
                label="Construction comparison"
              />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1">
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
            </div>
          </div>

          {/* MLS details from Redfin — shadow evidence for geo-matched/display comps */}
          {comp.listingDetails && (() => {
            const ld = comp.listingDetails
            const cells = [
              ['MLS Bed/Bath', ld.beds != null || ld.bathsFull != null ? `${ld.beds ?? '-'}bd / ${ld.bathsFull ?? '-'}ba${ld.bathsHalf ? ` (+${ld.bathsHalf} half)` : ''}` : null],
              ['HOA / mo', ld.hoaMonthly != null ? `$${ld.hoaMonthly.toLocaleString()}` : null],
              ['Parking', ld.parking],
              ['Garage', ld.garage],
              ['Pool', ld.pool === true ? 'Yes' : ld.pool === false ? 'No' : null],
              ['MLS Roof', ld.roof],
              ['MLS Foundation', ld.foundation],
              ['MLS Construction', ld.construction],
              ['MLS Heat / AC', [ld.heating, ld.cooling].filter(Boolean).join(' / ') || null],
              ['Utilities', (ld.utilities ?? []).slice(0, 3).join(', ') || null],
              ['MLS Style', ld.style],
              ['Subdivision', ld.subdivision],
              ['Zoning', ld.zoning],
              ['Flooring', (ld.flooring ?? []).slice(0, 3).join(', ') || null],
              ['Appliances', (ld.appliances ?? []).slice(0, 3).join(', ') || null],
              ['Interior', (ld.interiorFeatures ?? []).slice(0, 3).join(', ') || null],
              ['Community', (ld.communityFeatures ?? []).slice(0, 3).join(', ') || null],
              ['Schools', (ld.schools ?? []).length > 0
                ? ld.schools!.map((s) => `${s.name.split(' ')[0]}${s.rating != null ? ` ${s.rating}/10` : ''}`).join(', ')
                : null],
              ['Climate', ld.climateRisks
                ? [
                    ld.climateRisks.floodFactor != null ? `Flood ${ld.climateRisks.floodFactor}/10` : null,
                    ld.climateRisks.fireFactor != null ? `Fire ${ld.climateRisks.fireFactor}/10` : null,
                    ld.climateRisks.heatFactor != null ? `Heat ${ld.climateRisks.heatFactor}/10` : null,
                    ld.climateRisks.windFactor != null ? `Wind ${ld.climateRisks.windFactor}/10` : null,
                    ld.climateRisks.airFactor != null ? `Air ${ld.climateRisks.airFactor}/10` : null,
                  ].filter(Boolean).join(', ') || null
                : null],
            ].filter(([, v]) => v != null && v !== '' && v !== '-') as Array<[string, string]>
            if (cells.length === 0) return null
            return (
              <div>
                <div className="text-caption font-medium text-foreground-secondary mb-1.5 flex items-center gap-2">
                  MLS Details{ld.mlsSource ? ` — ${ld.mlsSource}` : ''}
                  {ld.sourceUrl && <a href={ld.sourceUrl} target="_blank" rel="noreferrer" className="text-primary text-[10px] underline">Redfin ↗</a>}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1">
                  {cells.map(([label, value]) => (
                    <div key={label} className="flex items-center justify-between text-[11px]">
                      <span className="text-foreground-tertiary">{label}</span>
                      <span className="font-medium truncate ml-2" title={value}>{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}

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
                        'text-caption-sm px-2.5 py-1.5 rounded-lg',
                        filter.status === 'passed'
                          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                          : filter.status === 'failed'
                            ? 'bg-red-500/10 text-red-700 dark:text-red-400'
                            : 'bg-muted/50 text-foreground-tertiary'
                      )}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium">{formatFilterType(filter.type)}</span>
                        <span className="text-[10px]">{filterStatusLabel(filter.status)}</span>
                      </div>
                      {filter.reason && <div className="mt-0.5 opacity-80">{filter.reason}</div>}
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

// Memoized — a comp list can hold ~100 cards; without this any parent state
// change (pin, hover, sort) re-renders every card's image/detail subtree.
export const CompCard = memo(CompCardInner)
