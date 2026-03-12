'use client'

import { useMemo } from 'react'
import dynamic from 'next/dynamic'
import type { SubjectData, CompItem, NeighbourhoodData } from './shared-types'

// Dynamically import the map internals (Leaflet requires browser APIs)
const MapInner = dynamic(() => import('./NeighbourhoodMapInner'), {
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
  type: 'subject' | 'comp-enabled' | 'comp-disabled' | 'school' | 'poi'
  label: string
  /** Key-value pairs shown in the popup */
  details?: [string, string][]
}

interface NeighbourhoodMapProps {
  subject?: SubjectData | null
  comps?: { items?: CompItem[] } | null
  neighbourhood?: NeighbourhoodData | null
}

export function NeighbourhoodMap({ subject, comps, neighbourhood }: NeighbourhoodMapProps) {
  const markers = useMemo(() => {
    const m: MapMarker[] = []

    // Subject property
    if (subject?.latitude && subject?.longitude) {
      const details: [string, string][] = []
      if (subject.bedrooms != null || subject.bathrooms != null) {
        details.push([`${subject.bedrooms ?? '-'}bd / ${subject.bathrooms ?? '-'}ba`, subject.squareFeet != null ? `${subject.squareFeet.toLocaleString()} sqft` : ''])
      } else if (subject.squareFeet != null) {
        details.push(['Sq Ft', subject.squareFeet.toLocaleString()])
      }
      if (subject.yearBuilt != null) details.push(['Built', String(subject.yearBuilt)])
      if (subject.lastSale?.price != null) details.push(['Last Sale', `$${subject.lastSale.price.toLocaleString()}`])
      m.push({
        lat: subject.latitude,
        lng: subject.longitude,
        type: 'subject',
        label: subject.address ?? 'Subject Property',
        details,
      })
    }

    // Comps
    if (comps?.items) {
      for (const comp of comps.items) {
        if (comp.latitude && comp.longitude) {
          const enabled = comp.isEnabled !== false
          const details: [string, string][] = []
          if (comp.salePrice != null) details.push(['Price', `$${comp.salePrice.toLocaleString()}`])
          if (comp.squareFeet != null) {
            const bd = comp.bedrooms ?? '-'
            const ba = comp.bathrooms ?? '-'
            details.push([`${bd}bd/${ba}ba`, `${comp.squareFeet.toLocaleString()} sqft`])
          }
          if (comp.distanceMiles != null) details.push(['Dist', `${comp.distanceMiles.toFixed(2)} mi`])
          if (!enabled && comp.disableReasons?.length) details.push(['Excluded', comp.disableReasons[0]])
          m.push({
            lat: comp.latitude,
            lng: comp.longitude,
            type: enabled ? 'comp-enabled' : 'comp-disabled',
            label: comp.address ?? 'Comparable',
            details,
          })
        }
      }
    }

    // Schools
    if (neighbourhood?.schools?.nearby) {
      for (const school of neighbourhood.schools.nearby) {
        if (school.latitude && school.longitude) {
          const details: [string, string][] = []
          if (school.type) details.push(['Type', school.type])
          if (school.gradeRange) details.push(['Grades', school.gradeRange])
          if (school.rating != null) details.push(['Rating', `${school.rating}/10`])
          if (school.distance != null) details.push(['Distance', `${school.distance.toFixed(1)} mi`])
          m.push({
            lat: school.latitude,
            lng: school.longitude,
            type: 'school',
            label: school.name,
            details,
          })
        }
      }
    }

    // POI
    if (neighbourhood?.poi?.nearby) {
      for (const poi of neighbourhood.poi.nearby) {
        if (poi.latitude && poi.longitude) {
          const details: [string, string][] = []
          if (poi.category) details.push(['Category', poi.category])
          if (poi.distance != null) details.push(['Distance', `${poi.distance.toFixed(1)} mi`])
          m.push({
            lat: poi.latitude,
            lng: poi.longitude,
            type: 'poi',
            label: poi.name,
            details,
          })
        }
      }
    }

    return m
  }, [subject, comps, neighbourhood])

  // Need at least the subject marker to render the map
  if (markers.length === 0) return null

  return <MapInner markers={markers} />
}
