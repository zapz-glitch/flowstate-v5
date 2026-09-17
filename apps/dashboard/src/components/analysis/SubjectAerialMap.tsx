/// <reference types="google.maps" />
'use client'

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { AltitudeMode, Map3D, MapMode, Marker3D, Pin, useMap3D } from '@vis.gl/react-google-maps'
import { distanceMeters, nextCounterclockwiseHeading, type MapCoordinate } from '@/lib/property-map-geometry'
import type { MapMarker } from './PropertyMap'

export interface SubjectAerialMapHandle {
  /** Positive zooms in, negative zooms out. */
  zoomBy(direction: 1 | -1): void
  rotate(): void
  recenter(): void
}

interface SubjectAerialMapProps {
  subject: MapCoordinate
  markers: MapMarker[]
  activeMarkerKey?: string | null
  onMarkerClick?: (marker: MapMarker) => void
  onStreetView?: () => void
  onUnavailable: () => void
}

const INITIAL_RANGE = 200
const STREET_RANGE = 45
const MAX_RANGE = 5000
const GROUND_PROBE_HEIGHT = 50
type Center = MapCoordinate & { altitude: number }

// The installed Google declarations predate stable 3D camera animations.
// Keep the compatibility surface limited to the documented method we use.
type GroundCameraMap = google.maps.maps3d.Map3DElement & {
  cameraPosition?: Center
  defaultUIHidden?: boolean
  flyCameraTo(options: {
    endCamera: { cameraPosition: Center; altitudeMode: 'RELATIVE_TO_GROUND'; range: number; tilt: number; heading: number; roll: number }
    durationMillis: number
  }): void
  stopCameraAnimation(): void
}

const NO_ACTIONS: SubjectAerialMapHandle = { zoomBy() {}, rotate() {}, recenter() {} }

function CameraController({ subject, actions, onReady, onStreetView, onUnavailable }: {
  subject: MapCoordinate
  actions: React.MutableRefObject<SubjectAerialMapHandle>
  onReady: () => void
  onStreetView?: () => void
  onUnavailable: () => void
}) {
  const instance = useMap3D()
  const callbacks = useRef({ onReady, onStreetView, onUnavailable })
  callbacks.current = { onReady, onStreetView, onUnavailable }

  useEffect(() => {
    if (!instance) return
    const map = instance as GroundCameraMap
    let anchor: Center | null = null
    let disposed = false
    let correcting = false
    let enteredStreet = false
    let correctionFrame = 0
    let initFrame = 0
    let probeRequested = false
    let readySent = false
    let desiredRange = INITIAL_RANGE

    const ready = () => {
      if (anchor && !readySent) {
        readySent = true
        callbacks.current.onReady()
      }
    }
    const correctCamera = () => {
      if (!anchor || disposed || correcting) return
      correcting = true
      try {
        const center = map.center
        if (!center || distanceMeters(center, anchor) > 0.02 || Math.abs((center.altitude ?? 0) - anchor.altitude) > 0.02) {
          map.center = { ...anchor }
        }
        if (Math.abs((map.tilt ?? 0) - 45) > 0.01) map.tilt = 45
        if (map.roll !== 0) map.roll = 0
        // Google can temporarily normalize range to zero while rotating. Only
        // our explicit zoom gestures may change range or enter Street View.
        if (Math.abs((map.range ?? 0) - desiredRange) > 0.01) map.range = desiredRange
      } finally {
        correcting = false
      }
    }
    const scheduleCorrection = () => {
      if (correcting || correctionFrame || disposed) return
      correctionFrame = requestAnimationFrame(() => { correctionFrame = 0; correctCamera() })
    }
    const finishGroundProbe = () => {
      if (disposed || anchor || !probeRequested) return
      const resolved = map.cameraPosition ?? map.center
      // A zero-duration fly may normalize center/range to the camera position
      // and emits no animationend. Probe directly above the subject at range 0,
      // then derive its terrain altitude from the resolved absolute camera.
      if (!resolved || distanceMeters(resolved, subject) > 1 || !Number.isFinite(resolved.altitude)) {
        // A queued steady notification may still describe the previous scene.
        // Keep waiting for the probe; the overall readiness deadline is bounded.
        return
      }
      anchor = { lat: subject.lat, lng: subject.lng, altitude: resolved.altitude! - GROUND_PROBE_HEIGHT }
      // Restore the review range before enabling normal boundary handling.
      // The probe's zero range must never open Street View.
      map.range = INITIAL_RANGE
      correctCamera()
    }
    const steady = (event: Event) => {
      if (!(event as Event & { isSteady?: boolean }).isSteady) return
      if (!anchor) finishGroundProbe()
      else ready()
    }
    const failed = () => { if (!disposed) callbacks.current.onUnavailable() }
    const rotate = () => {
      if (!anchor) return
      map.heading = nextCounterclockwiseHeading(map.heading ?? 0)
      correctCamera()
    }
    const zoom = (factor: number) => {
      if (!anchor || !Number.isFinite(factor) || factor <= 0) return
      desiredRange = Math.max(20, Math.min(MAX_RANGE, desiredRange * factor))
      if (desiredRange <= STREET_RANGE && !enteredStreet && callbacks.current.onStreetView) {
        enteredStreet = true
        desiredRange = INITIAL_RANGE
        correctCamera()
        callbacks.current.onStreetView()
        requestAnimationFrame(() => { if (!disposed) enteredStreet = false })
      } else correctCamera()
    }
    const interactiveTarget = (event: Event) => event.composedPath().some(node => node instanceof Element &&
      node.matches('button, a, input, select, textarea, gmp-marker-3d-interactive, [data-marker]'))
    const doubleClick = (event: MouseEvent) => {
      if (interactiveTarget(event)) return
      // Capture before the web component's native double-click zoom.
      event.preventDefault()
      event.stopImmediatePropagation()
      rotate()
    }

    const pointers = new Map<number, { x: number; y: number }>()
    let lastDown = { time: -Infinity, x: 0, y: 0 }
    let suppressSecondPress = false
    let dragStart: { x: number; y: number; heading: number } | null = null
    let dragged = false
    let pinchDistance = 0
    const wheel = (event: WheelEvent) => {
      if (interactiveTarget(event) || !anchor || !event.deltaY) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1)
      zoom(Math.exp(Math.max(-0.5, Math.min(0.5, pixels * 0.003))))
    }
    const pointerDown = (event: PointerEvent) => {
      if (interactiveTarget(event) || !anchor || event.button > 0) return
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      suppressSecondPress = event.pointerType !== 'touch' && event.timeStamp - lastDown.time < 450 && Math.hypot(event.clientX - lastDown.x, event.clientY - lastDown.y) < 8
      lastDown = { time: event.timeStamp, x: event.clientX, y: event.clientY }
      dragStart = { x: event.clientX, y: event.clientY, heading: map.heading ?? 0 }
      dragged = false
      if (pointers.size === 2) {
        const [first, second] = [...pointers.values()]
        pinchDistance = Math.hypot(first.x - second.x, first.y - second.y)
      }
      // Preserve first pointerdown for Google's projected marker hit testing,
      // but hide the second press before its native double-click zoom handler.
      if (suppressSecondPress || pointers.size > 1) event.stopImmediatePropagation()
    }
    const mouseDown = (event: MouseEvent) => {
      if (suppressSecondPress && !interactiveTarget(event)) event.stopImmediatePropagation()
    }
    const pointerMove = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId) || !anchor) return
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pointers.size >= 2) {
        const [first, second] = [...pointers.values()]
        const distance = Math.hypot(first.x - second.x, first.y - second.y)
        if (pinchDistance > 0 && distance > 0) zoom(pinchDistance / distance)
        pinchDistance = distance
        dragged = true
      } else if (dragStart && Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y) > 4) {
        map.heading = ((dragStart.heading - (event.clientX - dragStart.x) * 0.5) % 360 + 360) % 360
        correctCamera()
        dragged = true
      }
      if (dragged) { event.preventDefault(); event.stopImmediatePropagation() }
    }
    const pointerUp = (event: PointerEvent) => {
      if (!pointers.delete(event.pointerId)) return
      pinchDistance = 0
      const remaining = pointers.values().next().value
      dragStart = remaining ? { ...remaining, heading: map.heading ?? 0 } : null
    }
    const click = (event: MouseEvent) => {
      if (dragged && !interactiveTarget(event)) { event.preventDefault(); event.stopImmediatePropagation(); dragged = false }
    }

    actions.current = {
      zoomBy(direction) {
        if (!anchor) return
        zoom(direction === 1 ? 0.65 : 1 / 0.65)
      },
      rotate,
      recenter() {
        if (!anchor) return
        desiredRange = INITIAL_RANGE
        correctCamera()
      },
    }
    const cameraEvents = ['gmp-centerchange', 'gmp-rangechange', 'gmp-tiltchange', 'gmp-rollchange', 'gmp-headingchange']
    cameraEvents.forEach(name => map.addEventListener(name, scheduleCorrection))
    map.addEventListener('gmp-steadychange', steady)
    map.addEventListener('gmp-error', failed)
    const wrapper = map.parentElement
    wrapper?.addEventListener('dblclick', doubleClick, true)
    wrapper?.addEventListener('wheel', wheel, { capture: true, passive: false })
    wrapper?.addEventListener('pointerdown', pointerDown, true)
    wrapper?.addEventListener('mousedown', mouseDown, true)
    wrapper?.addEventListener('pointermove', pointerMove, { capture: true, passive: false })
    wrapper?.addEventListener('click', click, true)
    window.addEventListener('pointerup', pointerUp, true)
    window.addEventListener('pointercancel', pointerUp, true)
    const resize = new ResizeObserver(scheduleCorrection)
    resize.observe(map)
    // Wait until the wrapper has applied its initial camera options.
    initFrame = requestAnimationFrame(() => {
      if (disposed) return
      try {
        probeRequested = true
        map.defaultUIHidden = true
        map.flyCameraTo({
          endCamera: { cameraPosition: { lat: subject.lat, lng: subject.lng, altitude: GROUND_PROBE_HEIGHT }, altitudeMode: 'RELATIVE_TO_GROUND', range: 0, tilt: 45, heading: 0, roll: 0 },
          durationMillis: 0,
        })
      } catch { failed() }
    })
    return () => {
      disposed = true
      actions.current = NO_ACTIONS
      cancelAnimationFrame(initFrame)
      cancelAnimationFrame(correctionFrame)
      resize.disconnect()
      cameraEvents.forEach(name => map.removeEventListener(name, scheduleCorrection))
      map.removeEventListener('gmp-steadychange', steady)
      map.removeEventListener('gmp-error', failed)
      wrapper?.removeEventListener('dblclick', doubleClick, true)
      wrapper?.removeEventListener('wheel', wheel, true)
      wrapper?.removeEventListener('pointerdown', pointerDown, true)
      wrapper?.removeEventListener('mousedown', mouseDown, true)
      wrapper?.removeEventListener('pointermove', pointerMove, true)
      wrapper?.removeEventListener('click', click, true)
      window.removeEventListener('pointerup', pointerUp, true)
      window.removeEventListener('pointercancel', pointerUp, true)
      map.stopCameraAnimation?.()
    }
  }, [instance, subject.lat, subject.lng, actions])
  return null
}

export const SubjectAerialMap = forwardRef<SubjectAerialMapHandle, SubjectAerialMapProps>(function SubjectAerialMap(
  { subject, markers, activeMarkerKey, onMarkerClick, onStreetView, onUnavailable }, ref,
) {
  const actions = useRef<SubjectAerialMapHandle>(NO_ACTIONS)
  const [ready, setReady] = useState(false)
  const unavailable = useRef(onUnavailable)
  unavailable.current = onUnavailable
  const failed = useRef(false)
  const handleUnavailable = useCallback(() => {
    if (failed.current) return
    failed.current = true
    unavailable.current()
  }, [])
  const handleReady = useCallback(() => setReady(true), [])
  useImperativeHandle(ref, () => ({
    zoomBy: direction => actions.current.zoomBy(direction),
    rotate: () => actions.current.rotate(),
    recenter: () => actions.current.recenter(),
  }), [])
  useEffect(() => { setReady(false); failed.current = false }, [subject.lat, subject.lng])
  useEffect(() => {
    if (ready) return
    const timeout = setTimeout(handleUnavailable, 15000)
    return () => clearTimeout(timeout)
  }, [ready, subject.lat, subject.lng, handleUnavailable])

  let compNumber = 0
  return (
    <div className="relative h-full w-full" data-testid="subject-aerial-map">
      <Map3D key={`${subject.lat},${subject.lng}`} mode={MapMode.HYBRID} gestureHandling="GREEDY" defaultRange={INITIAL_RANGE} defaultHeading={0} defaultTilt={45} minTilt={45} maxTilt={45} defaultRoll={0} onError={handleUnavailable} style={{ width: '100%', height: '100%' }}>
        <CameraController subject={subject} actions={actions} onReady={handleReady} onStreetView={onStreetView} onUnavailable={handleUnavailable} />
        {markers.map(marker => {
          const isSubject = marker.type === 'subject'
          if (!isSubject) compNumber++
          const active = activeMarkerKey === (isSubject ? 'subject' : marker.compKey)
          const color = active ? '#f59e0b' : isSubject ? '#3b82f6' : marker.type === 'comp-enabled' ? '#10b981' : '#6b7280'
          return (
            <Marker3D key={isSubject ? 'subject' : marker.compKey ?? `${marker.lat},${marker.lng}`} position={{ lat: marker.lat, lng: marker.lng, altitude: 0 }} altitudeMode={AltitudeMode.CLAMP_TO_GROUND} drawsWhenOccluded collisionBehavior="REQUIRED" sizePreserved zIndex={isSubject ? 100 : active ? 50 : 10} title={marker.label} onClick={() => onMarkerClick?.(marker)}>
              <Pin background={color} borderColor="#fff" glyphColor="#fff" glyph={isSubject ? 'S' : String(compNumber)} scale={1.1} />
            </Marker3D>
          )
        })}
      </Map3D>
      {!ready && <div className="absolute inset-0 flex items-center justify-center bg-background text-sm text-foreground-secondary" role="status">Loading subject’s 3D map…</div>}
    </div>
  )
})

export default SubjectAerialMap
