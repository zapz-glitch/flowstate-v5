/**
 * Set-B trick 13 — the true neighborhood median (owner, 2026-10-28). Price
 * is the main evidence: a comp is at, above or below market against the
 * neighborhood's median $/sf. The median leaves out paper transfers
 * ($100 deeds, package and bulk sales) and $/sf outliers, and reads the
 * last 90 days first — 180, then 365, only when 90 is too thin.
 */
import assert from 'node:assert/strict'
import { bTrueMedian, type BComp, type BSubject } from '@flowstate-api/shared/appraisal'

const subject: BSubject = { squareFeet: 1500, censusTract: 'T1', subdivision: 'PINES' }
let n = 0
const sale = (ppsf: number, saleDate: string, over: Partial<BComp> = {}): BComp => ({
  id: String(++n), address: `${n} Main St`, isEnabled: true, squareFeet: 1000, salePrice: ppsf * 1000,
  saleDate, censusTract: 'T1', ...over,
})

// Six clean 90-day sales; a $100 deed and a $600/sf outlier are left out.
{
  const items = [
    sale(190, '2026-10-01'), sale(195, '2026-09-20'), sale(200, '2026-09-10'),
    sale(205, '2026-08-30'), sale(210, '2026-08-15'), sale(215, '2026-08-01'),
    sale(0.1, '2026-09-01'),                                         // $100 deed
    sale(400, '2026-09-05', { evidenceVerification: { transactionCheck: 'package_deed' } as never }),
    sale(600, '2026-09-25'),                                         // outlier
    sale(150, '2026-03-01'),                                         // outside 90 days
  ]
  const m = bTrueMedian(subject, items)!
  assert.equal(m.windowDays, 90)
  assert.equal(m.scope, 'tract')
  assert.equal(m.n, 6)
  assert.equal(m.ppsf, 205)
  assert.equal(m.dropped, 3, '$100 deed, package deed, $/sf outlier')
}

// Too thin at 90 days → 180.
{
  const items = [sale(300, '2026-10-01'), sale(310, '2026-09-01'), sale(290, '2026-08-01'),
    sale(305, '2026-06-01'), sale(295, '2026-05-01')]
  const m = bTrueMedian(subject, items)!
  assert.equal(m.windowDays, 180)
  assert.equal(m.n, 5)
}

// Tract too thin at every window → wider scope; nothing anywhere → null.
{
  const other = (p: number, d: string) => sale(p, d, { censusTract: 'T9' })
  const items = [sale(100, '2026-10-01'), other(120, '2026-10-02'), other(125, '2026-09-20'),
    other(130, '2026-09-10'), other(135, '2026-09-01'), other(140, '2026-08-20')]
  const m = bTrueMedian(subject, items)!
  assert.equal(m.scope, 'nearby')
  assert.equal(m.windowDays, 90)
  assert.equal(bTrueMedian(subject, [sale(100, '2026-10-01'), sale(110, '2026-09-01')]), null)
  assert.equal(bTrueMedian(subject, [sale(100, '2026-10-01', { saleDate: null })]), null, 'undated sales cannot be placed in a window')
}

console.log('set-b true median: passed')
