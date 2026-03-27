import type { ReactNode } from 'react'
import { MapPin } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { SubjectData } from './shared-types'
import { StatCell } from './StatCell'
import { ClassificationBadge } from './ClassificationBadge'
import { PhotoGallery } from './PhotoGallery'
import { AddressDisplay } from './AddressDisplay'

interface SubjectPropertyCardProps {
  subject: SubjectData
  /** Optional inline content rendered inside the photo gallery row (e.g. upload tiles) */
  children?: ReactNode
  /** Optional content rendered below the photo row (e.g. AI findings) */
  footer?: ReactNode
}

export function SubjectPropertyCard({ subject, children, footer }: SubjectPropertyCardProps) {
  return (
    <div data-card-key="subject" className="rounded-xl overflow-hidden border border-border transition-all duration-300">
      <div className="px-6 py-5">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="text-caption-sm font-normal p-1">
              <MapPin className="w-3 h-3" />
            </Badge>
            {subject.address ? (
              <AddressDisplay address={subject.address} latitude={subject.latitude} longitude={subject.longitude} className="text-heading-sm font-semibold leading-tight" />
            ) : (
              <h3 className="text-heading-sm font-semibold leading-tight">Unknown Address</h3>
            )}
            {subject.classification && (
              <ClassificationBadge classification={subject.classification} />
            )}
          </div>
          {(subject.subdivision || subject.county) && (
            <div className="flex items-center gap-3 mt-1.5 text-caption text-foreground-tertiary">
              {subject.subdivision && (
                <span><span className="text-foreground-tertiary/60">Subdivision:</span> {subject.subdivision}</span>
              )}
              {subject.county && (
                <span><span className="text-foreground-tertiary/60">County:</span> {subject.county}</span>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-wrap mt-4 rounded-lg bg-muted/40">
          <StatCell label="Beds" value={subject.bedrooms ?? '-'} />
          <StatCell label="Baths" value={subject.bathrooms ?? '-'} />
          <StatCell label="Sq Ft" value={subject.squareFeet?.toLocaleString() || '-'} />
          <StatCell label="Year" value={subject.yearBuilt || '-'} />
          <StatCell label="Lot" value={subject.lotSizeAcres ? `${Number(subject.lotSizeAcres).toFixed(3)} ac` : '-'} />
          <StatCell label="Foundation" value={subject.foundationType || '-'} />
          <StatCell label="House Style" value={subject.buildingStyle || '-'} />
        </div>

        {subject.lastSale?.price && (
          <div className="mt-4 flex items-center justify-between text-body-sm">
            <span className="text-foreground-tertiary">Last Sale</span>
            <span>
              <span className="font-semibold">${subject.lastSale.price.toLocaleString()}</span>
              {subject.lastSale.date && (
                <span className="text-foreground-tertiary ml-2">({subject.lastSale.date})</span>
              )}
            </span>
          </div>
        )}

        {((subject.photos && subject.photos.length > 0) || children) && (
          <div className="mt-4">
            <PhotoGallery photos={subject.photos || []}>
              {children}
            </PhotoGallery>
          </div>
        )}

        {footer && (
          <div className="mt-4">
            {footer}
          </div>
        )}

        {subject.classification?.reasoning && (
          <div className="mt-4 p-3.5 rounded-xl bg-primary/5">
            <div className="text-caption font-medium text-primary mb-1">AI Classification</div>
            <div className="text-caption text-foreground-secondary leading-relaxed">{subject.classification.reasoning}</div>
          </div>
        )}
      </div>
    </div>
  )
}
