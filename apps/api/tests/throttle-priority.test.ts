import assert from 'node:assert/strict'
import {
  computeThrottleSlot,
  THROTTLE_BULK_MAX_REQUESTS,
  THROTTLE_INTERACTIVE_RESERVE,
  THROTTLE_MAX_REQUESTS,
} from '../src/durable-objects/throttle'

// Bulk callers cap at THROTTLE_BULK_MAX_REQUESTS so interactive traffic
// (typeahead) always has headroom and never queues behind analysis backlog.
{
  const now = 1_000_000
  let grants: number[] = []

  // Fill the bulk lane to its cap — every one immediate
  for (let i = 0; i < THROTTLE_BULK_MAX_REQUESTS; i++) {
    const { grants: next, result } = computeThrottleSlot(
      grants,
      now,
      THROTTLE_BULK_MAX_REQUESTS,
    )
    grants = next
    assert.equal(result.granted, true)
    assert.equal(result.waitMs, 0, `bulk grant ${i} should be immediate`)
  }

  // The next bulk acquire queues (waits for the window to drain)
  const { result: bulkQueued } = computeThrottleSlot(
    grants,
    now,
    THROTTLE_BULK_MAX_REQUESTS,
  )
  assert.equal(bulkQueued.granted, true)
  assert.ok(bulkQueued.waitMs > 0, 'bulk past cap should queue')

  // Interactive callers still get immediate slots — reserved headroom
  for (let i = 0; i < THROTTLE_INTERACTIVE_RESERVE; i++) {
    const { grants: next, result } = computeThrottleSlot(
      grants,
      now,
      THROTTLE_MAX_REQUESTS,
    )
    grants = next
    assert.equal(result.granted, true)
    assert.equal(result.waitMs, 0, `priority grant ${i} should be immediate`)
  }

  // Once the provider's true cap is reached, even priority queues —
  // but at the earliest expiry, never behind the bulk tail.
  const { result: priQueued } = computeThrottleSlot(
    grants,
    now,
    THROTTLE_MAX_REQUESTS,
  )
  assert.equal(priQueued.granted, true)
  assert.ok(priQueued.waitMs > 0, 'priority queues only at the true 50/min cap')
  const { result: bulkTail } = computeThrottleSlot(
    grants,
    now,
    THROTTLE_BULK_MAX_REQUESTS,
  )
  assert.ok(
    priQueued.waitMs <= bulkTail.waitMs,
    'priority wait should never exceed bulk wait',
  )
}

// Sanity: a priority acquire on an empty window is immediate.
{
  const { result } = computeThrottleSlot([], Date.now(), THROTTLE_MAX_REQUESTS)
  assert.equal(result.granted, true)
  assert.equal(result.waitMs, 0)
}

console.log('throttle-priority tests passed')
