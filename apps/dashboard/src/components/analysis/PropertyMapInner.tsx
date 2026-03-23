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

// ─── Popup HTML ─────────────────────────────────────────────────────────────

function buildPopupHTML(m: MapMarker, hasToggle: boolean): string {
  const config = MARKER_CONFIG[m.type]
  const details = m.details ?? []
  const isProperty = m.type === 'subject' || m.type === 'comp-enabled' || m.type === 'comp-disabled'
  const isComp = m.type === 'comp-enabled' || m.type === 'comp-disabled'

  const rows = details
    .map(([k, v]) => {
      const isExcluded = k === 'Excluded'
      return `<div style="display:flex;justify-content:space-between;gap:8px;${isExcluded ? 'color:#ef4444;' : ''}">
        <span style="color:#6b7280;">${k}</span>
        <span style="font-weight:600;color:#111827;${isExcluded ? 'color:#ef4444;' : ''}">${v}</span>
      </div>`
    })
    .join('')

  // Zillow link on address for properties
  const zillowUrl = isProperty ? `https://www.zillow.com/homes/${encodeURIComponent(m.label)}_rb/` : ''
  const labelHtml = isProperty
    ? `<a href="${zillowUrl}" target="_blank" rel="noopener noreferrer" style="font-weight:600;font-size:12px;color:#111827;text-decoration:none;border-bottom:1px dashed #9ca3af;" onmouseover="this.style.color='#3b82f6';this.style.borderBottomColor='#3b82f6'" onmouseout="this.style.color='#111827';this.style.borderBottomColor='#9ca3af'">${m.label}</a>`
    : `<div style="font-weight:600;font-size:12px;color:#111827;">${m.label}</div>`

  // Toggle switch for comps
  const isEnabled = m.type === 'comp-enabled'
  const toggleHtml = isComp && hasToggle && m.compKey
    ? `<div style="border-top:1px solid #e5e7eb;padding-top:5px;margin-top:3px;display:flex;align-items:center;justify-content:space-between;">
        <span style="font-size:10px;font-weight:500;color:${isEnabled ? '#16a34a' : '#6b7280'};">${isEnabled ? 'Included in ARV' : 'Excluded from ARV'}</span>
        <div data-comp-key="${m.compKey}" data-action="toggle" style="
          width:28px;height:16px;border-radius:8px;cursor:pointer;position:relative;
          background:${isEnabled ? '#10b981' : '#d1d5db'};transition:background 0.2s;
        "><div style="
          width:12px;height:12px;border-radius:50%;background:white;
          position:absolute;top:2px;${isEnabled ? 'right:2px' : 'left:2px'};
          box-shadow:0 1px 2px rgba(0,0,0,0.2);
        "></div></div>
      </div>`
    : ''

  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;font-size:11px;min-width:160px;max-width:240px;line-height:1.4;">
      <div style="font-size:9px;font-weight:600;color:${config.color};text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">${config.label}</div>
      <div style="margin-bottom:3px;">${labelHtml}</div>
      ${rows ? `<div style="border-top:1px solid #e5e7eb;padding-top:3px;display:flex;flex-direction:column;gap:1px;">${rows}</div>` : ''}
      ${toggleHtml}
    </div>
  `
}

// ─── Component ──────────────────────────────────────────────────────────────

interface PropertyMapInnerProps {
  markers: MapMarker[]
  onToggleComp?: (key: string) => void
}

export default function PropertyMapInner({ markers, onToggleComp }: PropertyMapInnerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<maplibregl.Marker[]>([])
  const onToggleCompRef = useRef(onToggleComp)
  onToggleCompRef.current = onToggleComp

  // Track which comp popup to re-open after markers rebuild (e.g. after toggle)
  const reopenCompKeyRef = useRef<string | null>(null)

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
    const keyToReopen = reopenCompKeyRef.current
    reopenCompKeyRef.current = null

    for (const m of markersRef.current) m.remove()
    markersRef.current = []

    let compIndex = 0
    const bounds = new maplibregl.LngLatBounds()
    const hasToggle = !!onToggleCompRef.current

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
        maxWidth: '260px',
        className: 'flowstate-popup',
      }).setHTML(buildPopupHTML(m, hasToggle))

      // Wire up toggle switch click after popup opens
      if (isComp && hasToggle && m.compKey) {
        const compKey = m.compKey
        popup.on('open', () => {
          const el = popup.getElement()?.querySelector('[data-action="toggle"]') as HTMLElement | null
          if (el) {
            el.addEventListener('click', (e) => {
              e.stopPropagation()
              // Store the key so we re-open this popup after markers rebuild
              reopenCompKeyRef.current = compKey
              onToggleCompRef.current?.(compKey)
            })
          }
        })
      }

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

      // Re-open popup if this comp was just toggled
      if (keyToReopen && m.compKey === keyToReopen) {
        marker.togglePopup()
      }
    }

    if (!bounds.isEmpty() && !keyToReopen) {
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
