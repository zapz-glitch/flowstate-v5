import assert from 'node:assert/strict'
import { serialize } from 'node:v8'
import { ChunkedJobState } from '../src/durable-objects/chunked-job-state'

class Storage {
  values = new Map<string, unknown>()
  fail = false
  async transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
    const next = structuredClone(this.values)
    const result = await callback({
      get: async (key: string) => structuredClone(next.get(key)),
      put: async (key: string, value: unknown) => {
        assert.ok(serialize(value).byteLength <= 131072, 'DO value exceeds 128 KiB')
        if (this.fail && key === 'jobState') throw new Error('injected failure')
        next.set(key, structuredClone(value))
      },
      delete: async (key: string) => next.delete(key),
    })
    this.values = next
    return result
  }
}
const storage = new Storage()
const state = new ChunkedJobState<{ events: unknown[] }>(storage as unknown as DurableObjectStorage)
assert.equal(await state.read(), null)
const legacy = { events: [{ event: 'subject_found', data: 'legacy' }] }
storage.values.set('jobState', legacy)
assert.deepEqual(await state.read(), legacy)
const large = { events: [{ event: 'evaluation_complete', data: '🏡東京'.repeat(40000) }] }
assert.ok(serialize(large).byteLength > 231030)
await state.write(large)
assert.deepEqual(await new ChunkedJobState(storage as unknown as DurableObjectStorage).read(), large)
const first = state.write(large)
large.events.push({ event: 'enrichment_done' })
const second = state.write(large)
await Promise.all([first, second])
assert.deepEqual(await state.read(), large, 'concurrent writes preserve newest full history')
storage.fail = true
await assert.rejects(state.write(legacy), /injected failure/)
assert.deepEqual(await state.read(), large, 'failed transaction retains prior snapshot')
storage.fail = false
await state.write(legacy)
assert.deepEqual(await state.read(), legacy)
assert.equal(storage.values.size, 2, 'shrinking deletes obsolete chunks')
storage.values.delete('jobState:chunk:0')
await assert.rejects(state.read(), /Incomplete analysis state/)
console.log('chunked analysis state: oversized Unicode, legacy, concurrency, rollback, cleanup and corruption passed')

// Exercise the actual DO handlers after eviction, including a new large event.
const { AnalysisJobDO } = await import('../src/durable-objects/analysis-job')
const recoveredStorage = new Storage()
const persisted = new ChunkedJobState(recoveredStorage as unknown as DurableObjectStorage)
await persisted.write({ jobId: 'regression', userId: 'test', status: 'processing', pending: [], events: [], createdAt: 1 })
let hydration: Promise<unknown> = Promise.resolve()
const job = new AnalysisJobDO({
  storage: recoveredStorage,
  blockConcurrencyWhile: (callback: () => Promise<unknown>) => { hydration = callback(); return hydration },
} as unknown as DurableObjectState, {} as never)
await hydration
assert.equal((await job.fetch(new Request('https://job/state'))).status, 200)
const payload = { event: 'evaluation_complete', data: '🏡東京'.repeat(40000) }
assert.equal((await job.fetch(new Request('https://job/event', { method: 'POST', body: JSON.stringify(payload) }))).status, 200)
const response = await (await job.fetch(new Request('https://job/state'))).json() as { events: { data: string }[] }
assert.equal(response.events[0].data, payload.data)
assert.deepEqual(await persisted.read(), response)
console.log('AnalysisJobDO: cold hydration and oversized event handler passed')
