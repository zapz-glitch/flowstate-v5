/**
 * Site reads — cutoffs and pool evidence. Probabilities are real Clef
 * answers from the 19-lot owner-labeled test (docs/SITE-READS-CLEF-TEST.md).
 */
import assert from 'node:assert/strict'
import { waterFromP, busyFromExposure, poolFrom } from '../src/services/site-read'

// Water — lot 3 (bay) 0.88 and lot 5 (lake, Water Silk Dr) 0.86 are yes;
// lot 1 (pond ~100m off) 0.39 is unknown; interior lots ~0.02 are no.
assert.equal(waterFromP(0.88), true)
assert.equal(waterFromP(0.86), true)
assert.equal(waterFromP(0.39), null)
assert.equal(waterFromP(0.02), false)
assert.equal(waterFromP(undefined), null)

// Busy road — 27B NEUTRAL odds. Lot 12 (backs 4-lane) 0.09, lot 15
// (fronts 94th Ave double yellow) 0.28, lot 16 (backs commercial) 0.22
// are yes; lot 20 (94th Ave) 0.34 sits in the unknown band; quiet
// interior lots (0.58–0.78) are no. Unverified imagery is unknown.
const ex = (neutral: number, choice = 'FRONTING') => ({ choice, probabilities: { NEUTRAL: neutral } })
assert.equal(busyFromExposure(ex(0.09)), true)
assert.equal(busyFromExposure(ex(0.28)), true)
assert.equal(busyFromExposure(ex(0.22)), true)
assert.equal(busyFromExposure(ex(0.34)), null)
assert.equal(busyFromExposure(ex(0.58, 'NEUTRAL')), false)
assert.equal(busyFromExposure(ex(0.05, 'UNVERIFIED')), null)
assert.equal(busyFromExposure(null), null)

// Pool — MLS field wins, then the home's own pool in the description,
// then the county field. Shared pools and silence never read as a pool.
assert.equal(poolFrom({ mlsPool: false, description: 'Screened pool and lanai' }), false)
assert.equal(poolFrom({ description: 'Lakefront home with a heated screened pool.' }), true)
assert.equal(poolFrom({ description: 'Enjoy the community pool and clubhouse.' }), null)
assert.equal(poolFrom({ description: 'HOA includes resort-style pool, fitness center.' }), null)
assert.equal(poolFrom({ description: 'Large backyard with room for a pool. No pool HOA.' }), null)
assert.equal(poolFrom({ description: 'Updated kitchen, new roof.' }), null)
assert.equal(poolFrom({ poolType: 'In-Ground' }), true)
assert.equal(poolFrom({ poolType: 'None' }), null)

// Permits — a pool permit is pool evidence (7462 Water Silk Dr carries
// "Pool/att spa/deck/gas"); a removal / fill-in permit is not.
assert.equal(poolFrom({ permits: ['Re-roof mod bit/18 squares', 'Pool/att spa/deck/gas'] }), true)
assert.equal(poolFrom({ permits: ['Demo pool and fill in'] }), null)
assert.equal(poolFrom({ permits: ['Pool fence', 'Pool barrier'] }), null)
assert.equal(poolFrom({ mlsPool: false, permits: ['Pool/att spa/deck/gas'] }), false, 'MLS field still wins')

console.log('site-read: passed')
