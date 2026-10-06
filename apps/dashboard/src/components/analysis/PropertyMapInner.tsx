'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { APIProvider, Map, useApiIsLoaded, useMap } from '@vis.gl/react-google-maps'
import { resolvePropertyLocation, resolveSubjectPanorama } from '@/lib/resolve-property-map'
import type { MapCoordinate } from '@/lib/property-map-geometry'
import { SubjectAerialMap, type SubjectAerialMapHandle } from './SubjectAerialMap'
import { MAP_COLORS, markerNumberColor } from './map-colors'
import { AREA_MATCH_WORDS } from './format-helpers'
import { MapLegend } from './MapOverlay'
import type { MapMarker } from './PropertyMap'
import { emitMarkerHover } from './map-hover'
import { DWELL_MS, hoverIntent, movedBeyondSlop, type Point } from './hover-intent'

type Panorama = NonNullable<Awaited<ReturnType<typeof resolveSubjectPanorama>>>
// Comps are one neutral dot each · the price label beside it carries the
// information, and the number ties the dot to its card.
const colors = { subject: MAP_COLORS.subject, 'comp-arv': MAP_COLORS.included, 'comp-market': MAP_COLORS.included, 'comp-floor': MAP_COLORS.included, 'comp-disabled': MAP_COLORS.excluded }
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
  const fill = active ? MAP_COLORS.active : colors[marker.type]
  if (marker.type === 'subject') {
    return { path: google.maps.SymbolPath.CIRCLE, scale: 12, fillColor: fill, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 }
  }
  // Dot with the card number inside; beside it a white tag: the sale price, then how the comp sits
  // against the subject (block group, neighborhood, both, or outside). Light tag on satellite
  // imagery, dark text, a green dot when there is a match.
  const price = priceLabel(marker.price)
  const matchWord = AREA_MATCH_WORDS[marker.match ?? 'none']
  const matched = !!marker.match && marker.match !== 'none'
  const dotW = matched ? 12 : 0
  const tagW = Math.max(price ? price.length * 7 + 12 : 0, matchWord.length * 5.6 + 14 + dotW)
  const tagH = (price ? 30 : 18)
  const h = Math.max(24, tagH)
  const w = 24 + 4 + tagW
  const cy = h / 2
  const tagY = (h - tagH) / 2
  const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const matchY = tagY + (price ? 22 : 9)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<circle cx="12" cy="${cy}" r="10" fill="${fill}" stroke="#fff" stroke-width="2"/>`
    + `<text x="12" y="${cy}" text-anchor="middle" dominant-baseline="central" font-family="system-ui,sans-serif" font-size="10" font-weight="700" fill="${active ? '#fff' : markerNumberColor(marker.type)}">${index}</text>`
    + `<rect x="28" y="${tagY}" width="${tagW}" height="${tagH}" rx="5" fill="#ffffff" fill-opacity="0.96" stroke="${matched ? MAP_COLORS.included : '#a1a1aa'}" stroke-width="1"/>`
    + (price ? `<text x="${28 + tagW / 2}" y="${tagY + 11}" text-anchor="middle" dominant-baseline="central" font-family="system-ui,sans-serif" font-size="11" font-weight="700" fill="#171717">${esc(price)}</text>` : '')
    + (matched ? `<circle cx="${28 + 8}" cy="${matchY}" r="2.5" fill="${MAP_COLORS.included}"/>` : '')
    + `<text x="${28 + tagW / 2 + dotW / 2}" y="${matchY}" text-anchor="middle" dominant-baseline="central" font-family="system-ui,sans-serif" font-size="9" font-weight="600" fill="${matched ? '#047857' : '#52525b'}">${esc(matchWord)}</text>`
    + '</svg>'
  return { url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`, anchor: new google.maps.Point(12, cy), size: new google.maps.Size(w, h) }
}

// Where the pointer is · module scope, because the map layer remounts (for example when a dialog
// opens) and the position is needed at the first hover after that.
const lastPointer: { current: Point | null } = { current: null }

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
  // Build markers once per marker set · a highlight change must not rebuild
  // them under the pointer (that re-fires mouseover and reopens the dialog).
  useEffect(() => {
    if (!map) return
    const pointer = lastPointer
    const at = (event?: { domEvent?: Event }) => {
      const dom = event?.domEvent
      return dom instanceof MouseEvent ? { x: dom.clientX, y: dom.clientY } : pointer.current
    }
    const container = map.getDiv()

    // Hover has to be intentional: a drag, a zoom, a wheel turn or a held button is never a hover,
    // and the pointer has to rest on the marker for a moment before its card opens.
    let gesturing = false
    let dragging = false
    let lastInteractionAt = 0
    const rest: { compKey: string; point: Point; since: number; timer: ReturnType<typeof setTimeout> | null } = { compKey: '', point: { x: 0, y: 0 }, since: 0, timer: null }
    let over = false
    const cancelRest = () => { over = false; if (rest.timer) { clearTimeout(rest.timer); rest.timer = null } }
    const check = () => {
      rest.timer = null
      if (!over) return
      const intent = hoverIntent({ now: Date.now(), restedSince: rest.since, lastInteractionAt, gesturing })
      if (intent.ready) emitMarkerHover({ compKey: rest.compKey, x: rest.point.x, y: rest.point.y })
      else rest.timer = setTimeout(check, Math.max(40, intent.waitMs))
    }
    const startRest = (compKey: string, point: Point) => {
      rest.compKey = compKey; rest.point = point; rest.since = Date.now(); over = true
      if (rest.timer) clearTimeout(rest.timer)
      rest.timer = setTimeout(check, DWELL_MS)
    }
    const track = (event: MouseEvent) => {
      const point = { x: event.clientX, y: event.clientY }
      pointer.current = point
      gesturing = dragging || event.buttons !== 0
      if (over && movedBeyondSlop(rest.point, point)) startRest(rest.compKey, point)
    }
    const touchInteraction = () => { lastInteractionAt = Date.now() }
    const listeners = [
      map.addListener('dragstart', () => { dragging = true; gesturing = true; cancelRest(); emitMarkerHover(null) }),
      map.addListener('dragend', () => { dragging = false; gesturing = false; touchInteraction() }),
      map.addListener('zoom_changed', touchInteraction),
    ]
    container.addEventListener('mousemove', track, true)
    container.addEventListener('wheel', touchInteraction, { capture: true, passive: true })
    iconCache.current = {}
    instances.current = markers.map((marker, index) => {
      const instance = new google.maps.Marker({
        // Comp markers show our own card · a browser tooltip beside it only gets in the way
        map, position: marker, title: marker.type === 'subject' ? marker.label : undefined,
        icon: iconFor(marker, markerKey(marker) === activeKey.current, index),
        label: marker.type === 'subject' ? { text: 'S', color: '#fff', fontSize: '10px' } : undefined,
        zIndex: marker.type === 'subject' ? 100 : 10,
      })
      if (marker.type === 'subject' || !marker.compKey) {
        instance.addListener('click', () => onMarkerClick(marker))
        return { marker, instance }
      }
      const compKey = marker.compKey
      // A click or tap shows the comp beside the subject and keeps it there (the card itself opens the full
      // detail). Resting on the marker shows the same card, and it goes when the pointer leaves.
      instance.addListener('click', (event: google.maps.MapMouseEvent) => {
        cancelRest()
        const point = at(event)
        if (point) emitMarkerHover({ compKey, x: point.x, y: point.y, pinned: true })
      })
      instance.addListener('mouseover', (event: google.maps.MapMouseEvent) => {
        const point = at(event)
        if (point) startRest(compKey, point)
      })
      instance.addListener('mouseout', () => { cancelRest(); emitMarkerHover(null) })
      return { marker, instance }
    })
    return () => {
      cancelRest()
      listeners.forEach((listener) => listener.remove())
      container.removeEventListener('mousemove', track, true)
      container.removeEventListener('wheel', touchInteraction, true)
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
