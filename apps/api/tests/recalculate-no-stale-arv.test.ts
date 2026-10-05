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

// 1 — The operator's choice stands (docs/FILTER-LADDER.md): a checked comp is
// used even when the server's own selection would never pick it. The ARV is
// recomputed from the checked comp — the old number is never kept.
const next = await recalculateReport(saved as never, 'job_recalc', ['stale-comp'], {} as never)
const valuation = next.valuation as Record<string, unknown> | null | undefined
assert.notEqual(valuation?.arv, 228269, 'the stale ARV must not survive a recalculation')
assert.ok(typeof valuation?.arv === 'number' && (valuation.arv as number) > 0, 'the checked comp produces an ARV')
assert.equal((valuation?.bMechanics as { source?: string } | undefined)?.source, 'operator selection')
const picked = (next.comps as { items: Array<{ id: string; isEnabled: boolean; bRole?: string }> }).items[0]
assert.equal(picked.isEnabled, true, 'the checked comp stays checked')
assert.equal(picked.bRole, 'driver')

// 2 — Checked comps are averaged, each repriced to the subject.
const two = structuredClone(saved) as typeof saved
two.comps.items.push({ ...two.comps.items[0], id: 'second', address: 'Second Comp', salePrice: 300000, adjustedPrice: 300000, squareFeet: 1200 })
const one = (await recalculateReport(two as never, 'job_recalc', ['second'], {} as never)).valuation as { arv: number }
const first = valuation!.arv as number
const both = (await recalculateReport(two as never, 'job_recalc', ['stale-comp', 'second'], {} as never)).valuation as { arv: number }
assert.equal(both.arv, Math.round((first + one.arv) / 2), 'two checked comps → the average of their repriced values')

// 3 — Restoring the automatic selection gives the engine's own answer; with
// no usable ARV evidence it withholds instead of keeping the old number.
const auto = (await recalculateReport(saved as never, 'job_recalc', null, {} as never)).valuation as Record<string, unknown> | null | undefined
assert.equal(auto?.arv ?? null, null)
assert.equal(auto?.buyPrice ?? null, null)
assert.equal(auto?.resultGrade, 'withheld')

// 4 — A comp with no price or size cannot be checked.
const bad = structuredClone(saved) as typeof saved
bad.comps.items.push({ ...bad.comps.items[0], id: 'no-price', salePrice: null as never, adjustedPrice: null as never })
await assert.rejects(() => recalculateReport(bad as never, 'job_recalc', ['no-price'], {} as never), /no sale price or size/)

console.log('recalculate: operator selection averages checked comps; no stale ARV is ever kept')
