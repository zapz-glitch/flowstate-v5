import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadModule } from './test-load.mjs'

const m = loadModule(new URL('./permit-progress.ts', import.meta.url))
const plain = (value) => JSON.parse(JSON.stringify(value))

test('a permit message from the server becomes a stage', () => {
  assert.deepEqual(plain(m.permitProgressFromEvent({ message: '3 permits found', stage: 'received', state: 'ok', count: 3 })), { stage: 'received', message: '3 permits found', state: 'ok', count: 3 })
  assert.deepEqual(plain(m.permitProgressFromEvent({ message: 'Requesting permit records', stage: 'requesting' })), { stage: 'requesting', message: 'Requesting permit records' })
})

test('the evaluation\'s own messages are not permit messages', () => {
  assert.equal(m.permitProgressFromEvent({ message: 'Photos fetched' }), null)
  assert.equal(m.permitProgressFromEvent({ message: 'Renovation level assessed', stage: 'valuation' }), null)
  assert.equal(m.permitProgressFromEvent({ stage: 'received' }), null, 'a stage with no words')
  assert.equal(m.permitProgressFromEvent(null), null)
  assert.equal(m.permitProgressFromEvent('requesting'), null)
})

test('junk in the optional fields is dropped, not trusted', () => {
  const p = m.permitProgressFromEvent({ message: 'x', stage: 'received', state: 'bogus', count: '3' })
  assert.equal(p.state, undefined)
  assert.equal(p.count, undefined)
})

test('steps run one to three in order', () => {
  assert.deepEqual(plain(m.PERMIT_STAGES.map((stage) => m.permitStep({ stage, message: '' }))), [1, 2, 3])
})

test('it is done after assessing, or when the lookup found nothing or failed; not while permits are still to be assessed', () => {
  assert.equal(m.permitProgressDone({ stage: 'requesting', message: '' }), false)
  assert.equal(m.permitProgressDone({ stage: 'received', state: 'ok', count: 2, message: '' }), false)
  assert.equal(m.permitProgressDone({ stage: 'received', state: 'empty', count: 0, message: '' }), true)
  assert.equal(m.permitProgressDone({ stage: 'received', state: 'unavailable', message: '' }), true)
  assert.equal(m.permitProgressDone({ stage: 'assessed', message: '' }), true)
})

test('the on-demand pull has the same three stages', () => {
  assert.equal(m.pullRequesting().stage, 'requesting')
  assert.equal(m.pullReceived(1).message, '1 permit found')
  assert.equal(m.pullReceived(4).message, '4 permits found')
  assert.equal(m.pullReceived(0).message, 'No permits on file')
  assert.equal(m.pullReceived(0).state, 'empty')
  assert.equal(m.pullApplied().stage, 'assessed')
})
