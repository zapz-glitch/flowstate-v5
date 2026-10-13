import assert from 'node:assert/strict'
import { test } from 'node:test'
import { badgeText, describeJob, isStuck, upsertJob } from '../jobs.js'

test('the send list keeps the newest first, updates in place, and stays short', () => {
  let jobs = []
  jobs = upsertJob(jobs, { id: 'a', address: '1 A St', status: 'running' })
  jobs = upsertJob(jobs, { id: 'b', address: '2 B St', status: 'running' })
  assert.deepEqual(jobs.map((j) => j.id), ['b', 'a'])
  assert.equal(badgeText(jobs), '2')

  jobs = upsertJob(jobs, { id: 'a', status: 'done', arv: 300000 })
  assert.deepEqual(jobs, [{ id: 'b', address: '2 B St', status: 'running' }, { id: 'a', address: '1 A St', status: 'done', arv: 300000 }])
  assert.equal(badgeText(jobs), '1')
  assert.equal(badgeText(upsertJob(jobs, { id: 'b', status: 'error' })), '')

  for (let i = 0; i < 40; i++) jobs = upsertJob(jobs, { id: `n${i}`, status: 'done' })
  assert.equal(jobs.length, 25)
  assert.equal(jobs[0].id, 'n39')
})

test('each job reads as one plain line, and a run that never ends is caught', () => {
  assert.equal(describeJob({ status: 'running' }), 'Evaluating…')
  assert.equal(describeJob({ status: 'done', arv: 290606.4, offer: 171986 }), 'ARV $290,606 · Offer $171,986')
  assert.equal(describeJob({ status: 'done', arv: 290606, offer: null }), 'ARV $290,606')
  assert.equal(describeJob({ status: 'done', arv: null, offer: null }), 'Done — open the report')
  assert.equal(describeJob({ status: 'error', error: 'No comps found' }), 'No comps found')

  const minute = 60_000
  assert.equal(isStuck({ status: 'running', startedAt: 0 }, 19 * minute), false)
  assert.equal(isStuck({ status: 'running', startedAt: 0 }, 21 * minute), true)
  assert.equal(isStuck({ status: 'done', startedAt: 0 }, 99 * minute), false)
})
