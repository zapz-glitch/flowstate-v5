'use client'

import { useMemo, useCallback, useState } from 'react'
import dynamic from 'next/dynamic'
import type { SubjectData, CompItem } from './shared-types'
import { getCompKey } from './format-helpers'
import { isValidCoordinate } from '@/lib/property-map-geometry'

const MapInner = dynamic(() => import('./PropertyMapInner'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[400px] rounded-lg bg-secondary/30 flex items-center justify-center text-foreground-tertiary text-body-sm">
      Loading map…
    </div>
  ),
})

export interface MapMarker {
  lat: number
  lng: number
  type: 'subject' | 'comp-arv' | 'comp-market' | 'comp-floor' | 'comp-disabled'
  label: string
  /** Comp key for toggling ARV selection (comp markers only) */
  compKey?: string
}

interface PropertyMapProps {
  subject?: SubjectData | null
  comps?: { items?: CompItem[] } | null
  /** Manual comp selection keys — when provided, overrides comp.isEnabled */
  selectedCompKeys?: Set<string>
  /** Called when a marker is clicked — parent scrolls to the corresponding card */
  onMarkerSelect?: (type: 'subject' | 'comp', compKey?: string) => void
  /** Currently highlighted marker key ('subject' or a comp key) */
  activeMarkerKey?: string | null
}

export function PropertyMap({ subject, comps, selectedCompKeys, onMarkerSelect, activeMarkerKey }: PropertyMapProps) {
  const markers = useMemo(() => {
    const m: MapMarker[] = []

    // Subject property
    if (subject && isValidCoordinate({ lat: subject.latitude, lng: subject.longitude })) {
      m.push({
        lat: subject.latitude!,
        lng: subject.longitude!,
        type: 'subject',
        label: subject.address ?? 'Subject Property',
      })
    }

    // Comps
    if (comps?.items) {
      for (let i = 0; i < comps.items.length; i++) {
        const comp = comps.items[i]
        if (isValidCoordinate({ lat: comp.latitude, lng: comp.longitude })) {
          const compKey = getCompKey(comp, i)
          const enabled = selectedCompKeys ? selectedCompKeys.has(compKey) : comp.isEnabled !== false
          // Marker color = evidence class, not enabled state — green = ARV
          // evidence, orange = market/median, red = investor floor.
          const cls = comp.classification?.type
          m.push({
            lat: comp.latitude!,
            lng: comp.longitude!,
            type: !enabled ? 'comp-disabled'
              : cls === 'after_renovation' ? 'comp-arv'
              : cls === 'as_is' ? 'comp-floor'
              : 'comp-market',
            label: comp.address ?? 'Comparable',
            compKey,
          })
        }
      }
    }

    return m
  }, [subject, comps, selectedCompKeys])

  const compByKey = useMemo(() => {
    const map = new Map<string, CompItem>()
    comps?.items?.forEach((comp, i) => map.set(getCompKey(comp, i), comp))
    return map
  }, [comps])

  const [hoveredComp, setHoveredComp] = useState<CompItem | null>(null)
  const handleMarkerHover = useCallback((marker: MapMarker | null) => {
    setHoveredComp(marker && marker.type !== 'subject' && marker.compKey ? compByKey.get(marker.compKey) ?? null : null)
  }, [compByKey])

  const handleMarkerClick = useCallback((markerType: 'subject' | 'comp', compKey?: string) => {
    onMarkerSelect?.(markerType, compKey)
  }, [onMarkerSelect])

  if (!markers.some(marker => marker.type === 'subject')) return null

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
    <MapInner
      key={`${subject?.address}|${subject?.latitude}|${subject?.longitude}`}
      markers={markers}
      onMarkerClick={handleMarkerClick}
      onMarkerHover={handleMarkerHover}
      activeMarkerKey={activeMarkerKey}
    />
      {hoveredComp && (
        <CompHoverCard comp={hoveredComp} onMouseEnter={() => setHoveredComp(hoveredComp)} onMouseLeave={() => setHoveredComp(null)} />
      )}
    </div>
  )
}

function fmt$(n?: number | null) { return n != null ? `$${n.toLocaleString()}` : '-' }
function fmtNum(n?: number | null, suffix = '') { return n != null ? `${n.toLocaleString()}${suffix}` : '-' }

/** Full comp detail card shown on marker hover — every field the card
 *  grid carries, overlaid on the map; dismisses when the mouse leaves it. */
function CompHoverCard({ comp, onMouseEnter, onMouseLeave }: { comp: CompItem; onMouseEnter: () => void; onMouseLeave: () => void }) {
  const cls = comp.classification?.type
  const clsLabel = cls === 'after_renovation' ? 'ARV' : cls === 'as_is' ? 'Floor' : cls === 'transitional' ? 'Transitional' : 'Unclassified'
  const clsColor = cls === 'after_renovation' ? 'text-emerald-500' : cls === 'as_is' ? 'text-red-400' : 'text-amber-400'
  const rows: Array<[string, string]> = [
    ['Sale Price', fmt$(comp.salePrice)],
    ['Sale Date', comp.saleDate?.slice(0, 10) ?? '-'],
    ['Adjusted', comp.adjustedPrice ? fmt$(comp.adjustedPrice) : '-'],
    ['ATTOM AVM', fmt$(comp.avmValue)],
    ['Beds/Baths', comp.bedrooms != null || comp.bathrooms != null ? `${comp.bedrooms ?? '-'}bd / ${comp.bathrooms ?? '-'}ba` : '-'],
    ['Living Area', fmtNum(comp.squareFeet, ' sf')],
    ['Price / sf', comp.pricePerSqft != null ? `$${comp.pricePerSqft.toFixed(0)}` : '-'],
    ['Lot', comp.lotSizeSquareFeet ? fmtNum(comp.lotSizeSquareFeet, ' sf') : comp.lotSizeAcres ? `${comp.lotSizeAcres.toFixed(2)} ac` : '-'],
    ['Year Built', fmtNum(comp.yearBuilt)],
    ['Distance', comp.distanceMiles != null ? `${comp.distanceMiles.toFixed(2)} mi` : '-'],
    ['Style', comp.buildingStyle ?? '-'],
    ['Stories', comp.storiesType ?? '-'],
    ['Subdivision', comp.subdivision ?? '-'],
    ['Neighborhood', comp.neighborhoodName ?? '-'],
    ['Condition', (comp.curbAppeal?.condition ?? comp.condition ?? '-') as string],
  ]
  const ld = comp.listingDetails
  const mlsRows: Array<[string, string]> = ld ? [
    ['MLS Bed/Bath', ld.beds != null || ld.bathsFull != null ? `${ld.beds ?? '-'}bd / ${ld.bathsFull ?? '-'}ba${ld.bathsHalf ? ` (+${ld.bathsHalf} half)` : ''}` : '-'],
    ['HOA / mo', ld.hoaMonthly != null ? `$${ld.hoaMonthly.toLocaleString()}` : '-'],
    ['Parking', ld.parking ?? '-'],
    ['Garage', ld.garage ?? '-'],
    ['Pool', ld.pool === true ? 'Yes' : ld.pool === false ? 'No' : '-'],
    ['Roof', ld.roof ?? '-'],
    ['Foundation', ld.foundation ?? '-'],
    ['Construction', ld.construction ?? '-'],
    ['Heating/Cooling', [ld.heating, ld.cooling].filter(Boolean).join(' / ') || '-'],
    ['Utilities', (ld.utilities ?? []).slice(0, 3).join(', ') || '-'],
    ['MLS Style', ld.style ?? '-'],
    ['Zoning', ld.zoning ?? '-'],
  ].filter(([, v]) => v !== '-') as Array<[string, string]> : []
  return (
    <div
      className="absolute left-2 top-2 z-20 w-80 max-h-[85%] overflow-y-auto rounded-lg border border-border bg-background/95 p-3 shadow-xl backdrop-blur-sm"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold" title={comp.address ?? ''}>{comp.address ?? 'Comparable'}</div>
          <div className="text-[11px] text-foreground-secondary">{[comp.city, comp.state, comp.zipCode].filter(Boolean).join(', ')}</div>
        </div>
        <span className={`shrink-0 text-[11px] font-semibold ${clsColor}`}>{clsLabel}{comp.isEnabled === false ? ' · Disabled' : ''}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-2">
            <span className="text-foreground-tertiary">{label}</span>
            <span className="text-right text-foreground">{value}</span>
          </div>
        ))}
      </div>
      {mlsRows.length > 0 && (
        <>
          <div className="mt-2 border-t border-border/50 pt-1.5 text-[10px] font-semibold text-foreground-tertiary">MLS details{ld?.sourceUrl && <> · <a href={ld.sourceUrl} target="_blank" rel="noreferrer" className="text-primary underline">Redfin ↗</a></>}</div>
          <div className="mt-0.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            {mlsRows.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-2">
                <span className="text-foreground-tertiary">{label}</span>
                <span className="text-right text-foreground truncate" title={value}>{value}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-foreground-secondary">
        {comp.sameBlockGroup === true && <span className="text-emerald-500">✓ Block Group</span>}
        {comp.crossesMajorRoad === true && <span className="text-amber-500">⚠ Crosses tract</span>}
        {comp.crossesMajorRoad === false && comp.censusTract && <span className="text-emerald-500">✓ Tract</span>}
        {comp.geographyUnverified === true && <span className="text-amber-600">? Geo unverified</span>}
        {comp.curbAppeal?.condition && <span>Curb: {comp.curbAppeal.condition} ({comp.curbAppeal.confidence}%)</span>}
        {comp.zillowUrl && <a href={comp.zillowUrl} target="_blank" rel="noreferrer" className="text-primary underline">Zillow ↗</a>}
      </div>
    </div>
  )
}
