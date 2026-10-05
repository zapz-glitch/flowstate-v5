import assert from 'node:assert/strict'
import { evaluateB } from '@flowstate-api/shared/appraisal'

/**
 * Distressed and above-pocket comps are floor evidence — never drivers,
 * never ceiling members. Francis Ave proved it live: vision read
 * 'distressed' (tier:investor, 0.8/4) and verification stamped
 * above_pocket at 5.34×, yet it still sat in the median driver set and
 * set a $1.49M ceiling.
 *
 * How this can fail:
 *  1. A comp stamped above_pocket is value-divergent from the pocket —
 *     same class as stale/divergent. Out of verifiedPool entirely.
 *  2. Vision 'distressed' is not a median read — distressed comps can't
 *     anchor and can't join the driver set.
 *  3. Floor evidence still shows — it's bounded display evidence, not ARV.
 */

const subject = {
  squareFeet: 1566, yearBuilt: 1990, censusTract: 'T1',
  subdivision: 'Whitley Heights', avmValue: 300000,
}

const comp = (address: string, over: Record<string, unknown> = {}) => ({
  isEnabled: true, address,
  salePrice: 300000, saleDate: '2026-06-01',
  squareFeet: 1500, distanceMiles: 0.5, yearBuilt: 1990,
  censusTract: 'T1', subdivision: 'Whitley Heights',
  classification: { type: 'transitional' },
  curbAppeal: { condition: 'dated', confidence: 80 },
  ...over,
})

// Francis shape — a $1.4M sale stamped above_pocket + vision distressed.
const francis = comp('1854 Francis Ave NW', {
  salePrice: 1425000, squareFeet: 999, distanceMiles: 0.7,
  curbAppeal: { condition: 'distressed', confidence: 30, summary: 'Dated (0.8/4) · tier:investor' },
  evidenceVerification: { staleness: 'current', saleAgeDays: 20, marketFit: 'above_pocket', priceCheck: 'unverified' },
})

{
  const res = evaluateB(subject, [
    comp('1935 Sumter St NW', { salePrice: 400000 }),
    comp('1981 Sumter St NW', { salePrice: 350000 }),
    comp('1951 Sumter St NW', { salePrice: 380000 }),
    francis,
  ])
  const drivers = (res.drivers ?? []).map((d) => d.comp.address)
  assert.ok(!drivers.includes('1854 Francis Ave NW'), 'above_pocket comp cannot drive')
  assert.ok((res.ceiling ?? 0) < 500000, `ceiling must not count the outlier, got ${res.ceiling}`)
  assert.ok(res.arv != null && res.arv < 500000, `ARV stays in the real band, got ${res.arv}`)
}

{
  // Vision 'distressed' with a clean verification stamp still can't drive.
  const distressedOnly = comp('9 Ruin Rd', {
    salePrice: 180000,
    curbAppeal: { condition: 'distressed', confidence: 90 },
  })
  const res = evaluateB(subject, [
    comp('1935 Sumter St NW', { salePrice: 400000 }),
    distressedOnly,
  ])
  const drivers = (res.drivers ?? []).map((d) => d.comp.address)
  assert.ok(!drivers.includes('9 Ruin Rd'), 'distressed cannot drive')
}

console.log('set-b-distressed-floor: above_pocket and distressed reads are floor evidence only')

{
  // A verified-renovated comp above pocket explains its premium — stays
  // fit and can drive.
  const renovated = comp('7 Flip Ct', {
    salePrice: 450000,
    classification: { type: 'after_renovation' },
    curbAppeal: { condition: 'renovated', confidence: 85 },
    evidenceVerification: { staleness: 'current', saleAgeDays: 20, marketFit: 'above_pocket', priceCheck: 'unverified' },
  })
  const res = evaluateB(subject, [renovated])
  const drivers = (res.drivers ?? []).map((d) => d.comp.address)
  assert.ok(drivers.includes('7 Flip Ct'), 'verified-renovated above-pocket comp can drive')
}
