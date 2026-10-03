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
  firecrawlKey?: string | null,
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
  let data: { result?: { geographies?: Record<string, Array<{ GEOID?: string }>> } } | null = null
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (resp.ok) data = await resp.json()
  } catch { /* fall through to the Firecrawl relay */ }
  // IP-rotation relay: the free Census endpoint IP-blocks bursty callers
  // (connection reset, not 429). Route through Firecrawl's egress pool —
  // verified needed at volume; costs one scrape credit per lookup.
  if (!data && firecrawlKey) {
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
  if (!data) return null
  try {
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
