/**
 * Jev comp evaluation — two-test funnel coverage (swe-2-eval spec)
 *
 * Facts-only eligibility (usable price + date), test 1 — the five
 * raw-field nouls, no bathrooms (verifiable fields must clear the gate;
 * unverifiable is noted, not failed) plus the composite score —
 * proximity-dominant, blended with field-match strength — that picks the
 * ten passers who get enriched. Test 2 — subdivision OR neighborhood
 * passes; physical-character/material/foundation nouls are advisory and
 * lift a pass from the 90 baseline toward 100. Classification — passers
 * split by adjusted price, top 15% into the ARV set (variable count), the
 * rest as-is reference. No fill — a short passer set stays short and zero
 * passers flags human handoff. The TypeSafe calls and the provider
 * enrichment seam are injected — these tests cover the engine's
 * decisions, not Jev.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runJevEvaluation } from '../src/services/comp-hybrid'
import { DEFAULT_FILTERS, DEFAULT_ADJUSTMENTS } from '../src/services/appraisal/types'
import { evaluateComparable } from '../src/services/appraisal'
import type { AppraisedComparable } from '../src/services/appraisal/types'
import type { NormalizedProperty, NormalizedComparable } from '../src/services/property-api/types'
import { COMP_TEST1_FIELDS } from '../src/services/jev'
import type { CompTest1Field, CompTest2Noul, JevCompTest2Result } from '../src/services/jev'

const NOW = new Date('2026-09-22T00:00:00Z')
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString().slice(0, 10)

const subject: NormalizedProperty = {
  id: 'subj',
  provider: 'corelogic',
  address: '100 Main St',
  city: 'Tampa',
  state: 'FL',
  zipCode: '33607',
  latitude: 27.95,
  longitude: -82.45,
  bedrooms: 3,
  bathrooms: 2,
  squareFeet: 1500,
  lotSizeAcres: 0.15,
  lotSizeSquareFeet: 6500,
  yearBuilt: 1990,
  propertyType: 'Single Family Residence',
  subdivision: 'Highland Hills',
  neighborhoodName: 'Highland',
  stories: 1,
  construction: { buildingStyle: 'ranch', foundationType: 'slab', type: 'frame', exteriorWalls: 'wood siding' },
  features: { garageType: '2 Car Garage' },
} as unknown as NormalizedProperty

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
  lotSizeAcres: 0.15,
  lotSizeSquareFeet: 6500,
  yearBuilt: 1990,
  propertyType: 'Single Family Residence',
  salePrice: 300000,
  saleDate: daysAgo(90),
  pricePerSqft: 200,
  subdivision: 'Highland Hills',
  neighborhoodName: 'Highland',
  stories: 1,
  construction: { buildingStyle: 'ranch', foundationType: 'slab', type: 'frame', exteriorWalls: 'wood siding' },
  features: { garageType: '2 Car Garage' },
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

// ─── Jev fixtures ────────────────────────────────────────────────────────────

const ALL_PASS_T1: Record<CompTest1Field, number> = Object.fromEntries(COMP_TEST1_FIELDS.map((f) => [f, 0.9])) as Record<CompTest1Field, number>

/** Injected test-1 fn: serves field probabilities per comp id, defaulting to all-pass. */
const tester1 = (
  fields: Record<string, Partial<Record<CompTest1Field, number>>>,
  capture?: { ids?: string[] },
) =>
  async (_s: unknown, comps: AppraisedComparable[]) => {
    if (capture) capture.ids = comps.map((c) => c.id)
    return {
      results: Object.fromEntries(
        comps.map((c) => [c.id, { ...ALL_PASS_T1, ...fields[c.id] }]),
      ),
      model: 'jev-t1-1',
      latencyMs: 1,
      inputTokens: 50,
      stateHashes: ['feedbeef'],
    }
  }

const PASS_T2_NOULS: Record<CompTest2Noul, number> = {
  subdivision: 0.9, neighborhood: 0.9, physicalCharacter: 0.9, material: 0.9, foundation: 0.9,
}

type T2Entry = JevCompTest2Result['results'][string]

const t2 = (
  rawScore: number,
  opts?: { nouls?: Partial<Record<CompTest2Noul, number>>; confidence?: number | null },
): T2Entry => ({
  nouls: { ...PASS_T2_NOULS, ...opts?.nouls },
  rawScore,
  confidence: opts?.confidence === undefined ? 0.8 : opts.confidence,
  levelProbabilities: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 1 },
})

/** Injected test-2 fn: serves results per comp id, defaulting to pass + mid score. */
const tester2 = (
  entries: Record<string, T2Entry>,
  capture?: { ids?: string[]; comps?: AppraisedComparable[] },
) =>
  async (_s: unknown, comps: AppraisedComparable[]) => {
    if (capture) { capture.ids = comps.map((c) => c.id); capture.comps = comps }
    return {
      results: Object.fromEntries(comps.map((c) => [c.id, entries[c.id] ?? t2(3)])),
      model: 'jev-t2-1',
      latencyMs: 1,
      inputTokens: 100,
      stateHashes: ['deadbeef'],
    }
  }

const evaluate = (
  comps: AppraisedComparable[],
  t1Fields?: Record<string, Partial<Record<CompTest1Field, number>>>,
  t2Entries?: Record<string, T2Entry>,
  opts?: Parameters<typeof runJevEvaluation>[5],
) =>
  runJevEvaluation(subject, comps, DEFAULT_FILTERS, DEFAULT_ADJUSTMENTS, {}, {
    now: NOW,
    test1: tester1(t1Fields ?? {}),
    test2: tester2(t2Entries ?? {}),
    ...opts,
  })

// ─── Eligibility ─────────────────────────────────────────────────────────────

describe('runJevEvaluation — eligibility', () => {
  it('no price or no date is ineligible and never reaches test 1', async () => {
    const capture: { ids?: string[] } = {}
    const result = await evaluate(
      [comp('ok'), comp('noprice', { salePrice: null }), comp('nodate', { saleDate: null })],
      {},
      {},
      { test1: tester1({}, capture) },
    )
    assert.deepEqual(capture.ids, ['ok'], 'only the eligible comp reaches test 1')
    const nop = result.entries.find((e) => e.compId === 'noprice')!
    assert.equal(nop.stage, 'ineligible')
    assert.equal(nop.test1, null)
    assert.ok(nop.score != null && nop.score <= 34, 'ineligible comps still carry a bottom-band card score')
    assert.ok(nop.rejectReasons.some((r) => /price/i.test(r)))
    assert.equal(result.counts.ineligible, 2)
  })
})

// ─── Test 1 — raw-field nouls + composite score ──────────────────────────────

describe('runJevEvaluation — test 1', () => {
  it('bathrooms is not a test-1 field — the five raw fields are', () => {
    assert.deepEqual(
      [...COMP_TEST1_FIELDS].sort(),
      ['lotSize', 'saleDate', 'salePrice', 'squareFeet', 'yearBuilt'],
    )
    assert.ok(!COMP_TEST1_FIELDS.includes('bathrooms' as CompTest1Field))
  })

  it('all fields at/above the gate passes test 1 and reaches test 2', async () => {
    const capture: { ids?: string[] } = {}
    const result = await evaluate([comp('a'), comp('b')], {}, {}, { test2: tester2({}, capture) })
    assert.deepEqual(capture.ids!.sort(), ['a', 'b'], 'both passers are examined')
    for (const e of result.entries) {
      assert.equal(e.test1!.passed, true)
      assert.equal(e.stage, 'test2_pass')
    }
    assert.equal(result.counts.test1Passed, 2)
    assert.equal(result.counts.test1Failed, 0)
  })

  it('a single field below the gate fails test 1 — never enriched, never examined', async () => {
    const t2Capture: { ids?: string[] } = {}
    const enrichCalls: string[][] = []
    const result = await evaluate(
      [comp('a'), comp('b')],
      { b: { squareFeet: 0.3 } },
      {},
      {
        test2: tester2({}, t2Capture),
        enrich: async (comps: NormalizedComparable[]) => { enrichCalls.push(comps.map((c) => c.id)); return comps },
      },
    )
    const b = result.entries.find((e) => e.compId === 'b')!
    assert.equal(b.stage, 'test1_fail')
    assert.deepEqual(b.test1!.failedFields, ['squareFeet'])
    assert.equal(b.test1!.passed, false)
    assert.equal(b.test1!.score, null, 'fails carry no composite score')
    assert.equal(b.test2, null)
    assert.deepEqual(t2Capture.ids, ['a'], 'only the test-1 passer is examined')
    assert.deepEqual(enrichCalls, [['a']], 'only the test-1 passer is enriched')
  })

  it('a field that cannot be verified is noted, not failed — missing data never disqualifies', async () => {
    const result = await evaluate(
      [comp('a'), comp('noLot', { lotSizeSquareFeet: null, lotSizeAcres: null })],
    )
    const nb = result.entries.find((e) => e.compId === 'noLot')!
    assert.equal(nb.stage, 'test2_pass')
    assert.deepEqual(nb.test1!.failedFields, [])
    assert.deepEqual(nb.test1!.unverifiableFields, ['lotSize'])
    assert.equal(nb.test1!.passed, true)
    assert.equal(result.counts.test1Passed, 2)
  })

  it('a noul exactly at the gate threshold passes the field', async () => {
    const result = await evaluate([comp('a')], { a: { yearBuilt: 0.5 } })
    assert.equal(result.entries[0]!.test1!.passed, true)
  })

  it('composite score rewards proximity — the nearer passer scores higher', async () => {
    const result = await evaluate(
      [comp('near', { distanceMiles: 0.05 }), comp('far', { distanceMiles: 0.9 })],
    )
    const near = result.entries.find((e) => e.compId === 'near')!
    const far = result.entries.find((e) => e.compId === 'far')!
    assert.ok(near.test1!.score != null && far.test1!.score != null)
    assert.ok(near.test1!.score! > far.test1!.score!, 'closer to subject scores higher')
  })

  it('composite score rewards field strength — stronger matches score higher at equal distance', async () => {
    const result = await evaluate(
      [comp('strong'), comp('weak')],
      // Both pass, but 'weak' barely clears each field
      { weak: { squareFeet: 0.55, lotSize: 0.55, yearBuilt: 0.55, salePrice: 0.55, saleDate: 0.55 } },
    )
    const strong = result.entries.find((e) => e.compId === 'strong')!
    const weak = result.entries.find((e) => e.compId === 'weak')!
    assert.ok(strong.test1!.score! > weak.test1!.score!)
  })
})

// ─── Enrichment seam ─────────────────────────────────────────────────────────

describe('runJevEvaluation — enrichment', () => {
  it('test-1 passers are enriched through the provider seam and examined on the merged data', async () => {
    const capture: { comps?: AppraisedComparable[] } = {}
    const result = await evaluate(
      [comp('a'), comp('b')],
      {},
      {},
      {
        test2: tester2({}, capture),
        enrich: async (comps: NormalizedComparable[]) =>
          comps.map((c) => ({ ...c, construction: { ...(c.construction ?? {}), buildingStyle: 'enriched-ranch' }, isEnriched: true })),
      },
    )
    const examined = capture.comps!.find((c) => c.id === 'a')!
    assert.equal(examined.construction?.buildingStyle, 'enriched-ranch', 'test 2 saw enriched data')
    assert.equal(result.enrichedComps.get('a')?.construction?.buildingStyle, 'enriched-ranch')
    assert.equal(result.entries.find((e) => e.compId === 'a')!.enriched, true)
  })

  it('already-enriched comps skip the provider call', async () => {
    const enrichCalls: string[][] = []
    await evaluate(
      [comp('a', { isEnriched: true })],
      {},
      {},
      { enrich: async (comps: NormalizedComparable[]) => { enrichCalls.push(comps.map((c) => c.id)); return comps } },
    )
    assert.equal(enrichCalls.length, 0)
  })

  it('enrichment goes to the 10 highest-scoring passers — the rest stay test1_pass', async () => {
    // 12 passers: c0..c11 nearest→farthest, all with identical field
    // strength, so composite score follows proximity — the 10 nearest win.
    const ids = Array.from({ length: 12 }, (_, i) => `c${i}`)
    const comps = ids.map((id, i) => comp(id, { distanceMiles: 0.1 + i * 0.05 }))
    const enrichCalls: string[][] = []
    const capture: { ids?: string[] } = {}
    const result = await evaluate(comps, {}, {}, {
      test2: tester2({}, capture),
      enrich: async (cs: NormalizedComparable[]) => { enrichCalls.push(cs.map((c) => c.id)); return cs.map((c) => ({ ...c, isEnriched: true })) },
    })
    const expected = ids.slice(0, 10) // 10 highest scores = 10 nearest here
    assert.deepEqual(enrichCalls, [expected])
    assert.deepEqual(capture.ids, expected, 'test 2 ran on the capped enriched set only')
    const stageOf = (id: string) => result.entries.find((e) => e.compId === id)!.stage
    for (const id of expected) assert.equal(stageOf(id), 'test2_pass')
    assert.equal(stageOf('c10'), 'test1_pass')
    assert.equal(stageOf('c11'), 'test1_pass')
    assert.equal(result.counts.enriched, 10)
  })

  it('a stronger-but-farther passer can outscore a nearer weak passer for the enrich cohort', async () => {
    // 11 passers — 'strong' is farthest but field-perfect; 'w0'..'w9' are
    // near but barely pass every field. Proximity dominates (60%), so
    // 'strong' must be extreme to break the top-10… give it a different
    // shape: keep it simple — 'strong' mid-distance perfect vs 'w10' near
    // but barely-passing. Assert strong ranks ahead of the weakest.
    const ids = Array.from({ length: 11 }, (_, i) => `w${i}`)
    const comps = [
      comp('strong', { distanceMiles: 0.45 }),
      ...ids.map((id, i) => comp(id, { distanceMiles: 0.05 + i * 0.04 })), // w0=0.05 … w10=0.45
    ]
    const weakFields = { squareFeet: 0.5, lotSize: 0.5, yearBuilt: 0.5, salePrice: 0.5, saleDate: 0.5 }
    const t1 = Object.fromEntries(ids.map((id) => [id, weakFields]))
    const capture: { ids?: string[] } = {}
    const result = await evaluate(comps, t1, {}, { test2: tester2({}, capture) })
    assert.ok(capture.ids!.includes('strong'), 'perfect-strength passer made the top-10')
    assert.equal(capture.ids!.length, 10)
    const strong = result.entries.find((e) => e.compId === 'strong')!
    assert.ok(strong.test1!.score != null)
  })
})

// ─── Test 2 — subdivision OR neighborhood + match-boosted score ──────────────

describe('runJevEvaluation — test 2', () => {
  it('subdivision yes passes test 2', async () => {
    const result = await evaluate(
      [comp('a')],
      {},
      { a: t2(4, { nouls: { subdivision: 0.9, neighborhood: 0.1 } }) },
    )
    const a = result.entries[0]!
    assert.equal(a.test2!.passed, true)
    assert.equal(a.stage, 'test2_pass')
  })

  it('subdivision no + neighborhood yes still passes test 2', async () => {
    const result = await evaluate(
      [comp('a')],
      {},
      { a: t2(4, { nouls: { subdivision: 0.2, neighborhood: 0.8 } }) },
    )
    assert.equal(result.entries[0]!.test2!.passed, true)
  })

  it('subdivision no + neighborhood no fails test 2 — scored below the pass floor', async () => {
    const result = await evaluate(
      [comp('a'), comp('b'), comp('c'), comp('d')],
      {},
      {
        a: t2(4, { nouls: { subdivision: 0.9, neighborhood: 0.9 } }),
        b: t2(3, { nouls: { subdivision: 0.2, neighborhood: 0.3 } }),
        c: t2(2, { nouls: { subdivision: 0.1, neighborhood: 0.1 } }),
        d: t2(1, { nouls: { subdivision: 0.1, neighborhood: 0.1 } }),
      },
    )
    const b = result.entries.find((e) => e.compId === 'b')!
    assert.equal(b.stage, 'test2_fail')
    assert.equal(b.test2!.passed, false)
    assert.ok(b.test2!.score < 90, `fail scored ${b.test2!.score} — below the 90 pass floor`)
  })

  it('a bare pass starts at 90 — matched physical characteristics push toward 100', async () => {
    const result = await evaluate(
      [comp('bare'), comp('matched')],
      {},
      {
        bare: t2(4, { nouls: { physicalCharacter: 0, material: 0, foundation: 0 } }),
        matched: t2(4, { nouls: { physicalCharacter: 1, material: 1, foundation: 1 } }),
      },
    )
    const bare = result.entries.find((e) => e.compId === 'bare')!
    const matched = result.entries.find((e) => e.compId === 'matched')!
    assert.equal(bare.test2!.score, 90, 'no physical matches → the 90 baseline')
    assert.equal(matched.test2!.score, 100, 'all physical matches → 100')
    assert.equal(bare.score, 90)
    assert.equal(matched.score, 100)
  })

  it('physical character, material, and foundation are advisory — they never gate', async () => {
    const result = await evaluate(
      [comp('a')],
      {},
      { a: t2(4, { nouls: { physicalCharacter: 0.1, material: 0.1, foundation: 0.1 } }) },
    )
    const a = result.entries[0]!
    assert.equal(a.test2!.nouls.physicalCharacter, 0.1)
    assert.equal(a.test2!.nouls.foundation, 0.1)
    assert.equal(a.test2!.passed, true, 'advisory nouls do not block a subdivision pass')
    assert.equal(a.test2!.score, 90 + Math.round(10 * 0.1))
  })
})

// ─── Classification — top-15% price tier, no fill, human handoff ─────────────

describe('runJevEvaluation — classification', () => {
  it('the top 15% of passers by adjusted price become the ARV set — the rest as-is', async () => {
    // 10 passers at escalating prices → ceil(10×0.15) = 2 ARV comps:
    // the two most expensive. Remaining 8 are as-is reference.
    const ids = Array.from({ length: 10 }, (_, i) => `c${i}`)
    const comps = ids.map((id, i) => comp(id, { salePrice: 300_000 + i * 10_000, distanceMiles: 0.1 + i * 0.05 }))
    const result = await evaluate(comps)
    assert.equal(result.coreCompIds.length, 10)
    assert.equal(result.counts.test2Passed, 10)
    assert.equal(result.arvCompIds.length, 2, 'top 15% of 10 passers → 2 ARV comps')
    assert.equal(result.asIsCompIds.length, 8)
    const tiers = Object.fromEntries(result.entries.map((e) => [e.compId, e.priceTier]))
    const arvIds = result.arvCompIds
    for (const id of arvIds) assert.equal(tiers[id], 'arv')
    for (const id of result.asIsCompIds) assert.equal(tiers[id], 'as_is')
    // The ARV comps are the two highest-priced passers (c8, c9) — adjusted
    // price tracks sale price with matching fixtures.
    assert.deepEqual(arvIds.sort(), ['c8', 'c9'])
    // Only ARV-tier comps are 'selected' for the ARV.
    for (const e of result.entries) {
      assert.equal(e.selected === 'core', e.priceTier === 'arv')
    }
    assert.equal(result.humanHandoff, false)
  })

  it('a single passer still produces an ARV comp — minimum one ARV slot', async () => {
    const result = await evaluate([comp('a')])
    assert.deepEqual(result.arvCompIds, ['a'])
    assert.deepEqual(result.asIsCompIds, [])
    assert.equal(result.entries[0]!.priceTier, 'arv')
    assert.equal(result.entries[0]!.selected, 'core')
  })

  it('fewer than 3 passers → no fill — the set stays short', async () => {
    const result = await evaluate(
      [comp('p1'), comp('p2'), comp('f1'), comp('f2')],
      {},
      {
        p1: t2(4, { nouls: { subdivision: 0.9, neighborhood: 0.9 } }),
        p2: t2(3, { nouls: { subdivision: 0.9, neighborhood: 0.4 } }),
        f1: t2(3.5, { nouls: { subdivision: 0.2, neighborhood: 0.2 } }),
        f2: t2(2.5, { nouls: { subdivision: 0.2, neighborhood: 0.2 } }),
      },
    )
    assert.deepEqual(result.coreCompIds.sort(), ['p1', 'p2'])
    assert.equal(result.arvCompIds.length, 1, 'top 15% of 2 passers → 1 ARV comp, no fill')
    assert.equal(result.asIsCompIds.length, 1)
    for (const id of ['f1', 'f2']) {
      const e = result.entries.find((en) => en.compId === id)!
      assert.equal(e.selected, null, 'test-2 fails never fill')
      assert.equal(e.priceTier, null)
      assert.ok(!result.arvCompIds.includes(id))
    }
  })

  it('zero test-2 passers → human handoff, empty ARV set, nothing filled', async () => {
    const result = await evaluate(
      [comp('a'), comp('b'), comp('c')],
      {},
      {
        a: t2(4, { nouls: { subdivision: 0.2, neighborhood: 0.2 } }),
        b: t2(3, { nouls: { subdivision: 0.1, neighborhood: 0.1 } }),
        c: t2(2, { nouls: { subdivision: 0.1, neighborhood: 0.1 } }),
      },
    )
    assert.equal(result.counts.test2Passed, 0)
    assert.equal(result.humanHandoff, true)
    assert.deepEqual(result.arvCompIds, [])
    assert.deepEqual(result.asIsCompIds, [])
    assert.equal(result.counts.selected, 0)
    assert.ok(result.entries.every((e) => e.selected === null))
  })

  it('a test-1 fail can never be selected — no matter how close or cheap', async () => {
    const result = await evaluate(
      [comp('pass'), comp('fail', { distanceMiles: 0.05, salePrice: 999_000 })],
      { fail: { squareFeet: 0.1 } },
      { pass: t2(4) },
    )
    const fail = result.entries.find((e) => e.compId === 'fail')!
    assert.equal(fail.stage, 'test1_fail')
    assert.equal(fail.selected, null)
    assert.equal(fail.priceTier, null)
    assert.ok(!result.arvCompIds.includes('fail'))
    assert.ok(!result.asIsCompIds.includes('fail'))
  })

  it('poolRank covers the whole pool by composite — #1 is the closest comp that passed both tests', async () => {
    const result = await evaluate(
      [comp('far', { distanceMiles: 0.9 }), comp('near', { distanceMiles: 0.1 }), comp('fail', { distanceMiles: 0.05 })],
      { fail: { squareFeet: 0.1 } },
      {},
    )
    const ranks = Object.fromEntries(result.entries.map((e) => [e.compId, e.poolRank]))
    assert.equal(ranks['near'], 1, 'nearest test-2 passer tops the pool')
    assert.equal(ranks['far'], 2)
    assert.equal(ranks['fail'], 3, 'a test-1 fail ranks below passers even when closest')
  })

  it('score confidence propagates to the card record', async () => {
    const result = await evaluate(
      [comp('a')],
      {},
      { a: t2(4, { confidence: 0.93 }) },
    )
    assert.equal(result.entries[0]!.scoreConfidence, 0.93)
    assert.equal(result.entries[0]!.test2!.confidence, 0.93)
  })
})

// ─── Composite card score — tier band + proximity position ───────────────────

describe('runJevEvaluation — composite card score', () => {
  it('every comp carries a score — test outcome sets the band', async () => {
    const result = await evaluate(
      [
        comp('p1', { distanceMiles: 0.2 }),
        comp('p2', { distanceMiles: 0.6 }),
        comp('f', { distanceMiles: 0.05 }),
        comp('t1', { distanceMiles: 0.3 }),
      ],
      { t1: { squareFeet: 0.1 } },
      {
        p1: t2(4),
        p2: t2(4),
        f: t2(2, { nouls: { subdivision: 0.1, neighborhood: 0.1 } }),
      },
    )
    const score = Object.fromEntries(result.entries.map((e) => [e.compId, e.score]))
    // Tier dominance beats proximity — f at 0.05mi is the nearest comp in
    // the pool and still sits below both test-2 passers.
    assert.ok(score['p1']! > score['f']!)
    assert.ok(score['f']! > score['t1']!)
    // Passers carry the 90→100 match score; test-2 fail → 35–74; test-1
    // fail → 0–34.
    assert.ok(score['p1']! >= 90 && score['p1']! <= 100)
    assert.ok(score['p2']! >= 90 && score['p2']! <= 100)
    assert.ok(score['f']! >= 35 && score['f']! <= 74)
    assert.ok(score['t1']! <= 34)
  })

  it('a test-1 fail never outscores a test-2 fail even when much closer', async () => {
    const result = await evaluate(
      [comp('t2fail', { distanceMiles: 3 }), comp('t1fail', { distanceMiles: 0.01 })],
      { t1fail: { squareFeet: 0.1 } },
      { t2fail: t2(1, { nouls: { subdivision: 0.1, neighborhood: 0.1 } }) },
    )
    const score = Object.fromEntries(result.entries.map((e) => [e.compId, e.score]))
    assert.ok(score['t2fail']! > score['t1fail']!)
  })
})

// ─── Result shape ────────────────────────────────────────────────────────────

describe('runJevEvaluation — result shape', () => {
  it('carries per-stage metadata, counts, and deterministic adjusted prices', async () => {
    const result = await evaluate(
      [comp('a'), comp('noprice', { salePrice: null })],
      {},
      { a: t2(4) },
    )
    assert.equal(result.test1?.model, 'jev-t1-1')
    assert.equal(result.test2?.model, 'jev-t2-1')
    assert.equal(result.counts.pool, 2)
    assert.equal(result.counts.ineligible, 1)
    assert.equal(result.counts.test1Passed, 1)
    assert.equal(result.counts.test2Passed, 1)
    assert.equal(result.counts.selected, 1)
    assert.equal(result.counts.arv, 1)
    assert.equal(result.counts.asIs, 0)
    assert.equal(result.humanHandoff, false)
    assert.equal(result.noulGate, 0.5)
    assert.equal(result.questionSet.test1.length, 5)
    assert.equal(result.questionSet.test2.length, 5)
    const a = result.entries.find((e) => e.compId === 'a')!
    const expected = evaluateComparable(subject, comp('a'), DEFAULT_FILTERS, DEFAULT_ADJUSTMENTS).adjustedPrice
    assert.equal(a.adjustedPrice, expected)
    assert.equal(a.saleAgeDays, 90)
  })

  it('a missing test-1 result for a candidate fails the run', async () => {
    await assert.rejects(
      runJevEvaluation(subject, [comp('a')], DEFAULT_FILTERS, DEFAULT_ADJUSTMENTS, {}, {
        now: NOW,
        test1: async () => ({ results: {}, model: 'm', latencyMs: 1, inputTokens: 1, stateHashes: [] }),
        test2: tester2({}),
      }),
      /no result for comparable a/,
    )
  })

  it('empty pool still returns a well-formed result — human handoff', async () => {
    const result = await evaluate([comp('noprice', { salePrice: null })])
    assert.equal(result.test1, null)
    assert.equal(result.test2, null)
    assert.deepEqual(result.arvCompIds, [])
    assert.equal(result.humanHandoff, true, 'no passers → human handoff')
    assert.equal(result.counts.test1Passed, 0)
    assert.equal(result.counts.ineligible, 1)
  })
})
