/**
 * The subject is never its own comp. ATTOM market-context returns recent
 * sales near the subject — the subject's own resale included — and the
 * supplement's seen-set held only the pool, not the subject.
 */
import assert from 'node:assert/strict'
import { dropSubjectSelf } from '../src/services/property-api/comparable-pool'

const subject = { id: '145466011', address: '8609 Fish Lake Rd' }
const comps = [
  { id: '145466011', address: '8609 Fish Lake Rd' },          // same ATTOM id
  { id: '999', address: '8609 FISH LAKE RD.' },              // same street address, other id
  { id: '100', address: '8611 Fish Lake Rd' },                // next door stays
  { id: '101', address: null },
]
assert.deepEqual(dropSubjectSelf(comps, subject).map((c) => c.id), ['100', '101'])
// Nothing to match on → nothing dropped.
assert.equal(dropSubjectSelf(comps, { id: null, address: null }).length, 4)

console.log('subject self-comp: passed')
