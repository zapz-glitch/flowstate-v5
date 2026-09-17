'use client'

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { APIProvider, Map, useApiIsLoaded, useMap } from '@vis.gl/react-google-maps'
import { Crosshair, PersonStanding, Plus, Minus, RotateCcw, ArrowLeft } from 'lucide-react'
import { resolvePropertyLocation, resolveSubjectPanorama } from '@/lib/resolve-property-map'
import type { MapCoordinate } from '@/lib/property-map-geometry'
import { SubjectAerialMap, type SubjectAerialMapHandle } from './SubjectAerialMap'
import { MapLegend } from './MapOverlay'
import type { MapMarker } from './PropertyMap'

type Panorama = NonNullable<Awaited<ReturnType<typeof resolveSubjectPanorama>>>
const colors = { subject: '#3b82f6', 'comp-enabled': '#10b981', 'comp-disabled': '#6b7280' }
const buttonClass = 'flex h-8 items-center justify-center gap-1 rounded-md border border-border bg-background/95 px-2 text-xs text-foreground shadow-sm hover:bg-secondary disabled:opacity-40'

// Optional Google libraries must fail independently; a missing 3D library must
// never prevent Street View or a conventional satellite map from working.
async function loadLibrary(name: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      google.maps.importLibrary(name).then(() => true, () => false),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 6000) }),
    ])
  } finally { clearTimeout(timer) }
}

function FlatMarkers({ markers, activeMarkerKey, onMarkerClick }: {
  markers: MapMarker[]; activeMarkerKey?: string | null; onMarkerClick: (marker: MapMarker) => void
}) {
  const map = useMap()
  useEffect(() => {
    if (!map) return
    const instances = markers.map((marker, index) => {
      const active = (marker.type === 'subject' ? 'subject' : marker.compKey) === activeMarkerKey
      const instance = new google.maps.Marker({
        map, position: marker, title: marker.label,
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: marker.type === 'subject' ? 12 : 10,
          fillColor: active ? '#f59e0b' : colors[marker.type], fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
        label: { text: marker.type === 'subject' ? 'S' : String(index), color: '#fff', fontSize: '10px' },
        zIndex: marker.type === 'subject' ? 100 : 10,
      })
      instance.addListener('click', () => onMarkerClick(marker))
      return instance
    })
    return () => instances.forEach(marker => { google.maps.event.clearInstanceListeners(marker); marker.setMap(null) })
  }, [map, markers, activeMarkerKey, onMarkerClick])
  return null
}

function SubjectStreetView({ panorama, subject, onBack, onFailure, viewRef }: { panorama: Panorama; subject: MapCoordinate; onBack: () => void; onFailure: () => void; viewRef: MutableRefObject<google.maps.StreetViewPanorama | null> }) {
  const container = useRef<HTMLDivElement>(null)
  const [pending, setPending] = useState(true)
  const back = useRef(onBack)
  const failure = useRef(onFailure)
  back.current = onBack
  failure.current = onFailure
  useEffect(() => {
    const element = container.current
    if (!element) return
    let disposed = false
    let view: google.maps.StreetViewPanorama
    try {
      view = new google.maps.StreetViewPanorama(element, {
        pov: { heading: panorama.heading, pitch: 0 }, zoom: 0,
        visible: true, disableDefaultUI: true, linksControl: false, clickToGo: false,
        scrollwheel: false, showRoadLabels: false, motionTracking: false, motionTrackingControl: false,
      })
    } catch { failure.current(); return }
    viewRef.current = view
    let subjectPin: google.maps.Marker | null = null
    try { subjectPin = new google.maps.Marker({
      map: view, position: subject, title: 'Subject property location',
      icon: { path: google.maps.SymbolPath.CIRCLE, scale: 11, fillColor: colors.subject,
        fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
      label: { text: 'S', color: '#fff', fontSize: '11px' },
    }) } catch { /* The panorama remains usable if marker rendering fails. */ }
    const timer = setTimeout(() => {
      if (!disposed && view.getStatus() !== google.maps.StreetViewStatus.OK) failure.current()
    }, 12000)
    const statusChanged = () => {
      if (disposed) return
      const status = view.getStatus()
      if (status === google.maps.StreetViewStatus.OK) { clearTimeout(timer); setPending(false) }
      else if (status === google.maps.StreetViewStatus.ZERO_RESULTS || status === google.maps.StreetViewStatus.UNKNOWN_ERROR) {
        clearTimeout(timer)
        failure.current()
      }
    }
    const listener = view.addListener('status_changed', statusChanged)
    view.setPano(panorama.panoId)
    statusChanged()
    // Wheel zoom-out from street level returns to the aerial camera. Prevent
    // native wheel handling so a single gesture cannot change both views.
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      if (event.deltaY === 0) return
      const zoom = view.getZoom() ?? 0
      if (event.deltaY > 0 && zoom <= 0) back.current()
      else view.setZoom(Math.max(0, Math.min(3, zoom + (event.deltaY < 0 ? 0.25 : -0.25))))
    }
    element.addEventListener('wheel', wheel, { passive: false })
    const resize = new ResizeObserver(() => google.maps.event.trigger(view, 'resize'))
    resize.observe(element)
    return () => {
      disposed = true
      clearTimeout(timer)
      viewRef.current = null
      subjectPin?.setMap(null)
      resize.disconnect()
      element.removeEventListener('wheel', wheel)
      listener.remove()
      google.maps.event.clearInstanceListeners(view)
      view.setVisible(false)
      element.replaceChildren()
    }
  }, [panorama, subject.lat, subject.lng, viewRef])
  return <><div ref={container} className="absolute inset-0" aria-label="Street View facing the subject property" />{pending && <div role="status" className="pointer-events-none absolute left-2 top-2 rounded bg-background/95 p-2 text-xs">Loading Street View…</div>}</>
}

interface PropertyMapInnerProps {
  markers: MapMarker[]
  onMarkerClick?: (type: 'subject' | 'comp', compKey?: string) => void
  activeMarkerKey?: string | null
}

function SubjectMap({ markers, onMarkerClick, activeMarkerKey }: PropertyMapInnerProps) {
  const loaded = useApiIsLoaded()
  const original = markers.find(marker => marker.type === 'subject')!
  const [location, setLocation] = useState<{ coordinate: MapCoordinate; addressMatched: boolean } | null>(null)
  const [panorama, setPanorama] = useState<Panorama | null>(null)
  const [view, setView] = useState<'loading' | 'street' | 'aerial'>('loading')
  const [streetStatus, setStreetStatus] = useState('Checking subject location…')
  const [threeD, setThreeD] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [flatZoom, setFlatZoom] = useState(19)
  const aerial = useRef<SubjectAerialMapHandle>(null)
  const streetView = useRef<google.maps.StreetViewPanorama | null>(null)
  const viewChoice = useRef(false)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => { if (!loaded) setLoadFailed(true) }, 12000)
    return () => clearTimeout(timer)
  }, [loaded])

  useEffect(() => {
    if (!loaded) return
    let cancelled = false
    void (async () => {
      const streetLibrary = loadLibrary('streetView')
      const geocoding = await loadLibrary('geocoding')
      const coordinate = { lat: original.lat, lng: original.lng }
      const resolved = geocoding ? await resolvePropertyLocation(original.label, coordinate) : { coordinate, addressMatched: false }
      if (cancelled) return
      setLocation(resolved)
      setStreetStatus('Looking for nearby Street View…')
      const nearby = await streetLibrary ? await resolveSubjectPanorama(resolved.coordinate) : null
      if (cancelled) return
      setPanorama(nearby)
      setStreetStatus(nearby ? `Nearby Street View · ${Math.round(nearby.distanceMeters)} m from subject · facing subject` : 'No nearby Street View available for this subject.')
      if (!viewChoice.current) setView(nearby ? 'street' : 'aerial')
    })()
    return () => { cancelled = true }
  }, [loaded, original.label, original.lat, original.lng])

  // Load and render 3D only when requested: don't keep an invisible WebGL map
  // running behind the panorama during a long review session.
  useEffect(() => {
    if (view !== 'aerial' || threeD !== 'loading') return
    let cancelled = false
    void loadLibrary('maps3d').then(ok => { if (!cancelled) setThreeD(ok ? 'ready' : 'unavailable') })
    return () => { cancelled = true }
  }, [view, threeD])

  const backToMap = useCallback(() => {
    viewChoice.current = true
    setFlatZoom(19)
    setView('aerial')
  }, [])
  const openStreet = useCallback(() => {
    if (panorama) { viewChoice.current = true; setView('street') }
  }, [panorama])
  const streetFailed = useCallback(() => {
    setPanorama(null)
    setStreetStatus('Street View could not load for this subject.')
    backToMap()
  }, [backToMap])
  const mark3DUnavailable = useCallback(() => setThreeD('unavailable'), [])
  const selectMarker = useCallback((marker: MapMarker) => onMarkerClick?.(marker.type === 'subject' ? 'subject' : 'comp', marker.compKey), [onMarkerClick])
  const correctedMarkers = markers.map(marker => marker.type === 'subject' && location ? { ...marker, ...location.coordinate } : marker)
  const zoomBy = (direction: 1 | -1) => {
    if (view === 'street') {
      const zoom = streetView.current?.getZoom() ?? 0
      if (direction < 0 && zoom <= 0) backToMap()
      else streetView.current?.setZoom(Math.max(0, Math.min(3, zoom + direction * 0.5)))
      return
    }
    if (threeD === 'ready') aerial.current?.zoomBy(direction)
    else if (flatZoom + direction >= 21 && panorama) openStreet()
    else setFlatZoom(zoom => Math.min(21, Math.max(10, zoom + direction)))
  }

  if (loadFailed && !loaded) return <div role="status" className="p-4 text-sm">Map could not load. Reload this page to try again.</div>
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="subject-map" data-view={view}>
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border bg-background p-2">
        {view === 'street' ? <button type="button" className={buttonClass} onClick={backToMap}><ArrowLeft size={14} /> Back to map</button>
          : <button type="button" className={buttonClass} onClick={openStreet} disabled={!panorama}><PersonStanding size={14} /> Street View</button>}
        <button type="button" className={buttonClass} disabled={!location} onClick={() => { backToMap(); aerial.current?.recenter() }}><Crosshair size={14} /> Subject</button>
        <button type="button" className={buttonClass} aria-label="Zoom in" disabled={view === 'loading'} onClick={() => zoomBy(1)}><Plus size={14} /></button>
        <button type="button" className={buttonClass} aria-label="Zoom out" disabled={view === 'loading'} onClick={() => zoomBy(-1)}><Minus size={14} /></button>
        <button type="button" className={buttonClass} aria-label="Rotate counterclockwise" title="Rotate N → W → S → E; or double-click the map" disabled={view !== 'aerial' || threeD !== 'ready'} onClick={() => aerial.current?.rotate()}><RotateCcw size={14} /></button>
        {view === 'loading' && location && <button type="button" className={buttonClass} onClick={backToMap}>Open map</button>}
      </div>
      <div className="relative min-h-[160px] flex-1 overflow-hidden bg-secondary/30">
        {view === 'street' && panorama && location && <SubjectStreetView viewRef={streetView} panorama={panorama} subject={location.coordinate} onBack={backToMap} onFailure={streetFailed} />}
        {view === 'aerial' && location && (threeD === 'ready' ?
          <SubjectAerialMap ref={aerial} subject={location.coordinate} markers={correctedMarkers} activeMarkerKey={activeMarkerKey} onMarkerClick={selectMarker} onStreetView={panorama ? openStreet : undefined} onUnavailable={mark3DUnavailable} /> : threeD === 'unavailable' ?
          <Map center={location.coordinate} zoom={flatZoom} onZoomChanged={event => { if (event.detail.zoom >= 21 && panorama) openStreet(); else setFlatZoom(event.detail.zoom) }} mapTypeId="hybrid" tilt={0} gestureHandling="greedy" draggable={false} disableDefaultUI disableDoubleClickZoom clickableIcons={false}>
            <FlatMarkers markers={correctedMarkers} activeMarkerKey={activeMarkerKey} onMarkerClick={selectMarker} />
          </Map> : <div role="status" className="p-4 text-sm">Loading 3D map…</div>)}
        {view === 'aerial' && threeD !== 'loading' && <MapLegend />}
        {view === 'loading' && <div role="status" className="p-4 text-sm">{streetStatus}</div>}
      </div>
      <div className="shrink-0 border-t border-border bg-background px-2 py-1 text-[10px] text-foreground-secondary" aria-live="polite">
        <div className="truncate font-medium" title={original.label}>{original.label}</div>
        {view === 'street' ? <><div>{streetStatus}</div><div>{location?.addressMatched ? 'Address matched.' : 'Using report coordinates; address not confirmed.'} Image may show neighboring buildings.</div></>
          : view === 'aerial' ? <><div>{threeD === 'unavailable' ? 'Satellite fallback · 3D unavailable' : '45° aerial · double-click to rotate · zoom in for Street View'}</div>{!location?.addressMatched && <div>Using report coordinates; address not confirmed.</div>}{!panorama && <div>{streetStatus}</div>}</> : null}
      </div>
    </div>
  )
}

export default function PropertyMapInner(props: PropertyMapInnerProps) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAP_KEY
  const [failed, setFailed] = useState(false)
  if (!apiKey || failed) return <div role="status" className="p-4 text-sm">Map unavailable. Property details are still available.</div>
  return <APIProvider apiKey={apiKey} version="weekly" onError={() => setFailed(true)}><SubjectMap {...props} /></APIProvider>
}
