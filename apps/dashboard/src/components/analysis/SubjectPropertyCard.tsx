import type { ReactNode } from 'react'
import { MapPin } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { SubjectData } from './shared-types'
import { StatCell } from './StatCell'
import { ClassificationBadge } from './ClassificationBadge'
import { PhotoGallery } from './PhotoGallery'
import { AddressDisplay } from './AddressDisplay'
import { StreetViewImage } from './StreetViewImage'

interface SubjectPropertyCardProps {
  subject: SubjectData
  /** Optional inline content rendered inside the photo gallery row (e.g. upload tiles) */
  children?: ReactNode
  /** Optional content rendered below the photo row (e.g. AI findings) */
  footer?: ReactNode
}

export function SubjectPropertyCard({ subject, children, footer }: SubjectPropertyCardProps) {
  return (
    <div data-card-key="subject" className="overflow-hidden border border-border transition-all duration-300">
      <div className="px-6 py-5">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="text-caption-sm font-normal p-1">
              <MapPin className="w-3 h-3" />
            </Badge>
            {subject.address ? (
              <AddressDisplay address={subject.address} latitude={subject.latitude} longitude={subject.longitude} className="text-heading-sm font-semibold leading-tight" showStreetView={false} />
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

        <div className="flex flex-wrap mt-4 bg-muted/40">
          <StatCell label="Beds" value={subject.bedrooms ?? '-'} />
          <StatCell label="Baths" value={subject.bathrooms ?? '-'} />
          <StatCell label="Sq Ft" value={subject.squareFeet?.toLocaleString() || '-'} />
          <StatCell label="Year" value={subject.yearBuilt || '-'} />
          <StatCell label="Lot" value={subject.lotSizeAcres ? `${Number(subject.lotSizeAcres).toFixed(3)} ac` : '-'} />
          <StatCell label="Foundation" value={subject.foundationType || '-'} />
          <StatCell label="House Style" value={subject.buildingStyle || '-'} />
        </div>

        {subject.listingDetails && (() => {
          const ld = subject.listingDetails
          const cells = [
            ['MLS Bed/Bath', ld.beds != null || ld.bathsFull != null ? `${ld.beds ?? '-'}bd / ${ld.bathsFull ?? '-'}ba${ld.bathsHalf ? ` (+${ld.bathsHalf} half)` : ''}` : null],
            ['HOA / mo', ld.hoaMonthly != null ? `$${ld.hoaMonthly.toLocaleString()}` : null],
            ['Parking', ld.parking],
            ['Garage', ld.garage],
            ['Pool', ld.pool === true ? 'Yes' : ld.pool === false ? 'No' : null],
            ['Stories', ld.stories != null ? String(ld.stories) : null],
            ['Roof', ld.roof],
            ['Foundation', ld.foundation],
            ['Construction', ld.construction],
            ['Heat / AC', [ld.heating, ld.cooling].filter(Boolean).join(' / ') || null],
            ['Utilities', (ld.utilities ?? []).slice(0, 3).join(', ') || null],
            ['Subdivision', ld.subdivision],
            ['Zoning', ld.zoning],
            ['Style', ld.style],
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
            <div className="mt-4">
              <div className="text-caption font-medium text-foreground-secondary mb-1.5 flex items-center gap-2">
                MLS Details{ld.mlsSource ? ` · ${ld.mlsSource}` : ''}
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

        {/* Street View + Photos */}
        <div className="mt-4 space-y-2">
          <StreetViewImage
            photos={subject.photos}
            address={subject.address}
            latitude={subject.latitude}
            longitude={subject.longitude}
            width={640}
            height={360}
            className="w-full aspect-video object-cover bg-muted"
          />
          {((subject.photos && subject.photos.length > 0) || children) && (
            <PhotoGallery photos={subject.photos || []}>
              {children}
            </PhotoGallery>
          )}
        </div>

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
