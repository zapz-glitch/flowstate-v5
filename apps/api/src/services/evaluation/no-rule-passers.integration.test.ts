/**
 * Integration: nearest-25 pool → validation → gate, when no comp passes the rules.
 *
 * Way this can fail: the three pieces disagree — the pool cap keeps comps the
 * validation or the gate then refuses, so a closest-comp selection can never
 * be accepted.
 */

import { describe, expect, it } from 'vitest'
import { nearestComparables } from '../property-api/comparable-pool'
import { validateAgentSelection, type HarnessEvidence } from './index'
import { gradeVerdict } from './verdict-grade'

describe('closest-comp selection on a pool where nothing passes the rules', () => {
  it('is accepted by validation and by the gate, from the 25 nearest', () => {
    const wide = Array.from({ length: 40 }, (_, i) => ({
      id: `c${i}`, address: `${i} Elm St`, isEnabled: false, distanceMiles: i / 10,
      salePrice: 200000 + i * 500, squareFeet: 1200, pricePerSqft: (200000 + i * 500) / 1200,
      sameBlockGroup: i < 5, censusTract: 't1', conditionLabel: 'Renovated', compTier: 'arv',
    }))
    const pool = nearestComparables(wide, 25)
    const selection = { arv: 201000, conf: 'low' as const, selectedCompIds: ['c0', 'c1', 'c2'], drivers: ['c0', 'c1', 'c2'] }

    expect(pool).toHaveLength(25)
    expect(validateAgentSelection(selection, pool as unknown as Parameters<typeof validateAgentSelection>[1])).toEqual([])
    const evidence = {
      subject: { squareFeet: 1200, censusTract: 't1' },
      rules: { filters: [], adjustments: [], preferredSaleAgeDays: 180, asIsThresholdPercent: 15 },
      comps: pool, suggestedSelection: [],
    } as unknown as HarnessEvidence
    expect(gradeVerdict(evidence, selection).gateFails).toEqual([])
  })
})
