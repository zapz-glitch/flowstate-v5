/**
 * Redfin comp listing fetcher — the fast evidence path.
 *
 * The rendered-scrape chain (Serper → Firecrawl/Scrapfly on Zillow) costs
 * 15-45s per comp. Redfin's internal "stingray" JSON API serves the same
 * evidence (photos + listing remarks + property facts) without any JS
 * render: autocomplete resolves address → propertyId, then
 * aboveTheFold/belowTheFold return structured payloads in ~1-2s.
 *
 * Used FIRST for comp evidence; the Zillow chain stays as the fallback
 * when Redfin can't resolve the address (see gatherCompConditionEvidence).
 */

import type { Env } from '../../../types'
import type { PropertyPhotos } from '../types'
import type { CompEvidenceInput } from '../../comp-evidence'

const REDFIN = 'https://www.redfin.com'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/** Stingray responses are prefixed with "{}&&" — a literal empty object
 *  then the real payload. Slice past the && marker before parsing. */
function parseStingray<T>(body: string): T | null {
  const i = body.indexOf('&&')
  if (i < 0) return null
  try {
    return JSON.parse(body.slice(i + 2)) as T
  } catch {
    return null
  }
}

async function getStingray(env: Env, url: string, timeoutMs = 9000): Promise<Record<string, unknown> | null> {
  // Direct fetch first — stingray usually serves plain JSON to a browser
  // UA. If the endpoint blocks the Worker IP, fall back through Scrapfly.
  const direct = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => null)
  if (direct?.ok) {
    const text = await direct.text().catch(() => null)
    const parsed = text ? parseStingray<Record<string, unknown>>(text) : null
    if (parsed) return parsed
  }
  const flyKey = env.SCRAPFLY_API_KEY
  if (!flyKey) return null
  const flyUrl = env.SCRAPFLY_URL || 'https://api.scrapfly.io/scrape'
  // ASP is required — redfin sits behind CloudFront bot defense; plain
  // Scrapfly scrapes get the same 403 as a direct fetch.
  const proxied = await fetch(
    `${flyUrl}?key=${encodeURIComponent(flyKey)}&url=${encodeURIComponent(url)}&asp=true&country=us`,
    { signal: AbortSignal.timeout(timeoutMs + 15000) },
  ).catch(() => null)
  if (!proxied?.ok) return null
  const data = await proxied.json<{ result?: { content?: string } }>().catch(() => null)
  const content = data?.result?.content
  return content ? parseStingray<Record<string, unknown>>(content) : null
}

/** Recursively find the first numeric value for any of `keys` (case-insensitive). */
function findNumber(node: unknown, keys: string[], depth = 0): number | undefined {
  if (depth > 8 || node == null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const item of node) {
      const v = findNumber(item, keys, depth + 1)
      if (v !== undefined) return v
    }
    return undefined
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (typeof v === 'number' && keys.some((want) => k.toLowerCase() === want)) return v
  }
  for (const v of Object.values(node as Record<string, unknown>)) {
    if (v && typeof v === 'object') {
      const found = findNumber(v, keys, depth + 1)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** Recursively find the first long string under any of `keys`. */
function findText(node: unknown, keys: string[], minLen = 120, depth = 0): string | undefined {
  if (depth > 8 || node == null || typeof node !== 'object') return undefined
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length >= minLen && keys.some((want) => k.toLowerCase() === want)) return v
  }
  for (const v of Object.values(node as Record<string, unknown>)) {
    if (v && typeof v === 'object') {
      const found = findText(v, keys, minLen, depth + 1)
      if (found) return found
    }
  }
  return undefined
}

interface AutocompleteRow {
  id?: string
  url?: string
  name?: string
  subName?: string
}

/** Address → Redfin propertyId via the public location-autocomplete endpoint. */
async function resolvePropertyId(env: Env, comp: CompEvidenceInput): Promise<{ propertyId: string; url: string } | null> {
  const location = encodeURIComponent(`${comp.address} ${comp.city ?? ''} ${comp.state ?? ''} ${comp.zipCode ?? ''}`)
  const url = `${REDFIN}/stingray/do/location-autocomplete?location=${location}&start=0&count=10&v=2&al=1&iss=false&ooa=true&mrs=false`
  const body = await getStingray(env, url)
  const payload = body?.payload as {
    exactMatch?: AutocompleteRow
    sections?: Array<{ rows?: AutocompleteRow[] }>
  } | undefined
  const rows = payload?.sections?.flatMap((s) => s.rows ?? []) ?? []
  if (!payload?.exactMatch && rows.length === 0) return null

  const streetNum = (comp.address ?? '').match(/^\s*(\d+)/)?.[1] ?? ''
  const slug = comp.address.split(',')[0].replace(/^\s*\d+\s*/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  // exactMatch is authoritative; otherwise prefer the row whose URL
  // carries the street number or street slug.
  const matched = rows.find(
    (r) =>
      (r.url && streetNum && r.url.includes(`-${streetNum}-`)) ||
      (r.url && slug && r.url.toLowerCase().includes(slug)),
  )
  const row = payload?.exactMatch ?? matched ?? rows.find((r) => r.url?.includes('/home/')) ?? rows[0]
  if (!row) return null
  const fromId = row.id?.match(/^\d+_(\d+)$/)?.[1]
  const fromUrl = row.url?.match(/\/home\/(\d+)/)?.[1]
  const propertyId = fromId ?? fromUrl
  return propertyId ? { propertyId, url: `${REDFIN}${row.url ?? ''}` } : null
}

/** One comp listing through the stingray JSON API — photos, remarks, facts.
 *  Returns null when the property can't be resolved or has no media. */
export async function fetchRedfinListing(env: Env, comp: CompEvidenceInput): Promise<PropertyPhotos | null> {
  const resolved = await resolvePropertyId(env, comp)
  if (!resolved) return null
  const { propertyId } = resolved

  const [above, below] = await Promise.all([
    getStingray(env, `${REDFIN}/stingray/api/home/details/aboveTheFold?propertyId=${propertyId}&accessLevel=1`),
    getStingray(env, `${REDFIN}/stingray/api/home/details/belowTheFold?propertyId=${propertyId}&accessLevel=1`),
  ])
  const abovePayload = (above?.payload ?? {}) as {
    mediaBrowserInfo?: { photos?: Array<{ photoUrls?: { fullScreenPhotoUrl?: string; nonFullScreenPhotoUrl?: string } }> }
  }
  const belowPayload = (below?.payload ?? {}) as Record<string, unknown>

  const photos = (abovePayload.mediaBrowserInfo?.photos ?? [])
    .map((p) => p?.photoUrls?.fullScreenPhotoUrl ?? p?.photoUrls?.nonFullScreenPhotoUrl)
    .filter((u): u is string => typeof u === 'string' && u.length > 0)
    .slice(0, 8)
  if (photos.length === 0) return null

  // MLS listing remarks live on the property-history events — the first
  // event carrying marketingRemarks is the current listing's copy.
  const events = ((belowPayload.propertyHistoryInfo as { events?: Array<{ marketingRemarks?: Array<{ marketingRemark?: string }> }> })?.events) ?? []
  const description = events
    .map((e) => e.marketingRemarks?.[0]?.marketingRemark)
    .find((r): r is string => typeof r === 'string' && r.length > 0)
    ?? findText(belowPayload, ['propertydescription', 'description', 'remarks'])
  return {
    propertyId: comp.propertyId,
    photos,
    source: 'redfin',
    sourceUrl: resolved.url,
    description,
    fetchedAt: new Date().toISOString(),
    bedrooms: findNumber(belowPayload, ['beds', 'bedrooms', 'numbeds']),
    bathrooms: findNumber(belowPayload, ['baths', 'bathrooms', 'numbaths']),
    squareFeet: findNumber(belowPayload, ['sqft', 'squarefeet', 'totalsqft']),
    yearBuilt: findNumber(belowPayload, ['yearbuilt', 'yrbuilt']),
  }
}
