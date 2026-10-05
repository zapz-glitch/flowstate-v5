import assert from 'node:assert/strict'
import { arvEvidence, classifyCompsByEvidence } from '../src/services/evaluation/comp-classification'
import type { NormalizedComparable } from '../src/services/property-api/types'

/**
 * Classification chain — condition labels come from vision (Clef → Luna)
 * or listing text. Price alone can only corroborate membership in a
 * renovated band that vision/text evidence already defined — it can never
 * mint the class itself (the Dunseath defect: a $1.6M sale at 410% of the
 * subject's AVM was stamped after_renovation and drove ARV).
 *
 * How this can fail:
 *  1. A price-promoted comp with NO verified-renovated band must demote.
 *  2. Inside the band it keeps 'after_renovation'.
 *  3. Above OR below the band it demotes — outliers and floor sales both.
 *  4. A flip chain (buy → resale) is a renovation EVENT — keeps the class
 *     with no band.
 *  5. Only confident reads (conf ≥ 30) define the band.
 *  6. Band math reads raw sale $/sf.
 *  7. Distressed stays as_is; ordinary sales stay transitional.
 */

const comp = (id: string, salePrice = 300000, squareFeet = 1500, extra: Partial<NormalizedComparable> = {}) => ({
  id, provider: 'corelogic', address: `Synthetic ${id}`, city: 'Fixture', state: 'FL', zipCode: '00000',
  salePrice, saleDate: '2026-01-01', squareFeet, yearBuilt: 1975,
  raw: { salePrice, saleDate: '2026-01-01', isSale: true }, ...extra,
} as NormalizedComparable)

// A vision-verified renovated comp at $200/sf defines the band [180, 220].
const renovated = (ppsf = 200) => comp('reno', ppsf * 1500, 1500)
const reads = (over: Record<string, { condition?: string; confidence?: number }> = {}) =>
  ({ reno: { condition: 'renovated', confidence: 80 }, ...over })

// 1. Price promotion with no condition reads at all → demoted.
{
  const pool = [comp('promo', 400000, 1500, { avmValue: 250000 })]
  const out = classifyCompsByEvidence(pool, 250000)
  assert.equal(out.get('promo')!.classification, 'transitional')
}

// 2. Price promotion inside the verified band → keeps after_renovation.
{
  const pool = [renovated(), comp('promo', 310000, 1500, { avmValue: 240000 })]
  const out = classifyCompsByEvidence(pool, 240000, reads())
  assert.equal(out.get('promo')!.classification, 'after_renovation')
}

// 3a. Price promotion ABOVE the band → demoted (Bolton-class outlier).
{
  const pool = [renovated(), comp('promo', 780000, 1500, { avmValue: 300000 })]
  const out = classifyCompsByEvidence(pool, 300000, reads())
  assert.equal(out.get('promo')!.classification, 'transitional')
}

// 3b. Price promotion BELOW the band → demoted (renovated claim at floor price).
{
  const pool = [renovated(300), comp('promo', 180000, 1500, { avmValue: 150000 })]
  const out = classifyCompsByEvidence(pool, 150000, reads())
  assert.equal(out.get('promo')!.classification, 'transitional')
}

// 4. Flip chain keeps after_renovation with no band — the sale pair is the
//    renovation event, not a price read.
{
  const pool = [comp('flip', 420000, 1500, {
    flip: { priorSalePrice: 240000, priorSaleDate: '2025-05-01', daysHeld: 245, gainPct: 75 },
  })]
  const out = classifyCompsByEvidence(pool, 250000)
  assert.equal(out.get('flip')!.classification, 'after_renovation')
}

// 5. A low-confidence read cannot define the band.
{
  const pool = [renovated(), comp('promo', 310000, 1500, { avmValue: 240000 })]
  const out = classifyCompsByEvidence(pool, 240000, { reno: { condition: 'renovated', confidence: 10 } })
  assert.equal(out.get('promo')!.classification, 'transitional')
}

// 6. The band reads raw sale $/sf — a comp priced just over the band edge
//    demotes even when its listing asks low.
{
  const pool = [renovated(200), comp('promo', 330600, 1500, { avmValue: 200000 })] // 220.4/sf > 220
  const out = classifyCompsByEvidence(pool, 200000, reads())
  assert.equal(out.get('promo')!.classification, 'transitional')
}

// 6b. A sale just over its own AVM is ordinary — the premium must clear 15%.
{
  const pool = [comp('near-avm', 148000, 1410, { avmValue: 147674 })]
  const out = classifyCompsByEvidence(pool, 79490)
  assert.equal(out.get('near-avm')!.classification, 'transitional')
}

// 6c. A bad/stale subject AVM cannot promote below-pocket sales into ARV.
{
  const low = [
    comp('low-a', 100000, 1426, { avmValue: 98957 }), // $70/sf
    comp('low-b', 97000, 1053),                       // $92/sf
  ]
  const out = classifyCompsByEvidence(low, 79490, undefined, 158)
  assert.equal(arvEvidence(low[0], 79490, 158), null)
  assert.equal(arvEvidence(low[1], 79490, 158), null)
  assert.equal(out.get('low-a')!.classification, 'transitional')
  assert.equal(out.get('low-b')!.classification, 'transitional')
}

// 7. Baselines hold — distressed and ordinary sales unchanged.
{
  const pool = [
    renovated(),
    comp('dist', 150000, 1500, { distressedSale: true }),
    comp('plain', 210000, 1500),
  ]
  const out = classifyCompsByEvidence(pool, 240000, reads())
  assert.equal(out.get('dist')!.classification, 'as_is')
  assert.equal(out.get('plain')!.classification, 'transitional')
}

console.log('comp-classification-chain: band corroboration, no-band demotion, flip-chain exemption, read floor passed')

// ── Conflict arbiter — Clef's own probabilities decide, not a default ────
// 8. Vision 'distressed' but sale priced into the renovated band:
//    model says as-is (prob higher) → demotes to as_is.
{
  const pool = [
    renovated(),
    comp('conflict', 310000, 1500, { avmValue: 240000 }),
  ]
  const out = classifyCompsByEvidence(pool, 240000, reads({
    conflict: { condition: 'distressed', confidence: 70, renovatedProbability: 15, asIsProbability: 75 },
  }))
  const cls = out.get('conflict')!
  assert.equal(cls.classification, 'as_is')
  assert.equal(cls.method, 'conflict_arbiter')
}

// 9. Same shape but the model backs the renovated story → stays.
{
  const pool = [
    renovated(),
    comp('conflict', 310000, 1500, { avmValue: 240000 }),
  ]
  const out = classifyCompsByEvidence(pool, 240000, reads({
    conflict: { condition: 'distressed', confidence: 70, renovatedProbability: 80, asIsProbability: 15 },
  }))
  assert.equal(out.get('conflict')!.classification, 'after_renovation')
}

// 10. No probability scores → neither story proved → transitional.
{
  const pool = [
    renovated(),
    comp('conflict', 310000, 1500, { avmValue: 240000 }),
  ]
  const out = classifyCompsByEvidence(pool, 240000, reads({
    conflict: { condition: 'distressed', confidence: 70 },
  }))
  assert.equal(out.get('conflict')!.classification, 'transitional')
}

// 11. Flip chain is a transaction event — exempt from arbitration even
//     when vision reads distressed.
{
  const pool = [
    comp('flipper', 300000, 1500, { flip: { priorSalePrice: 200000, daysHeld: 90, gainPct: 50 } }),
  ]
  const out = classifyCompsByEvidence(pool, 240000, {
    flipper: { condition: 'distressed', confidence: 80, renovatedProbability: 10, asIsProbability: 85 },
  })
  assert.equal(out.get('flipper')!.classification, 'after_renovation')
  assert.equal(out.get('flipper')!.method, 'evidence_flip_chain')
}

// 12. One-tier disagreement is NOT a conflict — adjacent labels stand.
{
  const pool = [
    renovated(),
    comp('adj', 310000, 1500, { avmValue: 240000 }),
  ]
  const out = classifyCompsByEvidence(pool, 240000, reads({
    adj: { condition: 'dated', confidence: 70, renovatedProbability: 15, asIsProbability: 75 },
  }))
  assert.equal(out.get('adj')!.classification, 'after_renovation')
}
console.log('conflict-arbiter: Clef-prob arbitration, flip exemption, adjacent pass-through')
