/**
 * Site reads — yes/no lot facts for Set-B trick 12 (site match).
 *
 *   waterfront  Clef-flash on two Esri aerials (wide ~600m, close ~180m)
 *   busyRoad    Clef 27B on the same aerials (busy road, rail, commercial)
 *   pool        MLS pool field → listing description → county pool field
 *
 * The aerials are centered on a Geocodio ROOFTOP pin only — an ATTOM pin
 * or an interpolated street point lands on the wrong lot often enough
 * (6/20 and 2/20 in the test) that the read is left unknown instead.
 * Cutoffs come from the 19-lot owner-labeled test; aerial pool reads were
 * wrong even when confident, so pool never comes from the aerial.
 * Test record: docs/SITE-READS-CLEF-TEST.md
 *
 * Every failure resolves to unknown (null) — a site read can never block
 * a run or knock a comp out.
 */

import type { BSite } from '@flowstate-api/shared/appraisal'
import type { Env } from '../../types'

const PIN_TTL = 180 * 24 * 60 * 60
const AERIAL_TTL = 180 * 24 * 60 * 60
const READ_VERSION = 'v1'

// ── Cutoffs (pure) ───────────────────────────────────────────────────────

/** Clef-flash water probability → yes/no; the middle band is unknown. */
export function waterFromP(p: number | null | undefined): boolean | null {
  if (typeof p !== 'number') return null
  return p >= 0.6 ? true : p <= 0.3 ? false : null
}

/** Clef 27B exposure answer → busy road yes/no. Reads the NEUTRAL odds:
 *  low = something adverse touches the lot; the middle band is unknown. */
export function busyFromExposure(a: { choice?: string; probabilities?: Record<string, number> } | null | undefined): boolean | null {
  const neutral = a?.probabilities?.NEUTRAL
  if (!a || a.choice === 'UNVERIFIED' || typeof neutral !== 'number') return null
  return neutral <= 0.30 ? true : neutral >= 0.45 ? false : null
}

// Shared amenities and non-pool phrases — stripped before the pool check.
const NOT_OWN_POOL = /\b(community|neighborhood|subdivision|hoa|association|shared|club ?house|resort[- ]style|amenit(?:y|ies)[^.]{0,40})\s+(?:swimming\s+)?pools?\b|\bpools?\s+(?:table|access|privileges)\b|\b(?:room|space|yard)\s+for\s+(?:a\s+)?pool\b|\bno\s+pool\b|\bcar ?pool/gi

/** Pool from listing evidence. MLS field wins; a description that names
 *  the home's own pool is yes; the county field is last. Silence is
 *  unknown, never no. */
export function poolFrom(e: { mlsPool?: boolean | null; description?: string | null; poolType?: string | null }): boolean | null {
  if (typeof e.mlsPool === 'boolean') return e.mlsPool
  const text = (e.description ?? '').replace(NOT_OWN_POOL, ' ')
  if (/\b(?:swimming\s+)?pool\b/i.test(text)) return true
  const county = (e.poolType ?? '').trim().toLowerCase()
  if (county && !['none', 'no', 'n', 'false', '0'].includes(county)) return true
  return null
}

// ── Questions — exactly as tested (wording is part of the calibration) ──

const STATE = { subject: 'Residential lot site read for a real-estate appraisal. Image 1 is a wide aerial (~600m), image 2 is a close-up (~180m). The subject lot is at the CENTER of both.' }

const WATER_Q = {
  water: { type: 'noul', instructions: 'Probability that water (bay, canal, lake, pond, river) touches the CENTER parcel boundary. A water body elsewhere in frame that does not touch the center lot is NOT waterfront.' },
}

const EXPOSURE_Q = {
  exposure: {
    type: 'choice',
    criteria: { FRONTING: 'fronts a busy road, arterial, or commercial', SIDING: 'sides a busy road, arterial, or commercial', BACKING: 'backs a busy road, commercial, freeway, or rail', NEUTRAL: 'typical interior residential setting', UNVERIFIED: 'imagery insufficient' },
    instructions: 'Does the center lot have adverse site exposure? Scan every edge of the center parcel: a large commercial/industrial building, parking lot, multi-lane arterial or highway, or rail line touching or immediately adjacent = exposure. A through road counts too: any road with a painted center line (double yellow) or that carries traffic between neighborhoods. Only quiet neighborhood streets with no center line are NOT exposure. Pick the side: fronting = street side, backing = rear edge, siding = side edge. NEUTRAL when all edges border homes, yards, or woods.',
  },
}

// ── Rooftop pins (Geocodio, one batch call) ──────────────────────────────

export interface Pin { lat: number; lng: number }

const pinKey = (address: string) => `site:pin:${READ_VERSION}:${address.trim().toLowerCase().replace(/\s+/g, ' ')}`

/** Rooftop pin per address — anything Geocodio isn't sure of (street
 *  interpolation, centroid) is null. Cached; misses go in one batch call. */
export async function rooftopPins(env: Env, addresses: string[]): Promise<Map<string, Pin | null>> {
  const out = new Map<string, Pin | null>()
  const todo: string[] = []
  for (const a of new Set(addresses.filter(Boolean))) {
    const hit = await env.API_CACHE?.get<{ pin: Pin | null }>(pinKey(a), 'json').catch(() => null)
    if (hit) out.set(a, hit.pin)
    else todo.push(a)
  }
  if (!todo.length || !env.GEOCODIO_API_KEY) {
    for (const a of todo) out.set(a, null)
    return out
  }
  type GeoResult = { location?: { lat?: number; lng?: number }; accuracy_type?: string }
  let results: Array<{ response?: { results?: GeoResult[] } }> = []
  try {
    const resp = await fetch(`https://api.geocod.io/v1.9/geocode?api_key=${env.GEOCODIO_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(todo),
      signal: AbortSignal.timeout(20000),
    })
    if (resp.ok) results = ((await resp.json()) as { results?: typeof results }).results ?? []
    else console.log(`[SiteRead] geocodio batch ${resp.status}`)
  } catch (e) { console.log('[SiteRead] geocodio batch threw:', e) }
  for (const [i, a] of todo.entries()) {
    const top = results[i]?.response?.results?.[0]
    const ok = top?.accuracy_type === 'rooftop' && typeof top.location?.lat === 'number' && typeof top.location?.lng === 'number'
    const pin = ok ? { lat: top!.location!.lat!, lng: top!.location!.lng! } : null
    out.set(a, pin)
    // Only a real answer is cached — a failed call retries next run.
    if (results.length) await env.API_CACHE?.put(pinKey(a), JSON.stringify({ pin }), { expirationTtl: PIN_TTL }).catch(() => undefined)
  }
  return out
}

// ── Aerials (Esri World Imagery, USGS fallback) ──────────────────────────

async function tileB64(url: string) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (flowstate site-read)' }, signal: AbortSignal.timeout(15000) }).catch(() => null)
  if (!res?.ok || !(res.headers.get('content-type') ?? '').startsWith('image/')) return null
  const buf = new Uint8Array(await res.arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192))
  return { content_type: 'image/jpeg' as const, base64: btoa(bin) }
}

/** One aerial centered on the pin, `half` meters each way. Esri 500s on
 *  some 640px close-ups (Phoenix) — 512px then USGS cover it. */
export async function aerial(pin: Pin, half: number) {
  const R = 20037508.34
  const x = pin.lng * R / 180
  const y = (R / Math.PI) * Math.log(Math.tan(Math.PI / 4 + pin.lat * Math.PI / 360))
  const bbox = `${Math.round(x - half)},${Math.round(y - half)},${Math.round(x + half)},${Math.round(y + half)}`
  const q = (size: number) => `export?bbox=${bbox}&bboxSR=3857&imageSR=3857&size=${size},${size}&format=jpg&f=image`
  return (await tileB64(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/${q(640)}`))
    ?? (await tileB64(`https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/${q(512)}`))
    ?? (await tileB64(`https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/${q(512)}`))
}

// ── Aerial read (Clef) ───────────────────────────────────────────────────

const aerialKey = (pin: Pin) => `site:aerial:${READ_VERSION}:${pin.lat.toFixed(5)},${pin.lng.toFixed(5)}`

type ClefAnswers = { answers?: Record<string, { noul?: number; choice?: string; probabilities?: Record<string, number> }> }

/** Waterfront + busy road for one lot. Cached by pin; a failed read is
 *  unknown and not cached. */
export async function aerialRead(env: Env, pin: Pin): Promise<Pick<BSite, 'waterfront' | 'busyRoad'>> {
  const key = aerialKey(pin)
  const hit = await env.API_CACHE?.get<Pick<BSite, 'waterfront' | 'busyRoad'>>(key, 'json').catch(() => null)
  if (hit) return hit
  if (!env.AI) return { waterfront: null, busyRoad: null }
  const [wide, close] = await Promise.all([aerial(pin, 300), aerial(pin, 90)])
  if (!wide || !close) return { waterfront: null, busyRoad: null }
  const images = [wide, close]
  const run = (model: 'clef' | 'clef-flash', questions: Record<string, unknown>) =>
    (env.AI!.run(`@cf/cloudflare/${model}` as Parameters<Ai['run']>[0], { model, state: STATE, questions, images } as never) as Promise<ClefAnswers>)
      .catch((e: unknown) => { console.log(`[SiteRead] ${model} threw:`, e); return null })
  const [w, x] = await Promise.all([run('clef-flash', WATER_Q), run('clef', EXPOSURE_Q)])
  const read = {
    waterfront: waterFromP(w?.answers?.water?.noul),
    busyRoad: busyFromExposure(x?.answers?.exposure),
  }
  if (w?.answers && x?.answers) await env.API_CACHE?.put(key, JSON.stringify(read), { expirationTtl: AERIAL_TTL }).catch(() => undefined)
  return read
}

// ── One run: subject + comps ─────────────────────────────────────────────

export interface SiteLot {
  id: string
  address: string | null
  mlsPool?: boolean | null
  description?: string | null
  poolType?: string | null
}

/** Site reads for every lot, keyed by id. Aerial reads run 8 at a time. */
export async function readSites(env: Env, lots: SiteLot[]): Promise<Map<string, BSite>> {
  const pins = await rooftopPins(env, lots.map((l) => l.address ?? '').filter(Boolean))
  const out = new Map<string, BSite>()
  let next = 0
  const worker = async () => {
    while (next < lots.length) {
      const lot = lots[next++]
      const pin = lot.address ? pins.get(lot.address) ?? null : null
      const air = pin ? await aerialRead(env, pin) : { waterfront: null, busyRoad: null }
      out.set(lot.id, { ...air, pool: poolFrom(lot) })
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, lots.length) }, worker))
  return out
}
