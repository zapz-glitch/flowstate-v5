/**
 * Set-B trick 13 — price picks the comp's class against the true
 * neighborhood median; condition is supporting evidence (owner,
 * 2026-10-28). Above market → ARV evidence; at market → median tier;
 * below market → as-is, never ARV; over 145% or under 70% of the median →
 * outside the market, never a driver — a price label or a condition read
 * cannot excuse it. 6312 Fairway Blvd (+81%) anchored on a sale at 254%.
 */
import assert from 'node:assert/strict'
import { evaluateB, type BComp, type BSubject } from '@flowstate-api/shared/appraisal'

const subject: BSubject = { squareFeet: 1000, yearBuilt: 1990, censusTract: 'T1' }
let n = 0
const sale = (ppsf: number, over: Partial<BComp> = {}): BComp => ({
  id: String(++n), address: `${n} Main St`, isEnabled: true, squareFeet: 1000, salePrice: ppsf * 1000,
  saleDate: '2026-09-15', censusTract: 'T1', distanceMiles: 0.2, yearBuilt: 1990, ...over,
})
const market = () => [sale(195), sale(198), sale(200), sale(202), sale(205)]
const read = (condition: string) => ({ curbAppeal: { condition, confidence: 80 } })
const priceTop = { classification: { type: 'after_renovation', method: 'evidence_price_group' } }

// Above market drives; a 160% sale is outside the market even with a
// "top price group" label and a renovated read.
{
  const above = sale(240, { address: 'above' })
  const extreme = sale(320, { address: 'extreme', ...priceTop, ...read('renovated') })
  const r = evaluateB(subject, [...market(), above, extreme])
  assert.deepEqual(r.drivers.map((x) => x.comp.address), ['above'])
  assert.equal(r.arv, 240_000)
  assert.ok(r.flags.some((f) => f.startsWith('extreme: outside the market')))
  assert.ok(r.flags.some((f) => f.startsWith('market: 90-day tract median $202/sf')))
}

// Condition supports price — among above-market sales the renovated read
// anchors over a dated read listed first.
{
  const dated = sale(240, { address: 'dated', ...read('dated') })
  const renovated = sale(250, { address: 'renovated', ...read('renovated') })
  const plain = sale(245, { address: 'plain' })
  const r = evaluateB(subject, [...market(), dated, renovated, plain])
  assert.equal(r.anchorAddress, 'renovated')
}

// No above-market evidence — at-market sales carry; below market never does.
{
  const below = sale(170, { address: 'below', ...read('renovated') })
  const r = evaluateB(subject, [...market(), below])
  assert.ok(r.drivers.length > 0)
  assert.ok(!r.drivers.some((x) => x.comp.address === 'below'))
  assert.ok(r.flags.some((f) => f.includes('median-tier driver')))
}

console.log('set-b market position: passed')

// A flip is only ARV evidence when it resold at or above the median — a
// budget flip (bought distressed, light work, resold below market) is
// as-is evidence (owner, 2026-10-28; 5 of 5 big overshoots in the flip
// backtest were budget flips).
{
  const flip = (ppsf: number, address: string) => sale(ppsf, { address, classification: { type: 'after_renovation', method: 'evidence_flip_chain' } })
  const budget = flip(170, 'budget flip')
  const r = evaluateB(subject, [...market(), budget])
  assert.ok(!r.drivers.some((x) => x.comp.address === 'budget flip'), 'below-market flip never drives')
  const arvFlip = flip(235, 'arv flip')
  const r2 = evaluateB(subject, [...market(), arvFlip])
  assert.deepEqual(r2.drivers.map((x) => x.comp.address), ['arv flip'])
}

console.log('set-b flip class: passed')
