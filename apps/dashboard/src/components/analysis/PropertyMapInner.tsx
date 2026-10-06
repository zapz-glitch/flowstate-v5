'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { APIProvider, Map, useApiIsLoaded, useMap } from '@vis.gl/react-google-maps'
import { resolvePropertyLocation, resolveSubjectPanorama } from '@/lib/resolve-property-map'
import type { MapCoordinate } from '@/lib/property-map-geometry'
import { SubjectAerialMap, type SubjectAerialMapHandle } from './SubjectAerialMap'
import { MapLegend } from './MapOverlay'
import type { MapMarker } from './PropertyMap'
import { emitMarkerHover } from './map-hover'

type Panorama = NonNullable<Awaited<ReturnType<typeof resolveSubjectPanorama>>>
// Comps are one neutral dot each · the price label beside it carries the
// information, and the number ties the dot to its card.
const colors = { subject: '#3b82f6', 'comp-arv': '#404040', 'comp-market': '#404040', 'comp-floor': '#404040', 'comp-disabled': '#a3a3a3' }
const priceLabel = (price?: number | null) => price == null ? null : price >= 1_000_000 ? `$${(price / 1_000_000).toFixed(2)}M` : `$${Math.round(price / 1000)}k`
const buttonClass = 'flex h-8 items-center justify-center gap-1 rounded-md border border-border bg-background px-2 text-xs text-foreground shadow-sm hover:bg-secondary disabled:opacity-40'

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

const markerKey = (marker: MapMarker) => (marker.type === 'subject' ? 'subject' : marker.compKey)
const markerIcon = (marker: MapMarker, active: boolean, index: number): google.maps.Icon | google.maps.Symbol => {
  const fill = active ? '#f59e0b' : colors[marker.type]
  if (marker.type === 'subject') {
    return { path: google.maps.SymbolPath.CIRCLE, scale: 12, fillColor: fill, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 }
  }
  // Dot with the card number inside; beside it a small tag: sale price, then
  // price class, then condition.
  const lines = [priceLabel(marker.price), marker.priceClass ?? null, marker.condition ?? null].filter((line): line is string => !!line)
  const tagW = lines.length ? Math.max(...lines.map((line) => line.length)) * 6.8 + 14 : 0
  const tagH = lines.length * 12 + 6
  const h = Math.max(24, tagH)
  const w = 24 + (lines.length ? 4 + tagW : 0)
  const cy = h / 2
  const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<circle cx="12" cy="${cy}" r="10" fill="${fill}" stroke="#fff" stroke-width="2"/>`
    + `<text x="12" y="${cy}" text-anchor="middle" dominant-baseline="central" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="#fff">${index}</text>`
    + (lines.length ? `<rect x="28" y="${(h - tagH) / 2}" width="${tagW}" height="${tagH}" rx="5" fill="#171717" fill-opacity="0.92" stroke="#fff" stroke-width="1"/>`
      + lines.map((line, i) => `<text x="${28 + tagW / 2}" y="${(h - tagH) / 2 + 9 + i * 12}" text-anchor="middle" dominant-baseline="central" font-family="system-ui,sans-serif" font-size="${i === 0 ? 10 : 9}" font-weight="${i === 0 ? 700 : 500}" fill="${i === 0 ? '#fff' : '#d4d4d4'}">${esc(line)}</text>`).join('') : '')
    + '</svg>'
  return { url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`, anchor: new google.maps.Point(12, cy), size: new google.maps.Size(w, h) }
}

// Where the pointer is and where it last opened a comp from the map. Closing
// the dialog with the pointer still resting on (or wiggling over) a marker must
// not open it again. Module scope · the map layer remounts when the dialog
// opens, which would otherwise forget the guard at the exact moment it matters.
const hoverGuard: {
  pointer: { current: { x: number; y: number } | null }
  openedAt: { current: { x: number; y: number } | null }
} = { pointer: { current: null }, openedAt: { current: null } }

function FlatMarkers({ markers, activeMarkerKey, onMarkerClick }: {
  markers: MapMarker[]; activeMarkerKey?: string | null; onMarkerClick: (marker: MapMarker) => void
}) {
  const map = useMap()
  const instances = useRef<Array<{ marker: MapMarker; instance: google.maps.Marker }>>([])
  // Icons are SVG strings turned into data URLs · build each (marker, active) pair once
  const iconCache = useRef<Record<string, ReturnType<typeof markerIcon>>>({})
  const iconFor = (marker: MapMarker, active: boolean, index: number) => {
    const cacheKey = `${index}|${active ? 1 : 0}`
    return (iconCache.current[cacheKey] ??= markerIcon(marker, active, index))
  }
  const previousActive = useRef<string | null | undefined>(undefined)
  const activeKey = useRef(activeMarkerKey)
  activeKey.current = activeMarkerKey
  // Hover opens the comp detail once, then stays quiet until the pointer has
  // travelled away from where it opened (see hoverGuard). A click always opens.
  const { pointer, openedAt } = hoverGuard

  // Build markers once per marker set · a highlight change must not rebuild
  // them under the pointer (that re-fires mouseover and reopens the dialog).
  useEffect(() => {
    if (!map) return
    const REARM_DISTANCE = 32 // px · comfortably outside a 20px marker
    const at = (event?: { domEvent?: Event }) => {
      const dom = event?.domEvent
      return dom instanceof MouseEvent ? { x: dom.clientX, y: dom.clientY } : pointer.current
    }
    const container = map.getDiv()
    const track = (event: MouseEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY }
      const origin = openedAt.current
      if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > REARM_DISTANCE) openedAt.current = null
    }
    container.addEventListener('mousemove', track, true)
    iconCache.current = {}
    instances.current = markers.map((marker, index) => {
      const instance = new google.maps.Marker({
        // Comp markers show our own hover panel · a browser tooltip beside it only gets in the way
        map, position: marker, title: marker.type === 'subject' ? marker.label : undefined,
        icon: iconFor(marker, markerKey(marker) === activeKey.current, index),
        label: marker.type === 'subject' ? { text: 'S', color: '#fff', fontSize: '10px' } : undefined,
        zIndex: marker.type === 'subject' ? 100 : 10,
      })
      instance.addListener('click', (event: google.maps.MapMouseEvent) => {
        openedAt.current = at(event)
        onMarkerClick(marker)
      })
      // Hover shows the comp beside the subject (see map-hover) · a click
      // still opens the full comp detail.
      if (marker.type !== 'subject' && marker.compKey) {
        const compKey = marker.compKey
        instance.addListener('mouseover', (event: google.maps.MapMouseEvent) => {
          const point = at(event)
          if (point) emitMarkerHover({ compKey, x: point.x, y: point.y })
        })
        instance.addListener('mouseout', () => emitMarkerHover(null))
      }
      return { marker, instance }
    })
    return () => {
      container.removeEventListener('mousemove', track, true)
      instances.current.forEach(({ instance }) => { google.maps.event.clearInstanceListeners(instance); instance.setMap(null) })
      instances.current = []
    }
  }, [map, markers, onMarkerClick])

  // Highlight (card hover, selection) restyles only the two markers that change:
  // the one that just lost the highlight and the one that just gained it.
  useEffect(() => {
    const previous = previousActive.current
    previousActive.current = activeMarkerKey
    instances.current.forEach(({ marker, instance }, index) => {
      const key = markerKey(marker)
      if (key === activeMarkerKey || key === previous) instance.setIcon(iconFor(marker, key === activeMarkerKey, index))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMarkerKey, markers, map])
  return null
}

function NativeMapCamera({ mapRef }: { mapRef: MutableRefObject<google.maps.Map | null> }) {
  const map = useMap()
  useEffect(() => {
    mapRef.current = map
    return () => { if (mapRef.current === map) mapRef.current = null }
  }, [map, mapRef])
  return null
}

// Right-click leaves full screen. Outside full screen the browser menu is untouched.
function FullscreenRightClickExit() {
  const map = useMap()
  useEffect(() => {
    if (!map) return
    const container = map.getDiv()
    const onContextMenu = (event: MouseEvent) => {
      const full = document.fullscreenElement
      // Only the map's own full screen · the fullscreen element is the map div
      // or a wrapper around it, depending on how the map was mounted.
      if (!full || !(full.contains(container) || container.contains(full))) return
      event.preventDefault()
      event.stopPropagation()
      void document.exitFullscreen()
    }
    document.addEventListener('contextmenu', onContextMenu, true)
    return () => document.removeEventListener('contextmenu', onContextMenu, true)
  }, [map])
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
      // Proportional zoom — fixed ±0.25 steps jumped a whole zoom notch per
      // wheel tick; scale by pixels scrolled instead (line/page aware).
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1)
      if (event.deltaY > 0 && zoom <= 0) back.current()
      else view.setZoom(Math.max(0, Math.min(3, zoom - Math.max(-0.35, Math.min(0.35, pixels * 0.0012)))))
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
  return <><div ref={container} className="absolute inset-0" aria-label="Street View facing the subject property" />{pending && <div role="status" className="pointer-events-none absolute left-2 top-2 rounded bg-background p-2 text-xs">Loading Street View…</div>}</>
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
  // Satellite only · the layer buttons are gone; the 3D and Street View paths below are no longer reachable from the UI
  const [mapStyle] = useState<'roadmap' | 'hybrid' | '3d'>('hybrid')
  const nativeMap = useRef<google.maps.Map | null>(null)
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
      // Satellite map is the standard view. Street View is reached by zooming
      // the 3D map in to street level (see onStreetView).
      if (!viewChoice.current) setView('aerial')
      setStreetStatus('Looking for nearby Street View…')
      const nearby = await streetLibrary ? await resolveSubjectPanorama(resolved.coordinate) : null
      if (cancelled) return
      setPanorama(nearby)
      setStreetStatus(nearby ? `Nearby Street View · ${Math.round(nearby.distanceMeters)} m from subject · facing subject` : 'No nearby Street View available for this subject.')
    })()
    return () => { cancelled = true }
  }, [loaded, original.label, original.lat, original.lng])

  // Load and render 3D only when requested: don't keep an invisible WebGL map
  // running behind the panorama during a long review session.
  useEffect(() => {
    if (view !== 'aerial' || mapStyle !== '3d' || threeD !== 'loading') return
    let cancelled = false
    void loadLibrary('maps3d').then(ok => { if (!cancelled) setThreeD(ok ? 'ready' : 'unavailable') })
    return () => { cancelled = true }
  }, [view, threeD, mapStyle])

  const backToMap = useCallback(() => {
    viewChoice.current = true
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
  // Stable callback + memoized marker list — without these every status/state
  // change rebuilt all Google markers, which is the visible map flicker.
  const onMarkerClickRef = useRef(onMarkerClick)
  onMarkerClickRef.current = onMarkerClick
  const selectMarker = useCallback(
    (marker: MapMarker) => onMarkerClickRef.current?.(marker.type === 'subject' ? 'subject' : 'comp', marker.compKey),
    [],
  )
  const correctedMarkers = useMemo(
    () => markers.map(marker => marker.type === 'subject' && location ? { ...marker, ...location.coordinate } : marker),
    [markers, location],
  )
  if (loadFailed && !loaded) return <div role="status" className="p-4 text-sm">Map could not load. Reload this page to try again.</div>
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="subject-map" data-view={view}>
      <div className="relative min-h-[160px] flex-1 overflow-hidden bg-secondary/30">
        {view === 'street' && panorama && location && <SubjectStreetView viewRef={streetView} panorama={panorama} subject={location.coordinate} onBack={backToMap} onFailure={streetFailed} />}
        {view === 'aerial' && location && (mapStyle === '3d' && threeD === 'ready' ?
          <SubjectAerialMap ref={aerial} subject={location.coordinate} markers={correctedMarkers} activeMarkerKey={activeMarkerKey} onMarkerClick={selectMarker} onStreetView={panorama ? openStreet : undefined} onUnavailable={mark3DUnavailable} /> : mapStyle !== '3d' || threeD === 'unavailable' ?
          <Map defaultCenter={location.coordinate} defaultZoom={18} mapTypeId={mapStyle === 'roadmap' ? 'roadmap' : 'hybrid'}
            mapId={process.env.NEXT_PUBLIC_GOOGLE_MAP_ID || undefined}
            // Percentage heights collapse inside the min-h flex wrapper — pin
            // the map to the container so it always has a real viewport size.
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
            // VECTOR tiles require a Map ID — without one the map fails to
            // init entirely. Omit renderingType so the default raster works.
            {...(process.env.NEXT_PUBLIC_GOOGLE_MAP_ID ? { renderingType: 'VECTOR' as const } : {})}
            isFractionalZoomEnabled tilt={0} gestureHandling="greedy" clickableIcons keyboardShortcuts
            zoomControl mapTypeControl={false} streetViewControl={false} fullscreenControl fullscreenControlOptions={{ position: google.maps.ControlPosition.LEFT_TOP }} scaleControl>
            <NativeMapCamera mapRef={nativeMap} />
            <FullscreenRightClickExit />
            <FlatMarkers markers={correctedMarkers} activeMarkerKey={activeMarkerKey} onMarkerClick={selectMarker} />
          </Map> : <div role="status" className="p-4 text-sm">Loading 3D map…</div>)}
        {view === 'aerial' && (mapStyle !== '3d' || threeD !== 'loading') && <MapLegend />}
        {view === 'loading' && <div role="status" className="p-4 text-sm">{streetStatus}</div>}
      </div>
      {/* Only real status shows under the map · no address or how-to text */}
      {(view === 'street' || !panorama || !location?.addressMatched) && (view === 'street' || streetStatus) ? (
        <div className="sr-only" aria-live="polite">{streetStatus}</div>
      ) : null}
    </div>
  )
}

export default function PropertyMapInner(props: PropertyMapInnerProps) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAP_KEY
  const [failed, setFailed] = useState(false)
  if (!apiKey || failed) return <div role="status" className="p-4 text-sm">Map unavailable. Property details are still available.</div>
  return <APIProvider apiKey={apiKey} version="weekly" onError={() => setFailed(true)}><SubjectMap {...props} /></APIProvider>
}
