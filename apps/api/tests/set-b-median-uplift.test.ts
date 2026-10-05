import assert from 'node:assert/strict'
import { evaluateB } from '@flowstate-api/shared/appraisal'

/**
 * Median-only evidence — owner rule (f01f326): the band IS the answer.
 * The AVM is removed from the ARV path entirely; it carries no weight.
 *
 * How this can fail:
 *  1. Median-only pool + AVM above ceiling → ARV stays at the ceiling
 *     (no uplift — the pocket's own maintained sales are the evidence).
 *  2. AVM below the ceiling → same ceiling, unchanged.
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
  // Ceiling $240k, AVM $300k → AVM ignored, ARV = 240.
  const res = evaluateB(subject, [medianComp('1 Median St', 240000)])
  assert.equal(res.arv, 240000, `expected median ceiling → 240k, got ${res.arv}`)
  assert.equal(res.source, 'T0 anchor')
}

{
  // AVM below the ceiling → ceiling stands.
  const res = evaluateB({ ...subject, avmValue: 200000 }, [medianComp('1 Median St', 240000)])
  assert.equal(res.arv, 240000)
}

console.log('set-b-median-uplift: median ceiling stands — AVM carries no weight in the ARV path')
