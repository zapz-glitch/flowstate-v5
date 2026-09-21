/**
 * Comp screen — deterministic spec coverage
 *
 * The exception ranker (screenCompPool) and the ARV/as-is price-band
 * split (splitPriceBands): preset-weighted attribute scoring, the top-10
 * pool cut, 10% band membership, mutual exclusivity, and the ≤5 bucket cap.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { screenCompPool, splitPriceBands, SCREEN_POOL_TARGET, SCREEN_BUCKET_TARGET } from '../src/services/comp-screen'
import { COMP_ATTRIBUTE_KEYS, type CompAttributeKey } from '../src/services/jev'
import { DEFAULT_FILTERS, type AppraisedComparable, type AppraisalFilter } from '../src/services/appraisal/types'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const comp = (id: string, overrides?: Partial<AppraisedComparable>): AppraisedComparable => ({
  id,
  provider: 'corelogic',
  address: `${id} Comp Rd`,
  city: 'Tampa',
  state: 'FL',
  zipCode: '33607',
  latitude: 27.95,
  longitude: -82.45,
  distanceMiles: 0.4,
  bedrooms: 3,
  bathrooms: 2,
  squareFeet: 1500,
  lotSizeAcres: null,
  yearBuilt: 1990,
  propertyType: 'Single Family Residence',
  salePrice: 300000,
  saleDate: '2026-01-15',
  pricePerSqft: 200,
  evaluation: {
    comparableId: id,
    shouldDisable: false,
    filterResults: [],
    disableReasons: [],
    totalAdjustment: 0,
    adjustmentResults: [],
    originalPrice: 300000,
    adjustedPrice: 300000,
  },
  isEnabled: true,
  adjustedSalePrice: 300000,
  ...overrides,
})

/** All-8 score of `v` for a comp. */
const allAttrs = (v: number): Partial<Record<CompAttributeKey, number>> =>
  Object.fromEntries(COMP_ATTRIBUTE_KEYS.map((k) => [k, v]))

// ─── screenCompPool ─────────────────────────────────────────────────────────

describe('screenCompPool', () => {
  it('ranks by weighted Jev attribute score and keeps the top-10 pool', () => {
    const comps = Array.from({ length: 15 }, (_, i) => comp(`c${i}`))
    const scores = Object.fromEntries(
      comps.map((c, i) => [c.id, allAttrs(i / comps.length)]),
    )
    const { entries, pool } = screenCompPool(comps, scores, DEFAULT_FILTERS)
    assert.equal(pool.length, SCREEN_POOL_TARGET)
    assert.deepEqual(
      pool.map((e) => e.compId),
      comps.slice(5).reverse().map((c) => c.id),
    )
    assert.equal(entries[0].rank, 1)
    assert.equal(entries.filter((e) => e.inPool).length, SCREEN_POOL_TARGET)
  })

  it('keeps a rule-failing comp when it is otherwise the closest — the exception path', () => {
    const failing = comp('exception', {
      evaluation: {
        comparableId: 'exception',
        shouldDisable: true,
        filterResults: [{ type: 'subdivision_match', passed: false, status: 'failed' }],
        disableReasons: ['subdivision mismatch'],
        totalAdjustment: 0,
        adjustmentResults: [],
        originalPrice: 300000,
        adjustedPrice: 300000,
      },
      isEnabled: false,
    })
    const passing = comp('rule-passing')
    const { pool } = screenCompPool(
      [failing, passing],
      { exception: allAttrs(0.95), 'rule-passing': allAttrs(0.4) },
      DEFAULT_FILTERS,
    )
    assert.equal(pool[0].compId, 'exception')
    assert.equal(
      pool[0].attributes.find((a) => a.attribute === 'same_subdivision')?.ruleStatus,
      'failed',
    )
  })

  it('weights required (hard) attributes over preferred (soft) ones', () => {
    // comp A aces the hard subdivision match, fails everything soft
    // comp B aces soft attributes, fails the hard subdivision match
    const hardStrong: Partial<Record<CompAttributeKey, number>> = {
      same_subdivision: 1,
      same_property_style: 1,
      same_foundation: 1,
      within_sqft_range: 1,
      within_year_built_range: 1,
      same_construction: 0,
      within_lot_sqft_range: 0,
      same_neighborhood: 0,
    }
    const softStrong: Partial<Record<CompAttributeKey, number>> = {
      same_subdivision: 0,
      same_property_style: 0,
      same_foundation: 0,
      within_sqft_range: 0,
      within_year_built_range: 0,
      same_construction: 1,
      within_lot_sqft_range: 1,
      same_neighborhood: 1,
    }
    const { entries } = screenCompPool(
      [comp('a'), comp('b')],
      { a: hardStrong, b: softStrong },
      DEFAULT_FILTERS,
    )
    assert.equal(entries[0].compId, 'a')
    assert.ok(entries[0].score > entries[1].score)
  })

  it('ignores disabled filters entirely', () => {
    const filters: AppraisalFilter[] = DEFAULT_FILTERS.map((f) =>
      f.type === 'subdivision_match' ? { ...f, enabled: false } : f,
    )
    const a: Partial<Record<CompAttributeKey, number>> = { ...allAttrs(0.5), same_subdivision: 0 }
    const b: Partial<Record<CompAttributeKey, number>> = { ...allAttrs(0.5), same_subdivision: 1 }
    const { entries } = screenCompPool([comp('a'), comp('b')], { a, b }, filters)
    // identical weighted score — subdivision contributed nothing
    assert.equal(entries[0].score, entries[1].score)
    assert.equal(
      entries[0].attributes.find((x) => x.attribute === 'same_subdivision')?.weight,
      0,
    )
  })

  it('does not force comps into a small pool', () => {
    const { pool } = screenCompPool(
      [comp('a'), comp('b'), comp('c')],
      { a: allAttrs(1), b: allAttrs(1), c: allAttrs(1) },
      DEFAULT_FILTERS,
    )
    assert.equal(pool.length, 3)
  })
})

// ─── splitPriceBands ─────────────────────────────────────────────────────────

describe('splitPriceBands', () => {
  const poolWithPrices = (prices: number[]) => {
    const comps = prices.map((p, i) => comp(`c${i}`, { salePrice: p, adjustedSalePrice: null }))
    const scores = Object.fromEntries(comps.map((c) => [c.id, allAttrs(0.9)]))
    const { pool } = screenCompPool(comps, scores, DEFAULT_FILTERS, prices.length)
    return { pool, compsById: new Map(comps.map((c) => [c.id, c])) }
  }

  it('splits the pool into a top-10% ARV band and a bottom-10% as-is band', () => {
    const { pool, compsById } = poolWithPrices([400, 385, 370, 300, 250, 220, 200].map((n) => n * 1000))
    const bands = splitPriceBands(pool, compsById)
    // ARV floor = 400k * 0.9 = 360k → 400k, 385k, 370k
    assert.deepEqual(bands.arvIds, ['c0', 'c1', 'c2'])
    // as-is ceiling = 200k * 1.1 = 220k → 200k, 220k (band order follows screen score)
    assert.deepEqual(bands.asIsIds.slice().sort(), ['c5', 'c6'])
    assert.equal(bands.arvAnchor, 400000)
    assert.equal(bands.asIsAnchor, 200000)
  })

  it('caps each bucket at 5 comps', () => {
    const { pool, compsById } = poolWithPrices(
      [400, 399, 398, 397, 396, 395, 394, 200, 199, 198, 197, 196, 195, 194].map((n) => n * 1000),
    )
    const bands = splitPriceBands(pool, compsById)
    assert.equal(bands.arvIds.length, SCREEN_BUCKET_TARGET)
    assert.equal(bands.asIsIds.length, SCREEN_BUCKET_TARGET)
    assert.equal(bands.arvBandSize, 7)
    assert.equal(bands.asIsBandSize, 7)
  })

  it('never places a comp in both bands, even on a tight-spread pool', () => {
    // all prices within ~5% of each other → every comp qualifies for both bands
    const { pool, compsById } = poolWithPrices([300, 295, 292, 289, 286].map((n) => n * 1000))
    const bands = splitPriceBands(pool, compsById)
    const overlap = bands.arvIds.filter((id) => bands.asIsIds.includes(id))
    assert.equal(overlap.length, 0)
    // every comp lands in exactly one band
    assert.deepEqual(
      [...bands.arvIds, ...bands.asIsIds].sort(),
      pool.map((e) => e.compId).sort(),
    )
  })

  it('skips comps with no usable price rather than forcing them in', () => {
    const comps = [
      comp('priced', { salePrice: 300000 }),
      comp('no-price', { salePrice: null, adjustedSalePrice: null }),
    ]
    const { pool } = screenCompPool(comps, { priced: allAttrs(0.9), 'no-price': allAttrs(0.9) }, DEFAULT_FILTERS)
    const bands = splitPriceBands(pool, new Map(comps.map((c) => [c.id, c])))
    // single priced comp anchors both bands but lands in exactly one (ARV wins the tie)
    assert.deepEqual(bands.arvIds, ['priced'])
    assert.deepEqual(bands.asIsIds, [])
  })

  it('returns empty bands when the pool has no prices', () => {
    const comps = [comp('a', { salePrice: null, adjustedSalePrice: null })]
    const { pool } = screenCompPool(comps, { a: allAttrs(0.9) }, DEFAULT_FILTERS)
    const bands = splitPriceBands(pool, new Map(comps.map((c) => [c.id, c])))
    assert.equal(bands.arvIds.length, 0)
    assert.equal(bands.asIsIds.length, 0)
    assert.equal(bands.arvAnchor, null)
  })

  it('ranks band members by screen score, not price', () => {
    const comps = [
      comp('high-far', { salePrice: 400000 }),
      comp('high-close', { salePrice: 390000 }),
      comp('floor', { salePrice: 200000 }),
    ]
    const scores = {
      'high-far': allAttrs(0.5),
      'high-close': allAttrs(0.9),
      floor: allAttrs(0.9),
    }
    const { pool } = screenCompPool(comps, scores, DEFAULT_FILTERS)
    const bands = splitPriceBands(pool, new Map(comps.map((c) => [c.id, c])))
    // both high comps are in the ARV band; the closer one leads
    assert.equal(bands.arvIds[0], 'high-close')
  })
})
