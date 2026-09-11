/**
 * Throttle Tests — Cotality 50 req/min sliding window with slot reservation
 */

import { describe, it, expect } from 'vitest'
import {
  computeThrottleSlot,
  computeThrottleStats,
  THROTTLE_MAX_REQUESTS,
  THROTTLE_WINDOW_MS,
  THROTTLE_QUEUE_CAP_MS,
} from './throttle'

const T0 = 1_000_000_000 // arbitrary epoch

describe('computeThrottleSlot', () => {
  it('grants immediately when the window is empty', () => {
    const { result, grants } = computeThrottleSlot([], T0)
    expect(result.granted).toBe(true)
    expect(result.waitMs).toBe(0)
    expect(result.windowCount).toBe(1)
    expect(grants).toEqual([T0])
  })

  it('grants immediately up to the 50-request limit', () => {
    let grants: number[] = []
    for (let i = 0; i < THROTTLE_MAX_REQUESTS; i++) {
      const r = computeThrottleSlot(grants, T0)
      expect(r.result.granted).toBe(true)
      expect(r.result.waitMs).toBe(0)
      grants = r.grants
    }
    expect(grants).toHaveLength(THROTTLE_MAX_REQUESTS)
  })

  it('reserves the earliest future slot when the window is full', () => {
    let grants: number[] = []
    for (let i = 0; i < THROTTLE_MAX_REQUESTS; i++) {
      grants = computeThrottleSlot(grants, T0 + i).grants
    }

    const { result, grants: updated } = computeThrottleSlot(grants, T0 + 50)
    expect(result.granted).toBe(true)
    // 51st request waits for the oldest grant (T0) to roll off
    expect(result.scheduledFor).toBe(T0 + THROTTLE_WINDOW_MS)
    expect(result.waitMs).toBe(T0 + THROTTLE_WINDOW_MS - (T0 + 50))
    expect(updated).toHaveLength(THROTTLE_MAX_REQUESTS + 1)
  })

  it('serializes a queue of requests without exceeding the window', () => {
    let grants: number[] = []
    const scheduled: number[] = []

    // 150 requests arrive in the same instant — a burst
    for (let i = 0; i < 150; i++) {
      const r = computeThrottleSlot(grants, T0)
      grants = r.grants
      scheduled.push(r.result.scheduledFor)
    }

    // First 50 immediate; rest serialized
    expect(scheduled.slice(0, 50).every((s) => s === T0)).toBe(true)

    // Verify the invariant: at no point does any 60s window exceed 50 grants
    for (const t of scheduled) {
      const inWindow = scheduled.filter((g) => g > t - THROTTLE_WINDOW_MS && g <= t).length
      expect(inWindow).toBeLessThanOrEqual(THROTTLE_MAX_REQUESTS)
    }
  })

  it('prunes grants older than the window', () => {
    const old = [T0 - THROTTLE_WINDOW_MS - 1, T0 - THROTTLE_WINDOW_MS]
    const { result, grants } = computeThrottleSlot(old, T0)
    expect(result.granted).toBe(true)
    expect(result.waitMs).toBe(0)
    expect(grants).toEqual([T0]) // old grants dropped
  })

  it('rejects when the queue backlog exceeds the cap', () => {
    // Simulate a deep backlog: ~300 requests queue at once. Every 50 pending
    // requests pushes the next slot 60s out, so request ~301 waits >5min.
    let grants: number[] = []
    for (let i = 0; i < 300; i++) {
      grants = computeThrottleSlot(grants, T0).grants
    }

    const { result, grants: unchanged } = computeThrottleSlot(grants, T0)
    expect(result.granted).toBe(false)
    expect(result.waitMs).toBeGreaterThan(THROTTLE_QUEUE_CAP_MS)
    expect(result.error).toContain('saturated')
    expect(unchanged).toHaveLength(grants.length) // no new slot committed
  })
})

describe('computeThrottleStats', () => {
  it('reports empty-window stats', () => {
    const stats = computeThrottleStats([], T0)
    expect(stats.limit).toBe(50)
    expect(stats.windowCount).toBe(0)
    expect(stats.availableNow).toBe(50)
    expect(stats.queueDepth).toBe(0)
    expect(stats.nextSlotWaitMs).toBe(0)
  })

  it('reports queue depth and next-slot wait under load', () => {
    let grants: number[] = []
    for (let i = 0; i < 60; i++) {
      grants = computeThrottleSlot(grants, T0).grants
    }
    const stats = computeThrottleStats(grants, T0)
    expect(stats.availableNow).toBe(0)
    expect(stats.queueDepth).toBe(10) // 10 reserved in the future
    expect(stats.nextSlotWaitMs).toBeGreaterThan(0)
  })
})
