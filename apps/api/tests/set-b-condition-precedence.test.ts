import assert from 'node:assert/strict'
import { bCondTier } from '@flowstate-api/shared/appraisal'

// Structured condition beats stale text fragments.
assert.equal(bCondTier({
  isEnabled: true,
  curbAppeal: { condition: 'renovated', confidence: 90, summary: 'tier:median' },
}), 'renovated')
assert.equal(bCondTier({
  isEnabled: true,
  curbAppeal: { condition: 'dated', confidence: 90, summary: 'tier:premium' },
}), 'median')

// Confidence gates all vision labels; old tier text cannot rescue a weak read.
assert.equal(bCondTier({
  isEnabled: true,
  curbAppeal: { condition: 'dated', confidence: 20, summary: 'tier:premium' },
}), 'unknown')

// Text tiers remain a fallback when no structured condition exists.
assert.equal(bCondTier({
  isEnabled: true,
  curbAppeal: { condition: null, confidence: 90, summary: 'tier:premium' },
}), 'premium')
assert.equal(bCondTier({
  isEnabled: true,
  curbAppeal: { condition: null, confidence: 90, summary: 'tier:median' },
}), 'median')

console.log('set-b condition precedence: structured read, confidence, then legacy text')
