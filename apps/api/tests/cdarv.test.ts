/**
 * cdarv route regression: /cdarv/* proxy + /internal/cdarv/recalculate
 *
 * Covers the trust boundaries that protect production:
 *  - /cdarv/* requires a session (401 without cookies)
 *  - /internal/cdarv/* requires the shared service token (401 without it)
 *  - internal recalc validates input and 404s unknown reports
 *  - service unconfigured => fail closed, never hangs the request
 */
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { cdarv, cdarvInternal } from '../src/routes/cdarv'

function fakeDb(rows: Array<Record<string, unknown>> = []) {
  return {
    prepare(_sql: string) {
      return {
        bind(..._binds: unknown[]) {
          return {
            all: async <T>() => ({ results: rows as T[] }),
            first: async <T>() => (rows[0] as T) ?? null,
          }
        },
      }
    },
  }
}

function app(env: Record<string, unknown>) {
  const a = new Hono()
  a.route('/cdarv', cdarv)
  a.route('/internal/cdarv', cdarvInternal)
  return (req: Request) => a.fetch(req, env)
}

const BASE_ENV = { DB: fakeDb(), BETTER_AUTH_SECRET: 'test-secret' }

// ─── Session gate ────────────────────────────────────────────────────────────

{
  const res = await app(BASE_ENV)(
    new Request('http://t/cdarv/submissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reportIds: ['r1'] }),
    })
  )
  assert.equal(res.status, 401, 'submissions without session must 401')
}

{
  const res = await app(BASE_ENV)(new Request('http://t/cdarv/proxy/queue'))
  assert.equal(res.status, 401, 'proxy without session must 401')
}

// ─── Internal recalc token gate ─────────────────────────────────────────────

{
  // No token configured at all => reject (fail closed, not open)
  const res = await app(BASE_ENV)(
    new Request('http://t/internal/cdarv/recalculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reportId: 'r1', selectedCompIds: ['c1'] }),
    })
  )
  assert.equal(res.status, 401, 'recalc with no configured token must 401')
}

{
  const env = { ...BASE_ENV, CDARV_INTERNAL_API_TOKEN: 'shared-token' }
  const res = await app(env)(
    new Request('http://t/internal/cdarv/recalculate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CDARV-Internal-Secret': 'wrong',
      },
      body: JSON.stringify({ reportId: 'r1', selectedCompIds: ['c1'] }),
    })
  )
  assert.equal(res.status, 401, 'recalc with wrong token must 401')
}

{
  const env = { ...BASE_ENV, CDARV_INTERNAL_API_TOKEN: 'shared-token' }
  const res = await app(env)(
    new Request('http://t/internal/cdarv/recalculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer shared-token' },
      body: JSON.stringify({ reportId: 'r1' }),
    })
  )
  assert.equal(res.status, 400, 'recalc without selectedCompIds must 400')
}

{
  // Correct token but report not found => 404 (never fabricates a result)
  const env = { ...BASE_ENV, CDARV_INTERNAL_API_TOKEN: 'shared-token', DB: fakeDb([]) }
  const res = await app(env)(
    new Request('http://t/internal/cdarv/recalculate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CDARV-Internal-Secret': 'shared-token' },
      body: JSON.stringify({ reportId: 'missing', selectedCompIds: ['c1'] }),
    })
  )
  assert.equal(res.status, 404, 'recalc for unknown report must 404')
}

console.log('cdarv.test.ts: all assertions passed')
