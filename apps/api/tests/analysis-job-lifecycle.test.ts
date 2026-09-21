import assert from 'node:assert/strict'
import { AnalysisJobDO } from '../src/durable-objects/analysis-job'
import { ChunkedJobState } from '../src/durable-objects/chunked-job-state'
import type { Env } from '../src/types'

// Minimal DurableObjectState mock: transactional KV + alarm + waitUntil capture.
class MockStorage {
  values = new Map<string, unknown>()
  alarmAt: number | null = null
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
  async delete(key: string) { this.values.delete(key) }
  async setAlarm(at: number) { this.alarmAt = at }
  async deleteAlarm() { this.alarmAt = null }
}
class MockState {
  storage = new MockStorage()
  waited: Promise<unknown>[] = []
  blockConcurrencyWhile(callback: () => Promise<void>) { void callback() }
  waitUntil(promise: Promise<unknown>) { this.waited.push(promise) }
}

// No providers/credentials — the pipeline fails fast internally, which is fine:
// the lifecycle contract (waitUntil, alarm, runActive) is what is under test.
const env = {} as Env
const startBody = (jobId: string) => JSON.stringify({
  jobId,
  userId: 'u1',
  search: { address: '1 Test St' },
  searchOptions: {},
  evalParams: {},
  llmEnabled: false,
})

const startReq = (jobId: string) =>
  new Request('http://internal/start-streaming', { method: 'POST', body: startBody(jobId) })

// ─── waitUntil registration + watchdog arm ───────────────────────────────────
{
  const state = new MockState()
  const job = new AnalysisJobDO(state as never, env)
  const res = await job.fetch(startReq('job_lifecycle_1'))
  assert.equal(res.status, 200)
  await res.text()
  assert.equal(state.waited.length, 1, 'pipeline must be registered with state.waitUntil — without it a DO with no SSE clients can be evicted mid-run')
  assert.ok(state.storage.alarmAt !== null, 'watchdog alarm must be armed')
  await state.waited[0] // run settles (provider missing → error path)

  // After the run settles a new start on the same DO is allowed
  const res2 = await job.fetch(startReq('job_lifecycle_1'))
  assert.equal(res2.status, 200)
  await res2.text()
  await state.waited[1]
}

// ─── Duplicate start while a run is live → 409, no second pipeline ───────────
{
  const state = new MockState()
  const job = new AnalysisJobDO(state as never, env)
  ;(job as unknown as { runActive: boolean }).runActive = true
  const res = await job.fetch(startReq('job_lifecycle_dup'))
  assert.equal(res.status, 409)
  await res.text()
  assert.equal(state.waited.length, 0, 'no second run may be launched while one is live')
}

// ─── Watchdog: dead 'processing' job on a fresh isolate → terminal error ─────
{
  const state = new MockState()
  const persistence = new ChunkedJobState<{ status: string }>(state.storage as never)
  await persistence.write({
    jobId: 'job_dead', userId: 'u1', status: 'processing', pending: [], events: [], createdAt: Date.now() - 60_000,
  })
  const job = new AnalysisJobDO(state as never, env)
  await job.alarm()
  const persisted = await persistence.read() as { status: string; error?: string } | null
  assert.equal(persisted?.status, 'error', 'dead processing run must be converted to error')
  assert.match(persisted?.error ?? '', /interrupted/i)
  assert.equal(state.storage.alarmAt, null, 'watchdog clears the alarm after flagging')
}

// ─── Watchdog: completed job → no-op, alarm cleared ──────────────────────────
{
  const state = new MockState()
  const persistence = new ChunkedJobState<{ status: string }>(state.storage as never)
  await persistence.write({
    jobId: 'job_done', userId: 'u1', status: 'complete', pending: [], events: [], createdAt: Date.now() - 60_000,
  })
  const job = new AnalysisJobDO(state as never, env)
  await job.alarm()
  const persisted = await persistence.read() as { status: string } | null
  assert.equal(persisted?.status, 'complete')
  assert.equal(state.storage.alarmAt, null)
}

// ─── Watchdog: live run in this isolate → re-arm, state untouched ────────────
{
  const state = new MockState()
  const persistence = new ChunkedJobState<{ status: string }>(state.storage as never)
  await persistence.write({
    jobId: 'job_live', userId: 'u1', status: 'processing', pending: [], events: [], createdAt: Date.now() - 60_000,
  })
  const job = new AnalysisJobDO(state as never, env)
  ;(job as unknown as { runActive: boolean }).runActive = true
  await job.alarm()
  const persisted = await persistence.read() as { status: string } | null
  assert.equal(persisted?.status, 'processing', 'live run must not be flagged')
  assert.ok(state.storage.alarmAt !== null, 'watchdog re-arms while the run is live')
}

// ─── Ownership guard: start for another user's persisted job → 403 ──────────
{
  const state = new MockState()
  const persistence = new ChunkedJobState<{ status: string }>(state.storage as never)
  await persistence.write({
    jobId: 'job_victim', userId: 'victim-user', status: 'complete', pending: [], events: [], createdAt: Date.now() - 60_000,
  })
  const job = new AnalysisJobDO(state as never, env)
  const res = await job.fetch(new Request('http://internal/start-streaming', {
    method: 'POST',
    body: JSON.stringify({
      jobId: 'job_victim', userId: 'attacker-user',
      search: { address: '1 Test St' }, searchOptions: {}, evalParams: {}, llmEnabled: false,
    }),
  }))
  assert.equal(res.status, 403, 'start-streaming on another user\'s job must be rejected')
  await res.text()
  assert.equal(state.waited.length, 0, 'no pipeline may launch for a foreign job')
}

console.log('Analysis job lifecycle tests passed')
