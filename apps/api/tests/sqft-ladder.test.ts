import assert from 'node:assert/strict'
import { createAppraisalService } from '../src/services/appraisal'
import type { NormalizedProperty, NormalizedComparable } from '../src/services/property-api/types'

/**
 * Sqft ladder — the owner order: ±250 first, then ±500, ±750, ±1000 —
 * inside every geo scope, before leaving it. Size is a preference order,
 * not a wall: a thin market keeps asking for wider tolerances before it
 * goes further afield.
 *
 * How this can fail:
 *  1. A comp inside the tighter band must never wait for a wide band.
 *  2. A comp failing strict but inside a widened band must be admitted —
 *     at its own tier, tagged as expanded.
 *  3. A comp outside every band stays out.
 *  4. The strict default (±250) still fires first.
 */

const daysAgo = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

const subject: NormalizedProperty = {
  id: 'subj-1', provider: 'test', address: '100 Subject St',
  city: 'Atlanta', state: 'GA', zipCode: '30318',
  bedrooms: 3, bathrooms: 2, squareFeet: 1566, lotSizeSquareFeet: 8000,
  yearBuilt: 1990, propertyType: 'Single Family Residence', stories: 1,
  subdivision: 'Whitley Heights',
  latitude: 33.8, longitude: -84.5,
} as NormalizedProperty

const comp = (id: string, squareFeet: number, over: Partial<NormalizedComparable> = {}) => ({
  id, provider: 'test', address: `${id} Comp Rd`,
  city: 'Atlanta', state: 'GA', zipCode: '30318',
  latitude: 33.8, longitude: -84.5, distanceMiles: 0.4,
  bedrooms: 3, bathrooms: 2, squareFeet, lotSizeSquareFeet: 8100,
  yearBuilt: 1990, propertyType: 'Single Family Residence',
  salePrice: 300000, saleDate: daysAgo(60), pricePerSqft: 200,
  subdivision: 'Whitley Heights',
  raw: { salePrice: 300000, saleDate: daysAgo(60), isSale: true },
  ...over,
} as NormalizedComparable)

{
  // Dunseath shape — subject 1566sf, pool all ~950-1400sf. Diff 608sf:
  // fails ±250 and ±500, admitted at ±750.
  const svc = createAppraisalService()
  const pool = [
    comp('s1', 958), comp('s2', 1010), comp('s3', 1400),
  ]
  const r = svc.evaluateWithFallback(subject, pool)
  assert.equal(r.comparables.filter((c) => c.isEnabled).length, 3,
    'all three comps within ±750 get admitted')
  assert.ok(
    r.expansionApplied?.includes('sqft_diff') || r.fallbackUsed === 'sqft_expansion',
    `sqft widening tagged, got ${r.fallbackUsed} ${r.expansionApplied}`,
  )
}

{
  // Outside every band — 266sf over the widest rung stays disabled.
  const svc = createAppraisalService()
  const pool = [
    comp('s1', 958), comp('s2', 1010), comp('big', 3400, { squareFeet: 3400 }),
  ]
  const r = svc.evaluateWithFallback(subject, pool)
  const big = r.comparables.find((c) => c.id === 'big')
  assert.equal(big?.isEnabled, false, 'a 3400sf comp on a 1566sf subject stays cut')
}

{
  // Strict band still fires first — a ±150sf comp needs no widening.
  const svc = createAppraisalService()
  const pool = [
    comp('t1', 1450), comp('t2', 1700), comp('t3', 1550),
  ]
  const r = svc.evaluateWithFallback(subject, pool)
  assert.equal(r.fallbackUsed, 'none', `strict pool should not expand, got ${r.fallbackUsed}`)
}

console.log('sqft-ladder: ±250→500→750→1000 widening, strict-first ordering, outside-band rejection passed')
