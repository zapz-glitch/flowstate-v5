// TEMPORARY — MCP eval probe for the ATTOM provider swap. Not part of the
// production evaluation system; throw away or fold in once the swap lands.
//
//   npx tsx scripts/tmp-attom-eval.mts "12312 N 27th St, Tampa, FL 33612"
//
// Pulls subject + comp pool via the ATTOM MCP server (OAuth creds shared
// with attom-mcp.mjs), maps fields onto PropertyLike/CompLike, then runs the
// REAL appraisal math: DEFAULT_FILTERS / DEFAULT_ADJUSTMENTS from
// apps/api appraisal + evaluateComparable / pickBestComps / calculateARV
// from @flowstate-api/shared. Prints a comp-by-comp readout, the selected
// comps, computed ARV, and ATTOM's own AVM for comparison.
// Artifact → .data/attom-mcp/eval-<slug>-<ts>.json

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getToken, rpc } from './attom-mcp.mjs'
import { evaluateComparable, pickBestComps, calculateARV } from '@flowstate-api/shared/appraisal'
import { DEFAULT_FILTERS, DEFAULT_ADJUSTMENTS } from '../apps/api/src/services/appraisal/types'
import type { CompLike, PropertyLike } from '@flowstate-api/shared/appraisal'

const OUT_DIR = new URL('../.data/attom-mcp/', import.meta.url).pathname
const SEARCH_MILES = 1.0
const COMP_LIMIT = 25
const BEST_N = 3

type McpSubject = {
  attomId?: string
  address?: string
  neighborhoodN4?: string | null
  propertyUse?: string | null
  squareFootage?: number | null
  lotSquareFootage?: number | null
  yearBuilt?: number | null
  bedrooms?: number | null
  fullBathrooms?: number | null
  partialBathrooms?: number | null
  garageSpaces?: number | null
  subdivision?: string | null
  geoIds?: Record<string, string>
}
type McpComp = McpSubject & {
  salePrice?: number | null
  saleDate?: string | null
  pricePerSqFt?: number | null
  distanceMiles?: number | null
  normalizedScore?: number | null
}

function toProperty(p: McpSubject): PropertyLike {
  return {
    squareFeet: p.squareFootage ?? null,
    bedrooms: p.bedrooms ?? null,
    bathrooms: (p.fullBathrooms ?? 0) + 0.5 * (p.partialBathrooms ?? 0) || null,
    yearBuilt: p.yearBuilt ?? null,
    lotSizeSquareFeet: p.lotSquareFootage ?? null,
    // SD (legal plat) when enriched; N4 is the micro-neighborhood layer.
    subdivision: p.subdivision ?? null,
    neighborhoodName: p.neighborhoodN4 ?? null,
    propertyType: p.propertyUse ?? null,
    features: {
      garageType: p.garageSpaces ? ['garage'] : null,
      // ATTOM packs either space count or sqft here; >20 reads as sqft.
      garageSquareFeet: (p.garageSpaces ?? 0) > 20 ? p.garageSpaces : null,
    },
  }
}

function toComp(c: McpComp): CompLike {
  return {
    ...toProperty(c),
    salePrice: c.salePrice ?? null,
    saleDate: c.saleDate ?? null,
    pricePerSqft: c.pricePerSqFt ?? null,
    distanceMiles: c.distanceMiles ?? null,
  }
}

const address = process.argv[2]
if (!address) {
  console.error('usage: npx tsx scripts/tmp-attom-eval.mts "<address>"')
  process.exit(1)
}

const token = await getToken()

// subject identity + characteristics + ATTOM's own AVM
const pd = await rpc(token, 'tools/call', {
  name: 'get_property_data',
  arguments: {
    property: { lookupMode: 'address', address },
    datasets: ['identity', 'overview', 'valuation', 'geography-context'],
  },
})
const get = (name: string) =>
  pd.structuredContent?.results?.find((r: any) => r.dataset === name)?.data
const identity = get('identity')
const overview = get('overview')
const valuation = get('valuation')
const geoCtx = get('geography-context')
const attomId = String(identity?.attomId ?? pd.structuredContent?.property?.attomId)
if (!attomId) throw new Error(`no attomId resolved for "${address}"`)

const ch = overview?.characteristics ?? {}
// geography-context geographies → { scope: {name, geoId} }
const geoScopes: Record<string, { name: string; id?: string }> = {}
for (const g of geoCtx?.subject?.geographies ?? []) {
  geoScopes[g.geographyType] = { name: g.geographyName, id: g.geographyId }
}
const subject: McpSubject = {
  attomId,
  address: identity?.address ? `${identity.address.line1}, ${identity.address.city}, ${identity.address.state} ${identity.address.postalCode}` : address,
  squareFootage: ch.livingAreaSquareFeet,
  lotSquareFootage: ch.lotSquareFeet,
  yearBuilt: ch.yearBuilt,
  bedrooms: ch.bedrooms,
  fullBathrooms: ch.fullBathrooms,
  partialBathrooms: ch.partialBathrooms,
  garageSpaces: ch.garageSpaces,
  propertyUse: ch.propertyUse ?? overview?.summary?.propertyType,
  subdivision: geoCtx?.subject?.subdivision ?? geoScopes['SD']?.name ?? null,
  neighborhoodN4: geoScopes['N4']?.name ?? null,
  geoIds: Object.fromEntries(Object.entries(geoScopes).map(([k, v]) => [k, v.id ?? v.name])),
}

// comp pool at the WIDEST ladder window (548d — sale_age_expansion_2
// default), then re-evaluate per tier like the prod ladder does.
const saleDateFrom = new Date(Date.now() - 548 * 864e5).toISOString().slice(0, 10)
const compCall = await rpc(token, 'tools/call', {
  name: 'find_comparable_sales',
  arguments: {
    subjectAttomId: attomId,
    limit: COMP_LIMIT,
    saleDateFrom,
    maxDistanceMiles: SEARCH_MILES,
    propertyTypeStrict: true,
    includeScoringBreakdown: false,
  },
})
const compData = compCall.structuredContent
const rawComps: McpComp[] = compData?.results ?? compData?.comparables ?? []
// subject's neighborhood lands on the comparables subject block when present
const subjNeighborhood = compData?.subject?.neighborhoodN4
if (subjNeighborhood && !subject.neighborhoodN4) subject.neighborhoodN4 = subjNeighborhood

const subjectLike = toProperty(subject)
const subjectYear = subjectLike.yearBuilt ?? null
// Emulates vintage_year_cap: pre-1970 subjects may swap the ±10yr rule for
// "comp built on/before 1970" on expansion tiers.
const VINTAGE_CAP = 1970
const isVintage = subjectYear != null && subjectYear < VINTAGE_CAP

// ladder: [saleAgeDays, useVintageYearRule]
const TIERS: Array<[number, boolean]> = [
  [180, false],
  [365, isVintage],
  [548, isVintage],
]

// subdivision_match + neighborhood_match come OUT of the per-comp set —
// geo verification is a combined OR below (either one matching verifies).
function tierFilters(days: number, vintage: boolean) {
  return DEFAULT_FILTERS
    .filter((f) => !['sale_age_expansion', 'sale_age_expansion_2', 'vintage_year_cap',
                     'subdivision_match', 'neighborhood_match'].includes(f.type))
    .map((f) => {
      if (f.type === 'sale_age') return { ...f, value: days }
      if (f.type === 'year_built_diff' && vintage) return { ...f, value: 999 } // custom check below
      return f
    })
}

const norm = (s?: string | null) => (s ?? '').trim().toUpperCase().replace(/\s+/g, ' ')

// Comp geography enrichment cache — geography-context per attomId,
// fetched only for comps that survive the non-geo hard filters.
// Carries geoIds AND per-scope market stats (medianPPSF365d) for the
// value-equivalence fallback.
type CompGeo = {
  sd?: string; sdId?: string
  n4?: string; n4Id?: string
  n3?: string; n3Id?: string
  // scope → medianPricePerSqFt365d (null = no stats coverage)
  ppsf: { SD?: number | null; N4?: number | null; N3?: number | null }
}
const compGeoCache = new Map<string, CompGeo>()
async function enrichCompGeo(attomId: string): Promise<CompGeo> {
  if (compGeoCache.has(attomId)) return compGeoCache.get(attomId)!
  try {
    const r = await rpc(token, 'tools/call', {
      name: 'get_property_data',
      arguments: { property: { lookupMode: 'attomId', attomId }, datasets: ['geography-context'] },
    })
    const d = r.structuredContent?.results?.find((x: any) => x.dataset === 'geography-context')?.data
    const s = d?.subject
    const geos = Object.fromEntries((s?.geographies ?? []).map((g: any) => [g.geographyType, g]))
    const ppsf: CompGeo['ppsf'] = {}
    for (const l of d?.layers ?? []) {
      if (['SD', 'N4', 'N3'].includes(l.geographyType)) ppsf[l.geographyType as 'SD' | 'N4' | 'N3'] = l.medianPricePerSqFt365d ?? null
    }
    const entry: CompGeo = {
      sd: s?.subdivision ?? geos['SD']?.geographyName,
      sdId: geos['SD']?.geographyId,
      n4: geos['N4']?.geographyName,
      n4Id: geos['N4']?.geographyId,
      n3: geos['N3']?.geographyName,
      n3Id: geos['N3']?.geographyId,
      ppsf,
    }
    compGeoCache.set(attomId, entry)
    return entry
  } catch {
    compGeoCache.set(attomId, { ppsf: {} })
    return { ppsf: {} }
  }
}

const subjSd = { name: subject.subdivision, id: subject.geoIds?.['SD'] }
const subjN4 = { name: subject.neighborhoodN4, id: subject.geoIds?.['N4'] }
const subjN3 = { name: geoScopes['N3']?.name, id: geoScopes['N3']?.id }
// subject per-scope market stats from its own geography layers
const subjPpsf: CompGeo['ppsf'] = {}
for (const l of geoCtx?.layers ?? []) {
  if (['SD', 'N4', 'N3'].includes(l.geographyType)) subjPpsf[l.geographyType as 'SD' | 'N4' | 'N3'] = l.medianPricePerSqFt365d ?? null
}

// Value-equivalence band: comp scope median $/sqft within ±25% of the
// subject's same-scope median counts as a value-equivalent neighborhood.
const VALUE_EQ_PCT = 0.25

// Geo verification ladder: SD match → N4 match → N3 match → value
// equivalence on the tightest scope with stats on both sides.
// 'fail' only when data exists and nothing matches/equates.
function geoVerdict(geo: CompGeo, compN4?: string | null) {
  const n4 = geo.n4 ?? compN4 ?? undefined
  const hasData = !!(geo.sd || n4 || geo.n3)
  if (!hasData) return { verdict: 'not_verified' as const, detail: 'no comp geo data' }

  const scope = (cName: string | undefined, cId: string | undefined, s: { name?: string | null; id?: string }) =>
    (cId && s.id && cId === s.id) || (cName && s.name && norm(cName) === norm(s.name))

  if (scope(geo.sd, geo.sdId, subjSd)) return { verdict: 'pass' as const, detail: 'same subdivision' }
  if (scope(n4, geo.n4Id, subjN4)) return { verdict: 'pass' as const, detail: 'same neighborhood (N4)' }
  if (scope(geo.n3, geo.n3Id, subjN3)) return { verdict: 'pass' as const, detail: 'same broad neighborhood (N3)' }

  // value equivalence — tightest scope with stats on both sides
  for (const s of ['SD', 'N4', 'N3'] as const) {
    const c = geo.ppsf[s]; const j = subjPpsf[s]
    if (c != null && j != null && j > 0) {
      const diff = Math.abs(c - j) / j
      if (diff <= VALUE_EQ_PCT) {
        return { verdict: 'pass' as const, detail: `value-equivalent ${s}: $${Math.round(c)}/sf vs $${Math.round(j)}/sf (${Math.round(diff * 100)}%)` }
      }
      // stats exist and are out of band → verified mismatch at this scope
      return { verdict: 'fail' as const, detail: `not value-equivalent ${s}: $${Math.round(c)}/sf vs $${Math.round(j)}/sf (+${Math.round(diff * 100)}%) · SD:${geo.sd ?? '—'}·N4:${n4 ?? '—'}` }
    }
  }
  return { verdict: 'fail' as const, detail: `SD:${geo.sd ?? '—'} vs ${subjSd.name ?? '—'} · N4:${n4 ?? '—'} vs ${subjN4.name ?? '—'} · N3:${geo.n3 ?? '—'} vs ${subjN3.name ?? '—'} (no stats)` }
}

let tierUsed = TIERS[0]
let evaluated: any[] = []
let enabled: any[] = []
for (const [days, vintage] of TIERS) {
  const filters = tierFilters(days, vintage)
  // phase 1: non-geo rules
  evaluated = rawComps.map((c) => {
    const comp = toComp(c)
    const ev = evaluateComparable(subjectLike, comp, filters, DEFAULT_ADJUSTMENTS)
    let disabled = ev.shouldDisable
    let reasons = [...ev.disableReasons]
    if (vintage && !disabled && comp.yearBuilt != null && comp.yearBuilt > VINTAGE_CAP) {
      disabled = true
      reasons.push(`Post-${VINTAGE_CAP} build vs vintage subject`)
      ev.filterResults.push({ type: 'year_built_diff', passed: false, status: 'failed', reason: `post-${VINTAGE_CAP} build` })
    }
    return {
      ...comp,
      _addr: c.address,
      _attomId: c.attomId,
      _n4: c.neighborhoodN4,
      _score: c.normalizedScore,
      _geoNote: '',
      isEnabled: !disabled,
      adjustedPrice: ev.adjustedPrice,
      filterResults: ev.filterResults,
      disableReasons: reasons,
      totalAdjustment: ev.totalAdjustment,
    }
  })
  // phase 2: enrich survivors with geography-context, then OR geo verdict
  const survivors = evaluated.filter((c) => c.isEnabled)
  await Promise.all(survivors.map(async (c) => {
    const geo = c._attomId ? await enrichCompGeo(String(c._attomId)) : {}
    const v = geoVerdict(geo, c._n4)
    c._geoNote = v.detail ?? ''
    if (v.verdict === 'fail') {
      c.isEnabled = false
      c.disableReasons.push(`geo mismatch (${v.detail})`)
      c.filterResults.push({ type: 'subdivision_match', passed: false, status: 'failed', reason: `geo: ${v.detail}` })
    } else {
      c.filterResults.push({ type: 'subdivision_match', passed: v.verdict === 'pass', status: v.verdict === 'pass' ? 'passed' : 'not_verified', reason: v.detail })
    }
  }))
  enabled = evaluated.filter((c) => c.isEnabled)
  tierUsed = [days, vintage]
  if (enabled.length >= BEST_N) break
}

// hard-fail count per comp (verified hard-rule failures only) — used to
// rank "nearest miss" fallbacks so a thin pool still returns the closest
// evidence instead of a bare insufficient.
const hardTypes = new Set(DEFAULT_FILTERS.filter((f) => (f.priority ?? 'hard') === 'hard').map((f) => f.type))
for (const c of evaluated) {
  c._hardFails = c.filterResults.filter(
    (f) => f.passed === false && f.status !== 'not_verified' && hardTypes.has(f.type)
  ).length
}

// Price bands (mirrors services/comp-screen splitPriceBands): ARV band =
// within 10% under pool top; as-is band = within 10% over pool floor.
// Overlap → assigned to the relatively closer anchor.
const ARV_BAND_PCT = 0.10
const AS_IS_BAND_PCT = 0.10
const priced = enabled.filter((c) => (c.adjustedPrice ?? c.salePrice) != null && (c.adjustedPrice ?? c.salePrice) > 0)
const arvAnchor = priced.length ? Math.max(...priced.map((c) => c.adjustedPrice ?? c.salePrice)) : null
const asIsAnchor = priced.length ? Math.min(...priced.map((c) => c.adjustedPrice ?? c.salePrice)) : null
let arvBand: typeof evaluated = []
let asIsBand: typeof evaluated = []
if (arvAnchor != null && asIsAnchor != null) {
  const inArv = priced.filter((c) => (c.adjustedPrice ?? c.salePrice) >= arvAnchor * (1 - ARV_BAND_PCT))
  const inAsIs = priced.filter((c) => (c.adjustedPrice ?? c.salePrice) <= asIsAnchor * (1 + AS_IS_BAND_PCT))
  const arvIds = new Set(inArv.map((c) => c._attomId))
  for (const c of inAsIs) {
    if (!arvIds.has(c._attomId)) continue
    const p = c.adjustedPrice ?? c.salePrice
    if ((p - asIsAnchor) / asIsAnchor < (arvAnchor - p) / arvAnchor) arvIds.delete(c._attomId)
  }
  const overlapIds = arvIds
  arvBand = inArv.filter((c) => overlapIds.has(c._attomId))
  asIsBand = inAsIs.filter((c) => !overlapIds.has(c._attomId))
  for (const c of evaluated) c._band = arvBand.includes(c) ? 'ARV' : asIsBand.includes(c) ? 'AS-IS' : ''
}

// Degradation contract: never return empty. When the verified pool is
// thin, top it up with nearest misses (fewest hard fails, then distance)
// and mark every number DEGRADED so the operator decides sufficiency.
const nearestMissesAll = evaluated
  .filter((c) => !c.isEnabled)
  .sort((a, b) => (a._hardFails - b._hardFails) || ((a.distanceMiles ?? 99) - (b.distanceMiles ?? 99)))
const degraded = enabled.length < BEST_N
if (degraded) {
  for (const c of nearestMissesAll.slice(0, BEST_N - enabled.length)) c._degradedPick = true
}
const effectivePool = degraded ? [...enabled, ...nearestMissesAll.slice(0, BEST_N - enabled.length)] : enabled
const effPriced = effectivePool.filter((c) => (c.adjustedPrice ?? c.salePrice) != null && (c.adjustedPrice ?? c.salePrice) > 0)
if (degraded && effPriced.length) {
  // rebuild bands over the topped-up pool
  const aTop = Math.max(...effPriced.map((c) => c.adjustedPrice ?? c.salePrice))
  const aFloor = Math.min(...effPriced.map((c) => c.adjustedPrice ?? c.salePrice))
  arvBand = effPriced.filter((c) => (c.adjustedPrice ?? c.salePrice) >= aTop * (1 - ARV_BAND_PCT))
  asIsBand = effPriced.filter((c) => (c.adjustedPrice ?? c.salePrice) <= aFloor * (1 + AS_IS_BAND_PCT) && !arvBand.includes(c))
  for (const c of evaluated) c._band = arvBand.includes(c) ? 'ARV' : asIsBand.includes(c) ? 'AS-IS' : ''
}

const selected = pickBestComps(arvBand.length ? arvBand : effectivePool, BEST_N)
const arv = calculateARV(
  evaluated.map((c) => ({ ...c, isEnabled: selected.includes(c) })),
  subjectLike.squareFeet
)
const asIsValue = calculateARV(
  evaluated.map((c) => ({ ...c, isEnabled: asIsBand.includes(c) })),
  subjectLike.squareFeet
)
const nearestMisses = nearestMissesAll.slice(0, 3)
const attomAvm = valuation?.valuation?.value ?? null

// --- readout ---------------------------------------------------------------

const money = (n?: number | null) => (n == null ? '—' : `$${Math.round(n).toLocaleString()}`)
const days = (d?: string | null) => (d ? Math.round((Date.now() - new Date(d).getTime()) / 864e5) : '—')

console.log(`\nSUBJECT  ${subject.address}`)
console.log(`  attomId ${attomId} · ${subject.bedrooms ?? '?'}bd/${((subject.fullBathrooms ?? 0) + 0.5 * (subject.partialBathrooms ?? 0)) || '?'}ba · ${subject.squareFootage ?? '?'} sqft · built ${subject.yearBuilt ?? '?'} · lot ${subject.lotSquareFootage ?? '?'} sf`)
const geoLine = Object.entries(geoScopes).map(([k, v]) => `${k}=${v.name}`).join('  ')
console.log(`  geographies: ${geoLine || 'none'}${geoScopes['CT'] || geoScopes['CB'] ? '' : '  (no census tract/block in MCP surface)'}`)
console.log(`  geo verify: subdivision(SD)=${subjSd.name ?? '—'} · neighborhood(N4)=${subjN4.name ?? '—'} — either matching verifies`)
console.log(`  ladder used: sale_age ≤${tierUsed[0]}d${tierUsed[1] ? ` + vintage ≤${VINTAGE_CAP} year rule` : ''} · pool ${SEARCH_MILES}mi / strict type / limit ${COMP_LIMIT}`)

console.log(`\nCOMPS (${evaluated.length} returned, ${enabled.length} pass filters at this tier)`)
for (const c of evaluated) {
  const fails = c.filterResults.filter((f) => f.passed === false && f.status !== 'not_verified').map((f) => f.type).join(',')
  const mark = selected.includes(c) ? '★' : c.isEnabled ? '✓' : '✗'
  const band = (c._band ? ` ${c._band}` : '').padEnd(6)
  const geo = c._geoNote ? ` [geo:${c._geoNote}]` : ''
  console.log(`  ${mark}${band} ${(c._addr ?? '').padEnd(44)} ${money(c.salePrice).padStart(9)} ${String(c.squareFeet ?? '?').padStart(5)}sf ${(c.distanceMiles ?? 0).toFixed(2)}mi ${String(days(c.saleDate)).padStart(4)}d adj ${money(c.adjustedPrice).padStart(9)}${fails ? `  ✗${fails}` : ''}${geo}`)
}

console.log(`\nRESULT${degraded ? '  ⚠ thin pool — nearest misses below' : ''}`)
console.log(`  ARV band comps:  ${selected.map((c) => c._addr).join(' | ') || 'none'}`)
console.log(`  ARV (after-repair):   ${money(arv) || '—'}   ${degraded ? '(DEGRADED — computed on nearest misses)' : `(${arvBand.length} comp${arvBand.length === 1 ? '' : 's'} in band)`}`)
console.log(`  AS-IS (inv floor):    ${money(asIsValue) || '—'}   ${asIsBand.length ? `(${asIsBand.length} comp${asIsBand.length === 1 ? '' : 's'} in band)` : '(no floor comps in pool)'}`)
if (arv && asIsValue) console.log(`  spread ARV vs as-is:  ${money(arv - asIsValue)} (${Math.round(((arv - asIsValue) / asIsValue) * 100)}%)`)
console.log(`  ATTOM AVM (as-is):    ${money(attomAvm)}  (confidence ${valuation?.valuation?.confidenceScore ?? '?'})`)
if (nearestMisses.length) {
  console.log(`\nNEAREST MISSES (closest evidence that failed):`)
  for (const c of nearestMisses) {
    const reasons = c.disableReasons.join('; ') || '—'
    console.log(`  ~ ${c._addr}  ${money(c.adjustedPrice)}  ${(c.distanceMiles ?? 0).toFixed(2)}mi — ${reasons}`)
  }
}

mkdirSync(OUT_DIR, { recursive: true })
const slug = String(address).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50)
const outPath = join(OUT_DIR, `eval-${slug}-${Date.now()}.json`)
writeFileSync(outPath, JSON.stringify({ address, subject, subjectLike, evaluated, selectedAddresses: selected.map((c) => c._addr), arv, attomAvm }, null, 2))
console.log(`\nartifact: ${outPath}`)
