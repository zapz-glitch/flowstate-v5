'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import maplibregl from 'maplibre-gl'
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

  useEffect(() => {
    if (!containerRef.current) return

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
          'circle-color': '#ffffff',
          'circle-opacity': 0.18,
        },
      })
      map.addLayer({
        id: 'report-points',
        type: 'circle',
        source: 'reports',
        paint: {
          'circle-radius': 4.5,
          'circle-color': '#ffffff',
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
  }, [points])

  return <div ref={containerRef} className="absolute inset-0" />
}
