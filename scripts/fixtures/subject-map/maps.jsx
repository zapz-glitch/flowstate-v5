// Deterministic API boundary: production React map controllers remain real.
import React, { createContext, useContext, useLayoutEffect, useRef, useState } from 'react'
const ThreeD = createContext(null)
const Flat = createContext(null)
export const APIProvider = ({ children }) => children
export const useApiIsLoaded = () => true
export const useMap3D = () => useContext(ThreeD)
export const useMap = () => useContext(Flat)
export const MapMode = { HYBRID: 'HYBRID' }
export const AltitudeMode = { CLAMP_TO_GROUND: 'CLAMP_TO_GROUND' }
export const Pin = ({ background, glyphText, glyph }) => <span data-pin={glyphText ?? glyph} style={{ background }}>{glyphText ?? glyph}</span>
export function Marker3D({ children, title, onClick, position }) {
  return <button data-marker={title} data-position={JSON.stringify(position)} onClick={onClick}>{children}</button>
}
export function Map({ children, center, zoom }) {
  const ref = useRef({})
  window.fixture.flat = { center, zoom }
  return <div data-testid="flat-map" style={{ height: 400 }}><Flat.Provider value={ref.current}>{children}</Flat.Provider></div>
}
export function Map3D({ children }) {
  const ref = useRef(null)
  const [map, setMap] = useState(null)
  useLayoutEffect(() => {
    const element = ref.current
    window.fixture.aerial = element
    window.fixture.aerialMounts++
    const emitSteady = () => requestAnimationFrame(() => {
      if (window.fixture.stalled3D) return
      const event = new Event('gmp-steadychange')
      event.isSteady = true
      element.dispatchEvent(event)
    })
    let range = 0
    Object.defineProperty(element, 'range', { configurable: true, get: () => range, set(value) { range = value; emitSteady() } })
    let heading = 0
    Object.defineProperty(element, 'heading', { configurable: true, get: () => heading, set(value) {
      heading = value
      // Google normalizes camera/range during rotation; this must not be
      // interpreted as a user zoom or accidentally reopen Street View.
      range = 0
      element.dispatchEvent(new Event('gmp-headingchange'))
    } })
    let previousPress = -Infinity
    const nativePointerDown = event => {
      if (event.timeStamp - previousPress < 450) {
        window.fixture.nativeDoubleZooms = (window.fixture.nativeDoubleZooms ?? 0) + 1
        element.range = 0
        element.dispatchEvent(new Event('gmp-rangechange'))
      }
      previousPress = event.timeStamp
    }
    element.addEventListener('pointerdown', nativePointerDown)
    element.flyCameraTo = ({ endCamera }) => {
      window.fixture.groundMode = endCamera.altitudeMode
      // Match live Google: zero-duration fly normalizes to absolute camera
      // position/range0 and reports readiness without an animationend event.
      const position = endCamera.cameraPosition
      if (!position || endCamera.range !== 0) throw new Error('Expected range-zero ground probe')
      Object.assign(element, { heading: endCamera.heading, tilt: 44.9987, roll: 0, center: { ...position, altitude: 1600 + position.altitude }, cameraPosition: { ...position, altitude: 1600 + position.altitude }, range: 0 })
    }
    element.stopCameraAnimation = () => {}
    setMap(element)
    return () => element.removeEventListener('pointerdown', nativePointerDown)
  }, [])
  return <div><div ref={ref} data-testid="native-aerial" style={{ width: 700, height: 400 }}><ThreeD.Provider value={map}>{children}</ThreeD.Provider></div></div>
}
