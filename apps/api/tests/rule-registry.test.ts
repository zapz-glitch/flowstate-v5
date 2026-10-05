import assert from 'node:assert/strict'
import { checksForFlags, ruleIdForFlag } from '../src/services/analysis/rule-registry'

assert.equal(ruleIdForFlag('T3 as-is AVM floor — ARV ≥ AVM, uplift unverified'), 'setb.t3.avm_floor')
assert.equal(ruleIdForFlag('1671 Lamont Ave: verification — Sale is 220 days old — outside preferred 180-day window'), 'evidence.sale_age.stale')
assert.equal(ruleIdForFlag('1671 Lamont Ave: verification — Sale at $70/sf is 44% of current pocket $158/sf — below current pocket, verify market fit'), 'evidence.market_fit.below_pocket')
assert.equal(ruleIdForFlag('anchored to 1671 Lamont Ave (similarity 11.0)'), 'setb.anchor')
assert.equal(ruleIdForFlag('ARV $294,479 exceeds size-adjusted ceiling $228,178 with 1 supporter(s) — capped'), 'setb.size_ceiling')
assert.deepEqual(
  checksForFlags(['anchored to 1671 Lamont Ave (similarity 11.0)']),
  [{ ruleId: 'setb.anchor', message: 'anchored to 1671 Lamont Ave (similarity 11.0)' }],
)

console.log('rule-registry: stable check IDs passed')
