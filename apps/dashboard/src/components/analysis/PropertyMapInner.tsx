'use client'

import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { MapMarker } from './PropertyMap'

// ─── Marker Config ──────────────────────────────────────────────────────────

const MARKER_CONFIG: Record<MapMarker['type'], { color: string; label: string }> = {
  subject: { color: '#3b82f6', label: 'Subject Property' },
  'comp-enabled': { color: '#10b981', label: 'Comp (included)' },
  'comp-disabled': { color: '#9ca3af', label: 'Comp (excluded)' },
  school: { color: '#8b5cf6', label: 'School' },
  poi: { color: '#f59e0b', label: 'POI' },
}

// ─── Component ──────────────────────────────────────────────────────────────

interface PropertyMapInnerProps {
  markers: MapMarker[]
  onToggleComp?: (key: string) => void
  /** Called when a marker is clicked — opens detail modal in parent */
  onMarkerClick?: (markerType: 'subject' | 'comp', compKey?: string) => void
}

export default function PropertyMapInner({ markers, onToggleComp, onMarkerClick }: PropertyMapInnerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<maplibregl.Marker[]>([])
  const onToggleCompRef = useRef(onToggleComp)
  onToggleCompRef.current = onToggleComp
  const onMarkerClickRef = useRef(onMarkerClick)
  onMarkerClickRef.current = onMarkerClick

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

    let compIndex = 0
    const bounds = new maplibregl.LngLatBounds()

    // Render non-subject markers first, then subject last so it appears on top
    const sortedMarkers = [...markers].sort((a, b) => {
      if (a.type === 'subject') return 1
      if (b.type === 'subject') return -1
      return 0
    })

    for (const m of sortedMarkers) {
      const config = MARKER_CONFIG[m.type]
      const isComp = m.type === 'comp-enabled' || m.type === 'comp-disabled'
      const idx = isComp ? ++compIndex : undefined

      const markerOptions: maplibregl.MarkerOptions = {
        color: config.color,
        scale: 0.85,
      }

      // Subject property: home icon marker
      if (m.type === 'subject') {
        const el = document.createElement('div')
        el.className = 'flowstate-subject-marker'
        el.style.cssText = `
          width: 36px; height: 36px;
          background: ${config.color};
          border: 3px solid white;
          border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          cursor: pointer;
          box-shadow: 0 2px 8px rgba(0,0,0,0.4);
        `
        el.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`
        el.addEventListener('click', () => {
          onMarkerClickRef.current?.('subject')
        })
        markerOptions.element = el
        delete markerOptions.color
        delete markerOptions.scale
      }

      // Comps: numbered custom element
      if (isComp && idx != null) {
        const compKey = m.compKey
        const el = document.createElement('div')
        el.className = 'flowstate-comp-marker'
        el.style.cssText = `
          width: 26px; height: 26px;
          background: ${config.color};
          border: 2.5px solid white;
          border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          color: white; font-weight: 800; font-size: 12px;
          font-family: system-ui, -apple-system, sans-serif;
          cursor: pointer;
          box-shadow: 0 2px 6px rgba(0,0,0,0.35);
          text-shadow: 0 1px 2px rgba(0,0,0,0.3);
        `
        el.textContent = String(idx)
        el.addEventListener('click', () => {
          if (compKey) onMarkerClickRef.current?.('comp', compKey)
        })
        markerOptions.element = el
        delete markerOptions.scale
      }

      const marker = new maplibregl.Marker(markerOptions)
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
  }, [markers])

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
    <div>
      <div ref={containerRef} className="w-full h-[400px]" />
      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-2 px-3 py-2 border-t border-border bg-background/50">
        {(['subject', 'comp-enabled', 'comp-disabled', 'school', 'poi'] as const)
          .filter((t) => types.has(t))
          .map((t) => {
            const cfg = MARKER_CONFIG[t]
            const isComp = t === 'comp-enabled' || t === 'comp-disabled'
            return (
              <div key={t} className="flex items-center gap-1.5 text-xs text-foreground-secondary">
                {t === 'subject' ? (
                  <span
                    className="inline-flex items-center justify-center shrink-0 rounded-full"
                    style={{
                      width: 18,
                      height: 18,
                      background: cfg.color,
                      border: '1.5px solid white',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                    }}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
                      <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                    </svg>
                  </span>
                ) : isComp ? (
                  <span
                    className="inline-flex items-center justify-center shrink-0 rounded-full text-white font-bold"
                    style={{
                      width: 16,
                      height: 16,
                      fontSize: 9,
                      background: cfg.color,
                      border: '1.5px solid white',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                    }}
                  >
                    #
                  </span>
                ) : (
                  <svg width="14" height="20" viewBox="0 0 27 41.5" style={{ flexShrink: 0 }}>
                    <path
                      d="M13.5 0C6.044 0 0 6.044 0 13.5 0 24.82 13.5 41.5 13.5 41.5S27 24.82 27 13.5C27 6.044 20.956 0 13.5 0z"
                      fill={cfg.color}
                      stroke="white"
                      strokeWidth="1.5"
                    />
                    <circle cx="13.5" cy="13.5" r="5" fill="white" />
                  </svg>
                )}
                <span className="font-medium">{cfg.label}</span>
              </div>
            )
          })}
      </div>
    </div>
  )
}
