'use client'

import { MapPin } from 'lucide-react'
import type { SubjectData } from './shared-types'
import { StreetViewImage } from './StreetViewImage'
import { AddressDisplay } from './AddressDisplay'
import { formatShortDate } from './format-helpers'
import { PropertyPermits } from './PropertyPermits'

interface SubjectGridCardProps {
  subject: SubjectData
  isLoading?: boolean
}

export function SubjectGridCard({ subject, isLoading }: SubjectGridCardProps) {
  return (
    <div data-card-key="subject" className="border border-primary/30 rounded-sm overflow-hidden bg-primary/[0.02]">
      {/* Body: Image left + Details right */}
      <div className="flex flex-col sm:flex-row">
        {/* Image with subject badge overlay */}
        <div className="relative w-full sm:w-56 h-28 sm:h-auto flex-shrink-0 bg-muted/30 overflow-hidden">
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
                {subject.address ? (
                  <AddressDisplay address={subject.address} latitude={subject.latitude} longitude={subject.longitude} className="text-body-sm font-semibold" showStreetView={false} />
                ) : (
                  <span className="text-body-sm font-semibold">Unknown Address</span>
                )}
                {subject.subdivision && (
                  <span className="inline-flex items-center gap-1 mt-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-primary/10 text-primary border border-primary/20 truncate max-w-full">
                    {subject.subdivision}
                  </span>
                )}
              </div>
              {subject.lastSale?.price && (
                <div className="text-right flex-shrink-0">
                  <div className="text-sm font-bold tabular-nums">${subject.lastSale.price.toLocaleString()}</div>
                  <div className="text-[9px] text-foreground-tertiary tabular-nums">
                    {subject.lastSale.pricePerSqft ? `$${subject.lastSale.pricePerSqft.toFixed(0)}/sf · ` : ''}
                    {subject.lastSale.date ? formatShortDate(subject.lastSale.date) : 'Last Sale'}
                  </div>
                </div>
              )}
            </div>

            {/* Property stats — 3-column grid keeps the subject card ratio closer to comp cards */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 mt-2.5">
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
                <span className="font-medium">{subject.lotSizeAcres ? `${Number(subject.lotSizeAcres).toFixed(3)} ac` : '-'}</span>
              </div>
              {subject.buildingStyle && (
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-foreground-tertiary">Style</span>
                  <span className="font-medium truncate ml-2">{subject.buildingStyle}</span>
                </div>
              )}
              {subject.foundationType && (
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-foreground-tertiary">Foundation</span>
                  <span className="font-medium truncate ml-2">{subject.foundationType}</span>
                </div>
              )}
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-foreground-tertiary">Condition</span>
                <span className="font-medium truncate ml-2">{subject.condition || 'NA'}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-foreground-tertiary">Pool</span>
                <span className="font-medium">{subject.pool ? 'Yes' : '-'}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-foreground-tertiary">Garage</span>
                <span className="font-medium">{subject.garage ? 'Yes' : '-'}</span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-foreground-tertiary">Carport</span>
                <span className="font-medium">{subject.carport ? 'Yes' : '-'}</span>
              </div>
            </div>
            <PropertyPermits permits={subject.permits} loading={isLoading} />
          </div>
        </div>
      </div>
    </div>
  )
}
