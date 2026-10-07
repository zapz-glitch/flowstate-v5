import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadModule } from '../lib/test-load.mjs'

const { nextHold } = loadModule(new URL('./use-held-during-rerun.ts', import.meta.url), { react: { useState: () => [] } })
const idle = { busy: false, frozen: null, generation: 0 }

test('a rerun that starts with results on screen freezes them', () => {
  const next = nextHold(idle, 'old results', true, true)
  assert.deepEqual(JSON.parse(JSON.stringify(next)), { busy: true, frozen: 'old results', generation: 0 })
})

test('a first run, with nothing on screen, is not held', () => {
  const next = nextHold(idle, null, true, false)
  assert.equal(next.frozen, null)
})

test('the new data streaming in changes nothing while a rerun is held', () => {
  const held = nextHold(idle, 'old', true, true)
  assert.equal(nextHold(held, 'half new', true, true), held, 'same state object: the frozen results stay')
  assert.equal(nextHold(held, 'more new', true, true), held)
})

test('when the rerun ends the results are released and the count goes up once', () => {
  const held = nextHold(idle, 'old', true, true)
  const done = nextHold(held, 'new', false, true)
  assert.deepEqual(JSON.parse(JSON.stringify(done)), { busy: false, frozen: null, generation: 1 })
  assert.equal(nextHold(done, 'newer', false, true), done, 'idle changes do not count')
})

test('a first run that ends does not count as a held rerun, so it does not replay an entrance', () => {
  const first = nextHold(idle, null, true, false)
  assert.equal(nextHold(first, 'result', false, true).generation, 0)
})

test('two reruns in a row count twice', () => {
  let s = nextHold(idle, 'a', true, true)
  s = nextHold(s, 'b', false, true)
  s = nextHold(s, 'b', true, true)
  s = nextHold(s, 'c', false, true)
  assert.equal(s.generation, 2)
})
