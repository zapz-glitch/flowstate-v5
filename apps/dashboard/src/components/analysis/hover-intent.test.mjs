import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadModule } from '../../lib/test-load.mjs'

const { hoverIntent, movedBeyondSlop, DWELL_MS, DWELL_SLOP_PX, SETTLE_MS } = loadModule(new URL('./hover-intent.ts', import.meta.url))
const base = { now: 10_000, restedSince: 10_000, lastInteractionAt: 0, gesturing: false }

test('a pointer that has just arrived on a marker is not hovering yet', () => {
  const r = hoverIntent(base)
  assert.equal(r.ready, false)
  assert.equal(r.waitMs, DWELL_MS)
})

test('resting on the marker long enough opens it', () => {
  assert.equal(hoverIntent({ ...base, now: 10_000 + DWELL_MS }).ready, true)
  assert.equal(hoverIntent({ ...base, now: 10_000 + DWELL_MS - 1 }).ready, false)
})

test('the wait is about a quarter of a second', () => {
  assert.ok(DWELL_MS >= 200 && DWELL_MS <= 300)
})

test('a drag, or a held mouse button, is never a hover, however long it lasts', () => {
  assert.equal(hoverIntent({ ...base, now: 99_999, gesturing: true }).ready, false)
})

test('right after a drag, zoom or wheel turn hover stays quiet, then works again', () => {
  const justZoomed = { ...base, now: 20_000, restedSince: 19_000, lastInteractionAt: 19_900 }
  const early = hoverIntent(justZoomed)
  assert.equal(early.ready, false)
  assert.equal(early.waitMs, 19_900 + SETTLE_MS - 20_000)
  assert.equal(hoverIntent({ ...justZoomed, now: 19_900 + SETTLE_MS }).ready, true)
})

test('the longer of the two waits wins', () => {
  const r = hoverIntent({ now: 5_000, restedSince: 4_900, lastInteractionAt: 4_950, gesturing: false })
  assert.equal(r.waitMs, Math.max(4_900 + DWELL_MS - 5_000, 4_950 + SETTLE_MS - 5_000))
})

test('small jitter still counts as resting; a real move restarts the wait', () => {
  assert.equal(movedBeyondSlop({ x: 100, y: 100 }, { x: 100 + DWELL_SLOP_PX, y: 100 }), false)
  assert.equal(movedBeyondSlop({ x: 100, y: 100 }, { x: 100 + DWELL_SLOP_PX + 1, y: 100 }), true)
  assert.equal(movedBeyondSlop({ x: 100, y: 100 }, { x: 103, y: 103 }), true) // diagonal 4.24px
})
