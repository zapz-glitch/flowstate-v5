import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'
import { transformSync } from 'esbuild'

const { code } = transformSync(readFileSync(new URL('./pending-address.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' })
const module = { exports: {} }
vm.runInNewContext(code, { module, exports: module.exports, URLSearchParams })
const { stashPendingAddress, takePostSignInPath } = module.exports

function fakeStore() {
  const data = new Map()
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) }
}

test('an address link survives the sign-in bounce, once', () => {
  const store = fakeStore()
  stashPendingAddress('/dashboard/analyze', '?address=123%20Main%20St%20%234%2C%20Houston', store)
  assert.equal(takePostSignInPath(store), '/dashboard/analyze?address=123%20Main%20St%20%234%2C%20Houston')
  assert.equal(takePostSignInPath(store), '/dashboard/analyze')
})

test('nothing is kept for other pages, blank addresses, or blocked storage', () => {
  const store = fakeStore()
  stashPendingAddress('/dashboard/reports', '?address=1%20A%20St', store)
  stashPendingAddress('/dashboard/analyze', '?address=%20%20', store)
  stashPendingAddress('/dashboard/analyze', '', store)
  assert.equal(takePostSignInPath(store), '/dashboard/analyze')

  const blocked = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() {} }
  assert.doesNotThrow(() => stashPendingAddress('/dashboard/analyze', '?address=1%20A%20St', blocked))
  assert.equal(takePostSignInPath(blocked), '/dashboard/analyze')
})
