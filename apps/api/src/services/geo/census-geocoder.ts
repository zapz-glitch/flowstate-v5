/**
 * Census Geocoder — free public API, no key. Given a coordinate it returns
 * the census block GEOID; the block group is its first 12 digits
 * (state+county+tract+blockGroup) and the tract its first 11.
 *
 * Used by comp selection as a lateral market-area signal: same block group
 * is hard geographic evidence a comp sits in the subject's micro-market,
 * tighter than tract. Boundaries are stable for a decade, so results are
 * KV-cached long. Advisory only — every failure resolves null so the
 * pipeline never blocks on it.
 */

export interface CensusGeography {
  /** 12-digit block group GEOID */
  blockGroup: string
  /** 11-digit tract GEOID — fallback when the property provider didn't
   *  return a tract (never compare across sources) */
  tract: string
}

const ENDPOINT = 'https://geocoding.geo.census.gov/geocoder/geographies/coordinates'
const GEOCODIO_ENDPOINT = 'https://api.geocod.io/v1.9/reverse'
const GEOCODIO_FORWARD_ENDPOINT = 'https://api.geocod.io/v1.9/geocode'
const CACHE_TTL = 180 * 24 * 60 * 60

/**
 * Forward-geocode an address through Geocodio and return its USPS-normalized
 * form ("100 Cay Ct SW, Atlanta, GA 30349"). Used as a fallback when a
 * property provider's own matcher misses on a young-city name its database
 * still files under the older mailing city (South Fulton → Atlanta).
 * Returns null on any failure — advisory only, one lookup per call.
 */
export async function geocodeUspsAddress(
  address: string,
  geocodioKey?: string | null,
): Promise<string | null> {
  if (!geocodioKey || !address.trim()) return null
  try {
    const resp = await fetch(
      `${GEOCODIO_FORWARD_ENDPOINT}?q=${encodeURIComponent(address)}&api_key=${geocodioKey}`,
      { signal: AbortSignal.timeout(8000) },
    )
    if (!resp.ok) return null
    const data = (await resp.json()) as {
      results?: Array<{ formatted_address?: string; accuracy?: number; accuracy_type?: string }>
    }
    const top = data.results?.[0]
    const formatted = top?.formatted_address?.trim()
    if (!formatted) return null
    // Only an exact-parcel match may re-key the lookup: interpolated or
    // street-level results can land on a neighbouring house.
    if (top?.accuracy_type !== 'rooftop' && top?.accuracy_type !== 'point') return null
    const houseNumber = (s: string) => s.trim().match(/^(\d+[A-Z]?)\b/i)?.[1]?.toUpperCase()
    const wanted = houseNumber(address)
    if (!wanted || houseNumber(formatted) !== wanted) return null
    return formatted
  } catch {
    return null
  }
}

export async function fetchCensusGeography(
  latitude: number,
  longitude: number,
  cache?: KVNamespace | null,
  firecrawlKey?: string | null,
  geocodioKey?: string | null,
): Promise<CensusGeography | null> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  const key = `geo:census:${latitude.toFixed(5)},${longitude.toFixed(5)}`
  if (cache) {
    try {
      const hit = await cache.get<CensusGeography>(key, 'json')
      if (hit?.blockGroup) return hit
    } catch { /* cache is best-effort */ }
  }
  const url = `${ENDPOINT}?x=${longitude}&y=${latitude}&benchmark=Public_AR_Current&vintage=Current_Current&format=json`

  // 1. Geocodio — metered (free 2.5k lookups/day, then $1/1k), reliable, and
  //    not IP-throttled. skipGeocoding bills only the census append since we
  //    already hold coordinates — 1 lookup per call.
  let block: string | undefined
  if (geocodioKey) {
    try {
      const resp = await fetch(
        `${GEOCODIO_ENDPOINT}?q=${latitude},${longitude}&fields=census2020&skipGeocoding=true&api_key=${geocodioKey}`,
        { signal: AbortSignal.timeout(8000) },
      )
      if (resp.ok) {
        const data = (await resp.json()) as {
          results?: Array<{ fields?: { census?: Record<string, { full_fips?: string }> } }>
        }
        const census = data.results?.[0]?.fields?.census ?? {}
        block = census['2020']?.full_fips ?? Object.values(census)[0]?.full_fips
      } else {
        console.log(`[Geo] geocodio ${resp.status} for ${latitude},${longitude}`)
      }
    } catch (e) { console.log(`[Geo] geocodio threw for ${latitude},${longitude}:`, e) }
  }

  // 2. Census direct — free but IP-blocks bursty callers.
  let data: { result?: { geographies?: Record<string, Array<{ GEOID?: string }>> } } | null = null
  if (!block) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (resp.ok) data = await resp.json()
    } catch { /* fall through to the Firecrawl relay */ }
  }

  // 3. IP-rotation relay: the free Census endpoint IP-blocks bursty callers
  //    (connection reset, not 429). Route through Firecrawl's egress pool —
  //    verified needed at volume; costs one scrape credit per lookup.
  if (!block && !data && firecrawlKey) {
    try {
      const resp = await fetch('https://api.firecrawl.dev/v2/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${firecrawlKey}` },
        body: JSON.stringify({ url, formats: ['rawHtml'], onlyMainContent: false, timeout: 15000 }),
        signal: AbortSignal.timeout(18000),
      })
      if (resp.ok) {
        const fc = (await resp.json()) as { data?: { rawHtml?: string; html?: string } }
        const body = fc.data?.rawHtml ?? fc.data?.html ?? ''
        const jsonMatch = body.match(/\{.*\}/s)
        if (jsonMatch) data = JSON.parse(jsonMatch[0])
      }
    } catch { /* relay is best-effort */ }
  }
  if (!block) {
    const geographies = data?.result?.geographies ?? {}
    const blocksKey = Object.keys(geographies).find((k) => /census blocks$/i.test(k))
    block = blocksKey ? geographies[blocksKey]?.[0]?.GEOID : undefined
  }
  if (!block || block.length < 12) return null
  try {
    const geo: CensusGeography = { blockGroup: block.slice(0, 12), tract: block.slice(0, 11) }
    if (cache) {
      try {
        await cache.put(key, JSON.stringify(geo), { expirationTtl: CACHE_TTL })
      } catch { /* cache is best-effort */ }
    }
    return geo
  } catch {
    return null
  }
}
