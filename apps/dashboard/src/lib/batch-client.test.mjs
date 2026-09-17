import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'
import { transformSync } from 'esbuild'

function load(fetch, getImpersonatedUserId = () => null) {
  const source = readFileSync(new URL('./batch-client.ts', import.meta.url), 'utf8')
  const { code } = transformSync(source, { loader: 'ts', format: 'cjs' })
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports, fetch,
    process: { env: { NEXT_PUBLIC_API_URL: 'https://api.example.test' } },
    require: () => ({ getImpersonatedUserId }),
  })
  return module.exports
}

test('detail reads run concurrently with cookies and no cache or preflight header', async () => {
  const requests = []
  const pending = []
  const api = load((url, options) => {
    requests.push({ url, options })
    return new Promise(resolve => pending.push(resolve))
  })
  const a = api.getBatchStatus('a/b')
  const b = api.getBatchStatus('second')
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, 'https://api.example.test/batch/a%2Fb')
  for (const { options } of requests) {
    assert.equal(options.credentials, 'include')
    assert.equal(options.cache, 'no-store')
    assert.equal(Object.keys(options.headers).length, 0)
  }
  pending.forEach((resolve, i) => resolve({ ok: true, json: async () => ({ id: i }) }))
  assert.equal((await a).id, 0)
  assert.equal((await b).id, 1)
})

test('each read resolves current impersonation and surfaces failure instead of an empty list', async () => {
  let user = 'first'
  const users = []
  const api = load(async (_, options) => {
    users.push(options.headers['X-Impersonate-User-Id'])
    return { ok: false, status: 403 }
  }, () => user)
  await assert.rejects(api.getBatchJobs(), /403/)
  user = 'second'
  await assert.rejects(api.getBatchStatus('b'), /403/)
  assert.deepEqual(users, ['first', 'second'])
})
