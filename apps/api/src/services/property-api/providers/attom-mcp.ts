/**
 * ATTOM MCP Provider (experimental — feat/attom-provider-swap)
 *
 * Implements PropertyProviderAdapter over the ATTOM intelligence MCP server
 * (Streamable HTTP JSON-RPC) instead of the REST gateway. Used when
 * PROPERTY_PROVIDER=attom-mcp.
 *
 * Auth: Descope OAuth. Access tokens live ~10 min; refresh tokens rotate on
 * every use. The pair is injected via env vars (ATTOM_MCP_ACCESS_TOKEN /
 * ATTOM_MCP_REFRESH_TOKEN / ATTOM_MCP_CLIENT_ID / ATTOM_MCP_EXPIRES_AT) —
 * Workers can't read the Devin OAuth file, so `scripts/sync-attom-token.mjs`
 * refreshes the CLI creds and writes them into .dev.vars before boot.
 * In-worker refreshes hold the rotated pair in module memory for the life
 * of the isolate; if env creds go stale, re-run the sync script.
 *
 * Field notes from live MCP probing (2026-09-30):
 *   - get_property_data: { property: { lookupMode: 'address'|'attomId', ... },
 *     datasets: [...] } → structuredContent.results[] keyed by dataset
 *   - find_comparable_sales: subjectAttomId, limit, saleDateFrom,
 *     maxDistanceMiles, propertyTypeStrict → records carry attomId,
 *     centerPoint, neighborhoodN4 (micro-neighborhood, NOT legal subdivision)
 *   - geography-context: subject.subdivision (legal SD) + geographies[]
 *     (CO/CS/DB/N3/N4/PZ/SD scopes with geoIdv4) + layers[] (per-scope
 *     saleCount/medianPrice/medianPPSF over 90/180/365d)
 *   - sales-history: per-transaction flip/distressed flags, buyers/sellers
 *   - valuation: AVM value + confidenceScore + range
 *   - NO census tract/block — comp-hybrid's fetchCensusGeography covers that
 *   - permits carry no date field
 */

import type { Env } from '../../../types'
import type {
  PropertyProviderAdapter,
  PropertySearchParams,
  PropertySearchResponse,
  ComparablesSearchParams,
  ComparablesSearchResponse,
  PermitsResponse,
  FloodZoneResponse,
  AvmResponse,
  BuildingDetailResponse,
  NormalizedProperty,
  NormalizedComparable,
  NormalizedPermit,
  NormalizedFloodZone,
  NormalizedAvm,
  NormalizedBuildingDetail,
} from '../types'
import { fetchCensusGeography } from '../../geo/census-geocoder'
import { buildRetrievalMeta } from '../retrieval-policy'

// ─── MCP transport ────────────────────────────────────────────────────────────

const MCP_URL = 'https://mcp.intelligence.attomdata.com'
const TOKEN_URL = 'https://auth.intelligence.attomdata.com/oauth2/v1/apps/token'
// M2M (client_credentials) exchanges at the root token endpoint; the token
// must carry the MCP audience + scope or the surface rejects its iss/aud.
// Documented M2M endpoint lives on the MCP host itself (ATTOM Workbench docs:
// POST /token with Basic client_id:access_key_secret + resource param).
const M2M_TOKEN_URL = 'https://mcp.intelligence.attomdata.com/token'
const MCP_AUDIENCE = 'https://mcp.intelligence.attomdata.com'
const UA = 'flowstate-api/attom-mcp-provider (experimental)'

interface McpCreds {
  accessToken: string
  refreshToken: string
  clientId: string
  /** epoch seconds */
  expiresAt: number
}

// Isolate-scoped fast path; KV holds the rotated pair across isolates —
// every refresh rotates the refresh token, so an isolate that refreshes
// invalidates everyone else's copy. KV is the shared source of truth.
const CREDS_KV_KEY = 'attom-mcp:creds'
let credsCache: McpCreds | null = null
let refreshInFlight: Promise<string> | null = null

async function kvCreds(env: Env): Promise<McpCreds | null> {
  try {
    const kv = (await env.API_CACHE.get(CREDS_KV_KEY, 'json')) as McpCreds | null
    if (kv?.refreshToken) return kv
  } catch {}
  return null
}

function persistCreds(env: Env): void {
  // Refresh tokens can outlive the access token by days; refresh rewrites
  // this each rotation. Best-effort — never block the call on it.
  if (credsCache) {
    void env.API_CACHE.put(CREDS_KV_KEY, JSON.stringify(credsCache), { expirationTtl: 30 * 86400 }).catch(() => {})
  }
}

function envCreds(env: Env): McpCreds | null {
  if (!env.ATTOM_MCP_ACCESS_TOKEN || !env.ATTOM_MCP_REFRESH_TOKEN || !env.ATTOM_MCP_CLIENT_ID) return null
  return {
    accessToken: env.ATTOM_MCP_ACCESS_TOKEN,
    refreshToken: env.ATTOM_MCP_REFRESH_TOKEN,
    clientId: env.ATTOM_MCP_CLIENT_ID,
    expiresAt: Number(env.ATTOM_MCP_EXPIRES_AT ?? 0),
  }
}

async function refreshCreds(env: Env): Promise<string> {
  if (!credsCache?.refreshToken) throw new Error('ATTOM_MCP: no refresh token configured')
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credsCache.refreshToken,
      client_id: credsCache.clientId,
    }),
    signal: AbortSignal.timeout(15000),
  })
  const body = (await resp.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }
  if (!resp.ok || !body.access_token) {
    // Our refresh token may be stale because another isolate rotated it —
    // reload the shared pair from KV and retry once before giving up.
    const kv = await kvCreds(env)
    if (kv && kv.refreshToken !== credsCache.refreshToken) {
      credsCache = kv
      return refreshCreds(env)
    }
    throw new Error(
      `ATTOM_MCP token refresh failed ${resp.status}: ${body.error ?? ''} ${body.error_description ?? ''}`.trim(),
    )
  }
  credsCache = {
    ...credsCache,
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? credsCache.refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + (body.expires_in ?? 600),
  }
  persistCreds(env)
  console.log('ATTOM_MCP: token refreshed (pair persisted to KV — other isolates pick it up)')
  return credsCache.accessToken
}

let m2mTokenCache: { accessToken: string; expiresAt: number } | null = null
let m2mInFlight: Promise<string> | null = null

/** Machine-to-machine client_credentials — no user consent, no grants.
 *  Exchanges client_id/secret for a ~10-min bearer at the root token
 *  endpoint; aud + scope=mcp:* are required or the surface 401s. */
async function m2mToken(env: Env): Promise<string> {
  const id = (env as Env & { ATTOM_MCP_M2M_CLIENT_ID?: string }).ATTOM_MCP_M2M_CLIENT_ID
  const secret = (env as Env & { ATTOM_MCP_CLIENT_SECRET?: string }).ATTOM_MCP_CLIENT_SECRET
  if (!id || !secret) throw new Error('ATTOM_MCP: M2M requires ATTOM_MCP_M2M_CLIENT_ID + ATTOM_MCP_CLIENT_SECRET')
  if (m2mTokenCache && m2mTokenCache.expiresAt > Date.now() / 1000 + 30) return m2mTokenCache.accessToken
  if (m2mInFlight) return m2mInFlight
  m2mInFlight = (async () => {
    const resp = await fetch(M2M_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
        'User-Agent': UA,
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        audience: MCP_AUDIENCE,
        scope: 'mcp:*',
      }),
      signal: AbortSignal.timeout(15000),
    })
    const body = (await resp.json()) as { access_token?: string; expires_in?: number; error?: string }
    if (!resp.ok || !body.access_token) {
      throw new Error(`ATTOM_MCP M2M token failed ${resp.status}: ${body.error ?? ''}`)
    }
    m2mTokenCache = {
      accessToken: body.access_token,
      expiresAt: Math.floor(Date.now() / 1000) + (body.expires_in ?? 600),
    }
    return m2mTokenCache.accessToken
  })().finally(() => { m2mInFlight = null })
  return m2mInFlight
}

async function ensureToken(env: Env): Promise<string> {
  // Production path — a static API key bypasses the entire OAuth
  // lifecycle (no grants, no refresh, no expiry). Same endpoint,
  // same protocol; the Authorization header just carries the key.
  const apiKey = (env as Env & { ATTOM_MCP_API_KEY?: string }).ATTOM_MCP_API_KEY
  if (apiKey) return apiKey
  // M2M client_credentials — preferred server-side path when provisioned.
  if ((env as Env & { ATTOM_MCP_CLIENT_SECRET?: string }).ATTOM_MCP_CLIENT_SECRET) {
    return m2mToken(env)
  }
  if (!credsCache) {
    credsCache = envCreds(env)
    // A KV-persisted pair is fresher than the boot-time env pair
    const kv = await kvCreds(env)
    if (kv && (!credsCache || kv.expiresAt >= credsCache.expiresAt)) credsCache = kv
  }
  if (!credsCache) throw new Error('ATTOM_MCP: credentials not configured (ATTOM_MCP_ACCESS_TOKEN/REFRESH_TOKEN/CLIENT_ID)')
  if (credsCache.expiresAt > Date.now() / 1000 + 30) return credsCache.accessToken
  // De-dupe concurrent refreshes within the isolate
  if (!refreshInFlight) {
    refreshInFlight = refreshCreds(env).finally(() => { refreshInFlight = null })
  }
  return refreshInFlight
}

async function mcpRpc(env: Env, method: string, params: unknown, depth = 0): Promise<any> {
  const token = await ensureToken(env)
  const resp = await fetch(env.ATTOM_MCP_ENDPOINT ?? MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'User-Agent': UA,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30000),
  })
  const text = await resp.text()

  // One retry after a forced refresh — covers expired/revoked access tokens.
  // A 403 "Missing active allow grant" means the OAuth consent itself is gone
  // — refresh can't fix that; surface it plainly so re-login is obvious.
  if ((resp.status === 401 || resp.status === 403) && depth === 0) {
    console.log(`ATTOM_MCP: ${resp.status} — forcing token refresh and retrying once`)
    if (credsCache) credsCache.expiresAt = 0
    if (m2mTokenCache) m2mTokenCache.expiresAt = 0
    refreshInFlight = null
    return mcpRpc(env, method, params, depth + 1)
  }

  if (resp.status === 401 || resp.status === 403) {
    const grantMissing = /allow grant|unauthorized/i.test(text)
    throw new Error(
      grantMissing
        ? `ATTOM_MCP ${method} → auth grant revoked — re-run 'devin mcp login attom' + scripts/sync-attom-token.mjs`
        : `ATTOM_MCP ${method} → HTTP ${resp.status}: ${text.slice(0, 300)}`,
    )
  }
  if (!resp.ok) throw new Error(`ATTOM_MCP ${method} → HTTP ${resp.status}: ${text.slice(0, 300)}`)
  // Streamable HTTP may answer SSE — take the last data: payload
  const dataLine = text.split('\n').filter((l) => l.startsWith('data:')).pop()
  const json = JSON.parse(dataLine ? dataLine.slice(5).trim() : text)
  if (json.error) throw new Error(`ATTOM_MCP ${method} → ${json.error.code}: ${json.error.message}`)
  return json.result
}

async function callTool(env: Env, name: string, args: Record<string, unknown>): Promise<any> {
  const result = await mcpRpc(env, 'tools/call', { name, arguments: args })
  // Wire-level fixture capture for offline replay (local dev only): every
  // tools/call result lands on stdout as a greppable line — harvest with
  //   grep '^\[MCP_RECORD\]' dev.log | cut -d']' -f2- > fixtures.jsonl
  // Payloads >500KB are skipped (console may truncate; get_property_data
  // already caps at 524KB server-side).
  if ((env as Env & { ATTOM_MCP_RECORD?: string }).ATTOM_MCP_RECORD === '1') {
    try {
      const line = JSON.stringify({ t: Date.now(), name, args, result })
      if (line.length < 500_000) console.log(`[MCP_RECORD]${line}`)
      else console.log(`[MCP_RECORD_SKIPPED] ${name} ${line.length}B — too large to log`)
    } catch { /* recording is best-effort */ }
  }
  return result
}

// A "response too large" failure can surface three ways depending on where
// the gateway rejects it: an RPC error thrown by callTool, a tool-level
// isError result, or an error marker inside structuredContent.
const TOO_LARGE_RE = /too.large|response_too_large|524|payload.*exceed|size.*limit/i

function isTooLargeError(error: unknown): boolean {
  return error instanceof Error && TOO_LARGE_RE.test(error.message)
}

function isTooLargeResult(result: any): boolean {
  if (!result) return false
  const sc = result.structuredContent
  if (sc?.error && TOO_LARGE_RE.test(JSON.stringify(sc.error))) return true
  if (result.isError === true) {
    const text = (result.content ?? [])
      .map((c: any) => (c?.type === 'text' ? c.text : ''))
      .join(' ')
    if (TOO_LARGE_RE.test(text)) return true
  }
  return false
}

function dataset<T = any>(results: any[] | undefined, name: string): T | null {
  const r = results?.find((x: any) => x.dataset === name)
  return r?.status === 'ok' || r?.data != null ? (r?.data ?? null) : null
}

// ─── parcelId ↔ attomId bridge ────────────────────────────────────────────────
// The pipeline keys flood/AVM/building calls on composite parcelId
// (fips:apn). We synthesize the same shape and keep a map so those calls can
// resolve back to the attomId.

const parcelToAttom = new Map<string, string>()

function registerParcel(attomId: string | null | undefined, fips?: string | null, apn?: string | null): string | null {
  if (!attomId || !fips || !apn) return null
  const parcelId = `${fips}:${apn}`
  parcelToAttom.set(parcelId, attomId)
  return parcelId
}

// ─── MCP record types (loose — surface is still evolving) ─────────────────────

interface McpCompRecord {
  attomId?: string | number
  address?: string
  centerPoint?: { latitude?: number; longitude?: number } | null
  distanceMiles?: number | null
  salePrice?: number | null
  saleDate?: string | null
  recordedDate?: string | null
  pricePerSqFt?: number | null
  squareFootage?: number | null
  lotSquareFootage?: number | null
  yearBuilt?: number | null
  bedrooms?: number | null
  fullBathrooms?: number | null
  partialBathrooms?: number | null
  garageSpaces?: number | null
  propertyUse?: string | null
  propertyTypeKey?: string | null
  neighborhoodN4?: string | null
  distressedStatus?: boolean | null
  normalizedScore?: number | null
  saleId?: string | number | null
}

// ─── Normalizers ──────────────────────────────────────────────────────────────

/** APN spellings to try for fipsApn lookup — counties record parcel numbers
 *  in different punctuation (raw STRAP digits vs dashed form). */
function apnSpellings(apn: string): string[] {
  const out = [apn]
  const digits = apn.replace(/[^0-9A-Za-z]/g, '')
  if (digits !== apn) out.push(digits)
  // Florida STRAP pattern on 18-digit parcel numbers: RR-TT-SS-PPPPP-BBB-SSSS
  if (/^\d{18}$/.test(digits)) {
    out.push(`${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 11)}-${digits.slice(11, 14)}-${digits.slice(14)}`)
  }
  return out
}

function parseOneLine(addr?: string | null): { line1: string; city: string; state: string; zip: string } {
  const m = (addr ?? '').match(/^(.+?),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5})/i)
  if (!m) return { line1: addr ?? '', city: '', state: '', zip: '' }
  return { line1: m[1], city: m[2], state: m[3].toUpperCase(), zip: m[4] }
}

function latestPricedSale(sales: any[] | null): any | null {
  return (sales ?? []).find((s) => s.price != null && s.price > 1000 && s.saleDate) ?? null
}

// Flip chain: prior priced sale 30–365d before the latest sale at a lower
// price — same rule as the Zillow reconciliation flip detection in
// services/analysis, sourced here from ATTOM sales-history.
const FLIP_MIN_DAYS = 30
const FLIP_MAX_DAYS = 365

function newestPricedSale(sales: any[] | null): { price: number; date: string } | null {
  const priced = (sales ?? [])
    .filter((s) => s.price != null && s.price > 1000 && s.saleDate)
    .sort((a, b) => new Date(b.saleDate).getTime() - new Date(a.saleDate).getTime())
  const newest = priced[0]
  return newest ? { price: newest.price, date: String(newest.saleDate).slice(0, 10) } : null
}

function detectFlip(sales: any[] | null): NonNullable<NormalizedProperty['flip']> | null {
  const priced = (sales ?? [])
    .filter((s) => s.price != null && s.price > 1000 && s.saleDate)
    .sort((a, b) => new Date(b.saleDate).getTime() - new Date(a.saleDate).getTime())
  const newest = priced[0]
  if (!newest) return null
  for (const prior of priced.slice(1)) {
    const daysHeld = Math.round(
      (new Date(newest.saleDate).getTime() - new Date(prior.saleDate).getTime()) / 86_400_000,
    )
    if (daysHeld > FLIP_MAX_DAYS) break // sorted desc — nothing earlier qualifies
    if (daysHeld >= FLIP_MIN_DAYS && newest.price > prior.price) {
      return {
        priorSalePrice: prior.price,
        priorSaleDate: String(prior.saleDate).slice(0, 10),
        daysHeld,
        gainPct: Math.round(((newest.price - prior.price) / prior.price) * 1000) / 10,
      }
    }
  }
  return null
}

async function normalizeMcpProperty(results: any[], env: Env): Promise<NormalizedProperty> {
  const identity = dataset<any>(results, 'identity')
  const overview = dataset<any>(results, 'overview')
  const geo = dataset<any>(results, 'geography-context')
  const valuation = dataset<any>(results, 'valuation')
  const sales = dataset<any[]>(results, 'sales-history') ?? []
  const taxHist = dataset<any[]>(results, 'tax-history') ?? []

  const ch = overview?.characteristics ?? {}
  const attomId = String(identity?.attomId ?? geo?.attomId ?? '')
  const addr = identity?.address ?? geo?.address ?? {}
  const ids = identity?.identifiers ?? {}
  const center = geo?.subject?.centerPoint
    ?? (identity?.location ? { latitude: identity.location.latitude, longitude: identity.location.longitude } : null)
    ?? identity?.centerPoint
    ?? {}
  const geos: any[] = geo?.subject?.geographies ?? []
  const geoByType = (t: string) => geos.find((g) => g.geographyType === t)
  const lastSale = latestPricedSale(sales)
  const latestTax = taxHist[0] ?? null
  const baths = (ch.fullBathrooms ?? 0) + 0.5 * (ch.partialBathrooms ?? 0)

  const census = center.latitude != null && center.longitude != null
    ? await fetchCensusGeography(center.latitude, center.longitude, env.API_CACHE, env.FIRECRAWL_API_KEY).catch(() => null)
    : null

  const property: NormalizedProperty = {
    id: attomId,
    provider: 'attom-mcp',

    address: addr.line1 ?? '',
    city: addr.city ?? '',
    state: addr.state ?? '',
    zipCode: addr.postalCode ?? '',
    county: addr.county,

    latitude: center.latitude ?? null,
    longitude: center.longitude ?? null,

    bedrooms: ch.bedrooms ?? null,
    bathrooms: baths || null,
    fullBathrooms: ch.fullBathrooms ?? null,
    halfBathrooms: ch.partialBathrooms ?? null,
    squareFeet: ch.livingAreaSquareFeet ?? null,
    lotSizeAcres: ch.lotSquareFeet ? ch.lotSquareFeet / 43560 : null,
    lotSizeSquareFeet: ch.lotSquareFeet ?? null,
    yearBuilt: ch.yearBuilt ?? null,
    propertyType: ch.propertyUse ?? overview?.summary?.propertyType ?? null,
    stories: ch.stories ?? ch.levels ?? null,

    lastSalePrice: lastSale?.price ?? null,
    lastSaleDate: lastSale?.saleDate ? String(lastSale.saleDate).slice(0, 10) : null,
    pricePerSqft: lastSale?.price && ch.livingAreaSquareFeet ? Math.round(lastSale.price / ch.livingAreaSquareFeet) : null,

    // assessedValueTrend rides inside the valuation dataset (verified live
    // 2026-10-02 — Westella) — the tax-history array shape kept as fallback.
    assessedValue: valuation?.assessedValueTrend?.latestAssessedValue ?? latestTax?.totalValue ?? null,
    landAssessedValue: latestTax?.landValue ?? null,
    improvementAssessedValue: latestTax?.improvementValue ?? null,
    marketValue: valuation?.assessedValueTrend?.latestAssessedValue ?? latestTax?.totalValue ?? null,
    taxAmount: valuation?.assessedValueTrend?.latestTax ?? latestTax?.tax ?? null,
    taxYear: valuation?.assessedValueTrend?.latestTaxYear ?? latestTax?.taxYear ?? undefined,

    avmValue: valuation?.valuation?.value ?? null,
    avmConfidence: valuation?.valuation?.confidenceScore ?? null,

    subdivision: geo?.subject?.subdivision ?? geoByType('SD')?.geographyName ?? undefined,
    neighborhoodName: geoByType('N4')?.geographyName ?? geoByType('N3')?.geographyName ?? undefined,
    neighborhoodCode: geoByType('N4')?.geographyId ?? geoByType('N3')?.geographyId ?? undefined,
    // Median $/sqft per geography scope — the premium-ARV evidence signal
    ppsfMedians: {
      SD: geoByType('SD')?.medianPricePerSqFt365d ?? null,
      N4: geoByType('N4')?.medianPricePerSqFt365d ?? null,
      N3: geoByType('N3')?.medianPricePerSqFt365d ?? null,
    },
    censusTract: census?.tract ?? undefined,
    geoScopes: {
      county: geoByType('CO')?.geographyName ?? undefined,
      city: geoByType('CS')?.geographyName ?? undefined,
      zip: geoByType('PZ')?.geographyName ?? undefined,
      schoolDistrict: geoByType('DB')?.geographyName ?? undefined,
      subdivision: geo?.subject?.subdivision ?? geoByType('SD')?.geographyName ?? undefined,
      n4: geoByType('N4')?.geographyName ?? undefined,
      n3: geoByType('N3')?.geographyName ?? undefined,
    },
    zoning: ch.zoning ?? identity?.zoning ?? undefined,

    parcelId: registerParcel(attomId, ids.fips ?? addr.fips, ids.apn ?? identity?.parcelId),
    apnFormatted: ids.apn ?? identity?.parcelId ?? undefined,

    construction: {
      type: ch.constructionType ?? undefined,
      buildingStyle: ch.architecturalStyle ?? undefined,
      roofCover: ch.roofCover ?? undefined,
      foundationType: ch.foundationType ?? undefined,
      exteriorWalls: ch.exteriorWalls ?? undefined,
    },
    features: {
      garageType: ch.garageSpaces ? 'garage' : undefined,
      garageSquareFeet: (ch.garageSpaces ?? 0) > 20 ? ch.garageSpaces : undefined,
      heating: ch.heating ?? undefined,
      cooling: ch.cooling ?? undefined,
      poolType: ch.poolType ?? (ch.pool ? 'pool' : undefined),
      fireplacesCount: ch.fireplaces ?? undefined,
    },

    flip: detectFlip(sales),
    // Newest priced sale in the record — find_comparable_sales sometimes
    // returns the ACQUISITION leg of a flip as the comp's sale; the merge
    // uses this to correct the comp's salePrice/saleDate to the resale.
    latestSale: newestPricedSale(sales),
    distressedSale: lastSale?.distressed === true || null,

    transaction: lastSale ? {
      buyerNames: lastSale.buyers ? [String(lastSale.buyers)] : undefined,
      sellerNames: lastSale.sellers ? [String(lastSale.sellers)] : undefined,
      isForeclosure: lastSale.distressed === true || undefined,
    } : undefined,

    raw: { results },
  }
  return property
}

function normalizeMcpComp(c: McpCompRecord): NormalizedComparable {
  const a = parseOneLine(c.address)
  const baths = (c.fullBathrooms ?? 0) + 0.5 * (c.partialBathrooms ?? 0)
  const attomId = String(c.attomId ?? '')
  return {
    id: attomId,
    provider: 'attom-mcp',

    address: a.line1,
    city: a.city,
    state: a.state,
    zipCode: a.zip,

    latitude: c.centerPoint?.latitude ?? null,
    longitude: c.centerPoint?.longitude ?? null,
    distanceMiles: c.distanceMiles ?? null,

    bedrooms: c.bedrooms ?? null,
    bathrooms: baths || null,
    squareFeet: c.squareFootage ?? null,
    lotSizeAcres: c.lotSquareFootage ? c.lotSquareFootage / 43560 : null,
    lotSizeSquareFeet: c.lotSquareFootage ?? null,
    yearBuilt: c.yearBuilt ?? null,
    propertyType: c.propertyUse ?? c.propertyTypeKey ?? null,

    salePrice: c.salePrice ?? null,
    saleDate: c.saleDate ? String(c.saleDate).slice(0, 10) : null,
    pricePerSqft: c.pricePerSqFt ?? (c.salePrice && c.squareFootage ? Math.round(c.salePrice / c.squareFootage) : null),

    // N4 is ATTOM's micro-neighborhood layer — NOT the legal subdivision.
    // subdivision fills in via getPropertyById (geography-context) during
    // enrichComparables; N4 maps to neighborhoodName.
    neighborhoodName: c.neighborhoodN4 ?? null,

    // NOTE: pool `distressedStatus` is property-level (distress on file),
    // NOT a distressed-transaction flag — do not map it to distressedSale.
    // Transaction distress only arrives via sales-history enrichment.

    raw: c,
  }
}

function normalizeMcpPermit(attomId: string, p: any): NormalizedPermit {
  return {
    permitId: `${attomId}:${p.permitNumber ?? ''}`,
    permitNumber: p.permitNumber ?? null,
    status: p.status ?? null,
    effectiveDate: null, // MCP permits carry no dates
    expirationDate: null,
    projectType: p.permitType ?? null,
    projectCategory: null,
    classificationTypes: [],
    description: p.description ?? null,
    jobValue: typeof p.jobValue === 'number' ? p.jobValue : null,
    contractorName: null,
    areaSquareFeet: null,
    raw: p,
  }
}

function femaToFloodZone(fema: any): NormalizedFloodZone {
  const panel = fema?.panelContext ?? {}
  return {
    floodZone: panel.zoneCode ?? null,
    floodZoneDescription: panel.zoneDescription ?? null,
    isInFloodZone: panel.zoneCode ? !/^X$/i.test(panel.zoneCode) : false,
    isNearFloodZone: false,
    communityName: null,
    communityNumber: panel.communityId ?? null,
    firmMapNumber: panel.firmPanel ?? panel.mapNumber ?? null,
    mapPanel: panel.panel ?? null,
    mapDate: panel.panelDate ? String(panel.panelDate).slice(0, 10) : null,
    participationStatus: null,
    specialFloodHazardArea: panel.zoneCode ? (/^X$/i.test(panel.zoneCode) ? 'Out' : 'In') : null,
    source: 'parcel',
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────

const SUBJECT_DATASETS = ['identity', 'overview', 'geography-context', 'valuation', 'sales-history', 'tax-history', 'permits']
const COMP_DETAIL_DATASETS = ['identity', 'overview', 'geography-context', 'sales-history', 'valuation']
const MCP_COMP_LIMIT_CAP = 25 // find_comparable_sales limit param max is 25

class AttomMcpProvider implements PropertyProviderAdapter {
  readonly name = 'attom-mcp' as const
  private env: Env
  // Subject payload stash — the get_property_data subject call already
  // carries valuation/overview/permits; downstream getAvm/
  // getBuildingDetail/getBuildingPermits serve from it so the subject
  // stays ONE MCP call (1 Intelligence Report), not four.
  private subjectResults = new Map<string, any[]>()

  constructor(env: Env) {
    this.env = env
  }

  // get_property_data caps the response at ~524KB. A big multi-dataset call
  // can cross it, so on a size error bisect the dataset list and merge the
  // results; a single dataset that still overflows returns an errored entry
  // (dataset() treats it as absent) rather than failing the whole fetch.
  private async propertyData(lookup: Record<string, unknown>, datasets: string[]): Promise<any[]> {
    const result = await this.tryPropertyData(lookup, datasets)
    if (result.tooLarge) {
      if (datasets.length === 1) {
        return [{ dataset: datasets[0], status: 'error', error: 'response_too_large' }]
      }
      const mid = Math.ceil(datasets.length / 2)
      const [a, b] = await Promise.all([
        this.propertyData(lookup, datasets.slice(0, mid)),
        this.propertyData(lookup, datasets.slice(mid)),
      ])
      return [...a, ...b]
    }
    return result.results
  }

  private async tryPropertyData(
    lookup: Record<string, unknown>,
    datasets: string[],
  ): Promise<{ results: any[]; tooLarge: boolean }> {
    try {
      const result = await callTool(this.env, 'get_property_data', { property: lookup, datasets })
      return { results: result?.structuredContent?.results ?? [], tooLarge: isTooLargeResult(result) }
    } catch (error) {
      if (isTooLargeError(error)) return { results: [], tooLarge: true }
      throw error
    }
  }

  async searchProperty(params: PropertySearchParams): Promise<PropertySearchResponse> {
    const address =
      params.address ??
      [params.streetAddress, params.city, params.state, params.zipCode].filter(Boolean).join(', ')
    if (!address) return { success: false, error: 'Address is required', code: 'INVALID_PARAMS' }
    try {
      // Exact-identity first: parcel numbers bypass the address-string
      // matcher entirely — the resolver misses on parcels whose recorded
      // address diverges (verified: 800 40th St S resolves by fipsApn,
      // not by address). Try APN spellings: recorded form, digits-only,
      // and the FL STRAP pattern when the raw string is 18 digits.
      if (params.fips && params.apn) {
        const candidates = apnSpellings(params.apn)
        for (const apn of candidates) {
          const results = await this.propertyData(
            { lookupMode: 'fipsApn', fips: params.fips, apn },
            SUBJECT_DATASETS,
          ).catch(() => [])
          const property = await normalizeMcpProperty(results, this.env)
          if (property.id) {
            this.subjectResults.set(property.id, results)
            return { success: true, data: property }
          }
        }
      }
      const results = await this.propertyData({ lookupMode: 'address', address }, SUBJECT_DATASETS)
      const property = await normalizeMcpProperty(results, this.env)
      if (!property.id) return { success: false, error: 'Property not found', code: 'NOT_FOUND' }
      this.subjectResults.set(property.id, results)
      return { success: true, data: property }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'MCP property search failed', code: 'API_ERROR' }
    }
  }

  async getPropertyById(propertyId: string): Promise<PropertySearchResponse> {
    try {
      const results = await this.propertyData(
        { lookupMode: 'attomId', attomId: propertyId },
        COMP_DETAIL_DATASETS,
      )
      const property = await normalizeMcpProperty(results, this.env)
      if (!property.id) return { success: false, error: 'Property not found', code: 'NOT_FOUND' }
      return { success: true, data: property }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'MCP property lookup failed', code: 'API_ERROR' }
    }
  }

  async getComparables(params: ComparablesSearchParams): Promise<ComparablesSearchResponse> {
    try {
      const saleDateFrom = new Date(Date.now() - (params.monthsBack ?? 12) * 30.44 * 864e5)
        .toISOString()
        .slice(0, 10)
      const result = await callTool(this.env, 'find_comparable_sales', {
        subjectAttomId: params.propertyId,
        limit: Math.min(params.maxComps ?? 25, MCP_COMP_LIMIT_CAP),
        saleDateFrom,
        maxDistanceMiles: params.radiusMiles ?? 1,
        propertyTypeStrict: true,
        includeScoringBreakdown: false,
      })
      const sc = result?.structuredContent
      const comps: McpCompRecord[] = sc?.results ?? sc?.comparables ?? []
      const comparables = comps.map(normalizeMcpComp).filter((c) => c.id && c.salePrice)
      const requested = params.maxComps ?? 25
      const effective = Math.min(requested, MCP_COMP_LIMIT_CAP)
      return {
        success: true,
        data: {
          subject: { id: params.propertyId, address: sc?.subject?.address },
          comparables,
          count: comparables.length,
          retrieval: buildRetrievalMeta({
            requested,
            effectiveLimit: effective,
            received: comparables.length,
            ordering: 'distance',
            radiusMiles: params.radiusMiles ?? 1,
            monthsBack: params.monthsBack ?? 12,
          }),
        },
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'MCP comparables failed', code: 'API_ERROR' }
    }
  }

  async getBuildingPermits(propertyId: string): Promise<PermitsResponse> {
    try {
      const results =
        this.subjectResults.get(propertyId) ??
        await this.propertyData({ lookupMode: 'attomId', attomId: propertyId }, ['permits'])
      const data = dataset<any>(results, 'permits')
      const permits = (data?.permits ?? []).map((p: any) => normalizeMcpPermit(propertyId, p))
      return { success: true, data: { propertyId, permits, count: permits.length } }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'MCP permits failed', code: 'API_ERROR' }
    }
  }

  async getFloodZoneByParcel(parcelId: string): Promise<FloodZoneResponse> {
    const attomId = parcelToAttom.get(parcelId)
    if (!attomId) return { success: false, error: 'Unknown parcelId for MCP provider', code: 'NOT_FOUND' }
    try {
      const results = await this.propertyData({ lookupMode: 'attomId', attomId }, ['fema-context'])
      const fema = dataset<any>(results, 'fema-context')
      if (!fema?.panelContext) return { success: false, error: 'No FEMA context for property', code: 'NOT_FOUND' }
      return { success: true, data: femaToFloodZone(fema) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'MCP fema-context failed', code: 'API_ERROR' }
    }
  }

  // Coordinate flood lookup isn't a per-property resource — the fema-context
  // path above covers it via parcelId resolution.
  async getFloodZone(): Promise<FloodZoneResponse> {
    return { success: false, error: 'attom-mcp flood lookup is parcel-scoped (fema-context)', code: 'NOT_SUPPORTED' }
  }

  async getAvm(parcelId: string): Promise<AvmResponse> {
    const attomId = parcelToAttom.get(parcelId)
    if (!attomId) return { success: false, error: 'Unknown parcelId for MCP provider', code: 'NOT_FOUND' }
    try {
      const results =
        this.subjectResults.get(attomId) ??
        await this.propertyData({ lookupMode: 'attomId', attomId }, ['valuation'])
      const v = dataset<any>(results, 'valuation')?.valuation
      if (!v) return { success: false, error: 'No valuation for property', code: 'NOT_FOUND' }
      const avm: NormalizedAvm = {
        value: v.value ?? null,
        confidence: v.confidenceScore ?? null,
        valueRangeLow: v.valueMin ?? null,
        valueRangeHigh: v.valueMax ?? null,
        fsd: null,
        model: 'attomAvm',
        asOfDate: v.estimatedDate ? String(v.estimatedDate).slice(0, 10) : null,
      }
      return { success: true, data: avm }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'MCP valuation failed', code: 'API_ERROR' }
    }
  }

  async getBuildingDetail(parcelId: string): Promise<BuildingDetailResponse> {
    const attomId = parcelToAttom.get(parcelId)
    if (!attomId) return { success: false, error: 'Unknown parcelId for MCP provider', code: 'NOT_FOUND' }
    try {
      const results =
        this.subjectResults.get(attomId) ??
        await this.propertyData({ lookupMode: 'attomId', attomId }, ['overview'])
      const ch = dataset<any>(results, 'overview')?.characteristics ?? {}
      const detail: NormalizedBuildingDetail = {
        condition: ch.condition ?? null,
        buildingStyle: ch.architecturalStyle ?? null,
        foundation: ch.foundationType ?? null,
        constructionType: ch.constructionType ?? null,
        exteriorWalls: ch.exteriorWalls ?? null,
        roofCover: ch.roofCover ?? null,
        stories: ch.stories ?? ch.levels ?? null,
        heating: ch.heating ?? null,
        cooling: ch.cooling ?? null,
        parkingType: ch.garageSpaces ? 'garage' : null,
        garageSquareFeet: (ch.garageSpaces ?? 0) > 20 ? ch.garageSpaces : null,
        pool: ch.poolType ?? null,
        yearBuilt: ch.yearBuilt ?? null,
      }
      return { success: true, data: detail }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'MCP overview failed', code: 'API_ERROR' }
    }
  }
}

export function createAttomMcpProvider(env: Env): PropertyProviderAdapter {
  return new AttomMcpProvider(env)
}
