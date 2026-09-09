import assert from 'node:assert/strict'
import { signPythonSnapshot, verifyPythonSnapshot, signConfiguredPythonSnapshot, verifyConfiguredPythonSnapshot } from '../src/services/evaluation/python-snapshot'

const secret = 'synthetic-test-only-signature-secret-000000'
const request = { subject: { subject_id: 'subject' }, comps: [{ comp_id: 'comp', verified_sale_price: '300000' }], settings: { closing_cost_percent: '8' }, selected_ids: ['comp'] }
const signature = await signPythonSnapshot('job-one', request, secret)
assert.match(signature, /^[0-9a-f]{64}$/)
assert.equal(await verifyPythonSnapshot('job-one', JSON.parse(JSON.stringify(request)), signature, secret), true)
assert.equal(await verifyPythonSnapshot('job-two', request, signature, secret), false)
assert.equal(await verifyPythonSnapshot('job-one', request, signature, `${secret}wrong`), false)
for (const tampered of [
  { ...request, comps: [{ comp_id: 'comp', verified_sale_price: '900000' }] },
  { ...request, settings: { closing_cost_percent: '0' } },
  { ...request, selected_ids: ['other'] },
]) assert.equal(await verifyPythonSnapshot('job-one', tampered, signature, secret), false)
for (const malformed of ['', signature.toUpperCase(), `${signature}00`, 'g'.repeat(64), '0'.repeat(64)]) {
  assert.equal(await verifyPythonSnapshot('job-one', request, malformed, secret), false)
}
assert.equal(await verifyPythonSnapshot('job-one', request, signature, 'short'), false)
await assert.rejects(signPythonSnapshot('job-one', request, 'short'), /at least 32/)
await assert.rejects(signPythonSnapshot('', request, secret), /job ID/)
console.log('Python snapshot HMAC: serialization roundtrip, request/job/secret tampering and malformed signatures passed')
const independent = 'synthetic-independent-signing-secret-00002'
const config = { V4_SNAPSHOT_ACTIVE_KEY_ID: 'one', V4_SNAPSHOT_KEYS: JSON.stringify({ one: independent }), V4_SNAPSHOT_LEGACY_KEYS: JSON.stringify([secret]) }
const versioned = await signConfiguredPythonSnapshot('job-one', request, config)
assert.match(versioned, /^v2\.one\.[a-f0-9]{64}$/)
assert(await verifyConfiguredPythonSnapshot('job-one', request, versioned, config))
assert(await verifyConfiguredPythonSnapshot('job-one', request, signature, config))
const rotated = { ...config, V4_SNAPSHOT_ACTIVE_KEY_ID: 'two', V4_SNAPSHOT_KEYS: JSON.stringify({ one: independent, two: independent + 'rotated' }) }
assert(await verifyConfiguredPythonSnapshot('job-one', request, versioned, rotated))
assert(await verifyConfiguredPythonSnapshot('job-one', request, await signConfiguredPythonSnapshot('job-one', request, rotated), rotated))
assert(!await verifyConfiguredPythonSnapshot('job-one', request, versioned.replace('.one.', '.two.'), rotated))
assert(!await verifyConfiguredPythonSnapshot('job-two', request, versioned, rotated))
assert(!await verifyConfiguredPythonSnapshot('job-one', { ...request, injected: true }, versioned, rotated))
assert(!await verifyConfiguredPythonSnapshot('job-one', request, signature, { ...config, V4_SNAPSHOT_LEGACY_KEYS: '[]' }))
await assert.rejects(signConfiguredPythonSnapshot('job-one', request, {}), /not configured/)
console.log('Versioned snapshot keys: independent signing, old/new key rotation and explicit legacy verification passed')
