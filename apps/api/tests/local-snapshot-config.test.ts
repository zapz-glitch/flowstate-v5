import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { parseEnv } from 'node:util'

const source = readFileSync(new URL('../../../scripts/local-candidate.mjs', import.meta.url), 'utf8')
const encodeSource = source.slice(source.indexOf('function encodeEnvironment('), source.indexOf('function snapshotConfiguration('))
const encoding = vm.createContext({ values: { V4_SNAPSHOT_KEYS: JSON.stringify({ old: 'a'.repeat(32) }), V4_SNAPSHOT_LEGACY_KEYS: JSON.stringify(['b'.repeat(32)]), V4_LOCAL_BRIDGE_TOKEN: 'test-token' } })
vm.runInContext(encodeSource, encoding)
const roundTrip = parseEnv(vm.runInContext('encodeEnvironment(values)', encoding))
assert.deepEqual(roundTrip, encoding.values)
assert.equal(JSON.parse(roundTrip.V4_SNAPSHOT_KEYS).old, 'a'.repeat(32))
const functionSource = source.slice(source.indexOf('function snapshotConfiguration('), source.indexOf("\nif (command === 'init')"))
const oldKey = 'synthetic-old-key-000000000000000000'
const newKey = 'synthetic-new-key-000000000000000000'
const cached = { V4_SNAPSHOT_ACTIVE_KEY_ID: 'old', V4_SNAPSHOT_KEYS: JSON.stringify({ old: oldKey }), V4_SNAPSHOT_LEGACY_KEYS: '[]' }
let written: any
const context = vm.createContext({ state: '/synthetic', resolve: (...parts: string[]) => parts.join('/'), existsSync: () => true, readFileSync: () => JSON.stringify(cached), save: (_path: string, content: string) => { written = JSON.parse(content) }, randomBytes: () => { throw new Error('Must not generate replacement keys') } })
vm.runInContext(functionSource, context)
context.current = { V4_SNAPSHOT_ACTIVE_KEY_ID: 'new', V4_SNAPSHOT_KEYS: JSON.stringify({ old: oldKey, new: newKey }), V4_SNAPSHOT_LEGACY_KEYS: '[]' }
vm.runInContext('snapshotConfiguration(current)', context)
assert.deepEqual(written, context.current)
assert.equal(JSON.parse(written.V4_SNAPSHOT_KEYS).old, oldKey)
written = undefined
context.current = { V4_SNAPSHOT_ACTIVE_KEY_ID: 'missing' }
assert.throws(() => vm.runInContext('snapshotConfiguration(current)', context), /Invalid local snapshot/)
assert.equal(written, undefined)
console.log('Local snapshot setup preserves explicit rotated keys and rejects incomplete configuration before writes')
