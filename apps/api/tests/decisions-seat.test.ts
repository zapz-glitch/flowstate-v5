import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { runDecisionsSeat } from '../src/services/evaluation/decisions-seat'
import type { Phase1Context, HarnessEvidence } from '../src/services/evaluation'
import type { Env } from '../src/types'

// Decisions seat selection rules (finale lane):
// 1. A comp the seat fails on the final appraisal call (q_final < 0.5)
//    can never drive the ARV — the best_comp head-to-head is only a
//    preference order inside the qualified set, never an override.
// 2. Qualified top-of-pocket (above_market) comps pick before qualified
//    at-market comps; median-band comps only fill the pool out to 3.
// 3. When every non-below-market candidate fails, the run falls back to
//    the deterministic seat with an honest debug note.
// 4. An all-below-market pool still answers — least-bad floor pick,
//    flagged below_market_pick.

const subject = {
  id: 'subj', address: '1 Subject St', squareFeet: 1500, bedrooms: 3, bathrooms: 2,
  yearBuilt: 1990, lotSizeAcres: 0.2, stories: 1, propertyType: 'Single Family Residence',
  subdivision: 'Oak Park', neighborhoodName: 'Oak Hills', censusTract: 'T1', censusBlockGroup: 'BG1',
  foundationType: 'Slab', constructionType: 'Frame', exteriorWalls: 'Frame', roofType: 'Shingle',
}

const comp = (over: Record<string, unknown>) => ({
  id: over.id, address: `${over.id} Comp St`,
  isEnabled: true,
  salePrice: over.salePrice, saleDate: '2026-08-01',
  squareFeet: 1500, distanceMiles: 0.3,
  sameBlockGroup: true, censusBlockGroup: 'BG1', censusTract: 'T1',
  subdivision: 'Oak Park', neighborhoodName: 'Oak Hills',
  yearBuilt: 1991, lotSizeAcres: 0.2,
  bedrooms: 3, bathrooms: 2, stories: 1,
  foundationType: 'Slab', constructionType: 'Frame', exteriorWalls: 'Frame', roofType: 'Shingle',
  ...over,
})

// 2 top-band (ppsf 300/310), 2 mid (200/193), 1 bottom (100) →
// natural-break groups top/middle/bottom over the clean pocket set.
const mixedPool = () => [
  comp({ id: 'top1', salePrice: 450000 }),
  comp({ id: 'top2', salePrice: 465000 }),
  comp({ id: 'mid1', salePrice: 300000 }),
  comp({ id: 'mid2', salePrice: 290000 }),
  comp({ id: 'low1', salePrice: 150000 }),
]

// 3 local median-band comps (ppsf 180/210/230) + 3 FOREIGN top-band
// comps (ppsf 270, same tract, different pocket) — the foreign group is
// inside the R9 band (270/210 ≈ 1.29x ≤ 1.33x) so it stays eligible and
// lands the natural-break top group. Local at-market evidence must fill
// picks before foreign top-band sales (d1 pocket-first ordering).
const foreign = (id: string, salePrice: number) => comp({
  id, salePrice, sameBlockGroup: false, censusBlockGroup: 'BG9',
  subdivision: 'River Oaks', neighborhoodName: 'River Oaks',
})
const foreignTopPool = () => [
  comp({ id: 'mid1', salePrice: 270000 }),
  comp({ id: 'mid2', salePrice: 315000 }),
  comp({ id: 'mid3', salePrice: 345000 }),
  foreign('ft1', 405000),
  foreign('ft2', 405000),
  foreign('ft3', 405000),
]

const asIsPool = () => [
  comp({ id: 'a1', salePrice: 150000, classification: { type: 'as_is' } }),
  comp({ id: 'a2', salePrice: 155000, classification: { type: 'as_is' } }),
  comp({ id: 'a3', salePrice: 160000, classification: { type: 'as_is' } }),
]

const buildEvidence = (comps: unknown[]) => ({
  jobId: 'test-seat',
  subject,
  comps,
  suggestedSelection: [],
  classifications: {},
  classificationSummary: null,
  insufficient: false,
  rules: { filters: [], adjustments: [], preferredSaleAgeDays: 210, asIsThresholdPercent: 30 },
  steps: [],
}) as unknown as HarnessEvidence

const buildCtx = (comps: unknown[]) => ({
  jobId: 'test-seat',
  bundle: null,
  appraisalResult: { comparables: comps, insufficientComps: true },
  subjectAvm: null,
  insufficient: false,
  preferredSaleAgeDays: 210,
  filters: [],
  adjustments: [],
  steps: [],
  fallbacksUsed: [],
  compClassifications: [],
  classificationSummary: null,
}) as unknown as Phase1Context

type Scores = Record<string, { final: number; market: number; pref: number }>
const seatAnswers = (ids: string[], scores: Scores, best: string) => ({
  answers: [
    ...ids.flatMap((id) => [
      { type: 'predicate', name: `q_sqft_${id}`, probability: 0.9 },
      { type: 'predicate', name: `q_year_${id}`, probability: 0.9 },
      { type: 'predicate', name: `q_block_${id}`, probability: 1 },
      { type: 'predicate', name: `q_hood_${id}`, probability: 1 },
      { type: 'predicate', name: `q_apples_${id}`, probability: 0.8 },
      { type: 'predicate', name: `q_final_${id}`, probability: scores[id]?.final ?? 0 },
      { type: 'predicate', name: `q_market_${id}`, probability: scores[id]?.market ?? 0.5 },
    ]),
    {
      type: 'choice', name: 'best_comp', choice: best,
      probabilities: ids.map((id) => ({ value: id, probability: scores[id]?.pref ?? 0 }))
        .concat([{ value: 'NONE_QUALIFIED', probability: 0.01 }]),
    },
    { type: 'predicate', name: 'pool_quality', probability: 0.8 },
  ],
})

const realFetch = globalThis.fetch
const stubSeat = (payload: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch
}
const env = { OPENAI_API_KEY: 'test-key' } as Env
const ids = (r: Awaited<ReturnType<typeof runDecisionsSeat>>) => r.selection?.selectedCompIds ?? []

describe('decisions-seat pick rules', () => {
  beforeEach(() => {})
  afterEach(() => { globalThis.fetch = realFetch })

  it('qualified top-band comps pick before at-market comps', async () => {
    const comps = mixedPool()
    // mid1 scores highest on preference but a top-band comp qualified —
    // band order wins: top picks first, at-market fills.
    stubSeat(seatAnswers(
      comps.map((c) => String(c.id)),
      {
        top1: { final: 0.55, market: 0.9, pref: 0.3 },
        top2: { final: 0.6, market: 0.9, pref: 0.25 },
        mid1: { final: 0.95, market: 0.8, pref: 0.35 },
        mid2: { final: 0.9, market: 0.8, pref: 0.08 },
        low1: { final: 0.9, market: 0.1, pref: 0.02 },
      },
      'mid1',
    ))
    const res = await runDecisionsSeat(env, buildCtx(comps), buildEvidence(comps))
    assert.deepEqual(ids(res), ['top1', 'top2', 'mid1'])
    assert.ok(res.selection?.flags?.includes('decisions_seat'))
    assert.ok(res.selection?.arv && res.selection.arv > 0)
  })

  it('a comp the seat fails cannot drive ARV — falls back when none qualify', async () => {
    const comps = mixedPool()
    stubSeat(seatAnswers(
      comps.map((c) => String(c.id)),
      {
        top1: { final: 0.43, market: 0.9, pref: 0.4 },
        top2: { final: 0.3, market: 0.9, pref: 0.3 },
        mid1: { final: 0.4, market: 0.8, pref: 0.2 },
        mid2: { final: 0.2, market: 0.8, pref: 0.08 },
        low1: { final: 0.9, market: 0.1, pref: 0.02 },
      },
      'top1',
    ))
    const res = await runDecisionsSeat(env, buildCtx(comps), buildEvidence(comps))
    // The seat pick didn't land — and the seat-failed comps are excluded
    // from the deterministic re-run too (seat_all_failed flag, no
    // decisions_seat flag).
    assert.ok(!res.selection?.flags?.includes('decisions_seat'))
    assert.ok(res.selection?.flags?.includes('seat_all_failed'))
    assert.ok(res.debugNotes.some((n) => n.includes('failed q_final')))
    assert.ok(!ids(res).includes('top1') && !ids(res).includes('top2') && !ids(res).includes('mid1') && !ids(res).includes('mid2'))
  })

  it('in-pocket at-market comps pick before foreign top-band comps', async () => {
    const comps = foreignTopPool()
    stubSeat(seatAnswers(
      comps.map((c) => String(c.id)),
      {
        mid1: { final: 0.7, market: 0.8, pref: 0.1 },
        mid2: { final: 0.75, market: 0.8, pref: 0.1 },
        mid3: { final: 0.6, market: 0.8, pref: 0.1 },
        ft1: { final: 0.9, market: 0.9, pref: 0.3 },
        ft2: { final: 0.85, market: 0.9, pref: 0.25 },
        ft3: { final: 0.8, market: 0.9, pref: 0.15 },
      },
      'ft1',
    ))
    const res = await runDecisionsSeat(env, buildCtx(comps), buildEvidence(comps))
    // Local at-market evidence fills the pool before foreign top-band
    // sales — a foreign pick can never displace an in-pocket comp.
    assert.deepEqual([...ids(res)].sort(), ['mid1', 'mid2', 'mid3'])
  })

  it('the best_comp head-to-head never rescues a failing final call', async () => {
    const comps = mixedPool()
    stubSeat(seatAnswers(
      comps.map((c) => String(c.id)),
      {
        top1: { final: 0.43, market: 0.9, pref: 0.9 },
        top2: { final: 0.9, market: 0.9, pref: 0.05 },
        mid1: { final: 0.3, market: 0.8, pref: 0.03 },
        mid2: { final: 0.01, market: 0.8, pref: 0.01 },
        low1: { final: 0.9, market: 0.1, pref: 0.01 },
      },
      'top1',
    ))
    const res = await runDecisionsSeat(env, buildCtx(comps), buildEvidence(comps))
    assert.deepEqual(ids(res), ['top2'])
  })

  it('an all-below-market pool answers with the flagged floor pick', async () => {
    const comps = asIsPool()
    stubSeat(seatAnswers(
      comps.map((c) => String(c.id)),
      {
        a1: { final: 0.9, market: 0.1, pref: 0.5 },
        a2: { final: 0.8, market: 0.1, pref: 0.3 },
        a3: { final: 0.7, market: 0.1, pref: 0.2 },
      },
      'a1',
    ))
    const res = await runDecisionsSeat(env, buildCtx(comps), buildEvidence(comps))
    assert.ok(res.selection?.flags?.includes('below_market_pick'))
    assert.ok(res.debugNotes.some((n) => n.includes('forced floor pick')))
  })
})
