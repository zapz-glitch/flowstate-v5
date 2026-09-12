'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import * as maplibregl from 'maplibre-gl'
import type { FeatureCollection, Point } from 'geojson'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { ReportMapPoint } from '@/lib/client-api'

const SATELLITE_TILES =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

interface GlobeInnerProps {
  points: ReportMapPoint[]
}

export default function GlobeInner({ points }: GlobeInnerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const router = useRouter()
  const routerRef = useRef(router)
  routerRef.current = router
  const [supported] = useState(() => {
    if (typeof window === 'undefined') return true
    try {
      const canvas = document.createElement('canvas')
      return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'))
    } catch {
      return false
    }
  })

  useEffect(() => {
    if (!containerRef.current || !supported) return

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        projection: { type: 'globe' },
        sources: {
          satellite: {
            type: 'raster',
            tiles: [SATELLITE_TILES],
            tileSize: 256,
            attribution: 'Esri, Maxar, Earthstar Geographics',
          },
        },
        layers: [
          { id: 'satellite', type: 'raster', source: 'satellite' },
        ],
      },
      center: [-96, 38],
      zoom: 1.6,
      attributionControl: { compact: true },
    })

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right')

    const geojson: FeatureCollection = {
      type: 'FeatureCollection',
      features: points.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.longitude, p.latitude] },
        properties: {
          jobId: p.jobId ?? '',
          address: `${p.propertyAddress}, ${p.propertyCity}, ${p.propertyState}`,
          arv: p.arv,
          mao: p.maxAllowableOffer,
        },
      })),
    }

    map.on('load', () => {
      map.addSource('reports', { type: 'geojson', data: geojson })
      map.addLayer({
        id: 'report-glow',
        type: 'circle',
        source: 'reports',
        paint: {
          'circle-radius': 9,
          'circle-color': '#e0dcd4',
          'circle-opacity': 0.18,
        },
      })
      map.addLayer({
        id: 'report-points',
        type: 'circle',
        source: 'reports',
        paint: {
          'circle-radius': 4.5,
          'circle-color': '#e0dcd4',
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#0a0a0a',
        },
      })

      map.on('mouseenter', 'report-points', () => {
        map.getCanvas().style.cursor = 'pointer'
      })
      map.on('mouseleave', 'report-points', () => {
        map.getCanvas().style.cursor = ''
      })
      map.on('click', 'report-points', (e) => {
        const f = e.features?.[0]
        if (!f) return
        const props = f.properties as { jobId: string; address: string; arv: number | null; mao: number | null }
        const coords = (f.geometry as Point).coordinates as [number, number]

        const fmt = (n: number | null) =>
          n != null ? `$${Math.round(n).toLocaleString()}` : '—'

        const el = document.createElement('div')
        el.className = 'atlas-popup'
        el.innerHTML = `
          <div style="font-weight:600;font-size:12px;margin-bottom:4px">${props.address}</div>
          <div style="font-size:11px;color:#a1a1aa">ARV ${fmt(props.arv)} · MAO ${fmt(props.mao)}</div>
          <div style="font-size:11px;color:#e4e4e7;margin-top:6px;text-decoration:underline">Open report →</div>
        `
        el.addEventListener('click', () => {
          if (props.jobId) routerRef.current.push(`/dashboard/reports/${props.jobId}`)
        })

        new maplibregl.Popup({ closeButton: false, offset: 14, className: 'atlas-popup-wrap' })
          .setLngLat(coords)
          .setDOMContent(el)
          .addTo(map)
      })
    })

    return () => map.remove()
  }, [points, supported])

  if (!supported) {
    // No WebGL (headless/sandboxed browsers) — degrade to a property index
    return (
      <div className="absolute inset-0 overflow-y-auto p-6 bg-background">
        <p className="mono-label mb-4">WebGL unavailable — showing index</p>
        <div className="space-y-px max-w-2xl">
          {points.map((p) => (
            <button
              key={p.jobId ?? p.propertyAddress}
              onClick={() => p.jobId && router.push(`/dashboard/reports/${p.jobId}`)}
              className="w-full flex items-baseline justify-between gap-4 px-3 py-2.5 text-left border border-border/50 hover:bg-secondary/40 transition-colors"
            >
              <span className="text-xs text-foreground truncate">
                {p.propertyAddress}, {p.propertyCity}, {p.propertyState}
              </span>
              <span className="mono-label flex-shrink-0">
                {p.arv != null ? `ARV $${Math.round(p.arv).toLocaleString()}` : ''}
              </span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  return <div ref={containerRef} className="absolute inset-0" />
}
