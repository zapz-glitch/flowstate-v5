/**
 * Jev two-test comp evaluation — question generation and response parsing
 *
 * Test 1: one noul per raw field (8 per comp — bedrooms, bathrooms,
 * squareFeet, lotSize, yearBuilt, propertyType, salePrice, saleDate) with
 * preset tolerances baked into the question text. Test 2: subdivision,
 * neighborhood, advisory physical-character/material nouls, plus the
 * distance-dominant Score question. Strict parse — every question must be
 * answered in the typed envelope or the batch fails.
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTest1Defs,
  runCompTest1WithJev,
  runCompTest2WithJev,
  COMP_EVAL_VERSION,
  COMP_TEST1_FIELDS,
  COMP_TEST2_SCORE_LEVELS,
} from '../src/services/jev'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const fakeSubject = {
  id: 's1', address: '1 Main St', city: 'Atlanta', state: 'GA', zipCode: '30301',
  bedrooms: 3, bathrooms: 2, squareFeet: 1400, yearBuilt: 1985, subdivision: 'Test Sub',
  lotSizeSquareFeet: 7000, propertyType: 'Single Family Residence',
} as never

const fakeComp = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, address: `${id} Oak Ln`, city: 'Atlanta', state: 'GA', salePrice: 240000,
  saleDate: '2026-06-01', squareFeet: 1420, pricePerSqft: 169, distanceMiles: 0.4,
  bedrooms: 3, bathrooms: 2, yearBuilt: 1987, adjustedSalePrice: 245000,
  propertyType: 'Single Family Residence', lotSizeSquareFeet: 7200,
  subdivision: 'Test Sub', neighborhoodName: 'Testhood',
  evaluation: {
    comparableId: id, shouldDisable: false, disableReasons: [],
    filterResults: [{ type: 'distance', passed: true }],
    totalAdjustment: 5000, adjustmentResults: [], originalPrice: 240000, adjustedPrice: 245000,
  },
  ...overrides,
}) as never

const fakeFilters = [
  { type: 'sqft_diff', enabled: true, value: 250 },
  { type: 'sale_age', enabled: true, value: 180 },
  { type: 'distance', enabled: true, value: 1 },
] as never

const env = { TYPESAFE_API_KEY: 'k', TYPESAFE_MODEL: 'jev-test-1' }
const originalFetch = globalThis.fetch

/** Mock Jev: answers every question — noul ids get `noulFor`, score ids `scoreFor`. */
function mockJev(
  noulFor: (questionId: string) => number,
  scoreFor: (questionId: string) => Record<string, unknown>,
  capture?: { bodies?: Array<Record<string, unknown>> },
) {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    capture?.bodies?.push(body)
    const questions = (body.questions ?? {}) as Record<string, { type: string }>
    const answers = Object.fromEntries(
      Object.keys(questions).map((id) => [
        id,
        questions[id]!.type === 'score'
          ? scoreFor(id)
          : { type: 'noul', noul: noulFor(id) },
      ]),
    )
    return Response.json({ model: 'jev-test-1', answers, usage: { input_tokens: 500 } })
  }
}

const goodScore = () => ({
  type: 'score',
  score: 3.5,
  confidence: 0.7,
  probabilities: { 0: 0, 1: 0, 2: 0.1, 3: 0.4, 4: 0.5 },
})

afterEach(() => { globalThis.fetch = originalFetch })

// ─── Test 1 — defs and runner ────────────────────────────────────────────────

describe('buildTest1Defs', () => {
  it('generates one noul per raw field — the six spec fields, in order', () => {
    const defs = buildTest1Defs(fakeFilters, fakeSubject)
    assert.deepEqual(defs.map((d) => d.key), COMP_TEST1_FIELDS)
    assert.deepEqual(defs.map((d) => d.key), [
      'bathrooms', 'squareFeet', 'lotSize', 'yearBuilt', 'salePrice', 'saleDate',
    ])
  })

  it('bakes the preset tolerance into the size and sale-date questions', () => {
    const defs = buildTest1Defs(fakeFilters, fakeSubject)
    const sqft = defs.find((d) => d.key === 'squareFeet')!
    assert.match(sqft.question(0), /±250 sqft/)
    const sale = defs.find((d) => d.key === 'saleDate')!
    assert.match(sale.question(0), /180 days/)
  })
})

describe('runCompTest1WithJev', () => {
  it('asks t1_<index>_<field> nouls and returns per-comp field probabilities', async () => {
    const capture: { bodies: Array<Record<string, unknown>> } = { bodies: [] }
    mockJev((id) => (id.endsWith('_bathrooms') ? 0.9 : 0.8), goodScore, capture)
    const result = await runCompTest1WithJev(fakeSubject, [fakeComp('a'), fakeComp('b')], fakeFilters, {}, env)

    const questions = Object.keys((capture.bodies[0]!.questions ?? {}) as object)
    for (let i = 0; i < 2; i++) {
      for (const field of COMP_TEST1_FIELDS) {
        assert.ok(questions.includes(`t1_${i}_${field}`), `missing question t1_${i}_${field}`)
      }
    }
    assert.equal(result.results['a']!.bathrooms, 0.9)
    assert.equal(result.results['b']!.salePrice, 0.8)
    assert.equal(result.model, 'jev-test-1')
    assert.equal(result.inputTokens, 500)
  })

  it('throws when a noul answer is missing or mistyped', async () => {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      const questions = (body.questions ?? {}) as Record<string, { type: string }>
      const answers = Object.fromEntries(
        Object.keys(questions).map((id, i) => [
          id,
          i === 0 ? { type: 'noul', noul: 'yes' } : { type: 'noul', noul: 0.8 },
        ]),
      )
      return Response.json({ model: 'jev-test-1', answers, usage: { input_tokens: 500 } })
    }
    await assert.rejects(
      runCompTest1WithJev(fakeSubject, [fakeComp('a')], fakeFilters, {}, env),
      /invalid or incomplete/,
    )
  })
})

// ─── Test 2 — nouls + score ─────────────────────────────────────────────────

describe('runCompTest2WithJev', () => {
  it('asks the four nouls plus the score question per comp', async () => {
    const capture: { bodies: Array<Record<string, unknown>> } = { bodies: [] }
    mockJev(() => 0.85, goodScore, capture)
    const result = await runCompTest2WithJev(fakeSubject, [fakeComp('a')], {}, env)

    const questions = (capture.bodies[0]!.questions ?? {}) as Record<string, { type: string; criteria?: string[] }>
    for (const key of ['subdivision', 'neighborhood', 'physicalCharacter', 'material']) {
      assert.equal(questions[`t2_0_${key}`]?.type, 'noul', `missing t2_0_${key} noul`)
    }
    const scoreQ = questions['t2_0_score']!
    assert.equal(scoreQ.type, 'score')
    assert.equal(scoreQ.criteria!.length, COMP_TEST2_SCORE_LEVELS.length)

    const r = result.results['a']!
    assert.equal(r.nouls.subdivision, 0.85)
    assert.equal(r.nouls.neighborhood, 0.85)
    assert.equal(r.nouls.physicalCharacter, 0.85)
    assert.equal(r.nouls.material, 0.85)
    assert.equal(r.rawScore, 3.5)
    assert.equal(r.confidence, 0.7)
    assert.equal(r.levelProbabilities['4'], 0.5)
  })

  it('rejects a score outside the level range', async () => {
    mockJev(() => 0.8, () => ({ type: 'score', score: 9, confidence: 0.5, probabilities: { 0: 1, 1: 0, 2: 0, 3: 0, 4: 0 } }))
    await assert.rejects(
      runCompTest2WithJev(fakeSubject, [fakeComp('a')], {}, env),
      /invalid or incomplete/,
    )
  })

  it('requires unique nonempty comp ids', async () => {
    mockJev(() => 0.8, goodScore)
    await assert.rejects(
      runCompTest2WithJev(fakeSubject, [fakeComp('a'), fakeComp('a')], {}, env),
      /unique, nonempty ID/,
    )
  })
})

describe('version', () => {
  it('reports the two-test pipeline version', () => {
    assert.equal(COMP_EVAL_VERSION, 'comp_tests_v1')
  })
})
