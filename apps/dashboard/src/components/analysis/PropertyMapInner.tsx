'use client'

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useRef } from 'react'
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps'
import type { MapMarker } from './PropertyMap'

// ─── Config ─────────────────────────────────────────────────────────────────

const COLORS: Record<MapMarker['type'], string> = {
  subject: '#3b82f6',
  'comp-enabled': '#10b981',
  'comp-disabled': '#6b7280',
}

const MAP_STYLES = [
  { featureType: 'poi' as const, stylers: [{ visibility: 'off' as const }] },
  { featureType: 'transit' as const, stylers: [{ visibility: 'off' as const }] },
]

// ─── SVG icon builder ───────────────────────────────────────────────────────

function markerIcon(color: string, size: number, label?: string, isSubject?: boolean): string {
  const r = size / 2

  let inner = ''
  if (isSubject) {
    const iconSize = Math.round(size * 0.45)
    const offset = Math.round((size - iconSize) / 2)
    inner = `<svg x="${offset}" y="${offset}" width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`
  } else if (label) {
    inner = `<text x="${r}" y="${r}" text-anchor="middle" dominant-baseline="central" fill="white" font-weight="800" font-size="${size > 30 ? 14 : 11}" font-family="system-ui,sans-serif">${label}</text>`
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${r}" cy="${r}" r="${r - 1.5}" fill="${color}" stroke="white" stroke-width="2"/>${inner}</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

// ─── Markers component ──────────────────────────────────────────────────────

function MapMarkers({
  markers,
  activeMarkerKey,
  onMarkerClick,
}: {
  markers: MapMarker[]
  activeMarkerKey?: string | null
  onMarkerClick?: (m: MapMarker) => void
}) {
  const map = useMap()
  const refs = useRef<any[]>([])
  const fitted = useRef(false)
  const clickRef = useRef(onMarkerClick)
  clickRef.current = onMarkerClick

  // Reset fit when markers change
  const key = markers.map((m) => `${m.lat.toFixed(4)},${m.lng.toFixed(4)}`).join('|')
  useEffect(() => { fitted.current = false }, [key])

  useEffect(() => {
    const gm = (window as any).google?.maps
    if (!map || !gm || !markers.length) return

    // Cleanup
    for (const m of refs.current) m.setMap(null)
    refs.current = []

    // Fit bounds once
    if (!fitted.current) {
      const bounds = new gm.LatLngBounds()
      for (const m of markers) bounds.extend({ lat: m.lat, lng: m.lng })
      map.fitBounds(bounds, 50)
      fitted.current = true
    }

    let idx = 0
    for (const m of markers) {
      const isComp = m.type === 'comp-enabled' || m.type === 'comp-disabled'
      const isDisabled = m.type === 'comp-disabled'
      if (isComp) idx++
      const isActive = m.type === 'subject'
        ? activeMarkerKey === 'subject'
        : isComp && m.compKey === activeMarkerKey

      const size = 30
      const color = isActive ? '#f59e0b' : COLORS[m.type]

      const marker = new gm.Marker({
        map,
        position: { lat: m.lat, lng: m.lng },
        icon: {
          url: markerIcon(color, size, isDisabled ? undefined : isComp ? String(idx) : undefined, m.type === 'subject'),
          scaledSize: new gm.Size(size, size),
          anchor: new gm.Point(size / 2, size / 2),
        },
        zIndex: m.type === 'subject' ? 100 : isActive ? 50 : isDisabled ? 1 : 10,
      })

      const data = m
      marker.addListener('click', () => clickRef.current?.(data))
      refs.current.push(marker)
    }

    return () => {
      for (const m of refs.current) m.setMap(null)
      refs.current = []
    }
  }, [map, markers, activeMarkerKey])

  return null
}

// ─── Main ───────────────────────────────────────────────────────────────────

interface PropertyMapInnerProps {
  markers: MapMarker[]
  onToggleComp?: (key: string) => void
  onMarkerClick?: (type: 'subject' | 'comp', compKey?: string) => void
  activeMarkerKey?: string | null
}

export default function PropertyMapInner({ markers, onMarkerClick, activeMarkerKey }: PropertyMapInnerProps) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAP_KEY

  const handleClick = useCallback((m: MapMarker) => {
    if (m.type === 'subject') onMarkerClick?.('subject')
    else onMarkerClick?.('comp', m.compKey)
  }, [onMarkerClick])

  const center = markers.length > 0 ? { lat: markers[0].lat, lng: markers[0].lng } : { lat: 28, lng: -82 }

  if (!apiKey) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-muted/30 text-foreground-tertiary text-body-sm">
        Google Maps API key not configured
      </div>
    )
  }

  return (
    <APIProvider apiKey={apiKey}>
      <div className="h-full w-full min-h-[350px]">
        <Map
          defaultCenter={center}
          defaultZoom={13}
          mapTypeId="hybrid"
          gestureHandling="cooperative"
          disableDefaultUI
          zoomControl
          zoomControlOptions={{ position: 5 }}
          mapTypeControl={false}
          streetViewControl={false}
          fullscreenControl={false}
          clickableIcons={false}
          styles={MAP_STYLES}
          style={{ width: '100%', height: '100%' }}
        >
          <MapMarkers markers={markers} activeMarkerKey={activeMarkerKey} onMarkerClick={handleClick} />
        </Map>
      </div>
    </APIProvider>
  )
}
