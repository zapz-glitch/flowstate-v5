/**
 * Filter ladder proofs (docs/FILTER-LADDER.md).
 *
 * 1. Step order: strict → sale age alone → square feet → year → sale age …
 * 2. Each step widens exactly one rule: square feet by 25% of the subject's
 *    size, year built by 3 years, sale age by 30 days.
 * 3. Every step is a superset of the one before.
 * 4. Only the three ladder rules ever move; hard rules are untouched.
 * 5. The data ends the ladder — no fixed cap, and it cannot spin.
 */
import assert from 'node:assert/strict'
import {
  ladderTiersAt, ladderLimitsAt, filtersAtLadderStep, lastUsefulLadderStep,
  describeLadderConcessions, ladderFactorAt, ladderStepSizes,
} from '../src/services/appraisal/filter-ladder'
import { DEFAULT_FILTERS } from '../src/services/appraisal/types'

// 1 — order
assert.deepEqual(ladderTiersAt(0), { sqft: 0, year: 0, saleAge: 0 })
assert.deepEqual(ladderTiersAt(1), { sqft: 0, year: 0, saleAge: 1 }, 'sale age gives first, alone')
assert.deepEqual(ladderTiersAt(2), { sqft: 1, year: 0, saleAge: 1 }, 'then square feet')
assert.deepEqual(ladderTiersAt(3), { sqft: 1, year: 1, saleAge: 1 }, 'then year built')
assert.deepEqual(ladderTiersAt(4), { sqft: 1, year: 1, saleAge: 2 }, 'then sale age again')
assert.deepEqual(ladderTiersAt(5), { sqft: 2, year: 1, saleAge: 2 })
assert.deepEqual(ladderTiersAt(6), { sqft: 2, year: 2, saleAge: 2 })

// 2 — one rule per step: 25% of the SUBJECT's size, 3 years, 30 days
const SQFT = 1200 // subject size → 300 sf per step
assert.deepEqual(ladderStepSizes(DEFAULT_FILTERS, SQFT), { sqft: 300, year: 3, saleAge: 30 })
assert.deepEqual(ladderLimitsAt(DEFAULT_FILTERS, 0, SQFT), { sqft: 250, year: 10, saleAge: 180 })
assert.deepEqual(ladderLimitsAt(DEFAULT_FILTERS, 1, SQFT), { sqft: 250, year: 10, saleAge: 210 })
assert.deepEqual(ladderLimitsAt(DEFAULT_FILTERS, 2, SQFT), { sqft: 550, year: 10, saleAge: 210 })
assert.deepEqual(ladderLimitsAt(DEFAULT_FILTERS, 3, SQFT), { sqft: 550, year: 13, saleAge: 210 })
assert.deepEqual(ladderLimitsAt(DEFAULT_FILTERS, 4, SQFT), { sqft: 550, year: 13, saleAge: 240 })
// a bigger subject takes bigger size steps; year and sale age do not change
assert.equal(ladderLimitsAt(DEFAULT_FILTERS, 2, 2400).sqft, 850)
assert.equal(ladderLimitsAt(DEFAULT_FILTERS, 3, 2400).year, 13)
// no subject size on file → size steps by the configured tolerance
assert.equal(ladderLimitsAt(DEFAULT_FILTERS, 2, null).sqft, 500)
for (let n = 1; n < 60; n++) {
  const a = ladderTiersAt(n - 1), b = ladderTiersAt(n)
  const moved = (b.sqft - a.sqft) + (b.year - a.year) + (b.saleAge - a.saleAge)
  assert.equal(moved, 1, `step ${n} moves exactly one rule`)
  // 3 — superset
  assert.ok(b.sqft >= a.sqft && b.year >= a.year && b.saleAge >= a.saleAge)
}

// 4 — nothing else moves
const stepped = filtersAtLadderStep(DEFAULT_FILTERS, 9, SQFT)
for (const f of DEFAULT_FILTERS) {
  const g = stepped.find((x) => x.type === f.type)!
  if (['sqft_diff', 'year_built_diff', 'sale_age'].includes(f.type)) assert.ok(g.value > f.value, `${f.type} widened`)
  else assert.equal(g.value, f.value, `${f.type} must not move`)
}
assert.equal(filtersAtLadderStep(DEFAULT_FILTERS, 0), DEFAULT_FILTERS, 'strict returns the settings untouched')
// a disabled rule stays disabled and unmoved
const noYear = DEFAULT_FILTERS.map((f) => f.type === 'year_built_diff' ? { ...f, enabled: false } : f)
assert.equal(filtersAtLadderStep(noYear, 9).find((f) => f.type === 'year_built_diff')!.value, 10)
assert.equal(ladderLimitsAt(noYear, 9).year, null)

// 5 — the data is the stop
const now = Date.parse('2026-10-05T00:00:00Z')
const subject = { squareFeet: 1200, yearBuilt: 1960 }
assert.equal(lastUsefulLadderStep(DEFAULT_FILTERS, subject, [{ squareFeet: 1300, yearBuilt: 1965, saleDate: '2026-08-01' }], now), 0, 'all inside strict')
const last = lastUsefulLadderStep(DEFAULT_FILTERS, subject, [{ squareFeet: 1900, yearBuilt: 1975, saleDate: '2025-06-01' }], now)
const lim = ladderLimitsAt(DEFAULT_FILTERS, last, subject.squareFeet)
assert.ok(lim.sqft! >= 700 && lim.year! >= 15 && lim.saleAge! >= 491, 'last step covers the widest candidate')
const before = ladderLimitsAt(DEFAULT_FILTERS, last - 1, subject.squareFeet)
assert.ok(before.sqft! < 700 || before.year! < 15 || before.saleAge! < 491, 'and the step before does not')
assert.ok(lastUsefulLadderStep(DEFAULT_FILTERS, subject, [{ squareFeet: 9_000_000, yearBuilt: 1, saleDate: '1900-01-01' }], now) <= 600, 'bad data cannot spin the ladder')
assert.equal(lastUsefulLadderStep(DEFAULT_FILTERS, subject, [], now), 0)

// concessions read in plain words and list only what moved
assert.deepEqual(describeLadderConcessions(DEFAULT_FILTERS, 0), [])
assert.deepEqual(describeLadderConcessions(DEFAULT_FILTERS, 1, SQFT), ['sale age to 210 days (was sale age to 180 days)'])
assert.equal(describeLadderConcessions(DEFAULT_FILTERS, 3, SQFT).length, 3)
assert.equal(ladderFactorAt(DEFAULT_FILTERS, 0, SQFT), 1)
assert.equal(ladderFactorAt(DEFAULT_FILTERS, 2, SQFT), 2.2)

console.log('filter-ladder: all proofs passed')
