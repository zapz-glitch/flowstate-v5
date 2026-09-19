/**
 * Comparable candidate-retrieval hardening proofs.
 *
 * 1. >25 provider candidates can enter the pool when supported.
 * 2. A valid high-priced candidate at position 30+ is not lost to the cap.
 * 3. Provider retrieval order does not determine ARV selection.
 * 4. Provider truncation is visible in the audit trail.
 * 5. Radius-bound expansion triggers a refetch, not an incomplete pool.
 * 6. A bigger pool does not enrich every candidate — only provably-dead
 *    comps (never-relaxed rules) skip the paid property-detail call.
 * 7. Pre-cap-vintage subjects (e.g. built <1970) get a last-resort
 *    one-sided year cap when no year-built tier finds comps.
 */
import assert from 'node:assert/strict'
import { createPropertyApi } from '../src/services/property-api'
import { createAppraisalService } from '../src/services/appraisal'
import { mergeComparablePools } from '../src/services/property-api/comparable-pool'
import {
  resolveCandidateLimit,
  expansionRefetchRadius,
  isProvablyDeadComp,
  CORELOGIC_MAX_COMPS,
} from '../src/services/property-api/retrieval-policy'
import type { ComparablesSearchParams } from '../src/services/property-api/types'
import type { NormalizedComparable, NormalizedProperty } from '../src/services/property-api/types'
import type { AppraisalFilter } from '../src/services/appraisal/types'
import type { Env } from '../src/types'

const daysAgo = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

// ─── Provider-mock plumbing ───────────────────────────────────────────────────

const rawComp = (i: number) => ({
  clip: `clip-${i}`,
  streetAddress: `${100 + i} Comp Rd`,
  city: 'Tampa',
  state: 'FL',
  zip: '33607',
  latitude: 27.95,
  longitude: -82.45,
  bedrooms: 3,
  baths: 2,
  buildingSquareFeet: 1500,
  lotSquareFeet: 8000,
  yearBuilt: '1990',
  salePrice: 300000 + i * 1000,
  saleDate: daysAgo(60),
  distance: 0.1 + i * 0.01,
  pricePerSquareFoot: 200,
})

const urls: URL[] = []
const originalFetch = globalThis.fetch
const env = {
  PROPERTY_PROVIDER: 'corelogic',
  CORELOGIC_CLIENT_ID: 'synthetic',
  CORELOGIC_CLIENT_SECRET: 'synthetic',
  API_CACHE: { get: async () => null, put: async () => undefined },
} as unknown as Env

function mockProvider(compCount: number) {
  urls.length = 0
  globalThis.fetch = async (input, init) => {
    if (init?.method === 'POST') return Response.json({ access_token: 't', expires_in: 3600 })
    urls.push(new URL(String(input)))
    return Response.json({ comparables: Array.from({ length: compCount }, (_, i) => rawComp(i)) })
  }
}

// ─── 1 + 4: pool breadth and truncation audit ────────────────────────────────

mockProvider(60)
try {
  const api = createPropertyApi(env)
  const params: ComparablesSearchParams = { propertyId: 'fixture', radiusMiles: 1, monthsBack: 12, maxComps: 100 }
  const res = await api.getComparables(params)
  assert.equal(res.success, true)
  assert.equal(res.data.comparables.length, 60, 'pool admits >25 candidates')
  assert.equal(urls[0].searchParams.get('maxComps'), '100')
  assert.equal(res.data.retrieval?.candidateLimitEffective, 100)
  assert.equal(res.data.retrieval?.providerCandidatesReceived, 60)
  assert.equal(res.data.retrieval?.providerTruncated, false, '60 < 100 is not truncated')
  assert.equal(res.data.retrieval?.pagesRequested, 1, 'endpoint has no pagination')
} finally {
  globalThis.fetch = originalFetch
}

mockProvider(100)
try {
  const api = createPropertyApi(env)
  const res = await api.getComparables({ propertyId: 'fixture2', radiusMiles: 1, monthsBack: 12, maxComps: 100 })
  assert.equal(res.success, true)
  assert.equal(res.data.retrieval?.providerTruncated, true, 'full-window response infers truncation')
  assert.equal(res.data.retrieval?.providerCandidatesReported, null, 'provider exposes no total count')
} finally {
  globalThis.fetch = originalFetch
}

// Limit resolution: provider max is authoritative, env/requests only narrow it.
assert.equal(resolveCandidateLimit({} as Env, 'corelogic'), 100)
assert.equal(resolveCandidateLimit({ COMPARABLE_CANDIDATE_LIMIT: '50' } as Env, 'corelogic'), 50)
assert.equal(resolveCandidateLimit({ COMPARABLE_CANDIDATE_LIMIT: '500' } as Env, 'corelogic'), 100)
assert.equal(resolveCandidateLimit({} as Env, 'corelogic', 25), 25)
assert.equal(CORELOGIC_MAX_COMPS, 100)

// ─── 2 + 3: deep candidate reaches ARV selection; order is irrelevant ────────

const subject: NormalizedProperty = {
  id: 'subj', provider: 'corelogic', address: '1 Subject St', city: 'Tampa',
  state: 'FL', zipCode: '33607', latitude: 27.95, longitude: -82.45,
  bedrooms: 3, bathrooms: 2, squareFeet: 1500, lotSizeAcres: null,
  lotSizeSquareFeet: 8000, yearBuilt: 1990, propertyType: 'Single Family Residence',
  stories: 1, subdivision: 'Oak Park', lastSalePrice: null, lastSaleDate: null,
  assessedValue: null, marketValue: null, taxAmount: null,
}

const mkComp = (id: string, over: Partial<NormalizedComparable>): NormalizedComparable => ({
  id, provider: 'corelogic', address: `${id} Rd`, city: 'Tampa', state: 'FL',
  zipCode: '33607', latitude: 27.95, longitude: -82.45, distanceMiles: 0.5,
  bedrooms: 3, bathrooms: 2, squareFeet: 1500, lotSizeAcres: null,
  lotSizeSquareFeet: 8000, yearBuilt: 1990, propertyType: 'Single Family Residence',
  salePrice: 300000, saleDate: daysAgo(60), pricePerSqft: 200,
  subdivision: 'Oak Park', ...over,
})

const filters: AppraisalFilter[] = [
  { type: 'sale_age', enabled: true, value: 180 },
  { type: 'sqft_diff', enabled: true, value: 250 },
  { type: 'distance', enabled: true, value: 1.0 },
]

// 40-comp pool — impossible under the old 25 cap. Highest-priced comp sits at
// index 35 (position 36 in provider order) and is also the nearest.
const pool: NormalizedComparable[] = []
for (let i = 0; i < 40; i++) {
  pool.push(mkComp(`c-${i}`, { salePrice: 300000 - i * 1000, distanceMiles: 0.9 - i * 0.01 }))
}
pool[35] = mkComp('deep-high', { salePrice: 400000, distanceMiles: 0.1, saleDate: daysAgo(30) })
pool[0] = mkComp('band-2', { salePrice: 390000, distanceMiles: 0.2, saleDate: daysAgo(30) })
pool[1] = mkComp('band-3', { salePrice: 380000, distanceMiles: 0.3, saleDate: daysAgo(30) })

const service = createAppraisalService()
const r1 = service.evaluateWithFallback(subject, pool, { filters, adjustments: [], expansion: { enabled: false } })
assert.equal(r1.fallbackUsed, 'none')
assert.ok((r1.selectedCompIds ?? []).includes('deep-high'), 'position-36 candidate reaches ARV selection')
// ARV = mean(adjusted PPSF) x subject sqft — 400000/1500, 390000/1500, 380000/1500
assert.equal(r1.arv, Math.round(((400000 + 390000 + 380000) / 1500 / 3) * 1500))

// Deterministic shuffle (fixed seed) — selection must not depend on pool order.
const shuffled = [...pool]
let seed = 42
for (let i = shuffled.length - 1; i > 0; i--) {
  seed = (seed * 1103515245 + 12345) % 2147483648
  const j = seed % (i + 1)
  ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
}
const r2 = service.evaluateWithFallback(subject, shuffled, { filters, adjustments: [], expansion: { enabled: false } })
assert.deepEqual(new Set(r2.selectedCompIds), new Set(r1.selectedCompIds), 'shuffled pool selects same comps')
assert.equal(r2.arv, r1.arv, 'retrieval order does not change ARV')

// ─── 5: radius-bound expansion requires a real refetch ───────────────────────

// Radius-bound tiers → refetch radius; in-radius tiers → no refetch.
assert.equal(expansionRefetchRadius('subdivision_expansion', 1, 2), 2)
assert.equal(expansionRefetchRadius('geographic_expansion', 1, 2), 2)
assert.equal(expansionRefetchRadius('insufficient', 1, 2), 2)
assert.equal(expansionRefetchRadius('nearest_comps', 1, 2), 2)
assert.equal(expansionRefetchRadius('none', 1, 2), null)
assert.equal(expansionRefetchRadius('year_built_expansion', 1, 2), null)
assert.equal(expansionRefetchRadius('neighborhood_expansion', 1, 2), null)
assert.equal(expansionRefetchRadius('subdivision_expansion', 1, 2, 3), 3, 'env override wins')

// Refetched pool merges conflict-aware, without dropping candidates.
const merged = mergeComparablePools(pool.slice(0, 3), [pool[1], mkComp('wide-1', { distanceMiles: 1.5 })])
assert.equal(merged.comparables.length, 4, 'merge keeps overlap + new candidates')
assert.equal(merged.conflictIds.length, 0)

// ─── 6: bigger pool does not mean paid enrichment for every candidate ────────

const thresholds = { saleAgeDays: 180, sqftDiff: 250, maxYearDiff: 14 }
const now = Date.now()
assert.equal(isProvablyDeadComp(mkComp('old', { saleDate: daysAgo(200) }), subject, thresholds, now), true, 'verifiably stale sale is dead')
assert.equal(isProvablyDeadComp(mkComp('big', { squareFeet: 3000 }), subject, thresholds, now), true, 'verifiable sqft breach is dead')
assert.equal(isProvablyDeadComp(mkComp('old-year', { yearBuilt: 1960 }), subject, thresholds, now), true, 'year beyond widest tolerance is dead')
assert.equal(isProvablyDeadComp(mkComp('missing', { saleDate: null, squareFeet: null, yearBuilt: null }), subject, thresholds, now), false, 'missing data is not disqualification')
assert.equal(isProvablyDeadComp(mkComp('far', { distanceMiles: 3 }), subject, thresholds, now), false, 'distance is rescuable — not a dead-comp rule')
assert.equal(isProvablyDeadComp(mkComp('ok', {}), subject, thresholds, now), false)

// Simulated 60-comp pool: 10 dead → 50 enrichments, not 60.
const bigPool = Array.from({ length: 60 }, (_, i) =>
  mkComp(`p-${i}`, { saleDate: daysAgo(i < 10 ? 200 : 60) }))
const enrichable = bigPool.filter((c) => !isProvablyDeadComp(c, subject, thresholds, now))
assert.equal(enrichable.length, 50, 'only provably-live candidates get paid enrichment')

// ─── 7: vintage-subject year cap (pre-1970 fallback) ─────────────────────────

// 1949 subject — nothing within the ±10/±12/±14 ladder, but comps built
// ≤1970 qualify at the vintage tier (one-sided cap — 1920 is admissible).
const vintageSubject: NormalizedProperty = { ...subject, yearBuilt: 1949 }
const vintageFilters: AppraisalFilter[] = [
  ...filters,
  { type: 'year_built_diff', enabled: true, value: 10 },
  { type: 'vintage_year_cap', enabled: true, value: 1970, priority: 'soft' },
]
const vintagePool = [
  mkComp('v-64', { yearBuilt: 1964, salePrice: 210000 }),
  mkComp('v-68', { yearBuilt: 1968, salePrice: 200000 }),
  mkComp('v-20', { yearBuilt: 1920, salePrice: 150000 }),
  mkComp('v-75', { yearBuilt: 1975, salePrice: 999999 }),
]
const vr = service.evaluateWithFallback(vintageSubject, vintagePool, { filters: vintageFilters, adjustments: [] })
assert.equal(vr.insufficientComps, false, 'vintage tier fills the pool')
assert.equal(vr.fallbackUsed, 'year_built_expansion')
const v20 = vr.comparables.find((c) => c.id === 'v-20')
assert.equal(v20?.isEnabled, true, 'cap admits any ≤1970 build — however old')
assert.ok(
  v20?.evaluation?.filterResults.some((f) => f.type === 'year_built_cap' && f.passed === true),
  'admission is audited as a passed year_built_cap row'
)
// Eligible ≠ selected: the cheapest vintage comp can still fall outside
// the top-of-market ARV band — eligibility is what the cap governs.
assert.equal(v20?.arvStatus, 'not_examined')
const v75 = vr.comparables.find((c) => c.id === 'v-75')
assert.equal(v75?.isEnabled, false, 'post-cap comp stays disqualified')
assert.ok(
  v75?.evaluation?.filterResults.some((f) => f.type === 'year_built_cap' && f.passed === false),
  'post-cap failure is audited as year_built_cap'
)

// The rule is strictly for pre-cap stock: a 1975 subject never reaches
// the vintage tier — same pool stays insufficient.
const modernSubject: NormalizedProperty = { ...subject, yearBuilt: 1975 }
const modernPool = [
  mkComp('m-90a', { yearBuilt: 1990 }),
  mkComp('m-90b', { yearBuilt: 1990 }),
  mkComp('m-90c', { yearBuilt: 1990 }),
]
const mr = service.evaluateWithFallback(modernSubject, modernPool, { filters: vintageFilters, adjustments: [] })
assert.equal(mr.insufficientComps, true, 'vintage cap never applies to post-cap subjects')

// Disabled config row → no vintage tier, identical vintage pool is insufficient.
const vrOff = service.evaluateWithFallback(vintageSubject, vintagePool, {
  filters: vintageFilters.map((f) =>
    f.type === 'vintage_year_cap' ? { ...f, enabled: false } : f
  ),
  adjustments: [],
})
assert.equal(vrOff.insufficientComps, true, 'disabling the row disables the tier')

// Pruning honors the cap one-sidedly for pre-cap subjects.
const vintageThresholds = { saleAgeDays: 548, sqftDiff: 250, maxYearDiff: 14, vintageYearCap: 1970 }
assert.equal(isProvablyDeadComp(mkComp('pv-65', { yearBuilt: 1965 }), vintageSubject, vintageThresholds, now), false, '≤cap comp is enrichable')
assert.equal(isProvablyDeadComp(mkComp('pv-20', { yearBuilt: 1920 }), vintageSubject, vintageThresholds, now), false, 'any pre-cap year is enrichable — one-sided')
assert.equal(isProvablyDeadComp(mkComp('pv-75', { yearBuilt: 1975 }), vintageSubject, vintageThresholds, now), true, 'post-cap comp is provably dead')
assert.equal(isProvablyDeadComp(mkComp('pv-60', { yearBuilt: 1960 }), modernSubject, vintageThresholds, now), true, 'post-cap subjects keep the symmetric bound')

console.log('Comparable retrieval: pool breadth, deep-candidate selection, order invariance, truncation audit, expansion refetch, enrichment pruning, vintage year cap — all passed')
