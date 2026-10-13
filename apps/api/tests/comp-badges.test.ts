import assert from 'node:assert/strict'
import { compBadges } from '../src/services/analysis/comp-badges'

/**
 * The badge contract — server computes, card renders. How this can fail:
 *  1. Price/condition labels must map one-to-one — no blending.
 *  2. Pocket badge must distinguish census membership from value-only.
 *  3. Trust must read the stamps, not the outcome.
 *  4. widenedOn names only the run's relaxed filters — strict comps get [].
 */

const comp = (over = {}) => ({
  censusTract: 'T1',
  evaluation: { filterResults: [
    { type: 'subdivision', passed: true },
    { type: 'sqft_diff', passed: true },
    { type: 'sale_age', passed: true },
  ] },
  evidenceVerification: {
    staleness: 'current',
    priceCheck: 'corroborated',
  },
  ...over,
})

const opts = { subjectCensusTract: 'T1', subjectPpsfMedians: { SD: 200 } }

// clean comp — all checks pass, verified, strict admission
{
  const b = compBadges(comp(), { ...opts, classification: 'after_renovation', condition: { condition: 'renovated' } })
  assert.equal(b.price, 'renovated')
  assert.equal(b.condition, 'reno')
  assert.equal(b.pocket, 'in')
  assert.equal(b.trust, 'verified')
  assert.deepEqual(b.widenedOn, [])
  assert.deepEqual(b.checks, { pocket: true, size: true, fresh: true, priceFit: true, marketFit: null, transaction: null })
}

// out-of-pocket, same market → 'equal'; pricier → 'above'
{
  const b = compBadges(comp({ censusTract: 'T9', ppsfMedians: { SD: 195 } }), opts)
  assert.equal(b.pocket, 'equal')
  const b2 = compBadges(comp({ censusTract: 'T9', ppsfMedians: { SD: 400 } }), opts)
  assert.equal(b2.pocket, 'above')
  const b3 = compBadges(comp({ censusTract: 'T9' }), opts)
  assert.equal(b3.pocket, 'unknown')
}

// divergent price stamp → unverified; missing stamps → partial
{
  const b = compBadges(comp({ evidenceVerification: { staleness: 'current', priceCheck: 'divergent' } }), opts)
  assert.equal(b.trust, 'unverified')
  const b2 = compBadges(comp({ evidenceVerification: { staleness: 'current' } }), opts)
  assert.equal(b2.trust, 'partial')
  const b3 = compBadges(comp({ evidenceVerification: null }), opts)
  assert.equal(b3.trust, null)
}

// sale age and pocket-price fit stay separate on the badge contract
{
  const recentCheap = compBadges(comp({
    evidenceVerification: { staleness: 'current', saleAgeDays: 30, marketFit: 'below_pocket', priceCheck: 'corroborated' },
  }), opts)
  assert.equal(recentCheap.checks.fresh, true)
  assert.equal(recentCheap.checks.marketFit, false)
  assert.equal(recentCheap.trust, 'unverified')

  const oldInRange = compBadges(comp({
    evidenceVerification: { staleness: 'stale', saleAgeDays: 220, marketFit: 'in_range', priceCheck: 'corroborated' },
  }), opts)
  assert.equal(oldInRange.checks.fresh, false)
  assert.equal(oldInRange.checks.marketFit, true)
  assert.equal(oldInRange.trust, 'unverified')

  const packageDeed = compBadges(comp({
    evidenceVerification: { staleness: 'current', saleAgeDays: 20, marketFit: 'in_range', transactionCheck: 'package_deed', priceCheck: 'corroborated' },
  }), opts)
  assert.equal(packageDeed.checks.transaction, false)
  assert.equal(packageDeed.trust, 'unverified')
}

// rescued comp names its widened filter; strict-comp stays []
{
  const c = comp({ evaluation: { filterResults: [
    { type: 'subdivision', passed: false },
    { type: 'sqft_diff', passed: false },
    { type: 'sale_age', passed: true },
  ] } })
  const b = compBadges(c, { ...opts, expansionApplied: ['sqft_diff', 'sale_age'] })
  assert.deepEqual(b.widenedOn, ['sqft_diff'])
  assert.equal(b.checks.size, false)
}
// decisions observables — model's tier + code's position drive the badges
{
  const b = compBadges(comp(), { ...opts, observables: { conditionTier: 'LIGHT_COSMETIC', codePosition: 'MEDIAN' } })
  assert.equal(b.condition, 'light_cosmetic')
  assert.equal(b.marketPosition, 'at_market')
  assert.equal(b.trust, 'verified')
}
// decisions couldn't call condition but the code placed the price → partial
{
  const b = compBadges(comp(), { ...opts, observables: { conditionTier: 'UNVERIFIED', codePosition: 'ABOVE_MEDIAN' } })
  assert.equal(b.condition, 'unverified')
  assert.equal(b.marketPosition, 'above_market')
  assert.equal(b.trust, 'partial')
}
// condition confirmed but code couldn't place the price → still partial
{
  const b = compBadges(comp(), { ...opts, observables: { conditionTier: 'HEAVY_REHAB', codePosition: 'UNVERIFIED' } })
  assert.equal(b.condition, 'heavy_rehab')
  assert.equal(b.marketPosition, 'unverified')
  assert.equal(b.trust, 'partial')
}
// observables ran but neither side answered → unverified
{
  const b = compBadges(comp(), { ...opts, observables: { conditionTier: null, codePosition: 'UNVERIFIED' } })
  assert.equal(b.condition, 'unverified')
  assert.equal(b.marketPosition, 'unverified')
  assert.equal(b.trust, 'unverified')
}
console.log('comp-badges: price/condition/pocket/trust/widened checks passed')
