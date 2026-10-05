import assert from 'node:assert/strict'
import { verifyCompEvidence } from '../src/services/appraisal/verification'

const daysAgo = (days: number) => new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)
const subject = { address: '1 Subject St', squareFeet: 1200 } as never
const comp = (saleDate: string | null, salePrice: number, squareFeet = 1000) => ({
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

console.log('evidence-verification: sale age and pocket price are separate checks')
