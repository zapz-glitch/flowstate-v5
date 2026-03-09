import { MapPin } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { SubjectData } from './shared-types'
import { StatCell } from './StatCell'
import { ClassificationBadge } from './ClassificationBadge'
import { PhotoGallery } from './PhotoGallery'

export function SubjectPropertyCard({ subject }: { subject: SubjectData }) {
  return (
    <div className="rounded-xl overflow-hidden border border-border">
      <div className="px-6 py-5">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="text-caption-sm font-normal gap-1">
              <MapPin className="w-3 h-3" />
              Subject
            </Badge>
            <h3 className="text-heading-sm font-semibold leading-tight">{subject.address || 'Unknown Address'}</h3>
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

        <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-7 mt-4 rounded-lg bg-muted/40">
          <StatCell label="Beds" value={subject.bedrooms ?? '-'} />
          <StatCell label="Baths" value={subject.bathrooms ?? '-'} />
          <StatCell label="Sq Ft" value={subject.squareFeet?.toLocaleString() || '-'} />
          <StatCell label="Year" value={subject.yearBuilt || '-'} />
          <StatCell label="Lot" value={subject.lotSizeAcres ? `${subject.lotSizeAcres} ac` : '-'} />
          <StatCell label="Foundation" value={subject.foundationType || '-'} />
          <StatCell
            label="$/Sq Ft"
            value={subject.lastSale?.pricePerSqft ? `$${subject.lastSale.pricePerSqft.toFixed(0)}` : '-'}
          />
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

        {subject.photos && subject.photos.length > 0 && (
          <div className="mt-4">
            <PhotoGallery photos={subject.photos} />
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
