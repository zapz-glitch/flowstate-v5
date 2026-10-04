import assert from 'node:assert/strict'
import { createAppraisalService } from '../src/services/appraisal'
import { pocketValueEquivalent, subjectPocketRefPpsf } from '../src/services/appraisal/evaluator'
import type { NormalizedProperty, NormalizedComparable } from '../src/services/property-api/types'

/**
 * Rural rule — when the geo tiers exhaust (no tract, block, or
 * neighborhood match — probably rural), a far comp is still selectable
 * when ITS pocket trades at the subject's pocket level. Subject pocket
 * ref order: renovated-tier pool median → scope medians → AVM/sqft.
 *
 * How this can fail:
 *  1. A far comp whose pocket is value-equivalent must be rescuable.
 *  2. A far comp whose pocket trades at a different level must not be.
 *  3. The check reads the comp's POCKET ref (scope medians), falling back
 *     to its own sale $/sf — never the subject's attributes.
 *  4. When the subject has no computable ref, radius behavior is
 *     preserved (unverifiable ≠ divergent).
 *  5. nearest_comps applies the same gate — selection is gated, not just
 *     the rescue tiers.
 */

const daysAgo = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

// Rural subject — no census tract, no scope medians. AVM $300k / 1500sf
// gives a $200/sf pocket ref via the AVM floor.
const subject: NormalizedProperty = {
  id: 'subj-1', provider: 'test', address: '100 Subject Rd',
  city: 'Plains', state: 'TX', zipCode: '70001',
  bedrooms: 3, bathrooms: 2, squareFeet: 1500, lotSizeSquareFeet: 20000,
  yearBuilt: 1990, propertyType: 'Single Family Residence', stories: 1,
  subdivision: 'Oak Park', neighborhoodName: 'Riverside',
  avmValue: 300000,
  latitude: 31.0, longitude: -97.0,
} as NormalizedProperty

const comp = (id: string, over: Partial<NormalizedComparable>) => ({
  id, provider: 'test', address: `${id} Comp Rd`,
  city: 'Plains', state: 'TX', zipCode: '70001',
  latitude: 31.0, longitude: -97.0, distanceMiles: 0.4,
  bedrooms: 3, bathrooms: 2, squareFeet: 1500, lotSizeSquareFeet: 19000,
  yearBuilt: 1990, propertyType: 'Single Family Residence',
  salePrice: 300000, saleDate: daysAgo(60), pricePerSqft: 200,
  raw: { salePrice: 300000, saleDate: daysAgo(60), isSale: true },
  ...over,
} as NormalizedComparable)

// 1. Pure function — equivalence reads the comp's pocket ref.
assert.equal(subjectPocketRefPpsf(subject, []), 200, 'AVM/sqft floor when no pool or medians')
assert.equal(pocketValueEquivalent(200, comp('x', { ppsfMedians: { SD: 195 } })), true)
assert.equal(pocketValueEquivalent(200, comp('x', { ppsfMedians: { SD: 175 } })), true, 'within ±15%')
assert.equal(pocketValueEquivalent(200, comp('x', { ppsfMedians: { SD: 320 } })), false)
assert.equal(pocketValueEquivalent(200, comp('x', { salePrice: 330000 })), true, 'own $/sf fallback (220/sf)')
assert.equal(pocketValueEquivalent(null, comp('x', { ppsfMedians: { SD: 195 } })), false)

// 2. Rescue — 3 far comps, all name-labels fail, pocket-equivalent.
{
  const svc = createAppraisalService()
  const pool = [
    comp('r1', { subdivision: 'Prairie View', neighborhoodName: 'Eastside', distanceMiles: 2.5, ppsfMedians: { SD: 195 } }),
    comp('r2', { subdivision: 'Prairie View', neighborhoodName: 'Eastside', distanceMiles: 2.5, ppsfMedians: { SD: 200 } }),
    comp('r3', { subdivision: 'Prairie View', neighborhoodName: 'Eastside', distanceMiles: 2.5, ppsfMedians: { SD: 205 } }),
  ]
  const r = svc.evaluateWithFallback(subject, pool)
  assert.equal(r.fallbackUsed, 'geographic_expansion', `expected geographic_expansion, got ${r.fallbackUsed}`)
  assert.equal(r.comparables.filter((c) => c.isEnabled).length, 3)
}

// 3. Divergent pockets are NOT rescued — a different-priced market is a
//    different market, whatever the distance.
{
  const svc = createAppraisalService()
  const pool = [
    comp('d1', { subdivision: 'Prairie View', neighborhoodName: 'Eastside', distanceMiles: 2.5, salePrice: 480000, ppsfMedians: { SD: 320 } }),
    comp('d2', { subdivision: 'Prairie View', neighborhoodName: 'Eastside', distanceMiles: 2.5, salePrice: 480000, ppsfMedians: { SD: 320 } }),
    comp('d3', { subdivision: 'Prairie View', neighborhoodName: 'Eastside', distanceMiles: 2.5, salePrice: 480000, ppsfMedians: { SD: 320 } }),
  ]
  const r = svc.evaluateWithFallback(subject, pool)
  assert.equal(r.fallbackUsed, 'insufficient', `expected insufficient, got ${r.fallbackUsed}`)
}

// 4. Unverifiable ref keeps the old radius behavior — no AVM, no medians,
//    no pool → can't prove inequivalence, so don't exclude.
{
  const noRefSubject = { ...subject, avmValue: null, ppsfMedians: null } as NormalizedProperty
  const svc = createAppraisalService()
  const pool = [
    comp('u1', { subdivision: 'Prairie View', neighborhoodName: 'Eastside', distanceMiles: 2.5, salePrice: 480000, ppsfMedians: { SD: 320 } }),
    comp('u2', { subdivision: 'Prairie View', neighborhoodName: 'Eastside', distanceMiles: 2.5, salePrice: 480000, ppsfMedians: { SD: 320 } }),
    comp('u3', { subdivision: 'Prairie View', neighborhoodName: 'Eastside', distanceMiles: 2.5, salePrice: 480000, ppsfMedians: { SD: 320 } }),
  ]
  const r = svc.evaluateWithFallback(noRefSubject, pool)
  assert.equal(r.fallbackUsed, 'geographic_expansion',
    `unverifiable ref should preserve radius rescue, got ${r.fallbackUsed}`)
}

console.log('rural-pocket: pocket-value equivalence gate — rescues equivalent, rejects divergent, preserves unverifiable')
