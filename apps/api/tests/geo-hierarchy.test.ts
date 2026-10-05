import assert from 'node:assert/strict'
import { evaluateB } from '@flowstate-api/shared/appraisal'
import { createAppraisalService } from '../src/services/appraisal'
import type { NormalizedProperty, NormalizedComparable } from '../src/services/property-api/types'

/**
 * Geo hierarchy — the owner rule: tract 1st, block 2nd, neighborhood 3rd,
 * in every phase (first pass and every retry tier), for every comp class.
 *
 * How this can fail:
 *  1. A neighborhood-name match must never outrank a same-tract comp.
 *  2. A tract+block-group comp (nested pocket) ranks above tract-only.
 *  3. Block-group alone (tract data missing) still beats neighborhood.
 *  4. The grid ladder rescues pocket members (tract OR block) before it
 *     ever tries neighborhood-name matching.
 *  5. Non-pocket comps stay disabled at the pocket tier.
 */

const daysAgo = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

// ── Set-B similarity ordering ────────────────────────────────────────────

const bSubject = {
  squareFeet: 1500, yearBuilt: 1990, censusTract: 'T1',
  subdivision: 'Oak Park', neighborhoodName: 'Riverside',
  avmValue: 300000,
}

const bComp = (address: string, geo: Record<string, unknown>) => ({
  isEnabled: true,
  address,
  salePrice: 300000, saleDate: '2026-06-01',
  squareFeet: 1500, distanceMiles: 0.5, yearBuilt: 1990,
  classification: { type: 'renovated' },
  curbAppeal: { condition: 'renovated', confidence: 80 },
  subdivision: 'Other Sub',
  ...geo,
})

{
  const res = evaluateB(bSubject, [
    bComp('1 Tract Ln', { censusTract: 'T1' }),
    bComp('2 Hood Blvd', { censusTract: 'T9', neighborhoodName: 'Riverside' }),
    bComp('3 Block Ct', { censusTract: 'T1', sameBlockGroup: true }),
  ])
  assert.equal(res.anchorAddress, '3 Block Ct',
    'tract+block pocket member anchors above tract-only and neighborhood-only')
  assert.ok(res.drivers.some((d) => d.comp.address === '1 Tract Ln'),
    'tract-only comp stays a driver')
  assert.ok(!res.drivers.some((d) => d.comp.address === '2 Hood Blvd'),
    'neighborhood-only comp is gated out of drivers')
}

{
  // Without the nested member, tract-only still beats the name match.
  const res = evaluateB(bSubject, [
    bComp('1 Tract Ln', { censusTract: 'T1' }),
    bComp('2 Hood Blvd', { censusTract: 'T9', neighborhoodName: 'Riverside' }),
  ])
  assert.equal(res.anchorAddress, '1 Tract Ln')
}

{
  // Block group with no tract data still outranks a name match.
  const res = evaluateB(bSubject, [
    bComp('4 Block Only', { sameBlockGroup: true }),
    bComp('2 Hood Blvd', { censusTract: 'T9', neighborhoodName: 'Riverside' }),
  ])
  assert.equal(res.anchorAddress, '4 Block Only')
}

// ── Grid ladder — pocket tier before neighborhood ────────────────────────

const subject: NormalizedProperty = {
  id: 'subj-1', provider: 'test', address: '100 Subject St',
  city: 'Tampa', state: 'FL', zipCode: '33607',
  bedrooms: 3, bathrooms: 2, squareFeet: 1500, lotSizeSquareFeet: 8000,
  yearBuilt: 1990, propertyType: 'Single Family Residence', stories: 1,
  subdivision: 'Oak Park', neighborhoodName: 'Riverside',
  censusTract: 'T1', censusBlockGroup: 'BG1',
  latitude: 27.95, longitude: -82.45,
} as NormalizedProperty

const nComp = (id: string, over: Partial<NormalizedComparable>) => ({
  id, provider: 'test', address: `${id} Comp Rd`,
  city: 'Tampa', state: 'FL', zipCode: '33607',
  latitude: 27.95, longitude: -82.45, distanceMiles: 0.4,
  bedrooms: 3, bathrooms: 2, squareFeet: 1500, lotSizeSquareFeet: 8100,
  yearBuilt: 1990, propertyType: 'Single Family Residence',
  salePrice: 300000, saleDate: daysAgo(60), pricePerSqft: 200,
  raw: { salePrice: 300000, saleDate: daysAgo(60), isSale: true },
  ...over,
} as NormalizedComparable)

{
  const svc = createAppraisalService()
  const pool = [
    // Different subdivision AND neighborhood name — fails the name-label
    // filters — but inside the subject's tract. Pocket tier must rescue.
    nComp('p1', { subdivision: 'Maple Glen', neighborhoodName: 'Eastside', censusTract: 'T1' }),
    nComp('p2', { subdivision: 'Maple Glen', neighborhoodName: 'Eastside', censusTract: 'T1' }),
    nComp('p3', { subdivision: 'Maple Glen', neighborhoodName: 'Eastside', censusTract: 'T1' }),
    // A neighborhood-name match outside the pocket — must NOT be rescued
    // at the pocket tier.
    nComp('n1', { subdivision: 'Maple Glen', neighborhoodName: 'Riverside', censusTract: 'T9' }),
  ]
  const r = svc.evaluateWithFallback(subject, pool)
  // Census geography decides "same area" (docs/FILTER-LADDER.md): the three
  // same-tract comps pass the strict rules outright — name labels only rank
  // — and the other-tract comp is out, whatever its neighborhood name says.
  assert.equal(r.fallbackUsed, 'none', `same-tract comps need no rescue, got ${r.fallbackUsed}`)
  const enabled = r.comparables.filter((c) => c.isEnabled).map((c) => c.id).sort()
  assert.deepEqual(enabled, ['p1', 'p2', 'p3'],
    'only tract members pass — a neighborhood-name match in another tract waits for the ladder to widen the area')
}

console.log('geo-hierarchy: tract-first similarity, nested-pocket ranking, pocket-tier rescue order passed')
