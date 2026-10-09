import assert from 'node:assert/strict'
import { computePocketBenchmark, positionFor } from '../src/services/evaluation/observable'
import { gradeVerdict } from '../src/services/evaluation/verdict-grade'
import type { HarnessEvidence, AgentSelection } from '../src/services/evaluation'

// Proto harness regression: the Decisions-observable lane's code-side math
// (pocket benchmark + price tiers) and the deterministic gate (d1/d2/d4/d5/
// d6/d7/d8). These are pure functions over the evidence bundle — no model
// in the loop, so the checks below are the contract the appraiser is held
// to. If the harness stops behaving, these should fail first.

// ─── Pocket benchmark ────────────────────────────────────────────────────

const bgComp = (id: string, price: number, sqft: number) => ({
  id, salePrice: price, squareFeet: sqft,
  sameBlockGroup: true, neighborhoodName: null, censusTract: 'T1',
})

{
  const bench = computePocketBenchmark(
    { censusBlockGroup: 'BG1', neighborhoodName: 'Oak', censusTract: 'T1' },
    [bgComp('a', 300_000, 1500), bgComp('b', 330_000, 1500), bgComp('c', 360_000, 1500)],
  )
  assert.ok(bench, 'benchmark computed with a 3-comp block group')
  assert.equal(bench!.scope, 'block_group', 'block group scope wins when ≥3 members')
  assert.equal(bench!.medianPpsf, 220, 'median ppsf = median member')
  assert.equal(bench!.reliable, true, 'block-group benchmark is reliable')
  assert.equal(bench!.p25Ppsf, 200, 'p25 boundary from first quartile')
  // floor(p*(n-1)) indexing: n=3 → p75 lands on index 1 (the median).
  assert.equal(bench!.p75Ppsf, 220, 'p75 boundary — nearest-rank at n=3')
}

{
  // Every scope below 3 members → falls back to the priced pool.
  const pool = [
    bgComp('a', 300_000, 1500), // BG + tract T1
    { id: 'x', salePrice: 310_000, squareFeet: 1500, sameBlockGroup: false, neighborhoodName: 'Oak', censusTract: 'T1' }, // hood+tract
    { id: 'y', salePrice: 320_000, squareFeet: 1500, sameBlockGroup: false, neighborhoodName: 'Other', censusTract: 'T2' },
    { id: 'z', salePrice: 330_000, squareFeet: 1500, sameBlockGroup: false, neighborhoodName: 'Other', censusTract: 'T3' },
  ]
  const bench = computePocketBenchmark(
    { censusBlockGroup: 'BG1', neighborhoodName: 'Oak', censusTract: 'T1' },
    pool,
  )
  // BG=1, neighborhood=2, tract=2 — all thin → pool of 4, unreliable.
  assert.equal(bench!.scope, 'pool', 'thin pocket scopes fall back to the priced pool')
  assert.equal(bench!.reliable, false, 'pool-scope benchmark marked unreliable')
  assert.equal(bench!.n, 4, 'pool benchmark counts every priced comp')
}

{
  // Disabled comps never enter the benchmark — a poisoned pool member
  // must not shift the p25/p75 band the appraiser is held against.
  const comps = [
    bgComp('a', 300_000, 1500), bgComp('b', 330_000, 1500), bgComp('c', 360_000, 1500),
    { ...bgComp('poison', 2_780_000, 1834), isEnabled: false },
  ]
  const bench = computePocketBenchmark({ censusBlockGroup: 'BG1' }, comps)!
  assert.ok(!bench.compIds.includes('poison'), 'disabled data-poisoned comp excluded from benchmark')
  assert.equal(bench.medianPpsf, 220, 'median unaffected by the excluded outlier')
}

{
  assert.equal(computePocketBenchmark({}, []), null, 'empty pool → no benchmark')
  assert.equal(
    computePocketBenchmark({}, [{ id: 'a', salePrice: null, squareFeet: 1500 }]),
    null, 'unpriced pool → no benchmark',
  )
}

// ─── Price tiers (p25/p75 code boundaries) ───────────────────────────────

{
  const bench = {
    scope: 'block_group' as const, compIds: ['a', 'b', 'c'], n: 3,
    medianPrice: 330_000, medianPpsf: 220, p25Ppsf: 200, p75Ppsf: 240, reliable: true,
  }
  assert.equal(positionFor(250, bench).tier, 'ABOVE_MEDIAN', 'ppsf above p75 → ABOVE')
  assert.equal(positionFor(220, bench).tier, 'MEDIAN', 'ppsf inside band → MEDIAN')
  assert.equal(positionFor(190, bench).tier, 'BELOW_MEDIAN', 'ppsf below p25 → BELOW')
  assert.equal(positionFor(null, bench).tier, 'UNVERIFIED', 'no price → UNVERIFIED')
  assert.equal(positionFor(220, { ...bench, medianPpsf: null }).tier, 'UNVERIFIED', 'no median → UNVERIFIED')
}

// ─── Gate: gradeVerdict ──────────────────────────────────────────────────

type TestComp = HarnessEvidence['comps'][number]
const comp = (over: Record<string, unknown>): TestComp => ({
  id: 'c1', address: '1 Comp St', isEnabled: true,
  salePrice: 400_000, squareFeet: 1500, yearBuilt: 1990,
  sameBlockGroup: true, censusTract: 'T1',
  classification: { type: 'after_renovation' },
  ...over,
} as unknown as TestComp)

const evidence = (comps: TestComp[]): HarnessEvidence => ({
  jobId: 'job_test',
  subject: { censusTract: 'T1', address: '1 Subject St' },
  comps,
  suggestedSelection: [],
  classifications: {},
  classificationSummary: null,
  insufficient: false,
  rules: {},
} as unknown as HarnessEvidence)

const selection = (arv: number, picks: string[], drivers?: string[]): AgentSelection => ({
  arv, conf: 'medium', selectedCompIds: picks, drivers: drivers ?? picks,
} as AgentSelection)

{
  // Clean verdict: in-pocket renovated drivers, ARV inside envelope.
  const ev = evidence([
    comp({ id: 'd1', salePrice: 400_000 }),
    comp({ id: 'd2', salePrice: 420_000 }),
    comp({ id: 's1', salePrice: 380_000 }),
  ])
  const g = gradeVerdict(ev, selection(410_000, ['d1', 'd2', 's1'], ['d1', 'd2']))
  assert.equal(g.checks.d1, 'pass')
  assert.equal(g.checks.d2, 'pass')
  assert.equal(g.checks.d4, 'pass')
  assert.equal(g.checks.d7, 'pass')
  assert.equal(g.gateFails.length, 0, 'clean verdict accepts')
}

{
  // d8 (new): a driver code-verified BELOW_MEDIAN fails — investor-band
  // stock cannot drive an ARV verdict even when condition labels pass.
  const obsBelow = {
    pricePosition: 'BELOW_MEDIAN', priceSupport: 'SUPPORTS', codePosition: 'BELOW_MEDIAN',
    descCondition: null, coverPhotoEvidence: null, renoClaimP: 0.1,
    priceConditionAgreement: null, unexplainedPremiumP: 0, finalTier: 'BELOW_MEDIAN',
    premiumAttributes: null, siteExposure: null, confidence: {}, model: 'test', durationMs: 0,
  }
  const ev = evidence([
    comp({ id: 'cheap', salePrice: 200_000, observables: obsBelow }),
    comp({ id: 'reno1', salePrice: 400_000 }),
    comp({ id: 'reno2', salePrice: 420_000 }),
  ])
  const g = gradeVerdict(ev, selection(410_000, ['cheap', 'reno1', 'reno2'], ['cheap', 'reno1']))
  assert.equal(g.checks.d8, 'fail', 'below-median driver fails d8')
  assert.ok(g.gateFails.includes('d8'), 'd8 joins the gate-fail set')
  assert.ok(g.gateFeedback.some((f) => f.includes('below-median band')), 'd8 feedback names the band')
}

{
  // d8 warn: unexplained-premium pick must surface, not fail.
  const obsPremium = {
    pricePosition: 'ABOVE_MEDIAN', priceSupport: 'INSUFFICIENT', codePosition: 'ABOVE_MEDIAN',
    descCondition: null, coverPhotoEvidence: null, renoClaimP: 0.2,
    priceConditionAgreement: 'CONTRADICTS', unexplainedPremiumP: 0.8, finalTier: 'ABOVE_MEDIAN',
    premiumAttributes: 'NONE', siteExposure: null, confidence: {}, model: 'test', durationMs: 0,
  }
  const ev = evidence([
    comp({ id: 'prem', salePrice: 460_000, observables: obsPremium }),
    comp({ id: 'reno1', salePrice: 400_000 }),
    comp({ id: 'reno2', salePrice: 420_000 }),
  ])
  const g = gradeVerdict(ev, selection(440_000, ['prem', 'reno1', 'reno2'], ['reno1', 'reno2']))
  assert.equal(g.checks.d8, 'warn', 'unexplained-premium pick warns')
  assert.ok(g.failures.includes('d8_unexplained_premium_picked'))
}

{
  // d8 skips honestly when the observable lane never ran — no phantom fails.
  const ev = evidence([comp({ id: 'a', salePrice: 400_000 }), comp({ id: 'b', salePrice: 420_000 })])
  const g = gradeVerdict(ev, selection(410_000, ['a', 'b']))
  assert.equal(g.checks.d8, 'skipped', 'no observables → d8 skipped')
}

{
  // d2: a flagged pick fails — the data-poison case ($2.78M Marsh Lake comp).
  const poison = comp({
    id: 'poison', salePrice: 2_786_020, squareFeet: 1834, sameBlockGroup: true,
    clefDigest: { A: { priceSanity: 'data_error' } },
  })
  const ev = evidence([poison, comp({ id: 'ok1', salePrice: 400_000 }), comp({ id: 'ok2', salePrice: 410_000 })])
  const g = gradeVerdict(ev, selection(405_000, ['poison', 'ok1', 'ok2'], ['ok1', 'ok2']))
  assert.equal(g.checks.d2, 'fail', 'data-error pick fails d2')
  assert.ok(g.gateFeedback.some((f) => f.includes('poison')))
}

{
  // d7: ARV outside the renovated-comps envelope ±10% fails hard.
  const ev = evidence([comp({ id: 'a', salePrice: 400_000 }), comp({ id: 'b', salePrice: 420_000 })])
  const g = gradeVerdict(ev, selection(600_000, ['a', 'b']))
  assert.equal(g.checks.d7, 'fail', 'ARV far above envelope fails d7')
  const inside = gradeVerdict(ev, selection(410_000, ['a', 'b']))
  assert.equal(inside.checks.d7, 'pass', 'ARV inside envelope passes d7')
}

{
  // d1: off-pocket drivers while in-pocket candidates remain → fail.
  const offPocket = comp({ id: 'far', salePrice: 400_000, sameBlockGroup: false, censusTract: 'T9' })
  const inPocket = comp({ id: 'near', salePrice: 410_000, sameBlockGroup: true, censusTract: 'T1' })
  const ev = evidence([offPocket, inPocket, comp({ id: 'near2', salePrice: 420_000 })])
  const g = gradeVerdict(ev, selection(400_000, ['far'], ['far']))
  assert.equal(g.checks.d1, 'fail', 'off-pocket driver with in-pocket stock fails d1')
  assert.ok(g.gateFeedback.some((f) => f.includes('far')), 'd1 feedback names the off-pocket comp')
}

{
  // d4: as-is-classified driver fails when non-as-is evidence exists.
  const asIs = comp({ id: 'asis', salePrice: 250_000, classification: { type: 'as_is' } })
  const ev = evidence([asIs, comp({ id: 'reno1', salePrice: 400_000 }), comp({ id: 'reno2', salePrice: 420_000 })])
  const g = gradeVerdict(ev, selection(410_000, ['asis', 'reno1'], ['asis', 'reno1']))
  assert.equal(g.checks.d4, 'fail', 'as-is driver fails d4')
}

{
  // d5: picking a price-coherence outlier inside its group fails.
  // 4+ priceable comps in the 'arv' group make the trim active; $900k is
  // an outlier among ~$400k renovated comps.
  const ev = evidence([
    comp({ id: 'hot', salePrice: 900_000 }),
    comp({ id: 'm1', salePrice: 380_000 }), comp({ id: 'm2', salePrice: 400_000 }),
    comp({ id: 'm3', salePrice: 410_000 }), comp({ id: 'm4', salePrice: 420_000 }),
  ])
  const g = gradeVerdict(ev, selection(400_000, ['hot', 'm1', 'm2'], ['m1', 'm2']))
  assert.equal(g.checks.d5, 'fail', 'coherence-outlier pick fails d5')
  assert.ok(g.failures.includes('d5_coherence_outlier_picked'))
}

console.log('proto gate + observables: benchmark tiers, d1/d2/d4/d5/d7/d8 checks passed')
