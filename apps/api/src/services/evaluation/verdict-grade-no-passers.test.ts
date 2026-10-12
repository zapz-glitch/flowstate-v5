/**
 * Gate when no comp passes the filter rules.
 *
 * Way this can fail: the appraiser picks the closest comps because nothing
 * passes the rules, and the gate fails them as "flagged" for being switched off.
 */

import { describe, expect, it } from 'vitest'
import type { HarnessEvidence } from './index'
import { gradeVerdict } from './verdict-grade'

const comp = (id: string, salePrice: number) => ({
  id, address: `${id} St`, isEnabled: false, salePrice, squareFeet: 1200, pricePerSqft: salePrice / 1200,
  sameBlockGroup: true, censusTract: 't1', conditionLabel: 'Renovated', compTier: 'arv',
})

describe('gradeVerdict', () => {
  it('does not fail picks for being switched off when the whole pool is', () => {
    const evidence = {
      subject: { squareFeet: 1200, censusTract: 't1' },
      rules: { filters: [], adjustments: [], preferredSaleAgeDays: 180, asIsThresholdPercent: 15 },
      comps: [comp('a', 200000), comp('b', 210000), comp('c', 190000)],
      suggestedSelection: [],
    } as unknown as HarnessEvidence
    const grade = gradeVerdict(evidence, { arv: 205000, conf: 'low', selectedCompIds: ['a', 'b'], drivers: ['a', 'b'] })

    expect(grade.warnings).toContain('no_comp_passes_filter_rules')
    expect(grade.gateFeedback.join(' ')).not.toMatch(/disabled|flagged|not enabled/i)
    expect(grade.gateFails).toEqual([])
  })
})
