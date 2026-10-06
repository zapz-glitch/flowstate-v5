import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadModule } from '../lib/test-load.mjs'

const { rowStopsFor, mergeStops, nextWheelTarget } = loadModule(new URL('./use-paced-wheel.ts', import.meta.url))
// Arrays made inside the loader's sandbox have another prototype; compare plain copies
const plain = (value) => JSON.parse(JSON.stringify(value))

test('cards in the same grid row make one stop, rows make one stop each', () => {
  // 2 columns: tops repeat in pairs. The bar lane is 62px tall (54 bar + 8 gap).
  const tops = [392.5, 392.5, 741, 741, 1089.5, 1089.5]
  assert.deepEqual(plain(rowStopsFor(tops, 62)), [330.5, 679, 1027.5])
})

test('cards listed out of order still make sorted stops', () => {
  assert.deepEqual(plain(rowStopsFor([741, 392.5, 1089.5], 62)), [330.5, 679, 1027.5])
})

test('a single column makes a stop for every card', () => {
  assert.equal(rowStopsFor([100, 500, 900], 50).length, 3)
})

test('merging drops empty and non-positive stops and sorts the rest', () => {
  assert.deepEqual(plain(mergeStops([null, 0, -5, 700, 300, undefined])), [300, 700])
})

test('merging drops a stop within 40px of the one before', () => {
  // Bar stop 306 and a first-row stop 330 are nearly the same place
  assert.deepEqual(plain(mergeStops([306, 330, 679])), [306, 679])
  assert.deepEqual(plain(mergeStops([306, 347, 679])), [306, 347, 679], 'more than 40px apart stays')
})

const points = [306, 679, 1028, 1376]

test('down from the top lands on the first stop, then each row in turn', () => {
  const step = (from) => nextWheelTarget({ points, from, down: true, stepPx: 56, max: 5000 })
  assert.equal(step(0), 306)
  assert.equal(step(306), 679)
  assert.equal(step(679), 1028)
  assert.equal(step(1028), 1376)
})

test('past the last stop a notch is a small step', () => {
  assert.equal(nextWheelTarget({ points, from: 1376, down: true, stepPx: 56, max: 5000 }), 1432)
})

test('up retraces the same stops and ends at the top', () => {
  const step = (from) => nextWheelTarget({ points, from, down: false, stepPx: 56, max: 5000 })
  assert.equal(step(1376), 1028)
  assert.equal(step(1028), 679)
  assert.equal(step(679), 306)
  assert.equal(step(306), 0)
})

test('up from beyond the last stop steps back a little first', () => {
  assert.equal(nextWheelTarget({ points, from: 1500, down: false, stepPx: 56, max: 5000 }), 1444)
})

test('a position between stops goes to the next stop down and the previous stop up', () => {
  assert.equal(nextWheelTarget({ points, from: 800, down: true, stepPx: 56, max: 5000 }), 1028)
  assert.equal(nextWheelTarget({ points, from: 800, down: false, stepPx: 56, max: 5000 }), 679)
})

test('a stop below the bottom of the page is clamped to the bottom', () => {
  assert.equal(nextWheelTarget({ points, from: 1028, down: true, stepPx: 56, max: 1200 }), 1200)
})

test('with no stops at all a notch is a plain step, and never goes below zero', () => {
  assert.equal(nextWheelTarget({ points: [], from: 0, down: true, stepPx: 56, max: 500 }), 56)
  assert.equal(nextWheelTarget({ points: [], from: 20, down: false, stepPx: 56, max: 500 }), 0)
})
