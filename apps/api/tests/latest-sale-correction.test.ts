/**
 * Flip-leg correction — a comp pool can carry a flip's ACQUISITION leg as
 * the comp's sale. When sales-history shows a newer priced sale, the comp
 * is priced on that resale. 18 saved Oct-2026 comps kept the buy leg
 * (2927 Banza St at $25,100, labeled a verified flip) because the
 * market-context supplement path never applied the correction.
 */
import assert from 'node:assert/strict'
import { correctToLatestSale } from '../src/services/property-api/latest-sale'

const banza = { salePrice: 25_100, saleDate: '2025-12-29', squareFeet: 1355, pricePerSqft: 19,
  latestSale: { price: 240_000, date: '2026-07-15' } }
assert.deepEqual(correctToLatestSale(banza), { ...banza, salePrice: 240_000, saleDate: '2026-07-15', pricePerSqft: 177 })

// Already the newest sale, or no history — unchanged (same object).
const current = { salePrice: 299_000, saleDate: '2026-07-17', squareFeet: 910, pricePerSqft: 329,
  latestSale: { price: 299_000, date: '2026-07-17' } }
assert.equal(correctToLatestSale(current), current)
const bare = { salePrice: 300_000, saleDate: '2026-01-01', squareFeet: 1000, pricePerSqft: 300 }
assert.equal(correctToLatestSale(bare), bare)

// Undated pool sale takes the history's sale; no sqft keeps the old $/sf.
assert.deepEqual(correctToLatestSale({ salePrice: null, saleDate: null, squareFeet: null, pricePerSqft: null,
  latestSale: { price: 200_000, date: '2026-05-01' } }),
  { salePrice: 200_000, saleDate: '2026-05-01', squareFeet: null, pricePerSqft: null, latestSale: { price: 200_000, date: '2026-05-01' } })

console.log('latest-sale correction: passed')
