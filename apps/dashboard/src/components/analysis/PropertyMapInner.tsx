'use client'

import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { MapMarker } from './PropertyMap'

// ─── Marker Config ──────────────────────────────────────────────────────────

const MARKER_CONFIG: Record<MapMarker['type'], { color: string; label: string }> = {
  subject: { color: '#3b82f6', label: 'Subject Property' },
  'comp-enabled': { color: '#10b981', label: 'Comp (included)' },
  'comp-disabled': { color: '#6b7280', label: 'Comp (excluded)' },
  school: { color: '#8b5cf6', label: 'School' },
  poi: { color: '#f59e0b', label: 'POI' },
}

// SVG home icon path (lucide Home)
const HOME_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`

function createMarkerEl(
  color: string,
  size: number,
  opts?: { number?: number; isActive?: boolean },
): HTMLDivElement {
  const el = document.createElement('div')
  const isActive = opts?.isActive ?? false
  const bg = isActive ? '#f59e0b' : color

  el.style.cssText = `
    width: ${size}px; height: ${size}px;
    background: ${bg};
    border: ${size > 30 ? '3px' : '2.5px'} solid white;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    box-shadow: ${isActive ? '0 0 0 3px rgba(245,158,11,0.4), 0 2px 8px rgba(0,0,0,0.4)' : '0 2px 6px rgba(0,0,0,0.35)'};
  `

  if (opts?.number != null) {
    el.style.cssText += `
      color: white; font-weight: 800; font-size: ${size > 30 ? '14px' : '11px'};
      font-family: system-ui, -apple-system, sans-serif;
      text-shadow: 0 1px 2px rgba(0,0,0,0.3);
    `
    el.textContent = String(opts.number)
  } else {
    el.innerHTML = HOME_SVG
  }

  return el
}

// ─── Component ──────────────────────────────────────────────────────────────

interface PropertyMapInnerProps {
  markers: MapMarker[]
  onToggleComp?: (key: string) => void
  onMarkerClick?: (markerType: 'subject' | 'comp', compKey?: string) => void
  activeMarkerKey?: string | null
}

export default function PropertyMapInner({ markers, onToggleComp, onMarkerClick, activeMarkerKey }: PropertyMapInnerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<maplibregl.Marker[]>([])
  const onToggleCompRef = useRef(onToggleComp)
  onToggleCompRef.current = onToggleComp
  const onMarkerClickRef = useRef(onMarkerClick)
  onMarkerClickRef.current = onMarkerClick

  // Resize observer — keeps map in sync when container size changes (panel resize)
  // Debounced resize — avoids blinking during panel drag
  useEffect(() => {
    if (!containerRef.current) return
    let rafId: number | null = null
    const observer = new ResizeObserver(() => {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        mapRef.current?.resize()
      })
    })
    observer.observe(containerRef.current)
    return () => {
      observer.disconnect()
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [])

  useEffect(() => {
    if (!containerRef.current || markers.length === 0) return

    if (!mapRef.current) {
      mapRef.current = new maplibregl.Map({
        container: containerRef.current,
        style: {
          version: 8,
          sources: {
            'esri-satellite': {
              type: 'raster',
              tiles: [
                'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
              ],
              tileSize: 256,
              attribution: '&copy; Esri',
              maxzoom: 19,
            },
          },
          layers: [
            {
              id: 'satellite',
              type: 'raster',
              source: 'esri-satellite',
              minzoom: 0,
              maxzoom: 19,
            },
          ],
        },
        center: [markers[0].lng, markers[0].lat],
        zoom: 13,
      })

      mapRef.current.addControl(new maplibregl.NavigationControl(), 'top-right')
      mapRef.current.scrollZoom.disable()
    }

    const map = mapRef.current

    for (const m of markersRef.current) m.remove()
    markersRef.current = []

    const bounds = new maplibregl.LngLatBounds()

    // Render non-subject markers first, then subject last so it appears on top
    const sortedMarkers = [...markers].sort((a, b) => {
      if (a.type === 'subject') return 1
      if (b.type === 'subject') return -1
      return 0
    })

    let compIndex = 0
    for (const m of sortedMarkers) {
      const config = MARKER_CONFIG[m.type]
      const isComp = m.type === 'comp-enabled' || m.type === 'comp-disabled'
      if (isComp) compIndex++

      let el: HTMLDivElement

      if (m.type === 'subject') {
        const isActive = activeMarkerKey === 'subject'
        el = createMarkerEl(config.color, isActive ? 40 : 34, { isActive })
        el.addEventListener('click', () => onMarkerClickRef.current?.('subject'))
      } else if (isComp) {
        const isActive = activeMarkerKey != null && m.compKey === activeMarkerKey
        el = createMarkerEl(config.color, isActive ? 34 : 28, { number: compIndex, isActive })
        const compKey = m.compKey
        el.addEventListener('click', () => {
          if (compKey) onMarkerClickRef.current?.('comp', compKey)
        })
      } else {
        el = createMarkerEl(config.color, 24)
      }

      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([m.lng, m.lat])
        .addTo(map)

      markersRef.current.push(marker)
      bounds.extend([m.lng, m.lat])
    }

    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, {
        padding: 60,
        maxZoom: 15,
      })
    }
  }, [markers, activeMarkerKey])

  useEffect(() => {
    return () => {
      for (const m of markersRef.current) m.remove()
      markersRef.current = []
      if (mapRef.current) {
        mapRef.current.remove()
        mapRef.current = null
      }
    }
  }, [])

  const types = new Set(markers.map((m) => m.type))

  return (
    <div className="relative h-full flex flex-col">
      <div ref={containerRef} className="w-full flex-1 min-h-[350px]" />
      {/* Legend — overlays bottom of map */}
      <div className="absolute bottom-0 left-0 right-0 flex flex-wrap gap-x-4 gap-y-1 px-3 py-2 bg-black/60 backdrop-blur-sm">
        {(['subject', 'comp-enabled', 'comp-disabled'] as const)
          .filter((t) => types.has(t))
          .map((t) => {
            const cfg = MARKER_CONFIG[t]
            return (
              <div key={t} className="flex items-center gap-1.5 text-xs text-white/80">
                <span
                  className="inline-flex items-center justify-center shrink-0 rounded-full"
                  style={{
                    width: t === 'subject' ? 18 : 16,
                    height: t === 'subject' ? 18 : 16,
                    background: cfg.color,
                    border: '1.5px solid white',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  }}
                  dangerouslySetInnerHTML={{
                    __html: t === 'subject'
                      ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`
                      : `<span style="color:white;font-weight:bold;font-size:9px;">#</span>`
                  }}
                />
                <span className="font-medium text-white/90">{cfg.label}</span>
              </div>
            )
          })}
      </div>
    </div>
  )
}
