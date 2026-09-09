import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { evaluateHostedPython } from '../src/services/evaluation/python-hosted'
import type { Env } from '../src/types'

const input = JSON.parse(readFileSync(0, 'utf8'))
const local = new URL(input.localOrigin)
assert.equal(local.hostname, '127.0.0.1')
assert.equal(local.protocol, 'http:')
const originalFetch = globalThis.fetch
globalThis.fetch = (url, options) => {
  const source = new URL(String(url))
  assert.equal(source.origin, 'https://flowstate-v4-staging-python.onrender.com')
  return originalFetch(new URL(source.pathname, local), options)
}
try {
  const env = { ENVIRONMENT: 'staging', EVALUATION_ENGINE: 'python-v4', V4_HOSTED_API_URL: 'https://flowstate-v4-staging-python.onrender.com', V4_HOSTED_USER_CREDENTIALS: JSON.stringify({ [input.user]: { token: input.token, tenantId: input.tenant } }) } as Env
  for (const policy of ['legacy_physical_v1', 'provider_authoritative_upper_half_v2']) {
    for (const selected of [['c2'], null]) {
      const request = { ...input.request, settings: { ...input.request.settings, arv_selection_policy: policy }, selected_comp_ids: selected }
      const result = await evaluateHostedPython(request, env, { jobId: 'http-integration', userId: input.user })
      assert.deepEqual(result.arv?.accepted_comp_ids, selected ?? (policy === 'legacy_physical_v1' ? ['c1'] : ['c1', 'c2']))
      assert.equal(result.arv?.final_arv, selected ? '580000' : policy === 'legacy_physical_v1' ? '590000' : '585000.0')
    }
  }
  console.log('Real HTTP durable Python worker: manual ARV and reset pass')
} finally { globalThis.fetch = originalFetch }
