import assert from 'node:assert/strict'
import { evaluateB } from '@flowstate-api/shared/appraisal'

/**
 * Median-only uplift — owner rule: with no ARV evidence the AVM uplift is
 * half-trusted. ARV lands halfway between the median evidence ceiling and
 * the subject's AVM instead of jumping the full gap.
 *
 * How this can fail:
 *  1. Median-only pool + AVM above ceiling → 50% of the gap, not 100%.
 *  2. AVM at or below the ceiling → stays at the ceiling (no uplift to halve).
 *  3. Real ARV evidence → full answer, rule doesn't touch it.
 */

const subject = {
  squareFeet: 1500, yearBuilt: 1990, censusTract: 'T1',
  subdivision: 'Oak Park', avmValue: 300000,
}

const medianComp = (address: string, salePrice: number) => ({
  isEnabled: true, address,
  salePrice, saleDate: '2026-06-01',
  squareFeet: 1500, distanceMiles: 0.5, yearBuilt: 1990,
  censusTract: 'T1', subdivision: 'Oak Park',
  classification: { type: 'transitional' },
  curbAppeal: { condition: 'dated', confidence: 80 },
})

{
  // Ceiling $240k, AVM $300k → 240 + 0.5×(300−240) = 270.
  const res = evaluateB(subject, [medianComp('1 Median St', 240000)])
  assert.equal(res.arv, 270000, `expected 50% uplift → 270k, got ${res.arv}`)
  assert.equal(res.source, 'median+50% AVM uplift')
}

{
  // AVM below the ceiling → ceiling stands.
  const res = evaluateB({ ...subject, avmValue: 200000 }, [medianComp('1 Median St', 240000)])
  assert.equal(res.arv, 240000)
}

console.log('set-b-median-uplift: 50% uplift with no ARV evidence, ceiling floor preserved')
