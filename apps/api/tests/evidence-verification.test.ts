import assert from 'node:assert/strict'
import { bulkSaleIds, packageDeedIds, verifyCompEvidence } from '../src/services/appraisal/verification'

const daysAgo = (days: number) => new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)
const subject = { address: '1 Subject St', squareFeet: 1200 } as never
const comp = (saleDate: string | null, salePrice: number, squareFeet = 1000, id = 'c1') => ({
  id,
  address: '2 Comp St',
  saleDate,
  salePrice,
  squareFeet,
  pricePerSqft: salePrice / squareFeet,
} as never)

// Recent but cheap: age is current; the separate market-fit check fails.
{
  const v = verifyCompEvidence(subject, comp(daysAgo(30), 60_000), 150, 180)
  assert.equal(v.saleAgeDays <= 31, true)
  assert.equal(v.staleness, 'current')
  assert.equal(v.marketFit, 'below_pocket')
  assert.ok(v.flags.some((f) => f.includes('below current pocket')))
  assert.ok(!v.flags.some((f) => f.toLowerCase().includes('stale')))
}

// Older than the preferred window: stale by age even when the price fits.
{
  const v = verifyCompEvidence(subject, comp(daysAgo(200), 150_000), 150, 180)
  assert.equal(v.staleness, 'stale')
  assert.equal(v.marketFit, 'in_range')
  assert.ok(v.flags.some((f) => f.includes('200 days')))
}

// Missing/invalid dates cannot claim freshness; premium evidence stays a
// market-fit check, not a stale label.
{
  const missing = verifyCompEvidence(subject, comp(null, 150_000), 150, 180)
  assert.equal(missing.staleness, 'unverified')
  assert.equal(missing.marketFit, 'in_range')

  const premium = verifyCompEvidence(subject, comp(daysAgo(20), 220_000), 150, 180)
  assert.equal(premium.staleness, 'current')
  assert.equal(premium.marketFit, 'above_pocket')
}

// Same-day, same-price deeds are package evidence, not independent comps.
{
  const day = daysAgo(20)
  const ids = packageDeedIds([
    comp(day, 747_000, 1000, 'a'),
    comp(day, 747_000, 1100, 'b'),
    comp(day, 260_000, 1000, 'c'),
  ])
  assert.deepEqual(ids, new Set(['a', 'b']))
  const v = verifyCompEvidence(subject, comp(day, 747_000), 250, 180, { packageDeed: true })
  assert.equal(v.transactionCheck, 'package_deed')
  assert.ok(v.flags.some((f) => f.toLowerCase().includes('package deed')))

  const extreme = verifyCompEvidence(subject, comp(daysAgo(20), 700_000), 250, 180)
  assert.equal(extreme.marketFit, 'above_pocket')
  assert.equal(extreme.transactionCheck, 'extreme_outlier')
  assert.ok(extreme.flags.some((f) => f.toLowerCase().includes('extreme outlier')))

  const bulkComps = [
    { ...comp(day, 747_000, 1000, 'b1'), transaction: { buyerNames: ['Portfolio Buyer LLC'] } },
    { ...comp(day, 921_000, 1200, 'b2'), transaction: { buyerNames: ['Portfolio Buyer LLC'] } },
    comp(day, 250_000, 1000, 'b3'),
  ]
  assert.deepEqual(bulkSaleIds(bulkComps), new Set(['b1', 'b2']))
  const bulk = verifyCompEvidence(subject, comp(day, 921_000), 250, 180, { bulkSale: true })
  assert.equal(bulk.transactionCheck, 'bulk_sale')
}

console.log('evidence-verification: sale age, pocket price, and transaction noise are separate checks')
