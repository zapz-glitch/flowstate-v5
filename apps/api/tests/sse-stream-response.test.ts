import assert from 'node:assert/strict'
import { AnalysisJobDO } from '../src/durable-objects/analysis-job'
import { BatchJobDO } from '../src/durable-objects/batch-job'
import type { Env } from '../src/types'

// Minimal DurableObjectState mock: transactional KV + waitUntil capture.
class MockStorage {
  values = new Map<string, unknown>()
  async transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
    const next = new Map(this.values)
    const result = await callback({
      get: async (key: string) => next.get(key),
      put: async (key: string, value: unknown) => { next.set(key, value) },
      delete: async (key: string) => { next.delete(key) },
    })
    this.values = next
    return result
  }
  async get(key: string) { return this.values.get(key) }
  async put(key: string, value: unknown) { this.values.set(key, value) }
}
class MockState {
  storage = new MockStorage()
  waited: Promise<unknown>[] = []
  blockConcurrencyWhile(callback: () => Promise<void>) { void callback() }
  waitUntil(promise: Promise<unknown>) { this.waited.push(promise) }
}

const env = {} as Env

// fetch() must return the Response before the body is consumed — a
// TransformStream write only settles once the readable side is read, so
// awaiting the initial writes before returning is the deadlock under test.
const promptly = <T>(promise: Promise<T>, ms = 250): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('SSE response did not resolve promptly — initial writes are still awaited')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

// ─── AnalysisJobDO: /sse resolves before the stream is consumed ─────────────
{
  const state = new MockState()
  const job = new AnalysisJobDO(state as never, env)
  const res = await promptly(job.fetch(new Request('http://internal/sse')))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/event-stream')

  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let received = ''
  while (!received.includes('\n\n')) {
    const { value, done } = await reader.read()
    if (done) break
    received += decoder.decode(value, { stream: true })
  }
  assert.ok(received.startsWith('event: connected\n'), `first SSE event must be 'connected', got: ${JSON.stringify(received)}`)
  await reader.cancel()
  await Promise.allSettled(state.waited)
}

// ─── BatchJobDO: terminal batch replays snapshot then closes promptly ───────
{
  const state = new MockState()
  await state.storage.put('batchState', {
    batchId: 'batch_sse_terminal',
    userId: 'u1',
    status: 'completed',
    addresses: ['1 Test St'],
    results: [{ address: '1 Test St', index: 0, status: 'completed', jobId: 'job_1' }],
    currentIndex: 0,
    totalAddresses: 1,
    completedCount: 1,
    failedCount: 0,
    createdAt: Date.now() - 60_000,
  })
  const job = new BatchJobDO(state as never, env)
  const res = await promptly(job.fetch(new Request('http://internal/sse')))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/event-stream')

  const body = await res.text()
  const stateIdx = body.indexOf('event: batch_state')
  const doneIdx = body.indexOf('event: batch_done')
  assert.ok(stateIdx >= 0, 'batch_state snapshot must be emitted')
  assert.ok(doneIdx > stateIdx, 'batch_done must follow batch_state')
  await Promise.allSettled(state.waited)
}

console.log('SSE stream response tests passed')
