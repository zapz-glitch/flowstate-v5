/**
 * Nearest-comp pool cap.
 *
 * Ways this can fail, each covered below:
 *  - a farther comp is kept while a closer one is dropped
 *  - a comp with no distance on record crowds out a measured one
 *  - the cap changes a pool that is already within it
 *  - an unset or bad cap empties the pool
 */

import { describe, expect, it } from 'vitest'
import { nearestComparables } from './comparable-pool'

const comp = (id: string, distanceMiles: number | null) => ({ id, distanceMiles })

describe('nearestComparables', () => {
  it('keeps the closest comps, nearest first', () => {
    const pool = [comp('far', 2.1), comp('near', 0.1), comp('mid', 0.9), comp('next', 0.4)]
    expect(nearestComparables(pool, 2).map((c) => c.id)).toEqual(['near', 'next'])
  })

  it('keeps 25 of a 100-comp pool and none of the dropped ones is closer than a kept one', () => {
    const pool = Array.from({ length: 100 }, (_, i) => comp(`c${i}`, ((i * 37) % 100) / 10))
    const kept = nearestComparables(pool, 25)
    const keptIds = new Set(kept.map((c) => c.id))
    const farthestKept = Math.max(...kept.map((c) => c.distanceMiles!))
    expect(kept).toHaveLength(25)
    expect(pool.filter((c) => !keptIds.has(c.id)).every((c) => c.distanceMiles! >= farthestKept)).toBe(true)
  })

  it('sorts comps with no distance last and keeps provider order on ties', () => {
    const pool = [comp('unknown', null), comp('a', 0.5), comp('b', 0.5), comp('c', 0.2)]
    expect(nearestComparables(pool, 3).map((c) => c.id)).toEqual(['c', 'a', 'b'])
  })

  it('leaves the pool alone when it is within the cap or the cap is unset', () => {
    const pool = [comp('far', 2), comp('near', 1)]
    expect(nearestComparables(pool, 25)).toBe(pool)
    for (const bad of [null, undefined, 0, -3, Number.NaN]) expect(nearestComparables(pool, bad)).toBe(pool)
  })
})
