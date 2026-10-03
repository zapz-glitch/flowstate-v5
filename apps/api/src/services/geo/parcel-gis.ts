/**
 * County parcel-GIS resolver — the ATTOM-only bridge for addresses the MCP
 * address matcher misses.
 *
 * Chain: Census onelineaddress (free, no key) → lat/lng + county FIPS →
 * county ArcGIS parcel query → assessor parcel number → fipsApn lookup on
 * ATTOM. Verified live on Pinellas (egis.pinellas.gov) for a parcel the
 * ATTOM address resolver could not find.
 *
 * Coverage is per-county — the registry grows as calibration hits new
 * counties; a miss degrades to PROPERTY_NOT_FOUND exactly as before.
 */

export interface ParcelIdentity {
  fips: string
  apn: string
  /** County GIS display parcel number, if the county exposes one. */
  apnFormatted?: string
}

// ─── County registry ─────────────────────────────────────────────────────────
// Each entry knows the county's ArcGIS REST parcels layer + how to build the
// WHERE clause. ArcGIS parcels layers are ubiquitous but field names vary —
// add counties here as calibration runs hit them.

interface CountyParcelSource {
  /** 5-digit state+county FIPS */
  fips: string
  name: string
  /** ArcGIS MapServer layer query endpoint (no ?query suffix) */
  url: string
  /** WHERE clause for the street address — {ADDR} is substituted uppercase */
  where: (addr: string) => string
  /** Field carrying the parcel number */
  pinField: string
  outFields: string
  /** Extract the APN from a feature's attributes */
  apn: (attrs: Record<string, unknown>) => string | null
}

const COUNTY_SOURCES: CountyParcelSource[] = [
  {
    fips: '12103',
    name: 'Pinellas County, FL',
    url: 'https://egis.pinellas.gov/gis/rest/services/PublicWebGIS/Parcels/MapServer/0/query',
    where: (addr) => `FULLADDR = '${addr.replace(/'/g, "''")}'`,
    pinField: 'PIN_NUM',
    outFields: 'PIN_NUM,FULLADDR',
    apn: (a) => (typeof a.PIN_NUM === 'string' && a.PIN_NUM ? a.PIN_NUM : null),
  },
]

// ─── Census address geocode ──────────────────────────────────────────────────

const CENSUS_ONELINE =
  'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress'

async function geocodeAddress(address: string): Promise<{ fips: string } | null> {
  try {
    const url = `${CENSUS_ONELINE}?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&vintage=Current_Current&format=json`
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!resp.ok) return null
    const data = (await resp.json()) as {
      result?: { addressMatches?: Array<{ geographies?: Record<string, Array<{ GEOID?: string }>> }> }
    }
    const match = data.result?.addressMatches?.[0]
    const countiesKey = Object.keys(match?.geographies ?? {}).find((k) => /^counties$/i.test(k))
    const fips = countiesKey ? match?.geographies?.[countiesKey]?.[0]?.GEOID : undefined
    return fips ? { fips } : null
  } catch {
    return null
  }
}

// ─── Street-address normalization ────────────────────────────────────────────

/** "800 40th St S, St Petersburg, FL 33711" → "800 40TH ST S" */
function streetLine(address: string): string {
  return address.split(',')[0].trim().toUpperCase().replace(/\s+/g, ' ')
}

// ─── Resolver ────────────────────────────────────────────────────────────────

/**
 * Resolve a US street address to a county parcel (fips + APN) without any
 * property provider. Returns null on any miss — the caller degrades to its
 * existing not-found path.
 */
export async function resolveParcelApn(address: string): Promise<ParcelIdentity | null> {
  const geo = await geocodeAddress(address)
  if (!geo) return null

  const source = COUNTY_SOURCES.find((c) => c.fips === geo.fips)
  if (!source) {
    console.log(`[ParcelGIS] county ${geo.fips} not in registry — parcel bridge unavailable`)
    return null
  }

  try {
    const where = source.where(streetLine(address))
    const url = `${source.url}?where=${encodeURIComponent(where)}&outFields=${encodeURIComponent(source.outFields)}&f=json`
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!resp.ok) return null
    const data = (await resp.json()) as { features?: Array<{ attributes?: Record<string, unknown> }> }
    const attrs = data.features?.[0]?.attributes
    const apn = attrs ? source.apn(attrs) : null
    if (!apn) return null
    return { fips: geo.fips, apn }
  } catch {
    return null
  }
}
