import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mergeComparablePools } from '../src/services/property-api/comparable-pool'
import type { NormalizedComparable } from '../src/services/property-api/types'

const comp = (id: string, salePrice = 300000, saleDate = '2026-01-01', extra: Partial<NormalizedComparable> = {}) => ({
  id, provider: 'corelogic', address: `Synthetic ${id}`, city: 'Fixture', state: 'FL', zipCode: '00000',
  salePrice, saleDate, squareFeet: 1500, yearBuilt: 2000, raw: { salePrice, saleDate, isSale: true }, ...extra,
} as NormalizedComparable)
const merge = (nearby: NormalizedComparable[], expanded: NormalizedComparable[]) => mergeComparablePools(nearby, expanded, '2026-09-09')
const nearby = [comp('one'), comp('two')]
const expanded = [comp('two', 300000, '2026-01-01', { address: 'Expanded winner' }), comp('three')]
const before = JSON.stringify({ nearby, expanded })
const result = merge(nearby, expanded)
assert.deepEqual(result.comparables.map(c => c.id), ['one', 'two', 'three'])
assert.equal(result.comparables[1].address, 'Expanded winner')
assert.equal((result.comparables[1].raw as any).retrievalVariants.length, 2)
assert.equal(JSON.stringify({ nearby, expanded }), before)
assert.deepEqual(result.conflictIds, [])
const newer = merge([comp('one', 400000, '2026-04-01', { bedrooms: 4 })], [comp('one', 300000, '2026-01-01', { bedrooms: 3 })]).comparables[0]
assert.equal(newer.salePrice, 400000)
assert.equal(newer.saleDate, '2026-04-01')
assert.equal(newer.bedrooms, 4)
for (const date of ['2027-01-01', '2026-02-30', 'invalid']) {
  assert.equal(merge([comp('one')], [comp('one', 999999, date)]).comparables[0].salePrice, 300000)
}
assert.equal(merge([comp('one')], [comp('one', 0, '2026-04-01')]).comparables[0].salePrice, 300000)
assert.equal(merge([comp('one')], [comp('one', 999999, '2026-04-01', { raw: { isSale: false } })]).comparables[0].salePrice, 300000)
assert.equal(merge([comp('one')], [comp('one', 600000, '2026-04-01', { raw: { pricePerSquareFoot: 400, saleDate: '20260401' } })]).comparables[0].salePrice, 300000)
assert.equal(merge([comp('one')], [comp('one', 600000, '2026-04-01', { raw: { salePrice: 500000, saleDate: '20260401' } })]).comparables[0].salePrice, 300000)
assert.equal(merge([comp('one')], [comp('one', 600000, '2026-04-01', { raw: { saleAmount: '600000', saleDate: '20260401' } })]).comparables[0].salePrice, 600000)
const conflict = merge([comp('one', 300000)], [comp('one', 400000)])
assert.deepEqual(conflict.conflictIds, ['one'])
assert.equal(conflict.comparables[0].salePrice, 400000)
assert.equal((conflict.comparables[0].raw as any).retrievalConflict, true)
assert.deepEqual((conflict.comparables[0].raw as any).retrievalVariants.map((v: any) => v.salePrice), [300000, 400000])
const physical = merge([comp('one')], [comp('one', 300000, '2026-01-01', { squareFeet: 1600, yearBuilt: 2001 })])
assert.deepEqual((physical.comparables[0].raw as any).retrievalPhysicalConflicts, ['squareFeet', 'yearBuilt'])
assert.deepEqual(physical.conflictIds, [])
// No artificial per-pool cap: pools are bounded by the provider's documented
// maximum (CoreLogic maxComps = 100). The old slice(0, 50) silently dropped
// candidates the appraisal rules were entitled to evaluate.
assert.equal(merge(Array.from({ length: 70 }, (_, i) => comp(`n${i}`)), Array.from({ length: 70 }, (_, i) => comp(`e${i}`))).comparables.length, 140)
const probePath = (label: string) => new URL(`../../../.data/local-candidate/magnolia-coverage-probe-${label}.json`, import.meta.url)
if (existsSync(probePath('defaults')) && existsSync(probePath('filtered'))) {
  const load = (label: string) => JSON.parse(readFileSync(probePath(label), 'utf8')).raw.comparables.map((raw: any) => comp(String(raw.clip), raw.salePrice, `${raw.saleDate.slice(0, 4)}-${raw.saleDate.slice(4, 6)}-${raw.saleDate.slice(6, 8)}`, { address: raw.streetAddress, squareFeet: raw.buildingSquareFeet, raw }))
  const observed = merge(load('defaults'), load('filtered'))
  assert.equal(observed.comparables.length, 72)
  assert.equal(observed.comparables.find(c => c.id === '2782069136')?.salePrice, 380000)
  console.log('Saved live Magnolia probes: union72 preserves16142 Magnolia at380000')
}
console.log('Comparable pool merge: bounds, duplicate provenance, newest valid sale, conflicts and immutable inputs passed')
