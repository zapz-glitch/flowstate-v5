/**
 * Same-area rule proofs (docs/EVAL-PLAYBOOK.md, Rule 2).
 *
 * 1. Same tract passes, whatever the city / subdivision labels say.
 * 2. A different tract fails at the default level…
 * 3. …passes on a matching neighborhood name once the ladder widens (level 2).
 * 4. Missing census data is unverifiable, not a mismatch.
 * 5. Subdivision and neighborhood NAME rules never disqualify.
 */
import assert from 'node:assert/strict'
import { evaluateComparable } from '../src/services/appraisal/evaluator'
import { DEFAULT_FILTERS } from '../src/services/appraisal/types'
import { filtersForLadder, geoLevelForScope } from '../src/services/appraisal/filter-ladder'
import type { NormalizedProperty, NormalizedComparable } from '../src/services/property-api/types'

const today = new Date(); today.setDate(today.getDate() - 30)
const subject = {
  id: 's', provider: 'test', address: '1 Subject St', city: 'Forest Park-Morrow', state: 'GA', zipCode: '30273',
  squareFeet: 1500, yearBuilt: 1980, propertyType: 'Single Family Residence', stories: 1,
  subdivision: 'Ambleside', neighborhoodName: 'Amble Side', censusTract: 'T1', censusBlockGroup: 'T1-2',
} as NormalizedProperty
const comp = (over: Partial<NormalizedComparable>) => ({
  id: 'c', provider: 'test', address: '2 Comp St', city: 'Rex', state: 'GA', zipCode: '30273',
  squareFeet: 1500, yearBuilt: 1980, propertyType: 'Single Family Residence', stories: 1,
  salePrice: 250000, saleDate: today.toISOString().slice(0, 10), distanceMiles: 0.3,
  subdivision: 'Stanton Ridge', neighborhoodName: 'Stanton Ridge', censusTract: 'T1',
  raw: {}, ...over,
} as NormalizedComparable)
const disabled = (c: NormalizedComparable, filters = DEFAULT_FILTERS) => evaluateComparable(subject, c, filters, [])

// 1 + 5 — same tract; city, subdivision and neighborhood labels all differ
{
  const r = disabled(comp({}))
  assert.equal(r.shouldDisable, false, `same-tract comp must pass, got: ${r.disableReasons.join('; ')}`)
}
// 2 — a different tract fails at the default level
{
  const r = disabled(comp({ censusTract: 'T9' }))
  assert.equal(r.shouldDisable, true)
  assert.ok(r.disableReasons.some((x) => /census tract/i.test(x)), r.disableReasons.join('; '))
}
// same block group passes even when the tract stamp differs
assert.equal(disabled(comp({ censusTract: 'T9', sameBlockGroup: true })).shouldDisable, false)
// 3 — the ladder widens the area last: a matching neighborhood name passes at level 2
{
  const named = comp({ censusTract: 'T9', neighborhoodName: 'Amble Side' })
  assert.equal(disabled(named).shouldDisable, true, 'not at the default level')
  assert.equal(disabled(named, filtersForLadder(DEFAULT_FILTERS, 0, 'neighborhood')).shouldDisable, false)
  assert.equal(disabled(comp({ censusTract: 'T9' }), filtersForLadder(DEFAULT_FILTERS, 0, 'neighborhood')).shouldDisable, true,
    'a different tract with no shared name still fails')
}
assert.deepEqual(['tract', 'block_group', 'neighborhood', 'value_equivalent'].map((s) => geoLevelForScope(s as never)), [1, 1, 2, 3])
// 4 — no census data on the comp is unverifiable, not a mismatch
assert.equal(disabled(comp({ censusTract: undefined })).shouldDisable, false)

console.log('same-area rule: census decides, names only rank, the ladder widens the area last')
