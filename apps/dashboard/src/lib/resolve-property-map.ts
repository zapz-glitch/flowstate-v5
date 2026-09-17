import { assessPanoramaLocation, distanceMeters, headingToSubject, isPreciseSubjectGeocode, isValidCoordinate, type MapCoordinate } from './property-map-geometry'

/** Caller loads geocoding and streetView libraries before resolving. */
function maps(): typeof google.maps | undefined {
  return typeof window === 'undefined' ? undefined : window.google?.maps
}

/** APIs cannot be aborted; ignore late responses after a bounded wait. */
function bounded<T>(request: Promise<T>, fallback: T): Promise<T> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(fallback), 6000)
    request.then(value => { clearTimeout(timer); resolve(value) }, () => { clearTimeout(timer); resolve(fallback) })
  })
}

export async function resolvePropertyLocation(address: string, coordinate: MapCoordinate): Promise<{ coordinate: MapCoordinate; addressMatched: boolean }> {
  const fallback = { coordinate, addressMatched: false }
  const gm = maps()
  if (!gm?.Geocoder || !address.trim()) return fallback
  try {
    return await bounded((async () => {
      const bounds = isValidCoordinate(coordinate) ? { south: Math.max(-90, coordinate.lat - 0.025), north: Math.min(90, coordinate.lat + 0.025), west: Math.max(-180, coordinate.lng - 0.025), east: Math.min(180, coordinate.lng + 0.025) } : undefined
      const response = await new gm.Geocoder().geocode({ address, bounds })
      const result = response.results.find(candidate => isPreciseSubjectGeocode(candidate, address))
      const location = result?.geometry.location.toJSON()
      // Street-only addresses repeat across cities. Bias is not a guarantee: only
      // a validated ZIP-qualified address may replace a distant provider point.
      const localityQualified = /,.*\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/i.test(address)
      const closeToProvider = isValidCoordinate(location) && distanceMeters(location, coordinate) <= 250
      return isValidCoordinate(location) && (closeToProvider || localityQualified) ? { coordinate: location, addressMatched: true } : fallback
    })(), fallback)
  } catch { return fallback }
}

export type SubjectPanorama = { panoId: string; heading: number; distanceMeters: number }

/** Nearby official outdoor imagery aimed at the subject; never visual house verification. */
export async function resolveSubjectPanorama(coordinate: MapCoordinate): Promise<SubjectPanorama | null> {
  const gm = maps()
  if (!gm?.StreetViewService || !isValidCoordinate(coordinate)) return null
  try {
    return await bounded<SubjectPanorama | null>((async () => {
      const { data } = await new gm.StreetViewService().getPanorama({
        location: coordinate,
        radius: 80,
        preference: gm.StreetViewPreference.NEAREST,
        sources: [gm.StreetViewSource.GOOGLE, gm.StreetViewSource.OUTDOOR],
      })
      const panoId = data.location?.pano
      const location = data.location?.latLng?.toJSON()
      const assessment = assessPanoramaLocation({ panoId, location }, coordinate)
      if (!assessment.accepted || !panoId || !location) return null
      return { panoId, heading: headingToSubject(location, coordinate), distanceMeters: assessment.distanceMeters }
    })(), null)
  } catch { return null }
}
