'use client'

import { useMemo, useCallback } from 'react'
import dynamic from 'next/dynamic'
import type { SubjectData, CompItem } from './shared-types'
import { getCompKey, compAreaMatch, conditionLabel, type AreaMatch } from './format-helpers'
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
  /** Sale price · drawn as a small label beside the dot */
  price?: number | null
  /** Block group, neighborhood, both or neither · the line under the price */
  match?: AreaMatch
  /** Property condition · the last line of the tag */
  condition?: string | null
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
            price: comp.salePrice ?? null,
            match: compAreaMatch(comp, subject),
            condition: comp.badges ? conditionLabel(comp.badges.condition) : null,
          })
        }
      }
    }

    return m
  }, [subject, comps, selectedCompKeys])

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
      activeMarkerKey={activeMarkerKey}
    />
    </div>
  )
}
