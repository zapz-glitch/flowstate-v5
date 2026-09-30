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
    // ATTOM N4 is a micro-neighborhood, NOT the legal subdivision —
    // leaving subdivision unmapped keeps subdivision_match at not_verified.
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
    datasets: ['identity', 'overview', 'valuation'],
  },
})
const get = (name: string) =>
  pd.structuredContent?.results?.find((r: any) => r.dataset === name)?.data
const identity = get('identity')
const overview = get('overview')
const valuation = get('valuation')
const attomId = String(identity?.attomId ?? pd.structuredContent?.property?.attomId)
if (!attomId) throw new Error(`no attomId resolved for "${address}"`)

const ch = overview?.characteristics ?? {}
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

function tierFilters(days: number, vintage: boolean) {
  return DEFAULT_FILTERS
    .filter((f) => !['sale_age_expansion', 'sale_age_expansion_2', 'vintage_year_cap'].includes(f.type))
    .map((f) => {
      if (f.type === 'sale_age') return { ...f, value: days }
      if (f.type === 'year_built_diff' && vintage) return { ...f, value: 999 } // custom check below
      return f
    })
}

let tierUsed = TIERS[0]
let evaluated: any[] = []
let enabled: any[] = []
for (const [days, vintage] of TIERS) {
  const filters = tierFilters(days, vintage)
  evaluated = rawComps.map((c) => {
    const comp = toComp(c)
    const ev = evaluateComparable(subjectLike, comp, filters, DEFAULT_ADJUSTMENTS)
    let disabled = ev.shouldDisable
    let reasons = [...ev.disableReasons]
    // vintage rule: comp must be built on/before the cap year
    if (vintage && !disabled && comp.yearBuilt != null && comp.yearBuilt > VINTAGE_CAP) {
      disabled = true
      reasons.push(`Post-${VINTAGE_CAP} build vs vintage subject`)
      ev.filterResults.push({ type: 'year_built_diff', passed: false, status: 'failed', reason: `post-${VINTAGE_CAP} build` })
    }
    return {
      ...comp,
      _addr: c.address,
      _score: c.normalizedScore,
      isEnabled: !disabled,
      adjustedPrice: ev.adjustedPrice,
      filterResults: ev.filterResults,
      disableReasons: reasons,
      totalAdjustment: ev.totalAdjustment,
    }
  })
  enabled = evaluated.filter((c) => c.isEnabled)
  tierUsed = [days, vintage]
  if (enabled.length >= BEST_N) break
}

const selected = pickBestComps(enabled, BEST_N)
const arv = calculateARV(
  evaluated.map((c) => ({ ...c, isEnabled: selected.includes(c) })),
  subjectLike.squareFeet
)
const attomAvm = valuation?.valuation?.value ?? null

// --- readout ---------------------------------------------------------------

const money = (n?: number | null) => (n == null ? '—' : `$${Math.round(n).toLocaleString()}`)
const days = (d?: string | null) => (d ? Math.round((Date.now() - new Date(d).getTime()) / 864e5) : '—')

console.log(`\nSUBJECT  ${subject.address}`)
console.log(`  attomId ${attomId} · ${subject.bedrooms ?? '?'}bd/${((subject.fullBathrooms ?? 0) + 0.5 * (subject.partialBathrooms ?? 0)) || '?'}ba · ${subject.squareFootage ?? '?'} sqft · built ${subject.yearBuilt ?? '?'} · lot ${subject.lotSquareFootage ?? '?'} sf`)
console.log(`  ladder used: sale_age ≤${tierUsed[0]}d${tierUsed[1] ? ` + vintage ≤${VINTAGE_CAP} year rule` : ''} · pool ${SEARCH_MILES}mi / strict type / limit ${COMP_LIMIT}`)

console.log(`\nCOMPS (${evaluated.length} returned, ${enabled.length} pass filters at this tier)`)
for (const c of evaluated) {
  const fails = c.filterResults.filter((f) => f.passed === false && f.status !== 'not_verified').map((f) => f.type).join(',')
  const mark = selected.includes(c) ? '★' : c.isEnabled ? '✓' : '✗'
  console.log(`  ${mark} ${(c._addr ?? '').padEnd(46)} ${money(c.salePrice).padStart(9)} ${String(c.squareFeet ?? '?').padStart(5)}sf ${(c.distanceMiles ?? 0).toFixed(2)}mi ${String(days(c.saleDate)).padStart(4)}d adj ${money(c.adjustedPrice).padStart(9)}${fails ? `  ✗${fails}` : ''}`)
}

console.log(`\nRESULT`)
console.log(`  selected: ${selected.map((c) => c._addr).join(' | ') || 'none — insufficient comps'}`)
console.log(`  ARV (rules engine): ${money(arv) || '— insufficient'}`)
console.log(`  ATTOM AVM:          ${money(attomAvm)}  (confidence ${valuation?.valuation?.confidenceScore ?? '?'})`)

mkdirSync(OUT_DIR, { recursive: true })
const slug = String(address).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50)
const outPath = join(OUT_DIR, `eval-${slug}-${Date.now()}.json`)
writeFileSync(outPath, JSON.stringify({ address, subject, subjectLike, evaluated, selectedAddresses: selected.map((c) => c._addr), arv, attomAvm }, null, 2))
console.log(`\nartifact: ${outPath}`)
