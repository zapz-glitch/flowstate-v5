'use client'

import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { MapMarker } from './NeighbourhoodMap'

// ─── Marker Config ──────────────────────────────────────────────────────────

const MARKER_CONFIG: Record<MapMarker['type'], { color: string; label: string }> = {
  subject: { color: '#3b82f6', label: 'Subject Property' },
  'comp-enabled': { color: '#10b981', label: 'Comp (included)' },
  'comp-disabled': { color: '#9ca3af', label: 'Comp (excluded)' },
  school: { color: '#8b5cf6', label: 'School' },
  poi: { color: '#f59e0b', label: 'POI' },
}

// ─── Popup HTML ─────────────────────────────────────────────────────────────

function buildPopupHTML(m: MapMarker): string {
  const config = MARKER_CONFIG[m.type]
  const details = m.details ?? []

  const rows = details
    .map(([k, v]) => {
      const isExcluded = k === 'Excluded'
      return `<div style="display:flex;justify-content:space-between;gap:8px;${isExcluded ? 'color:#ef4444;' : ''}">
        <span style="color:#6b7280;">${k}</span>
        <span style="font-weight:600;color:#111827;${isExcluded ? 'color:#ef4444;' : ''}">${v}</span>
      </div>`
    })
    .join('')

  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;font-size:11px;min-width:140px;max-width:220px;line-height:1.4;">
      <div style="font-size:9px;font-weight:600;color:${config.color};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">${config.label}</div>
      <div style="font-weight:600;font-size:12px;color:#111827;margin-bottom:3px;">${m.label}</div>
      ${rows ? `<div style="border-top:1px solid #e5e7eb;padding-top:3px;display:flex;flex-direction:column;gap:1px;">${rows}</div>` : ''}
    </div>
  `
}

// ─── Component ──────────────────────────────────────────────────────────────

interface NeighbourhoodMapInnerProps {
  markers: MapMarker[]
}

export default function NeighbourhoodMapInner({ markers }: NeighbourhoodMapInnerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<maplibregl.Marker[]>([])

  useEffect(() => {
    if (!containerRef.current || markers.length === 0) return

    if (!mapRef.current) {
      mapRef.current = new maplibregl.Map({
        container: containerRef.current,
        style: 'https://tiles.openfreemap.org/styles/liberty',
        center: [markers[0].lng, markers[0].lat],
        zoom: 13,
        pitch: 45,
        bearing: -10,
      })

      mapRef.current.addControl(new maplibregl.NavigationControl(), 'top-right')
      mapRef.current.scrollZoom.disable()

      mapRef.current.on('load', () => {
        const map = mapRef.current!
        const layers = map.getStyle().layers
        let labelLayerId: string | undefined
        if (layers) {
          for (const layer of layers) {
            if (layer.type === 'symbol' && (layer.layout as Record<string, unknown>)?.['text-field']) {
              labelLayerId = layer.id
              break
            }
          }
        }

        if (map.getSource('openmaptiles') || map.getSource('maptiler_planet') || map.getSource('openfreemap')) {
          const sourceId = map.getSource('openmaptiles') ? 'openmaptiles' : map.getSource('maptiler_planet') ? 'maptiler_planet' : 'openfreemap'
          if (!map.getLayer('3d-buildings')) {
            map.addLayer(
              {
                id: '3d-buildings',
                source: sourceId,
                'source-layer': 'building',
                type: 'fill-extrusion',
                minzoom: 14,
                paint: {
                  'fill-extrusion-color': '#aaa',
                  'fill-extrusion-height': ['get', 'render_height'],
                  'fill-extrusion-base': ['get', 'render_min_height'],
                  'fill-extrusion-opacity': 0.5,
                },
              },
              labelLayerId,
            )
          }
        }
      })
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

      const popup = new maplibregl.Popup({
        offset: 25,
        closeButton: false,
        maxWidth: '240px',
        className: 'flowstate-popup',
      }).setHTML(buildPopupHTML(m))

      // Use maplibre's default marker with color — properly anchored, no drift
      const markerOptions: maplibregl.MarkerOptions = {
        color: config.color,
        scale: m.type === 'subject' ? 1.2 : 0.85,
      }

      // For comps, use a numbered custom element
      if (isComp && idx != null) {
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
        markerOptions.element = el
        delete markerOptions.scale
      }

      const marker = new maplibregl.Marker(markerOptions)
        .setLngLat([m.lng, m.lat])
        .setPopup(popup)
        .addTo(map)

      markersRef.current.push(marker)
      bounds.extend([m.lng, m.lat])
    }

    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, {
        padding: 60,
        maxZoom: 15,
        pitch: 45,
        bearing: -10,
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
    <div className="space-y-2">
      <style>{`
        .flowstate-popup .maplibregl-popup-content {
          border-radius: 8px;
          padding: 8px 10px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.15);
          border: none;
        }
        .flowstate-popup .maplibregl-popup-tip {
          border-top-color: white;
        }
      `}</style>
      <div ref={containerRef} className="w-full h-[400px] rounded-lg overflow-hidden border border-border" />
      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-2 px-1">
        {(['subject', 'comp-enabled', 'comp-disabled', 'school', 'poi'] as const)
          .filter((t) => types.has(t))
          .map((t) => {
            const cfg = MARKER_CONFIG[t]
            const isComp = t === 'comp-enabled' || t === 'comp-disabled'
            return (
              <div key={t} className="flex items-center gap-1.5 text-xs text-foreground-secondary">
                {isComp ? (
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
