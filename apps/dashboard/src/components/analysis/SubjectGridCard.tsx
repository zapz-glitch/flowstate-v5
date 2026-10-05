'use client'

import { MapPin } from 'lucide-react'
import { cn } from '@/lib/utils'
import { CopyButton } from '@/components/ui/copy-button'
import type { SubjectData } from './shared-types'
import { StreetViewImage } from './StreetViewImage'
import { formatAddressCasing, formatBlockGroup, formatCensusTract, formatLotSize, formatShortDate, titleCaseWords } from './format-helpers'
import { PropertyPermits } from './PropertyPermits'
import { PhotoGallery } from './PhotoGallery'
import { PhysicalCharacteristicsLine } from './PhysicalCharacteristicsLine'

interface SubjectGridCardProps {
  subject: SubjectData
  isLoading?: boolean
}

export function SubjectGridCard({ subject, isLoading }: SubjectGridCardProps) {
  // Only geography we actually have · an empty value says nothing, so it is not drawn.
  const tract = formatCensusTract(subject.censusTract)
  const blockGroup = formatBlockGroup(subject.censusBlockGroup)
  const geography = [
    tract ? { label: 'Tract', value: tract, title: subject.censusTract ?? undefined } : null,
    blockGroup ? { label: 'Group', value: blockGroup, title: 'Census block group' } : null,
    subject.neighborhoodName ? { label: 'Neighborhood', value: titleCaseWords(subject.neighborhoodName), title: undefined } : null,
  ].filter((item): item is { label: string; value: string; title: string | undefined } => item !== null)

  return (
    <div data-card-key="subject" className="border border-primary/30 rounded-sm overflow-hidden bg-primary/[0.02]">
      {/* Body: Image left + Details right */}
      <div className="subject-card-row">
        {/* Image with subject badge overlay */}
        <div className="subject-card-media relative bg-muted/30 overflow-hidden">
          <StreetViewImage
            photos={subject.photos}
            address={subject.address}
            latitude={subject.latitude}
            longitude={subject.longitude}
            width={500}
            height={300}
            className="w-full h-full object-cover"
          />
          <div className="absolute top-2 left-2 flex items-center gap-1 px-1.5 py-0.5 rounded bg-primary/90 backdrop-blur-sm shadow-sm">
            <MapPin className="w-2.5 h-2.5 text-white" />
            <span className="text-[9px] font-semibold text-white uppercase tracking-wider">Subject</span>
          </div>
        </div>

        {/* Details */}
        <div className="flex-1 min-w-0 px-4 py-2.5 flex flex-col justify-between">
          <div>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  {subject.address ? (
                    <a
                      href={subject.listingUrl ?? `https://www.zillow.com/homes/${encodeURIComponent(subject.address)}_rb/`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-body-sm font-semibold hover:text-primary hover:underline truncate"
                      title={subject.listingUrl ? 'Open listing' : 'Search on Zillow'}
                    >
                      {formatAddressCasing(subject.address)}
                    </a>
                  ) : (
                    <span className="text-body-sm font-semibold">Unknown Address</span>
                  )}
                  {subject.address && <CopyButton text={subject.address} title="Copy address" />}
                </div>
                {subject.subdivision && (
                  <div className="flex items-center gap-1 mt-1 flex-wrap">
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-primary/10 text-primary border border-primary/20">
                      {subject.subdivision}
                    </span>
                  </div>
                )}
                {geography.length > 0 && (
                  <div className="flex items-center gap-x-3 gap-y-0.5 mt-1 text-[11px] flex-wrap" aria-label="Subject geography">
                    {geography.map((item) => (
                      <span key={item.label} className="whitespace-nowrap" title={item.title}>
                        <span className="text-foreground-tertiary">{item.label}</span>{' '}
                        <span className="font-medium text-foreground-secondary">{item.value}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {(subject.listPrice != null || subject.lastSale?.price) && (
                <div className="text-right flex-shrink-0">
                  {subject.listPrice != null && (
                    <>
                      <div className="text-sm font-bold tabular-nums">${subject.listPrice.toLocaleString()}</div>
                      <div className="text-[9px] text-foreground-tertiary">List Price</div>
                    </>
                  )}
                  {subject.lastSale?.price && (
                    <div className={subject.listPrice != null ? 'mt-1' : ''}>
                      <div className="text-[11px] font-medium tabular-nums text-foreground-secondary">${subject.lastSale.price.toLocaleString()}</div>
                      <div className="text-[9px] text-foreground-tertiary tabular-nums">
                        {subject.lastSale.pricePerSqft ? `$${subject.lastSale.pricePerSqft.toFixed(0)}/sf · ` : ''}
                        {subject.lastSale.date ? formatShortDate(subject.lastSale.date) : 'Last Sale'}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Property stats — 3-column grid keeps the subject card ratio closer to comp cards */}
            <div className="subject-stats mt-2.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-foreground-tertiary">Bed/Bath</span>
                <span className="font-medium">{subject.bedrooms ?? '-'}/{subject.bathrooms ?? '-'}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-foreground-tertiary">Sq Ft</span>
                <span className="font-medium tabular-nums">{subject.squareFeet?.toLocaleString() || '-'}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-foreground-tertiary">Year Built</span>
                <span className="font-medium">{subject.yearBuilt ?? '-'}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-foreground-tertiary">Lot</span>
                <span className="font-medium">{formatLotSize(subject.lotSizeAcres)}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-foreground-tertiary">Condition</span>
                <span className="font-medium truncate ml-2" title={subject.conditionSummary ?? subject.curbAppeal?.summary ?? undefined}>
                  {subject.condition || 'NA'}
                </span>
              </div>
              {(subject.heating || subject.cooling) && (
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-foreground-tertiary">Heat / AC</span>
                  <span className="font-medium truncate ml-2">{[subject.heating, subject.cooling].filter(Boolean).join(' / ')}</span>
                </div>
              )}
              {subject.buildingCondition && (
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-foreground-tertiary">Assessor Cond.</span>
                  <span className="font-medium truncate ml-2">{subject.buildingCondition}{subject.buildingGrade ? ` · ${subject.buildingGrade} grade` : ''}</span>
                </div>
              )}
              {subject.additionSquareFeet != null && subject.additionSquareFeet > 0 && (
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-foreground-tertiary">Addition</span>
                  <span className="font-medium tabular-nums">{subject.additionSquareFeet.toLocaleString()} sf</span>
                </div>
              )}
            </div>
            <div className="mt-2">
              <PhysicalCharacteristicsLine
                characteristics={subject.physicalCharacteristics}
                label="Subject construction"
              />
            </div>
            <PropertyPermits permits={subject.permits} loading={isLoading} />
            {subject.photos && subject.photos.length > 0 && (
              <PhotoGallery photos={subject.photos} className="mt-2" />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
