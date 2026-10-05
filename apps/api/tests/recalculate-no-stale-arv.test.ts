import assert from 'node:assert/strict'
import { recalculateReport } from '../src/services/evaluation/recalculate'

// A selected comp set with no verified ARV evidence must not keep the old
// answer. Withholding is safer than serving a stale number.
const saved = {
  subject: { squareFeet: 1200 },
  appliedSettings: {
    rehabLevelIndex: 2,
    rehabTable: undefined,
    majorItems: [],
    additionPlay: 0,
    dealParams: { closingCostsPercent: 8, carryingCostsPercent: 2, wholesaleFee: 10000 },
  },
  valuation: { arv: 228269, arvB: 228269, buyPrice: 120000, rehabCost: 50000 },
  comps: {
    items: [{
      id: 'stale-comp',
      address: 'Stale Comp',
      salePrice: 200000,
      adjustedPrice: 216000,
      squareFeet: 1000,
      isEnabled: true,
      appraisalRules: { passedFilters: true },
      classification: { type: 'as_is' },
      evidenceVerification: { staleness: 'stale', priceCheck: 'divergent' },
    }],
  },
}

const next = await recalculateReport(saved as never, 'job_recalc', ['stale-comp'], {} as never)
const valuation = next.valuation as Record<string, unknown> | null | undefined
assert.equal(valuation?.arv ?? null, null)
assert.equal(valuation?.arvB ?? null, null)
assert.equal(valuation?.buyPrice ?? null, null)
assert.equal(valuation?.resultGrade, 'withheld')
assert.equal((valuation?.bMechanics as { source?: string } | undefined)?.source, 'T0 anchor')

console.log('recalculate: no-answer selection withholds instead of retaining stale ARV')
