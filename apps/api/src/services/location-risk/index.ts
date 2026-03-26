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

export interface LocationRisk {
  type: 'major_road' | 'railroad' | 'commercial'
  description: string
  /** Distance in meters (approximate) */
  distanceMeters: number
  /** Additional detail (road name, road type, etc.) */
  detail?: string
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
  return `
[out:json][timeout:10];
(
  way(around:${radiusMeters},${lat},${lng})["highway"~"^(${roadTypes})$"];
  way(around:${radiusMeters},${lat},${lng})["railway"="rail"];
  way(around:${radiusMeters},${lat},${lng})["landuse"~"^(commercial|industrial|retail)$"];
);
out tags;
`.trim()
}

interface OverpassElement {
  type: string
  id: number
  tags?: Record<string, string>
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
          risks.push({
            type: 'major_road',
            description: `Adjacent to ${typeLabel}: ${roadName}`,
            distanceMeters: radiusMeters,
            detail: `${typeLabel} (${tags.highway}) within ${radiusMeters}m`,
          })
        }
      }

      // Railroad
      if (tags.railway === 'rail' && !hasRailroad) {
        hasRailroad = true
        const railName = tags.name || 'Railroad'
        risks.push({
          type: 'railroad',
          description: `Near railroad: ${railName}`,
          distanceMeters: radiusMeters,
          detail: `Railroad tracks within ${radiusMeters}m`,
        })
      }

      // Commercial/industrial land use
      if (tags.landuse && !seenLandUse.has(tags.landuse)) {
        seenLandUse.add(tags.landuse)
        const name = tags.name || tags.landuse
        risks.push({
          type: 'commercial',
          description: `Adjacent to ${tags.landuse} area: ${name}`,
          distanceMeters: radiusMeters,
          detail: `${tags.landuse} land use within ${radiusMeters}m`,
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
