/**
 * Comp classification proofs (docs/FILTER-LADDER.md).
 *
 * 1. A real flip (resold 30–365 days after purchase) is ARV.
 * 2. A buy-and-resell outside that window is NOT a flip.
 * 3. The top price group of the pocket is ARV — with no condition read.
 * 4. No AVM test: a sale far above its own AVM or the subject's is not ARV
 *    unless it sits in the pocket's top group.
 * 5. Groups come only from sales INSIDE the pocket.
 * 6. The bottom group is investor-priced; distressed sales are never ARV.
 * 7. A lone sale far above the pocket is an outlier, not a class…
 * 8. …unless a confident renovated read vouches for it.
 * 9. A full-tier conflict with a confident read is still arbitrated.
 */
import assert from 'node:assert/strict'
import { arvEvidence, classifyCompsByEvidence, pocketPriceGroups } from '../src/services/evaluation/comp-classification'
import type { NormalizedComparable, NormalizedProperty } from '../src/services/property-api/types'

const subject = {
  censusTract: 'T1', censusBlockGroup: 'T1-1', subdivision: 'Oak Hills',
  neighborhoodName: 'Oak Hills', propertyType: 'Single Family Residence',
} as NormalizedProperty

const comp = (id: string, ppsf: number, over: Partial<NormalizedComparable> = {}) => ({
  id, provider: 'test', address: `${id} St`, squareFeet: 1000, salePrice: ppsf * 1000,
  pricePerSqft: ppsf, censusTract: 'T1', propertyType: 'Single Family Residence',
  saleDate: '2026-08-01', ...over,
} as NormalizedComparable)
const cls = (m: Map<string, { classification: string }>, id: string) => m.get(id)?.classification

// 1 — a real flip is ARV whatever group it lands in
{
  const flip = comp('flip', 150, { flip: { priorSalePrice: 90000, priorSaleDate: '2026-02-01', daysHeld: 180, gainPct: 67 } })
  const m = classifyCompsByEvidence([flip, comp('a', 148), comp('b', 152), comp('c', 155)], subject)
  assert.equal(cls(m, 'flip'), 'after_renovation')
  assert.equal(m.get('flip')?.method, 'evidence_flip_chain')
}

// 2 — outside 30–365 days it is not a flip
for (const daysHeld of [10, 400]) {
  const c = comp('x', 150, { flip: { priorSalePrice: 90000, priorSaleDate: '2025-01-01', daysHeld, gainPct: 67 } })
  const m = classifyCompsByEvidence([c, comp('a', 148), comp('b', 152), comp('c', 155)], subject)
  assert.equal(cls(m, 'x'), 'transitional', `${daysHeld} days held is not a flip`)
}

// 3 — the pocket's top price group is ARV with no condition read at all
{
  const pool = [comp('i1', 90), comp('i2', 95), comp('m1', 150), comp('m2', 156), comp('r1', 240), comp('r2', 248)]
  const m = classifyCompsByEvidence(pool, subject)
  assert.deepEqual(['r1', 'r2'].map((id) => cls(m, id)), ['after_renovation', 'after_renovation'])
  assert.equal(m.get('r1')?.method, 'evidence_price_group')
  assert.deepEqual(['m1', 'm2'].map((id) => cls(m, id)), ['transitional', 'transitional'])
  // 6 — the bottom group is investor-priced
  assert.deepEqual(['i1', 'i2'].map((id) => cls(m, id)), ['as_is', 'as_is'])
}

// 4 — no AVM test: far above its own AVM, but in an evenly priced pocket → not ARV
{
  const pool = [
    comp('a', 150, { avmValue: 100000 }), comp('b', 152, { avmValue: 100000 }),
    comp('c', 154, { avmValue: 100000 }), comp('d', 156, { avmValue: 100000 }),
  ]
  const m = classifyCompsByEvidence(pool, subject)
  assert.ok(pool.every((c) => cls(m, c.id) === 'transitional'), 'selling above an AVM is not a price class')
  assert.equal(arvEvidence(pool[3], pocketPriceGroups(pool, subject)), null)
}

// 5 — sales outside the pocket never shape the groups
{
  const inside = [comp('a', 150), comp('b', 153), comp('c', 156), comp('d', 159)]
  const outside = [comp('o1', 320, { censusTract: 'T9' }), comp('o2', 330, { censusTract: 'T9' })]
  const m = classifyCompsByEvidence([...inside, ...outside], subject)
  assert.ok(inside.every((c) => cls(m, c.id) === 'transitional'), 'the pocket is evenly priced — outside sales do not make its top a class')
  assert.ok(outside.every((c) => cls(m, c.id) === 'transitional'), 'outside sales get no pocket class')
  assert.equal(pocketPriceGroups([...inside, ...outside], subject).scope, 'tract')
}

// 6 — a distressed sale is investor evidence even at a top price
{
  const pool = [comp('m1', 150), comp('m2', 156), comp('r1', 240), comp('d', 246, { distressedSale: true })]
  const m = classifyCompsByEvidence(pool, subject)
  assert.equal(cls(m, 'd'), 'as_is')
  assert.equal(cls(m, 'r1'), 'after_renovation')
}

// 7 — a lone sale far above the pocket is an outlier, not ARV
{
  const pool = [comp('m1', 273), comp('m2', 260), comp('m3', 280), comp('x', 1019)]
  const m = classifyCompsByEvidence(pool, subject)
  assert.equal(cls(m, 'x'), 'transitional')
  assert.match(m.get('x')!.reasoning, /outlier/)
}

// 8 — a confident renovated read vouches for a lone top sale
{
  const pool = [comp('m1', 150), comp('m2', 155), comp('m3', 160), comp('r', 250)]
  assert.equal(cls(classifyCompsByEvidence(pool, subject), 'r'), 'transitional', 'alone and unvouched')
  const reads = { r: { condition: 'renovated', confidence: 80 } }
  assert.equal(cls(classifyCompsByEvidence(pool, subject, reads), 'r'), 'after_renovation', 'vouched by the read')
}

// 9 — a full-tier conflict with a confident read is arbitrated by the model's own scores
{
  const pool = [comp('m1', 150), comp('m2', 156), comp('r1', 240), comp('r2', 248)]
  const reads = { r2: { condition: 'distressed', confidence: 80, renovatedProbability: 10, asIsProbability: 85 } }
  const m = classifyCompsByEvidence(pool, subject, reads)
  assert.equal(cls(m, 'r2'), 'as_is')
  assert.equal(m.get('r2')?.method, 'conflict_arbiter')
  assert.equal(cls(m, 'r1'), 'after_renovation', 'the comp without a conflict keeps its class')
}

// a widened batch is classed against the FULL pool's pocket, not itself
{
  const pool = [comp('m1', 150), comp('m2', 156), comp('r1', 240)]
  const added = [comp('r2', 246)]
  const m = classifyCompsByEvidence(added, subject, undefined, [...pool, ...added])
  assert.equal(cls(m, 'r2'), 'after_renovation')
}

// rules first, then groups — a comp that fails the rules never shapes a group
{
  const on = (c: NormalizedComparable) => ({ ...c, isEnabled: true }) as NormalizedComparable
  const off = (c: NormalizedComparable) => ({ ...c, isEnabled: false }) as NormalizedComparable
  // Two big-lot sales at $400+/sf fail the rules. Without them the passing
  // pocket is evenly priced, so nobody is "top".
  const pool = [on(comp('a', 150)), on(comp('b', 153)), on(comp('c', 156)), on(comp('d', 159)), off(comp('x1', 400)), off(comp('x2', 410))]
  const m = classifyCompsByEvidence(pool, subject)
  assert.ok(['a', 'b', 'c', 'd'].every((id) => cls(m, id) === 'transitional'))
  assert.equal(cls(m, 'x1'), 'transitional', 'a rule-failing sale gets no price class')
  assert.match(m.get('x1')!.reasoning, /Did not pass the evaluation rules/)
  // …and a passing top pair is still read as the top group
  const pool2 = [on(comp('a', 150)), on(comp('b', 153)), on(comp('r1', 240)), on(comp('r2', 246)), off(comp('x1', 90))]
  const m2 = classifyCompsByEvidence(pool2, subject)
  assert.deepEqual(['r1', 'r2'].map((id) => cls(m2, id)), ['after_renovation', 'after_renovation'])
}

console.log('comp-classification: flips, pocket price groups, outliers, and arbitration proofs passed')
