'use client'

import { useMemo, useState, useCallback } from 'react'
import dynamic from 'next/dynamic'
import type { SubjectData, CompItem, NeighbourhoodData } from './shared-types'

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
  type: 'subject' | 'comp-enabled' | 'comp-disabled' | 'school' | 'poi'
  label: string
  /** Key-value pairs shown in the popup */
  details?: [string, string][]
  /** Comp key for toggling ARV selection (comp markers only) */
  compKey?: string
}

interface PropertyMapProps {
  subject?: SubjectData | null
  comps?: { items?: CompItem[] } | null
  neighbourhood?: NeighbourhoodData | null
  subjectSubdivision?: string | null
  /** Manual comp selection keys — when provided, overrides comp.isEnabled */
  selectedCompKeys?: Set<string>
  /** Called when a comp's enable/disable toggle is clicked */
  onToggleComp?: (key: string) => void
  /** Called when a marker is clicked — parent scrolls to the corresponding card */
  onMarkerSelect?: (type: 'subject' | 'comp', compKey?: string) => void
  /** Currently highlighted marker key ('subject' or a comp key) */
  activeMarkerKey?: string | null
}

export function PropertyMap({ subject, comps, neighbourhood, selectedCompKeys, onToggleComp, onMarkerSelect, activeMarkerKey }: PropertyMapProps) {
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
      for (let i = 0; i < comps.items.length; i++) {
        const comp = comps.items[i]
        if (comp.latitude && comp.longitude) {
          const compKey = comp.address || `comp-${i}`
          const enabled = selectedCompKeys ? selectedCompKeys.has(compKey) : comp.isEnabled !== false
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
            compKey,
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
  }, [subject, comps, neighbourhood, selectedCompKeys])

  const handleMarkerClick = useCallback((markerType: 'subject' | 'comp', compKey?: string) => {
    onMarkerSelect?.(markerType, compKey)
  }, [onMarkerSelect])

  if (markers.length === 0) return null

  return (
    <MapInner
      markers={markers}
      onToggleComp={onToggleComp}
      onMarkerClick={handleMarkerClick}
      activeMarkerKey={activeMarkerKey}
    />
  )
}
