import assert from 'node:assert/strict'
import { comparePhysicalEvidence, parsePhysicalEvidence, safePropertyPhotos } from '../src/services/evaluation/physical-evidence'
import type { Env } from '../src/types'

assert.deepEqual(safePropertyPhotos(['http://127.0.0.1/x', 'https://photos.zillowstatic.com.evil.test/x', 'https://photos.zillowstatic.com/x']), ['https://photos.zillowstatic.com/x'])
assert.equal(parsePhysicalEvidence({ status: 'match', confidence: 'high', reason: 'Looks alike' }, 2, 2).status, 'unknown')
assert.equal(parsePhysicalEvidence({ status: 'mismatch', confidence: 'high', reason: 'Different stories', subject_front_index: 0, comp_front_index: 8 }, 2, 2).status, 'unknown')
const valid = parsePhysicalEvidence({ status: 'match', confidence: 'high', reason: 'Same form', subject_front_index: 0, comp_front_index: 1, subject_garage_spaces: 2, comp_garage_spaces: 2, visible_updates: ['Updated cabinets'] }, 2, 2)
assert.equal(valid.status, 'match')
assert.equal(valid.comp_garage_spaces, 2)
assert.equal(parsePhysicalEvidence(null, 2, 2).status, 'unknown')
const originalFetch = globalThis.fetch
globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body))
  assert.deepEqual(body.response_format, { type: 'json_object' })
  return Response.json({ choices: [{ message: { content: JSON.stringify({ ...valid, comp_front_index: 0 }) } }] })
}
try {
  const result = await comparePhysicalEvidence({ OPENAI_API_KEY: 'synthetic-test-only' } as Env,
    ['https://photos.zillowstatic.com/subject.jpg'], [{ id: 'comp', photos: ['https://photos.zillowstatic.com/comp.jpg'] }])
  assert.equal(result.comp.status, 'match')
} finally { globalThis.fetch = originalFetch }
console.log('Physical evidence parsing and image source restrictions passed')
