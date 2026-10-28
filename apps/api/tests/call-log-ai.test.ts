/**
 * Workers AI (Clef) calls go through the env.AI binding, not fetch — the
 * call log missed them, so ~65s of a 87s run showed no calls at all
 * (1715 1st St, 2026-10-28). The AI recorder logs each run: model, the
 * questions asked, image count, time, failure.
 */
import assert from 'node:assert/strict'
import { newCallLog, runWithCallLog, recordingAi, summarizeCallLog } from '../src/services/observability/call-log'

const ai = recordingAi({
  run: async (model: string, input: { questions?: Record<string, unknown> }) => {
    await new Promise((r) => setTimeout(r, 20))
    if ('fail' in (input.questions ?? {})) throw new Error('clef 503')
    return { model, answers: {} }
  },
})
const log = newCallLog({ jobId: 'job_t' })
await runWithCallLog(log, {}, async () => {
  await ai.run('@cf/cloudflare/clef', { questions: { water: {}, exposure: {} }, images: [{}, {}] })
  await ai.run('@cf/cloudflare/clef-flash', { questions: { fail: {} } }).catch(() => null)
})
assert.equal(log.entries.length, 2)
const [a, b] = log.entries
assert.equal(a.kind, 'clef')
assert.equal(a.model, '@cf/cloudflare/clef')
assert.equal(a.url, 'workers-ai://@cf/cloudflare/clef?q=water,exposure&images=2')
assert.ok(a.ms >= 15)
assert.equal(a.status, 200)
assert.equal(b.status, 500)
assert.equal(summarizeCallLog(log).clef.calls, 2)

// Outside a call-log scope the binding is passed straight through.
assert.deepEqual(await ai.run('m', {}), { model: 'm', answers: {} })
assert.equal(log.entries.length, 2)

console.log('call log ai: passed')
