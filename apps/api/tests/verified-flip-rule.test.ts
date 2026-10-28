/**
 * Verified flip — a buy → renovate → resell pair the A/B tests can trust as
 * ARV truth. Cases are real comps from saved Oct-2026 reports.
 */
import assert from 'node:assert/strict'
import { verifyFlip } from '../src/services/verified-flips'

const comp = (o: Record<string, unknown>) => ({ salePrice: null, saleDate: null, latestSale: null, flip: null, distressedSale: null, ...o })

// 4615 Webster St, Tampa — bought $150k, resold $299k 239 days later.
const webster = verifyFlip(comp({ salePrice: 299_000, saleDate: '2026-07-17',
  flip: { priorSalePrice: 150_000, priorSaleDate: '2025-11-20', daysHeld: 239, gainPct: 99.3 } }))
assert.equal(webster.verified, true)
assert.equal(webster.confidence, 'high')
assert.deepEqual([webster.buy, webster.sell, webster.daysHeld], [{ price: 150_000, date: '2025-11-20' }, { price: 299_000, date: '2026-07-17' }, 239])

// 2928 Banza St — modest +21% flip still counts.
assert.equal(verifyFlip(comp({ salePrice: 200_000, saleDate: '2026-08-24',
  flip: { priorSalePrice: 165_100, priorSaleDate: '2026-03-20', daysHeld: 157, gainPct: 21.1 } })).confidence, 'high')

// 2927 Banza St — the pool sale IS the buy leg and no resale is on hand.
const banza = verifyFlip(comp({ salePrice: 25_100, saleDate: '2025-12-29',
  flip: { priorSalePrice: 25_100, priorSaleDate: '2025-12-29', daysHeld: 198, gainPct: 856.2 } }))
assert.equal(banza.verified, false)
assert.match(banza.reasons.join(), /resale/)
// …with the resale in sales-history it verifies, but a $25k buy is not
// an arm's-length purchase we can trust → medium.
const banza2 = verifyFlip(comp({ salePrice: 25_100, saleDate: '2025-12-29', latestSale: { price: 240_000, date: '2026-07-15' },
  flip: { priorSalePrice: 25_100, priorSaleDate: '2025-12-29', daysHeld: 198, gainPct: 856.2 } }))
assert.equal(banza2.verified, true)
assert.equal(banza2.confidence, 'medium')

// 7254 Landmark Dr — +443% → medium (buy may be a transfer, not a sale).
assert.equal(verifyFlip(comp({ salePrice: 307_150, saleDate: '2026-03-19',
  flip: { priorSalePrice: 56_500, priorSaleDate: '2025-08-04', daysHeld: 227, gainPct: 443.6 } })).confidence, 'medium')

// Hard fails: under 10% gain, held < 30 days, distressed resale, no flip.
const f = (o: Record<string, unknown>) => verifyFlip(comp({ salePrice: 300_000, saleDate: '2026-06-01', flip: { priorSalePrice: 200_000, priorSaleDate: '2026-01-01' }, ...o }))
assert.equal(f({ flip: { priorSalePrice: 285_000, priorSaleDate: '2026-01-01' } }).verified, false)
assert.equal(f({ flip: { priorSalePrice: 200_000, priorSaleDate: '2026-05-15' } }).verified, false)
assert.equal(f({ distressedSale: true }).verified, false)
assert.equal(f({ flip: null }).verified, false)
assert.equal(f({}).verified, true)

console.log('verified flip rule: passed')
