/**
 * County zoning resolver — point-in-polygon lookup against county ArcGIS
 * zoning layers. ATTOM MCP carries no zoning dataset; the counties we
 * calibrate in publish the layers free and unkeyed.
 *
 * Populates NormalizedProperty.zoning / zoningDescription, which the
 * location-risk detector already reads (commercial/mixed-use flags) and
 * the HBU development signal needs for land-value plays.
 *
 * Registry pattern like parcel-gis: per-county source entries, a miss
 * degrades to null — zoning stays a flag source, never a gate.
 */

export interface ZoningResult {
  code: string
  description: string | null
  /** Parcel acreage where the county carries it on the zone feature. */
  acres?: number | null
}

interface CountyZoningSource {
  fips: string
  name: string
  url: string
  codeField: string
  descField?: string
  acresField?: string
}

const COUNTY_SOURCES: CountyZoningSource[] = [
  {
    fips: '12057',
    name: 'Hillsborough County, FL',
    url: 'https://maps.hillsboroughcounty.org/arcgis/rest/services/DSD_Viewer_Services/DSD_Viewer_Zoning_Regulatory/MapServer/0/query',
    codeField: 'NZONE',
    descField: 'NZONE_DESC',
    acresField: 'ACRES',
  },
]

async function queryCounty(
  src: CountyZoningSource,
  lat: number,
  lng: number,
): Promise<ZoningResult | null> {
  const url = `${src.url}?geometry=${lng},${lat}&geometryType=esriGeometryPoint` +
    `&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=*&f=json`
  const resp = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!resp.ok) return null
  const json = (await resp.json()) as { features?: { attributes?: Record<string, unknown> }[] }
  const attrs = json.features?.[0]?.attributes
  const code = attrs?.[src.codeField]
  if (typeof code !== 'string' || !code) return null
  const desc = src.descField ? attrs?.[src.descField] : null
  const acres = src.acresField ? attrs?.[src.acresField] : null
  return {
    code,
    description: typeof desc === 'string' && desc ? desc : null,
    acres: typeof acres === 'number' ? acres : null,
  }
}

/**
 * Resolve zoning at a point. With a county FIPS the lookup is single-shot;
 * without one it tries each registered source (few counties — cheap).
 */
export async function resolveZoning(
  latitude: number,
  longitude: number,
  countyFips?: string | null,
): Promise<ZoningResult | null> {
  const sources = countyFips
    ? COUNTY_SOURCES.filter((s) => s.fips === countyFips)
    : COUNTY_SOURCES
  for (const src of sources) {
    const hit = await queryCounty(src, latitude, longitude).catch(() => null)
    if (hit) return hit
  }
  return null
}
