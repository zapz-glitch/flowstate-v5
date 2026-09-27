import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { test } from 'node:test'
import { transformSync } from 'esbuild'

const { code } = transformSync(readFileSync(new URL('./server-action.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' })
const module = { exports: {} }
vm.runInNewContext(code, { module, exports: module.exports })
const { isStaleServerActionError, isChunkLoadError } = module.exports

test('stale server action errors match reported strings', () => {
  assert.equal(isStaleServerActionError(new Error('Failed to find Server Action "a1b2c3".')), true)
  assert.equal(isStaleServerActionError(new Error('Server Action "0f9e" was not found on the server.')), true)
  assert.equal(isStaleServerActionError(new Error('Some other error')), false)
  assert.equal(isStaleServerActionError(null), false)
})

test('chunk load errors match what browsers actually emit', () => {
  const webpack = new Error('Loading chunk 4312 failed.')
  webpack.name = 'ChunkLoadError'
  assert.equal(isChunkLoadError(webpack), true)
  // Chrome dynamic-import failure
  assert.equal(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/_next/static/chunks/abc.js')), true)
  // Firefox
  assert.equal(isChunkLoadError(new Error('error loading dynamically imported module: https://x/chunk.js')), true)
  // Safari
  assert.equal(isChunkLoadError(new Error('Importing a module script failed.')), true)
  // Non-matches stay clear
  assert.equal(isChunkLoadError(new Error('Network request failed')), false)
  assert.equal(isChunkLoadError('Failed to find Server Action'), false)
  assert.equal(isChunkLoadError(undefined), false)
})
