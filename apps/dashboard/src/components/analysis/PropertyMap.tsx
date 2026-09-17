'use client'

import { useMemo, useCallback } from 'react'
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
  type: 'subject' | 'comp-enabled' | 'comp-disabled'
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
          m.push({
            lat: comp.latitude!,
            lng: comp.longitude!,
            type: enabled ? 'comp-enabled' : 'comp-disabled',
            label: comp.address ?? 'Comparable',
            compKey,
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
    <MapInner
      key={`${subject?.address}|${subject?.latitude}|${subject?.longitude}`}
      markers={markers}
      onMarkerClick={handleMarkerClick}
      activeMarkerKey={activeMarkerKey}
    />
  )
}
