'use client'

import { MapPin } from 'lucide-react'
import { CopyButton } from '@/components/ui/copy-button'
import type { SubjectData } from './shared-types'
import { StreetViewImage } from './StreetViewImage'
import { formatAddressCasing, formatBlockGroup, formatLotSize, formatShortDate, subjectStreetViewHref, titleCaseWords } from './format-helpers'
import { PropertyPermits } from './PropertyPermits'
import { PhotoGallery } from './PhotoGallery'
import { PhysicalCharacteristicsLine } from './PhysicalCharacteristicsLine'

interface SubjectGridCardProps {
  subject: SubjectData
  isLoading?: boolean
  /** Extra lines inside the card, under the facts (flood risk) */
  footer?: React.ReactNode
  /** Foot of the card, left · the selection stats for the comps on screen */
  stats?: React.ReactNode
  /** Foot of the card, right · the deal actions, one horizontal row */
  actions?: React.ReactNode
}

export function SubjectGridCard({ subject, isLoading, footer, stats, actions }: SubjectGridCardProps) {
  // Only geography we actually have · an empty value says nothing, so it is not drawn.
  const blockGroup = formatBlockGroup(subject.censusBlockGroup)
  // One name for the area · the neighborhood, or the subdivision when the
  // neighborhood is missing. Never both.
  const area = subject.neighborhoodName || subject.subdivision
  // The headline price and what it is. The last sale gets its own line when
  // a list price takes the headline.
  const headline = subject.listPrice ?? subject.lastSale?.price ?? null
  const lastSaleDate = subject.lastSale?.date ? formatShortDate(subject.lastSale.date) : null
  const headlineLabel = subject.listPrice != null
    ? 'List price'
    : headline != null ? `Last sale${lastSaleDate ? ` · ${lastSaleDate}` : ''}` : null
  const lastSale = subject.listPrice != null && subject.lastSale?.price ? subject.lastSale : null
  // Written like a comp's address: street, city, state · no ZIP (the copy button keeps it)
  const shortAddress = subject.address ? formatAddressCasing(subject.address.replace(/\s+\d{5}(-\d{4})?$/, '')) : null

  const streetViewUrl = subjectStreetViewHref(subject)
  const photo = (
    <StreetViewImage
      photos={subject.photos}
      address={subject.address}
      latitude={subject.latitude}
      longitude={subject.longitude}
      width={500}
      height={300}
      className="w-full h-full object-cover"
    />
  )
  const badge = (
    <div className="absolute top-2 left-2 flex items-center gap-1 px-1.5 py-0.5 rounded bg-primary/90 backdrop-blur-sm shadow-sm">
      <MapPin className="w-2.5 h-2.5 text-white" />
      <span className="text-[9px] font-semibold text-white uppercase tracking-wider">Subject</span>
    </div>
  )

  return (
    <div data-card-key="subject" className="border border-primary/30 rounded-sm overflow-hidden bg-primary/[0.02]">
      {/* Body: Image left + Details right */}
      <div className="subject-card-row">
        {/* Image with subject badge overlay */}
        <div className="subject-card-media relative bg-muted/30 overflow-hidden">
          {/* Clicking the photo opens Street View in a new tab, like the comp cards */}
          {streetViewUrl ? (
            <a href={streetViewUrl} target="_blank" rel="noopener noreferrer" className="block h-full w-full" title="Open Street View">
              {photo}
              {badge}
            </a>
          ) : (
            <>
              {photo}
              {badge}
            </>
          )}
        </div>

        {/* Details */}
        <div className="flex-1 min-w-0 px-4 py-2 flex flex-col justify-between">
          <div>
            {/* Address + price, then area + what the price is · the comp card's two lines */}
            <div className="flex items-baseline justify-between gap-2">
              <div className="min-w-0 flex items-center gap-1.5">
                {shortAddress ? (
                  <a
                    href={subject.listingUrl ?? `https://www.zillow.com/homes/${encodeURIComponent(subject.address!)}_rb/`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-body-sm font-semibold hover:text-primary hover:underline truncate"
                    title={subject.address ?? undefined}
                  >
                    {shortAddress}
                  </a>
                ) : (
                  <span className="text-body-sm font-semibold">Unknown Address</span>
                )}
                {subject.address && <CopyButton text={subject.address} title="Copy address" />}
              </div>
              {headline != null && (
                <span className="text-sm font-bold tabular-nums flex-shrink-0">${headline.toLocaleString()}</span>
              )}
            </div>
            {(area || blockGroup || headlineLabel) && (
              <div className="flex items-center justify-between gap-2 mt-0.5 text-[11px]">
                <span className="min-w-0 truncate text-foreground-secondary">
                  {area ? titleCaseWords(area) : ''}
                  {blockGroup && (
                    <span aria-label="Subject geography" title="Census block group" className="text-foreground-tertiary">
                      {area ? ' · ' : ''}Group {blockGroup}
                    </span>
                  )}
                </span>
                {headlineLabel && <span className="flex-shrink-0 text-foreground-tertiary tabular-nums">{headlineLabel}</span>}
              </div>
            )}
            {lastSale && (
              <div className="mt-0.5 text-[11px] text-foreground-tertiary tabular-nums">
                Last sold ${lastSale.price!.toLocaleString()}
                {lastSale.pricePerSqft ? ` · $${lastSale.pricePerSqft.toFixed(0)}/sf` : ''}
                {lastSaleDate ? ` · ${lastSaleDate}` : ''}
              </div>
            )}

            {/* Property stats — 3-column grid keeps the subject card ratio closer to comp cards */}
            <div className="subject-stats mt-1.5">
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="text-foreground-tertiary">Bed/Bath</span>
                <span className="font-medium">{subject.bedrooms ?? '-'}/{subject.bathrooms ?? '-'}</span>
              </div>
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="text-foreground-tertiary">Sq Ft</span>
                <span className="font-medium tabular-nums">{subject.squareFeet?.toLocaleString() || '-'}</span>
              </div>
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="text-foreground-tertiary">Year Built</span>
                <span className="font-medium">{subject.yearBuilt ?? '-'}</span>
              </div>
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="text-foreground-tertiary">Lot</span>
                <span className="font-medium">{formatLotSize(subject.lotSizeAcres)}</span>
              </div>
              {/* Starts under Sq Ft and runs two columns, so the condition is never cut short */}
              <div className="col-span-2 col-start-2 flex items-center gap-2 text-[11px]">
                <span className="text-foreground-tertiary">Condition</span>
                <span className="font-medium truncate" title={subject.conditionSummary ?? subject.curbAppeal?.summary ?? undefined}>
                  {subject.condition || 'NA'}
                </span>
              </div>
              {(subject.heating || subject.cooling) && (
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-foreground-tertiary">Heat / AC</span>
                  <span className="font-medium truncate ml-2">{[subject.heating, subject.cooling].filter(Boolean).join(' / ')}</span>
                </div>
              )}
              {subject.buildingCondition && (
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-foreground-tertiary">Assessor Cond.</span>
                  <span className="font-medium truncate ml-2">{subject.buildingCondition}{subject.buildingGrade ? ` · ${subject.buildingGrade} grade` : ''}</span>
                </div>
              )}
              {subject.additionSquareFeet != null && subject.additionSquareFeet > 0 && (
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="text-foreground-tertiary">Addition</span>
                  <span className="font-medium tabular-nums">{subject.additionSquareFeet.toLocaleString()} sf</span>
                </div>
              )}
            </div>
            {/* empty:hidden · the line can render nothing, and then it must not leave a gap */}
            <div className="mt-2 empty:hidden">
              <PhysicalCharacteristicsLine
                characteristics={subject.physicalCharacteristics}
                label="Subject construction"
              />
            </div>
            {footer}
            <PropertyPermits permits={subject.permits} loading={isLoading} />
            {subject.photos && subject.photos.length > 0 && (
              <PhotoGallery photos={subject.photos} compact className="mt-1.5" />
            )}
          </div>
        </div>
      </div>
      {/* Foot of the card: the comp selection stats beside the deal buttons. If they do not fit
          on one line the buttons drop under the stats. */}
      {(stats || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-t border-border/60 px-2 py-1">
          {stats && <div className="min-w-0 shrink-0">{stats}</div>}
          {actions}
        </div>
      )}
    </div>
  )
}
