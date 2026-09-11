/**
 * Location Risk Detection via OpenStreetMap Overpass API
 *
 * Queries OSM for major roads, railroads, and commercial buildings
 * near a property's coordinates to identify location-based risks.
 */

// Multiple Overpass API endpoints for failover
const OVERPASS_ENDPOINTS = [
  'https://lz4.overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://overpass-api.de/api/interpreter',
]

/** OSM road types considered "major" (high traffic, noise risk) */
const MAJOR_ROAD_TYPES = ['motorway', 'trunk', 'primary', 'secondary'] as const

/** Human-readable labels for OSM road types */
const ROAD_TYPE_LABELS: Record<string, string> = {
  motorway: 'Highway/Interstate',
  trunk: 'Major Highway',
  primary: 'Primary Road',
  secondary: 'Secondary Road',
}

export type RiskPosition = 'fronting' | 'backing' | 'siding'

export interface LocationRisk {
  type: 'major_road' | 'railroad' | 'commercial'
  description: string
  /** Distance in meters (approximate) */
  distanceMeters: number
  /** Additional detail (road name, road type, etc.) */
  detail?: string
  /** Where the exposure sits relative to the subject — drives proximity deduction */
  position?: RiskPosition | null
  /** Feature name (road/commercial) when OSM provides one */
  featureName?: string
}

export interface LocationRiskResult {
  risks: LocationRisk[]
  /** Risk flag strings ready to inject into analysis response */
  riskFlags: string[]
  /** Query timing in ms */
  durationMs: number
}

/**
 * Build an Overpass QL query to find major roads, railroads, and
 * commercial land use near a coordinate.
 */
function buildOverpassQuery(lat: number, lng: number, radiusMeters: number): string {
  const roadTypes = MAJOR_ROAD_TYPES.join('|')
  // Minor-road ways give us the subject's own street — the front reference
  // for fronting/backing/siding classification.
  return `
[out:json][timeout:10];
(
  way(around:${radiusMeters},${lat},${lng})["highway"~"^(${roadTypes})$"];
  way(around:${radiusMeters},${lat},${lng})["railway"="rail"];
  way(around:${radiusMeters},${lat},${lng})["landuse"~"^(commercial|industrial|retail)$"];
  way(around:80,${lat},${lng})["highway"~"^(residential|unclassified|living_street|tertiary)$"];
);
out center tags;
`.trim()
}

interface OverpassElement {
  type: string
  id: number
  tags?: Record<string, string>
  center?: { lat: number; lon: number }
}

/** Initial bearing (degrees) from subject to a point */
function bearingBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLng = toRad(lng2 - lng1)
  const y = Math.sin(dLng) * Math.cos(toRad(lat2))
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

/** Smallest angle between two bearings (0-180) */
function bearingDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/** Normalize a street name for comparison — "Engman St", "N Missouri Ave" */
function normalizeStreet(name: string | null | undefined): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/\b(street|st|avenue|ave|drive|dr|boulevard|blvd|road|rd|lane|ln|court|ct|place|pl|terrace|ter|way|circle|cir|north|n|south|s|east|e|west|w)\b\.?/g, '')
    .replace(/[^a-z]/g, '')
}

interface OverpassResponse {
  elements?: OverpassElement[]
}

/**
 * Query OpenStreetMap Overpass API for location risks near a property.
 *
 * @param lat - Property latitude
 * @param lng - Property longitude
 * @param radiusMeters - Search radius in meters (default: 150m)
 * @returns Location risks found, or empty result on failure
 */
export async function detectOsmLocationRisks(
  lat: number,
  lng: number,
  radiusMeters = 150,
  opts?: { streetName?: string },
): Promise<LocationRiskResult> {
  const start = Date.now()
  const risks: LocationRisk[] = []

  try {
    const query = buildOverpassQuery(lat, lng, radiusMeters)
    const body = `data=${encodeURIComponent(query)}`

    // Try each endpoint until one returns valid JSON
    let elements: OverpassElement[] = []
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body,
          signal: AbortSignal.timeout(6000),
        })

        if (!response.ok) continue

        const contentType = response.headers.get('content-type') ?? ''
        const text = await response.text()

        // Verify it's actually JSON (Overpass returns HTML on errors even with 200)
        if (!text.startsWith('{')) continue

        const data = JSON.parse(text) as OverpassResponse
        elements = data.elements ?? []
        console.log(`[LocationRisk] Overpass ${endpoint.split('//')[1].split('/')[0]}: ${elements.length} elements`)
        break
      } catch {
        continue // Try next endpoint
      }
    }

    // ── Front reference: the subject's own street ───────────────────────────
    // Prefer a name match with the address street; otherwise the nearest
    // minor-road center. Its bearing = the direction the property faces.
    const subjectStreetNorm = normalizeStreet(opts?.streetName)
    const minorRoads = elements.filter((el) => {
      const h = el.tags?.highway
      return h && ['residential', 'unclassified', 'living_street', 'tertiary'].includes(h)
    })
    const namedMatch = subjectStreetNorm
      ? minorRoads.find((el) => normalizeStreet(el.tags?.name) === subjectStreetNorm)
      : undefined
    const frontRef = (namedMatch ?? minorRoads[0])?.center
    const frontBearing = frontRef ? bearingBetween(lat, lng, frontRef.lat, frontRef.lon) : null

    const positionOf = (featureName: string | undefined, center?: { lat: number; lon: number }): RiskPosition | null => {
      // A road risk on the subject's own street is always fronting
      if (featureName && subjectStreetNorm && normalizeStreet(featureName) === subjectStreetNorm) return 'fronting'
      if (!center || frontBearing === null) return null
      const delta = bearingDelta(frontBearing, bearingBetween(lat, lng, center.lat, center.lon))
      return delta <= 60 ? 'fronting' : delta >= 120 ? 'backing' : 'siding'
    }

    // Dedupe by type — only report one risk per category
    const seenRoadTypes = new Set<string>()
    let hasRailroad = false
    const seenLandUse = new Set<string>()

    for (const el of elements) {
      const tags = el.tags ?? {}

      // Major roads
      if (tags.highway && MAJOR_ROAD_TYPES.includes(tags.highway as typeof MAJOR_ROAD_TYPES[number])) {
        if (!seenRoadTypes.has(tags.highway)) {
          seenRoadTypes.add(tags.highway)
          const roadName = tags.name || tags.ref || 'Unnamed road'
          const typeLabel = ROAD_TYPE_LABELS[tags.highway] || tags.highway
          const position = positionOf(roadName !== 'Unnamed road' ? roadName : undefined, el.center)
          risks.push({
            type: 'major_road',
            description: `Adjacent to ${typeLabel}: ${roadName}${position ? ` (${position})` : ''}`,
            distanceMeters: radiusMeters,
            detail: `${typeLabel} (${tags.highway}) within ${radiusMeters}m`,
            position,
            featureName: roadName !== 'Unnamed road' ? roadName : undefined,
          })
        }
      }

      // Railroad
      if (tags.railway === 'rail' && !hasRailroad) {
        hasRailroad = true
        const railName = tags.name || 'Railroad'
        const position = positionOf(tags.name, el.center)
        risks.push({
          type: 'railroad',
          description: `Near railroad: ${railName}${position ? ` (${position})` : ''}`,
          distanceMeters: radiusMeters,
          detail: `Railroad tracks within ${radiusMeters}m`,
          position,
          featureName: tags.name,
        })
      }

      // Commercial/industrial land use
      if (tags.landuse && !seenLandUse.has(tags.landuse)) {
        seenLandUse.add(tags.landuse)
        const name = tags.name || tags.landuse
        const position = positionOf(tags.name, el.center)
        risks.push({
          type: 'commercial',
          description: `Adjacent to ${tags.landuse} area: ${name}${position ? ` (${position})` : ''}`,
          distanceMeters: radiusMeters,
          detail: `${tags.landuse} land use within ${radiusMeters}m`,
          position,
          featureName: tags.name,
        })
      }
    }

    const durationMs = Date.now() - start
    console.log(`[LocationRisk] OSM query: ${elements.length} elements, ${risks.length} risks in ${durationMs}ms`)

    // Build risk flag strings
    const riskFlags = risks.map((r) => r.description)

    return { risks, riskFlags, durationMs }
  } catch (error) {
    const durationMs = Date.now() - start
    console.warn(`[LocationRisk] OSM query failed in ${durationMs}ms:`, error instanceof Error ? error.message : error)
    return { risks: [], riskFlags: [], durationMs }
  }
}
