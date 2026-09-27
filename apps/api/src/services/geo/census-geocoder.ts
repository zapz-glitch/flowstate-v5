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
const CACHE_TTL = 180 * 24 * 60 * 60

export async function fetchCensusGeography(
  latitude: number,
  longitude: number,
  cache?: KVNamespace | null,
): Promise<CensusGeography | null> {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  const key = `geo:census:${latitude.toFixed(5)},${longitude.toFixed(5)}`
  if (cache) {
    try {
      const hit = await cache.get<CensusGeography>(key, 'json')
      if (hit?.blockGroup) return hit
    } catch { /* cache is best-effort */ }
  }
  try {
    const url = `${ENDPOINT}?x=${longitude}&y=${latitude}&benchmark=Public_AR_Current&vintage=Current_Current&format=json`
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!resp.ok) return null
    const data = (await resp.json()) as { result?: { geographies?: Record<string, Array<{ GEOID?: string }>> } }
    const geographies = data.result?.geographies ?? {}
    const blocksKey = Object.keys(geographies).find((k) => /census blocks$/i.test(k))
    const block = blocksKey ? geographies[blocksKey]?.[0]?.GEOID : undefined
    if (!block || block.length < 12) return null
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
