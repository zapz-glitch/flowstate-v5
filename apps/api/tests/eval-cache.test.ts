import assert from 'node:assert/strict'
import { AnalysisJobDO } from '../src/durable-objects/analysis-job'
import type { Env } from '../src/types'
import {
  decodeVerdict,
  encodeVerdict,
  evalResultKey,
  hashEvalParams,
  isCacheableVerdict,
  searchOptionsFingerprint,
} from '../src/utils/eval-cache'

// Minimal DurableObjectState mock (same shape as analysis-job-lifecycle.test.ts)
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

const mockKv = (seed?: Record<string, string>) => {
  const map = new Map(Object.entries(seed ?? {}))
  return {
    map,
    get: async (k: string) => map.get(k) ?? null,
    put: async (k: string, v: string) => { map.set(k, v) },
    delete: async (k: string) => { map.delete(k) },
  }
}

const startReq = (jobId: string, cacheKey: string, skipCache = false) =>
  new Request('http://internal/start-streaming', {
    method: 'POST',
    body: JSON.stringify({
      jobId,
      userId: 'u1',
      search: { address: '1 Dead End St' },
      searchOptions: {},
      evalParams: {},
      evalResultCacheKey: cacheKey,
      skipCache,
      llmEnabled: false,
    }),
  })

const stateOf = async (job: AnalysisJobDO) =>
  (await (await job.fetch(new Request('http://internal/state'))).json()) as {
    status: string
    events: Array<{ event: string; data: { message?: string; code?: string } }>
  }

// ─── Key/hash determinism ────────────────────────────────────────────────────
{
  const a = await hashEvalParams({ evalParams: { b: 1, a: { y: 2, x: 1 } }, searchOptions: searchOptionsFingerprint({ radiusMiles: 1 }) })
  const b = await hashEvalParams({ evalParams: { a: { x: 1, y: 2 }, b: 1 }, searchOptions: searchOptionsFingerprint({ radiusMiles: 1 }) })
  assert.equal(a, b, 'hash must be order-insensitive')

  const r1 = await hashEvalParams({ evalParams: {}, searchOptions: searchOptionsFingerprint({ radiusMiles: 1 }) })
  const r2 = await hashEvalParams({ evalParams: {}, searchOptions: searchOptionsFingerprint({ radiusMiles: 2 }) })
  assert.notEqual(r1, r2, 'different radius must produce a different fingerprint')

  const empty = await hashEvalParams({ evalParams: {}, searchOptions: searchOptionsFingerprint(undefined) })
  const explicitUndef = await hashEvalParams({ evalParams: {}, searchOptions: searchOptionsFingerprint({ radiusMiles: undefined }) })
  assert.equal(empty, explicitUndef, 'absent vs explicit-undefined options must hash identically')

  assert.equal(
    evalResultKey('u1', '  123 Main   St ', 'h'),
    evalResultKey('u1', '123 main st', 'h'),
    'address normalizes into the key',
  )
}

// ─── Verdict codec ───────────────────────────────────────────────────────────
{
  const encoded = encodeVerdict('INSUFFICIENT_COMPS', 'no comparables sold within the last 548 days')
  const decoded = decodeVerdict(encoded)
  assert.equal(decoded?.code, 'INSUFFICIENT_COMPS')
  assert.equal(decoded?.message, 'no comparables sold within the last 548 days')
  assert.equal(decodeVerdict('job_1234_abc'), null, 'a bare jobId is not a verdict')
  assert.equal(isCacheableVerdict('INSUFFICIENT_COMPS'), true)
  assert.equal(isCacheableVerdict('PROPERTY_NOT_FOUND'), true)
  assert.equal(isCacheableVerdict('COMPS_FETCH_FAILED'), false, 'transient failures must not be cached')
  assert.equal(isCacheableVerdict('EVALUATION_ERROR'), false)
  assert.equal(isCacheableVerdict(undefined), false)
}

// ─── DO replays a cached verdict with zero provider calls ────────────────────
{
  const key = 'eval-result:u1:1 dead end st:testhash'
  const kv = mockKv({ [key]: encodeVerdict('INSUFFICIENT_COMPS', 'no comps') })
  const env = { API_CACHE: kv } as unknown as Env
  const state = new MockState()
  const job = new AnalysisJobDO(state as never, env)

  const res = await job.fetch(startReq('job_verdict_1', key))
  assert.equal(res.status, 200)
  await res.text()
  await state.waited[0]

  const s = await stateOf(job)
  const errEvt = s.events.findLast((e) => e.event === 'error')
  assert.equal(errEvt?.data.message, 'no comps', 'cached verdict message replays')
  assert.equal(errEvt?.data.code, 'INSUFFICIENT_COMPS')
  assert.ok(
    !s.events.some((e) => e.event === 'property_fetch'),
    'cached verdict must short-circuit before any provider call',
  )
  assert.ok(s.events.some((e) => e.event === 'enrichment_done'), 'terminal event still emitted')
}

// ─── skipCache bypasses the verdict ──────────────────────────────────────────
{
  const key = 'eval-result:u1:1 dead end st:testhash2'
  const kv = mockKv({ [key]: encodeVerdict('INSUFFICIENT_COMPS', 'no comps') })
  const env = { API_CACHE: kv } as unknown as Env
  const state = new MockState()
  const job = new AnalysisJobDO(state as never, env)

  const res = await job.fetch(startReq('job_verdict_2', key, /* skipCache */ true))
  assert.equal(res.status, 200)
  await res.text()
  await state.waited[0]

  const s = await stateOf(job)
  assert.ok(
    s.events.some((e) => e.event === 'property_fetch'),
    'skipCache must run the pipeline (fails later on missing creds in test env)',
  )
}

console.log('Eval cache tests passed')
