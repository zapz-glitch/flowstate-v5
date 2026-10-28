/**
 * Cache policy (owner, 2026-10-27): property facts 90–180 days, comps and
 * ARV 30 days. Comps + ARV keys rolled once — entries written before the
 * ATTOM sale-date fix carry undated comps and must never be served.
 * 2026-10-28: everything an evaluation pulls lives 30 days on our side
 * (permits, photo reads too); ARV key rolled past pools that held a flip's
 * buy leg or the subject's own sale.
 */
import assert from 'node:assert/strict'
import { CACHE_TTL, comparablesKey } from '../src/services/cache'
import { EVAL_RESULT_TTL, EVAL_RESULT_TTL_SECONDS, evalResultKey, cachePolicyFor } from '../src/utils/eval-cache'

const DAY = 24 * 60 * 60
assert.equal(CACHE_TTL.PROPERTY_DETAILS, 90 * DAY, 'property facts: 90 days')
assert.equal(CACHE_TTL.COMPARABLES, 30 * DAY, 'comps: 30 days')
assert.equal(EVAL_RESULT_TTL, 30 * DAY, 'ARV result: 30 days')
assert.equal(EVAL_RESULT_TTL_SECONDS, EVAL_RESULT_TTL, 'one evaluation TTL, not two')
assert.equal(CACHE_TTL.PERMITS, 30 * DAY, 'permits: 30 days')
assert.equal(CACHE_TTL.VISION_ANALYSIS, 30 * DAY, 'photo condition reads: 30 days')
assert.ok(comparablesKey('1', 1, 12, 'attom-mcp').includes('search-v5:'), 'comps key rolled past undated entries')
assert.ok(evalResultKey('u', 'a', 'h').startsWith('eval-result:v6:'), 'ARV key rolled past buy-leg / self-comp pools')

// What a request may reuse. Default: the stored answer (30 days) and the
// provider caches. rerun: re-evaluate on cached provider data — what
// harness tests use so they don't pay ATTOM again inside the window.
// skipCache / refresh: nothing cached.
assert.deepEqual(cachePolicyFor({}, false), { readStoredResult: true, skipProviderCache: false })
assert.deepEqual(cachePolicyFor({ rerun: true }, false), { readStoredResult: false, skipProviderCache: false })
assert.deepEqual(cachePolicyFor({ skipCache: true }, false), { readStoredResult: false, skipProviderCache: true })
assert.deepEqual(cachePolicyFor({ rerun: true }, true), { readStoredResult: false, skipProviderCache: true })

console.log('cache policy: passed')
