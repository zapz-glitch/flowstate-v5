/**
 * Per-report call log.
 *
 * Ways this can fail, each covered below:
 *  - an API key ends up in the stored log
 *  - megabytes of image data are stored instead of a digest
 *  - recording consumes the response body, so the caller reads nothing
 *  - calls from another run, or from outside any run, leak into a log
 *  - two runs in flight at once write into each other's log
 *  - replay answers a request that is NOT identical to the logged one
 *  - replay returns a different body than the original call did
 *  - a failed call disappears from the log
 *  - the log is saved without the 90-day expiry
 *  - a large body (a listing page, a long prompt) is dropped, so the next
 *    arm cannot replay it and re-fetches different evidence
 *  - hundreds of repeated error pages fill the log
 */

import { describe, expect, it, vi } from 'vitest'
import {
  CALL_LOG_TTL_SECONDS, callLogKey, classifyCall, loadCallBodies, loadCallLog, newCallLog, recordingFetch, redactUrl,
  runWithCallLog, saveCallLog, summarizeCallLog, summarizeModelCalls, type CallLog,
} from './call-log'

/** Run `fn` in a scope using a wrapper around `network` rather than the global fetch. */
function memoryStore() {
  const values = new Map<string, string>()
  const put = vi.fn(async (key: string, value: string, _options?: { expirationTtl?: number }) => { values.set(key, value) })
  return { values, put, get: async (key: string) => values.get(key) ?? null }
}
type Store = ReturnType<typeof memoryStore>

async function inScope<T>(log: CallLog, replayFrom: CallLog | null, network: typeof fetch, fn: (f: typeof fetch) => Promise<T>, store: Store | null = null): Promise<T> {
  const original = globalThis.fetch
  const f = recordingFetch(network)
  try { return await runWithCallLog(log, { store, replayFrom }, () => fn(f)) } finally { globalThis.fetch = original }
}

const jsonNetwork = (payload: unknown = { ok: true }) => vi.fn(async () => Response.json(payload)) as unknown as typeof fetch
const IMAGE = 'A'.repeat(5000)

describe('recording', () => {
  it('records the request, the response, status and kind', async () => {
    const log = newCallLog({ jobId: 'j1' })
    const body = await inScope(log, null, jsonNetwork({ answers: [1] }), async (f) =>
      (await f('https://api.openai.com/v1/decisions', { method: 'POST', body: JSON.stringify({ q: 1 }) })).json())

    expect(body).toEqual({ answers: [1] })
    expect(log.entries).toHaveLength(1)
    expect(log.entries[0]).toMatchObject({
      seq: 1, kind: 'decisions', method: 'POST', status: 200, replayed: false,
      request: '{"q":1}', response: '{"answers":[1]}',
    })
  })

  it('never stores an API key from the URL', async () => {
    const log = newCallLog({ jobId: 'j1' })
    await inScope(log, null, jsonNetwork(), (f) => f('https://api.scrapfly.io/scrape?key=scp-live-SECRET&url=https%3A%2F%2Fexample.com'))

    expect(JSON.stringify(log)).not.toContain('scp-live-SECRET')
    expect(log.entries[0]!.url).toContain('key=REDACTED')
    expect(log.entries[0]!.url).toContain('example.com')
  })

  it('stores a digest instead of inline image data', async () => {
    const log = newCallLog({ jobId: 'j1' })
    const request = JSON.stringify({ input: [{ image_url: `data:image/jpeg;base64,${IMAGE}` }] })
    await inScope(log, null, jsonNetwork(), (f) => f('https://api.openai.com/v1/decisions', { method: 'POST', body: request }))

    expect(log.entries[0]!.request).toContain('[5000 chars')
    expect(log.entries[0]!.request!.length).toBeLessThan(300)
  })

  it('keeps only the type and size of a binary response', async () => {
    const log = newCallLog({ jobId: 'j1' })
    const network = vi.fn(async () => new Response(new Uint8Array(64), { headers: { 'content-type': 'image/png', 'content-length': '64' } })) as unknown as typeof fetch
    const bytes = await inScope(log, null, network, async (f) => (await (await f('https://maps.googleapis.com/maps/api/staticmap?key=g')).arrayBuffer()).byteLength)

    expect(bytes).toBe(64)
    expect(log.entries[0]).toMatchObject({ kind: 'imagery', response: null, responseType: 'image/png', responseBytes: 64 })
  })

  it('records a failed call and still throws to the caller', async () => {
    const log = newCallLog({ jobId: 'j1' })
    const network = vi.fn(async () => { throw new Error('socket hang up') }) as unknown as typeof fetch
    await expect(inScope(log, null, network, (f) => f('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}' }))).rejects.toThrow('socket hang up')

    expect(log.entries[0]).toMatchObject({ kind: 'reasoning', status: null, error: 'socket hang up' })
  })

  it('records nothing outside a run', async () => {
    const network = jsonNetwork()
    const f = recordingFetch(network)
    await f('https://api.anthropic.com/v1/messages')
    expect(network).toHaveBeenCalledTimes(1)
  })

  it('keeps two concurrent runs in separate logs', async () => {
    const a = newCallLog({ jobId: 'a' }); const b = newCallLog({ jobId: 'b' })
    const network = vi.fn(async (input: RequestInfo | URL) => {
      await new Promise((r) => setTimeout(r, String(input).includes('slow') ? 20 : 1))
      return Response.json({ url: String(input) })
    }) as unknown as typeof fetch
    const f = recordingFetch(network)
    await Promise.all([
      runWithCallLog(a, {}, async () => { await f('https://x.test/slow-a'); await f('https://x.test/a2') }),
      runWithCallLog(b, {}, async () => { await f('https://x.test/b1') }),
    ])

    expect(a.entries.map((e) => e.url)).toEqual(['https://x.test/slow-a', 'https://x.test/a2'])
    expect(b.entries.map((e) => e.url)).toEqual(['https://x.test/b1'])
  })
})

describe('replay', () => {
  const record = async () => {
    const log = newCallLog({ jobId: 'armA' })
    await inScope(log, null, jsonNetwork({ comps: [1, 2, 3] }), (f) =>
      f('https://api.corelogic.com/property?key=k1', { method: 'POST', body: '{"address":"1 A St"}' }))
    return log
  }

  it('answers an identical request from the earlier log without a network call', async () => {
    const first = await record()
    const second = newCallLog({ jobId: 'armB', replayedFrom: 'armA' })
    const network = jsonNetwork({ comps: ['different'] })
    const body = await inScope(second, first, network, async (f) =>
      (await f('https://api.corelogic.com/property?key=ROTATED', { method: 'POST', body: '{"address":"1 A St"}' })).json())

    expect(body).toEqual({ comps: [1, 2, 3] })
    expect(network).not.toHaveBeenCalled()
    expect(second.entries[0]).toMatchObject({ replayed: true, status: 200, response: '{"comps":[1,2,3]}' })
  })

  it('goes to the network when the request differs at all', async () => {
    const first = await record()
    const second = newCallLog({ jobId: 'armB' })
    const network = jsonNetwork({ comps: ['fresh'] })
    const body = await inScope(second, first, network, async (f) =>
      (await f('https://api.corelogic.com/property?key=k1', { method: 'POST', body: '{"address":"2 B St"}' })).json())

    expect(body).toEqual({ comps: ['fresh'] })
    expect(network).toHaveBeenCalledTimes(1)
    expect(second.entries[0]!.replayed).toBe(false)
  })
})

describe('large bodies', () => {
  const PAGE = '<html>' + 'x'.repeat(50_000) + '</html>'
  const pageNetwork = () => vi.fn(async () => new Response(PAGE, { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch

  it('stores a large response under its own key, with the expiry, and keeps the index small', async () => {
    const store = memoryStore()
    const log = newCallLog({ jobId: 'j1' })
    const text = await inScope(log, null, pageNetwork(), async (f) => (await f('https://api.scrapfly.io/scrape?key=k&url=u')).text(), store)
    await saveCallLog(store, log)

    expect(text).toBe(PAGE)
    const entry = log.entries[0]!
    expect(entry.response).toBeNull()
    expect(entry.truncated).toBe(false)
    expect(store.values.get(entry.responseKey!)).toBe(PAGE)
    expect(store.put).toHaveBeenCalledWith(entry.responseKey, PAGE, { expirationTtl: CALL_LOG_TTL_SECONDS })
    expect(store.values.get(callLogKey('j1'))!.length).toBeLessThan(2000)
    expect((await loadCallBodies(store, entry)).response).toBe(PAGE)
  })

  it('replays a large response from its key', async () => {
    const store = memoryStore()
    const first = newCallLog({ jobId: 'armA' })
    await inScope(first, null, pageNetwork(), (f) => f('https://api.scrapfly.io/scrape?key=k&url=u'), store)
    await saveCallLog(store, first)

    const second = newCallLog({ jobId: 'armB' })
    const network = jsonNetwork()
    const text = await inScope(second, await loadCallLog(store, 'armA'), network, async (f) => (await f('https://api.scrapfly.io/scrape?key=k2&url=u')).text(), store)

    expect(text).toBe(PAGE)
    expect(network).not.toHaveBeenCalled()
    expect(second.entries[0]!.replayed).toBe(true)
  })

  it('keeps only the head of a large error page, and replays the failure as a failure', async () => {
    const store = memoryStore()
    const first = newCallLog({ jobId: 'armA' })
    const failing = vi.fn(async () => new Response(PAGE, { status: 429, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    await inScope(first, null, failing, (f) => f('https://api.scrapfly.io/scrape?key=k&url=u'), store)

    expect(first.entries[0]).toMatchObject({ status: 429, truncated: true })
    expect(first.entries[0]!.response!.length).toBe(2000)
    expect(first.entries[0]!.responseKey).toBeUndefined()

    // The next arm must hit the same wall, not quietly succeed where A failed.
    const second = newCallLog({ jobId: 'armB' })
    const network = jsonNetwork()
    const status = await inScope(second, first, network, async (f) => (await f('https://api.scrapfly.io/scrape?key=k&url=u')).status, store)
    expect(status).toBe(429)
    expect(network).not.toHaveBeenCalled()
  })

  it('marks a large body as not stored when there is no store', async () => {
    const log = newCallLog({ jobId: 'j1' })
    await inScope(log, null, pageNetwork(), (f) => f('https://api.scrapfly.io/scrape?key=k&url=u'))
    expect(log.entries[0]).toMatchObject({ response: null, truncated: true })
  })
})

describe('storage', () => {
  it('saves under the job id with a 90-day expiry and loads it back', async () => {
    const kv = new Map<string, string>()
    const put = vi.fn(async (key: string, value: string) => { kv.set(key, value) })
    const store = { put, get: async (key: string) => kv.get(key) ?? null }
    const log = newCallLog({ jobId: 'j9', userId: 'u1', address: '1 A St', meta: { arm: 'A' } })

    expect(await saveCallLog(store, log)).toBe(true)
    expect(put).toHaveBeenCalledWith(callLogKey('j9'), expect.any(String), { expirationTtl: 90 * 24 * 60 * 60 })
    expect(CALL_LOG_TTL_SECONDS).toBe(7_776_000)
    const loaded = await loadCallLog(store, 'j9')
    expect(loaded).toMatchObject({ jobId: 'j9', userId: 'u1', meta: { arm: 'A' } })
    expect(loaded?.finishedAt).not.toBeNull()
    expect(await loadCallLog(store, 'missing')).toBeNull()
  })

  it('does not throw when the store fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = { put: async () => { throw new Error('kv down') }, get: async () => null }
    expect(await saveCallLog(store, newCallLog({ jobId: 'j' }))).toBe(false)
  })
})

describe('helpers', () => {
  it('redacts credentials but keeps the rest of the URL', () => {
    expect(redactUrl('https://a.test/x?key=1&url=https%3A%2F%2Fb.test&token=2')).toBe('https://a.test/x?key=REDACTED&url=https%3A%2F%2Fb.test&token=REDACTED')
  })

  it('classifies calls by where they go', () => {
    expect(classifyCall('https://api.openai.com/v1/decisions')).toBe('decisions')
    expect(classifyCall('https://api.anthropic.com/v1/messages')).toBe('reasoning')
    expect(classifyCall('https://openrouter.ai/api/v1/chat/completions')).toBe('reasoning')
    expect(classifyCall('https://api.scrapfly.io/scrape')).toBe('scrape')
    expect(classifyCall('https://maps.googleapis.com/maps/api/staticmap')).toBe('imagery')
    expect(classifyCall('https://ssl.cdn-redfin.com/photo/1.jpg')).toBe('photo')
  })

  it('summarizes calls per kind', async () => {
    const log = newCallLog({ jobId: 'j' })
    await inScope(log, null, jsonNetwork(), async (f) => {
      await f('https://api.openai.com/v1/decisions', { method: 'POST', body: '1' })
      await f('https://api.openai.com/v1/decisions', { method: 'POST', body: '2' })
      await f('https://api.anthropic.com/v1/messages', { method: 'POST', body: '3' })
    })
    const summary = summarizeCallLog(log)
    expect(summary.decisions).toMatchObject({ calls: 2, replayed: 0, failed: 0 })
    expect(summary.reasoning!.calls).toBe(1)
  })

  it('reports latency per model, counting only calls that really went out', async () => {
    const first = newCallLog({ jobId: 'a' })
    const slow = vi.fn(async () => { await new Promise((r) => setTimeout(r, 15)); return Response.json({ ok: 1 }) }) as unknown as typeof fetch
    const ask = (f: typeof fetch, model: string, n: number) =>
      f('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model, messages: [n] }) })
    await inScope(first, null, slow, async (f) => { await ask(f, 'deepseek/deepseek-v4.1-flash', 1); await ask(f, 'deepseek/deepseek-v4.1-flash', 2) })
    const models = summarizeModelCalls(first)
    expect(models['deepseek/deepseek-v4.1-flash']).toMatchObject({ calls: 2, replayed: 0 })
    expect(models['deepseek/deepseek-v4.1-flash']!.avgMs).toBeGreaterThanOrEqual(10)

    const second = newCallLog({ jobId: 'b' })
    await inScope(second, first, slow, (f) => ask(f, 'deepseek/deepseek-v4.1-flash', 1))
    expect(summarizeModelCalls(second)['deepseek/deepseek-v4.1-flash']).toMatchObject({ calls: 0, replayed: 1, ms: 0 })
  })
})
