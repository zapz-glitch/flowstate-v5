/**
 * Cache policy (owner, 2026-10-27): property facts 90–180 days, comps and
 * ARV 30 days. Comps + ARV keys rolled once — entries written before the
 * ATTOM sale-date fix carry undated comps and must never be served.
 */
import assert from 'node:assert/strict'
import { CACHE_TTL, comparablesKey } from '../src/services/cache'
import { EVAL_RESULT_TTL, evalResultKey } from '../src/utils/eval-cache'

const DAY = 24 * 60 * 60
assert.equal(CACHE_TTL.PROPERTY_DETAILS, 90 * DAY, 'property facts: 90 days')
assert.equal(CACHE_TTL.COMPARABLES, 30 * DAY, 'comps: 30 days')
assert.equal(EVAL_RESULT_TTL, 30 * DAY, 'ARV result: 30 days')
assert.ok(comparablesKey('1', 1, 12, 'attom-mcp').includes('search-v5:'), 'comps key rolled past undated entries')
assert.ok(evalResultKey('u', 'a', 'h').startsWith('eval-result:v5:'), 'ARV key rolled past undated entries')

console.log('cache policy: passed')
