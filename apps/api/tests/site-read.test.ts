/**
 * Site reads — cutoffs and pool evidence. Probabilities are real Clef
 * answers from the 19-lot owner-labeled test (docs/SITE-READS-CLEF-TEST.md).
 */
import assert from 'node:assert/strict'
import { waterFromP, busyFromExposure, poolFrom, poolFromP, sharpEnough } from '../src/services/site-read'

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

// Aerial pool ranks after listing text and permits, ahead of the county
// field (blank on 4 of 5 pool lots). Comps rarely carry anything else, so
// the aerial is what finds their pools (7253 Bryce Pt, 7861 Oliver Rd).
assert.equal(poolFrom({ aerialPool: true }), true)
assert.equal(poolFrom({ aerialPool: false }), false)
assert.equal(poolFrom({ aerialPool: null, poolType: 'In-Ground' }), true)
assert.equal(poolFrom({ aerialPool: false, poolType: 'In-Ground' }), false, 'aerial beats county')
assert.equal(poolFrom({ aerialPool: false, permits: ['Pool/att spa/deck/gas'] }), true, 'permit beats aerial')
assert.equal(poolFrom({ mlsPool: false, aerialPool: true }), false, 'MLS field still wins')

// Aerial pool — Clef 27B on a tight (~70m) aerial, 2026-10-27 owner-labeled
// test. Every real pool scored ≥0.89 (7303 Sawgrass courtyard pool 0.93);
// the worst no-pool lot on a sharp image scored 0.60 → unknown, not yes.
assert.equal(poolFromP(0.9346), true)
assert.equal(poolFromP(0.8996), true)
assert.equal(poolFromP(0.6024), null)
assert.equal(poolFromP(0.7909), null)
assert.equal(poolFromP(0.1324), false)
assert.equal(poolFromP(undefined), null)

// Blur gate — Esri is sharp in Pinellas (80KB+ per 640px tile) and mush
// in Phoenix/Atlanta (~22KB); a blurry tile made 6131 N 8th Ave read 0.79.
assert.equal(sharpEnough(82_137, 640), true)
assert.equal(sharpEnough(21_918, 512), false)
assert.equal(sharpEnough(21_981, 640), false)

console.log('site-read: passed')
