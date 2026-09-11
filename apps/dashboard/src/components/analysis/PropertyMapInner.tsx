'use client'

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useRef, useState } from 'react'
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps'
import { Crosshair, PersonStanding, Plus, Minus, RotateCcw, Box, Map as MapIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MapMarker } from './PropertyMap'

// ─── Config ─────────────────────────────────────────────────────────────────

const COLORS: Record<MapMarker['type'], string> = {
  subject: '#3b82f6',
  'comp-enabled': '#10b981',
  'comp-disabled': '#6b7280',
}

// POIs intentionally visible — commercial businesses, grocery stores, parks
// are part of the area context users need when evaluating a flip.

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
          url: markerIcon(color, size, isComp ? String(idx) : undefined, m.type === 'subject'),
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

// ─── 3D map experience: tilt, rotation, animated zoom, street-view approach ──

const TILT_ZOOM = 18       // 3D mode: zoom ≥ 18 → 45° aerial approach
const STREETVIEW_ZOOM = 20 // 3D mode: zoom ≥ 20 → street-level panorama
const ANIM_MS = 550

type MapMode = '2d' | '3d'

const easeInOut = (p: number) => p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2

/** rAF-driven interpolation — Google Maps has no animated zoom/heading API. */
function animate(map: any, apply: (v: number) => void, from: number, to: number, ms = ANIM_MS) {
  const t0 = performance.now()
  const step = (t: number) => {
    const p = Math.min((t - t0) / ms, 1)
    apply(from + (to - from) * easeInOut(p))
    if (p < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

function MapHud({ subject }: { subject: { lat: number; lng: number } | null }) {
  const map = useMap()
  const [mode, setMode] = useState<MapMode>('3d')
  const modeRef = useRef(mode)
  modeRef.current = mode

  // Start in 3D: tilt as soon as the map is ready (zoom-independent at load)
  useEffect(() => {
    if (map && mode === '3d') {
      animate(map, (v: number) => map.setTilt(v), map.getTilt() ?? 0, 45, 800)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map])

  // Zoom → tilt + street-view approach (3D mode only)
  useEffect(() => {
    const gm = (window as any).google?.maps
    if (!map || !gm) return

    const onZoom = () => {
      if (modeRef.current !== '3d') return
      const z = map.getZoom() ?? 0
      map.setTilt(z >= TILT_ZOOM ? 45 : 0)
      const sv = map.getStreetView()
      if (z >= STREETVIEW_ZOOM && subject) {
        sv.setPosition(subject)
        sv.setPov({ heading: 0, pitch: 0 })
        sv.setVisible(true)
      } else if (sv.getVisible()) {
        sv.setVisible(false)
      }
    }
    const zoomListener = map.addListener('zoom_changed', onZoom)

    // Double-click = rotate counterclockwise 90° (4 clicks = full turn)
    const dblListener = map.addListener('dblclick', () => {
      const from = map.getHeading() ?? 0
      animate(map, (v: number) => map.setHeading(v), from, from - 90, ANIM_MS)
    })

    return () => {
      gm.event.removeListener(zoomListener)
      gm.event.removeListener(dblListener)
    }
  }, [map, subject])

  if (!map) return null

  const zoomBy = (delta: number) => {
    animate(map, (v: number) => map.setZoom(v), map.getZoom() ?? 13, (map.getZoom() ?? 13) + delta)
  }

  const rotateCCW = () => {
    const from = map.getHeading() ?? 0
    animate(map, (v: number) => map.setHeading(v), from, from - 90, ANIM_MS)
  }

  const setMapMode = (m: MapMode) => {
    setMode(m)
    if (m === '3d') {
      animate(map, (v: number) => map.setTilt(v), map.getTilt() ?? 0, 45)
      const z = map.getZoom() ?? 13
      if (z < 17) zoomBy(17 - z)
    } else {
      map.getStreetView().setVisible(false)
      animate(map, (v: number) => map.setTilt(v), map.getTilt() ?? 45, 0)
      map.setHeading(0)
    }
  }

  const goSubject = () => {
    map.getStreetView().setVisible(false)
    map.panTo(subject!)
    const z = map.getZoom() ?? 13
    if (z < 18) zoomBy(18 - z)
    if (modeRef.current === '3d') animate(map, (v: number) => map.setTilt(v), map.getTilt() ?? 0, 45)
  }

  const goStreetView = () => {
    const gm = (window as any).google?.maps
    if (!gm || !subject) return
    new gm.StreetViewService().getPanorama(
      { location: subject, radius: 100, source: 'outdoor' },
      (data: any, status: string) => {
        if (status === 'OK' && data?.location?.latLng) {
          const sv = map.getStreetView()
          sv.setPosition(data.location.latLng)
          sv.setPov({ heading: 0, pitch: 0 })
          sv.setVisible(true)
        } else {
          goSubject()
          zoomBy(19 - (map.getZoom() ?? 13))
        }
      }
    )
  }

  const btn =
    'flex items-center justify-center w-8 h-8 bg-background/95 border border-border text-foreground shadow-md hover:bg-secondary transition-colors'
  const labelBtn =
    'flex items-center gap-1.5 px-2.5 h-8 rounded-md bg-background/95 border border-border text-[10px] font-medium text-foreground shadow-md hover:bg-secondary transition-colors'

  return (
    <>
      {/* Mode + subject controls — top right */}
      <div className="absolute top-2 right-2 z-10 flex flex-col gap-1.5 items-end">
        <div className="flex rounded-md border border-border overflow-hidden shadow-md">
          <button type="button" onClick={() => setMapMode('2d')} title="2D flat view"
            className={cn('flex items-center gap-1 px-2 h-8 text-[10px] font-medium transition-colors',
              mode === '2d' ? 'bg-primary text-primary-foreground' : 'bg-background/95 text-foreground hover:bg-secondary')}>
            <MapIcon className="w-3.5 h-3.5" /> 2D
          </button>
          <button type="button" onClick={() => setMapMode('3d')} title="3D aerial view"
            className={cn('flex items-center gap-1 px-2 h-8 text-[10px] font-medium transition-colors',
              mode === '3d' ? 'bg-primary text-primary-foreground' : 'bg-background/95 text-foreground hover:bg-secondary')}>
            <Box className="w-3.5 h-3.5" /> 3D
          </button>
        </div>
        {subject && (
          <>
            <button type="button" className={labelBtn} onClick={goSubject} title="Center on subject property">
              <Crosshair className="w-3.5 h-3.5" /> Subject
            </button>
            <button type="button" className={labelBtn} onClick={goStreetView} title="Street View at subject">
              <PersonStanding className="w-3.5 h-3.5" /> Street View
            </button>
          </>
        )}
      </div>

      {/* Zoom + rotate — bottom left */}
      <div className="absolute bottom-6 left-2 z-10 flex flex-col gap-1">
        <button type="button" className={cn(btn, 'rounded-t-md border-b-0')} onClick={() => zoomBy(1)} title="Zoom in">
          <Plus className="w-4 h-4" />
        </button>
        <button type="button" className={cn(btn, 'rounded-b-md')} onClick={() => zoomBy(-1)} title="Zoom out">
          <Minus className="w-4 h-4" />
        </button>
        <button type="button" className={cn(btn, 'rounded-md mt-1.5')} onClick={rotateCCW} title="Rotate counterclockwise (or double-click map)">
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      </div>
    </>
  )
}

// ─── Main ───────────────────────────────────────────────────────────────────

interface PropertyMapInnerProps {
  markers: MapMarker[]
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
  const subjectMarker = markers.find((m) => m.type === 'subject')
  const subject = subjectMarker ? { lat: subjectMarker.lat, lng: subjectMarker.lng } : null

  if (!apiKey) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-muted/30 text-foreground-tertiary text-body-sm">
        Google Maps API key not configured
      </div>
    )
  }

  return (
    <APIProvider apiKey={apiKey} libraries={['streetView']}>
      <div className="relative h-full w-full min-h-[350px]">
        <Map
          defaultCenter={center}
          defaultZoom={17}
          mapTypeId="hybrid"
          gestureHandling="greedy"
          disableDefaultUI
          disableDoubleClickZoom
          rotateControl={false}
          mapTypeControl={false}
          streetViewControl={false}
          fullscreenControl={false}
          clickableIcons={false}
          style={{ width: '100%', height: '100%' }}
        >
          <MapMarkers markers={markers} activeMarkerKey={activeMarkerKey} onMarkerClick={handleClick} />
          <MapHud subject={subject} />
        </Map>
      </div>
    </APIProvider>
  )
}
