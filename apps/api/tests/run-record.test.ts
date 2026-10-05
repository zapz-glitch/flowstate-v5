import assert from 'node:assert/strict'
import { canonicalJson, sha256Text, buildRunRecordPayload, insertRunRecord } from '../src/services/evaluation/run-record'

// Canonical JSON is order-insensitive for object keys and drops call seams.
{
  const a = canonicalJson({ z: 1, nested: { b: 2, a: 1 }, fn: () => 'dropped', missing: undefined })
  const b = canonicalJson({ missing: undefined, fn: () => 'other', nested: { a: 1, b: 2 }, z: 1 })
  assert.equal(a, b)
  assert.equal(a, '{"missing":null,"nested":{"a":1,"b":2},"z":1}')
}

{
  const payload = buildRunRecordPayload({
    jobId: 'job_1',
    userId: 'user_1',
    status: 'completed',
    request: { search: { address: '1 Main St' }, evalParams: { widen: () => [] } },
    evidence: { compPool: [{ address: '2 Main St' }] },
    attempts: [{ name: 'attempt 1' }],
    response: {
      subject: { address: '1 Main St', city: 'Conley', state: 'GA', zipCode: '30288', id: 'clip-1' },
      valuation: { arv: 228269, resultGrade: 'weak', processGrade: 'clean', bMechanics: { harnessVersion: 'test-v1' } },
      comps: { total: 2, enabledCount: 1 },
    },
  })
  const json = canonicalJson(payload)
  const hash = await sha256Text(json)
  assert.equal(hash, await sha256Text(canonicalJson(payload)))
  assert.equal(payload.attempts.length, 1)
  assert.equal(payload.property.address, '1 Main St')

  const writes: unknown[][] = []
  const db = {
    prepare(sql: string) {
      return {
        bind: (...args: unknown[]) => ({
          run: async () => { writes.push(args); return { success: true } },
          first: async () => null,
        }),
      }
    },
  } as unknown as D1Database
  const saved = await insertRunRecord(db, payload)
  assert.equal(saved.payloadHash, hash)
  assert.equal(writes.length, 1)
  const row = writes[0]
  assert.equal(row[1], 'job_1')
  assert.equal(row[4], '1 Main St')
  assert.equal(row[9], 'completed')
  assert.equal(row[12], 228269)
  assert.equal(row[13], 'weak')
  assert.equal(row[23], 1)
  assert.equal(row[26], json)
}

console.log('run-record: canonical evidence, hash, and insert mapping passed')
