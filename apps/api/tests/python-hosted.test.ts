import assert from 'node:assert/strict'
import { evaluateHostedPython } from '../src/services/evaluation/python-hosted'
import type { PythonRequest } from '../src/services/evaluation/python'
import type { Env } from '../src/types'

const env = { ENVIRONMENT: 'staging', EVALUATION_ENGINE: 'python-v4', V4_HOSTED_API_URL: 'https://flowstate-v4-staging-python.onrender.com', V4_HOSTED_USER_CREDENTIALS: JSON.stringify({ alice: { token: 'synthetic-test-token-not-a-secret-0001', tenantId: 'staging' } }) } as Env
const context = { jobId: 'job-one', userId: 'alice' }
const request = { methodology_version: 'evaluation-v4', evaluation_date: '2026-09-01', subject: { sqft: '2000' }, comps: [], settings: { snapshot_id: 'test' }, selected_comp_ids: ['c2'] } as unknown as PythonRequest
const id = '12345678-1234-1234-1234-123456789abc'
const result = { methodology_version: 'evaluation-v4', decisions: [], status: 'INSUFFICIENT_COMPS', arv: null }
const originalFetch = globalThis.fetch
let keys: string[] = []
let calls = 0
let mode = 'ok'
globalThis.fetch = async (url, options) => {
  calls++
  assert.equal(options?.redirect, 'manual')
  assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer synthetic-test-token-not-a-secret-0001')
  if (mode === 'unauthorized') return Response.json({}, { status: 401 })
  if (mode.startsWith('redirect-')) return new Response(null, { status: Number(mode.slice(9)), headers: { Location: 'https://untrusted.example/collect' } })
  if (options?.method === 'POST') {
    const body = JSON.parse(String(options.body))
    assert.equal(body.candidate_evidence_mode, 'preloaded')
    assert.equal(body.evaluations.length, 1)
    assert.deepEqual(body.evaluations[0].selected_comp_ids, request.selected_comp_ids)
    assert(!('methodology_version' in body.evaluations[0]))
    const key = (options.headers as Record<string, string>)['Idempotency-Key']
    assert.equal(key, body.evaluations[0].idempotency_key)
    keys.push(key)
    return Response.json({ batch_id: 'batch', evaluations: [{ evaluation_id: mode === 'bad-id' ? '../secrets' : id, idempotency_key: key }] })
  }
  assert(String(url).endsWith(`/v1/evaluations/${id}`))
  return Response.json({ evaluation_id: id, requested_by_user_id: mode === 'wrong-user' ? 'bob' : 'alice', batch_id: mode === 'wrong-batch' ? 'other' : 'batch', tenant_id: mode === 'wrong-tenant' ? 'other' : 'staging', status: mode === 'failed' ? 'FAILED' : mode === 'pending' ? 'QUEUED' : 'INSUFFICIENT_COMPS', result: mode === 'invalid-result' ? {} : result })
}
try {
  assert.deepEqual(await evaluateHostedPython(request, env, context), result)
  await evaluateHostedPython(request, env, context)
  assert.equal(keys[0], keys[1])
  await evaluateHostedPython(request, env, { ...context, jobId: 'job-two' })
  assert.notEqual(keys[0], keys[2])
  for (const environment of ['production', 'development', '']) await assert.rejects(evaluateHostedPython(request, { ...env, ENVIRONMENT: environment }, context), /staging/)
  const before = calls
  await assert.rejects(evaluateHostedPython(request, env), /ownership/)
  await assert.rejects(evaluateHostedPython(request, env, { ...context, userId: 'bob' }), /not configured/)
  for (const url of ['http://localhost:8788', 'https://evil.example', 'https://x.onrender.com/extra', 'https://user:pass@x.onrender.com', 'https://x.onrender.com?token=bad']) await assert.rejects(evaluateHostedPython(request, { ...env, V4_HOSTED_API_URL: url }, context))
  assert.equal(calls, before)
  for (mode of ['unauthorized', 'bad-id', 'wrong-batch', 'wrong-tenant', 'wrong-user', 'failed', 'invalid-result']) await assert.rejects(evaluateHostedPython(request, env, context))
  for (const status of [301, 302, 303, 307, 308]) {
    mode = `redirect-${status}`
    const beforeRedirect = calls
    await assert.rejects(evaluateHostedPython(request, env, context), /submission failed/)
    assert.equal(calls, beforeRedirect + 1)
  }
  mode = 'pending'
  const timeout = AbortSignal.timeout
  AbortSignal.timeout = () => timeout(10)
  try { await assert.rejects(evaluateHostedPython(request, env, context), /timed out|aborted/i) } finally { AbortSignal.timeout = timeout }
} finally { globalThis.fetch = originalFetch }
console.log('Hosted Python: frozen submission, idempotency, user isolation, endpoint restrictions, failures and bounded polling pass')
