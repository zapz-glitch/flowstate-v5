/** Geometry checks establish proximity, not visual verification of a house. */
export type MapCoordinate = { lat: number; lng: number }

export function isValidCoordinate(value: unknown): value is MapCoordinate {
  if (!value || typeof value !== 'object') return false
  const { lat, lng } = value as MapCoordinate
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
}

const radians = (degrees: number) => degrees * Math.PI / 180
export function distanceMeters(a: MapCoordinate, b: MapCoordinate): number {
  if (!isValidCoordinate(a) || !isValidCoordinate(b)) return Infinity
  const latitude = radians(b.lat - a.lat)
  const longitude = radians(b.lng - a.lng)
  const h = Math.sin(latitude / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(longitude / 2) ** 2
  return 6371008.8 * 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))))
}

export function normalizeHeading(value: number): number {
  return Number.isFinite(value) ? ((value % 360) + 360) % 360 : 0
}

/** Snap to the nearest compass quarter before rotating one quarter counterclockwise. */
export function nextCounterclockwiseHeading(value: number): number {
  return normalizeHeading(Math.round(normalizeHeading(value) / 90) * 90 - 90)
}

export function headingToSubject(panorama: MapCoordinate, subject: MapCoordinate): number {
  if (!isValidCoordinate(panorama) || !isValidCoordinate(subject)) return 0
  const delta = radians(subject.lng - panorama.lng)
  const from = radians(panorama.lat)
  const to = radians(subject.lat)
  return normalizeHeading(Math.atan2(Math.sin(delta) * Math.cos(to), Math.cos(from) * Math.sin(to) - Math.sin(from) * Math.cos(to) * Math.cos(delta)) * 180 / Math.PI)
}

export function assessPanoramaLocation(
  panorama: { panoId?: string | null; location?: MapCoordinate | null },
  subject: MapCoordinate,
  maxDistanceMeters = 80,
): { accepted: boolean; distanceMeters: number; reason: 'nearby' | 'missing-panorama' | 'invalid-coordinate' | 'too-far' } {
  if (!panorama.panoId?.trim()) return { accepted: false, distanceMeters: Infinity, reason: 'missing-panorama' }
  if (!isValidCoordinate(panorama.location) || !isValidCoordinate(subject)) return { accepted: false, distanceMeters: Infinity, reason: 'invalid-coordinate' }
  const distance = distanceMeters(panorama.location, subject)
  const accepted = Number.isFinite(maxDistanceMeters) && maxDistanceMeters >= 0 && distance <= maxDistanceMeters
  return { accepted, distanceMeters: distance, reason: accepted ? 'nearby' : 'too-far' }
}

export type SubjectGeocode = {
  partial_match?: boolean
  geometry?: { location_type?: string }
  address_components?: Array<{ long_name: string; short_name?: string; types: string[] }>
}

const aliases: Record<string, string> = {
  street: 'st', road: 'rd', avenue: 'ave', boulevard: 'blvd', drive: 'dr', lane: 'ln', court: 'ct', circle: 'cir', place: 'pl', terrace: 'ter', parkway: 'pkwy', highway: 'hwy', trail: 'trl',
  north: 'n', south: 's', east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
}
const normalize = (text: string) => text.toLowerCase().replace(/[.]/g, '').replace(/[^a-z0-9-]+/g, ' ').trim().split(/\s+/).map(word => aliases[word] ?? word).join(' ')

/** Conservative US numbered-address check; ambiguous/partial geocodes are never accepted. */
export function isPreciseSubjectGeocode(result: SubjectGeocode, address: string): boolean {
  if (result.partial_match || result.geometry?.location_type !== 'ROOFTOP') return false
  const components = result.address_components ?? []
  const component = (type: string) => components.find(item => item.types.includes(type))
  const number = component('street_number')
  const route = component('route')
  if (!number || !route) return false
  const parts = address.split(',').map(part => part.trim()).filter(Boolean)
  const street = parts[0]?.replace(/\s+(?:apt\.?|unit|suite|#)\s*\S+.*$/i, '') ?? ''
  if (normalize(street) !== normalize(`${number.long_name} ${route.long_name}`) && normalize(street) !== normalize(`${number.long_name} ${route.short_name ?? route.long_name}`)) return false
  const postcode = address.match(/\b\d{5}(?:-\d{4})?\s*(?:,?\s*(?:USA|US|United States))?\s*$/i)?.[0].match(/\d{5}/)?.[0]
  if (postcode && component('postal_code')?.long_name !== postcode) return false
  // Comma-delimited locality is checked when present. A state/ZIP-only second segment is allowed.
  const locality = parts[1]
  if (locality && !/^[a-z]{2}(?:\s+\d{5}(?:-\d{4})?)?$/i.test(locality) && !/^\d{5}(?:-\d{4})?$/.test(locality)) {
    const candidates = components.filter(item => item.types.some(type => ['locality', 'postal_town', 'sublocality', 'sublocality_level_1'].includes(type)))
    if (!candidates.some(item => normalize(item.long_name) === normalize(locality) || normalize(item.short_name ?? '') === normalize(locality))) return false
  }
  const state = parts.slice(1).join(' ').match(/\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/i)?.[1]
  if (state && normalize(component('administrative_area_level_1')?.short_name ?? '') !== normalize(state)) return false
  return true
}
