import { describe, expect, it } from 'vitest'
import { computeBlockLadder, compLadderPosition } from './block-ladder'

const sale = (id: string, ppsf: number, bg = true, tract = 'T1') =>
  ({ id, pricePerSqft: ppsf, sameBlockGroup: bg, censusTract: tract })

describe('computeBlockLadder', () => {
  it('splits a bimodal block group into bottom/top clusters', () => {
    // Investor band ~100-120, renovated band ~300-330, middle ~200
    const comps = [
      sale('a', 100), sale('b', 110), sale('c', 120),
      sale('d', 195), sale('e', 205),
      sale('f', 300), sale('g', 315), sale('h', 330),
    ]
    const ladder = computeBlockLadder(comps, 'T1')!
    expect(ladder).not.toBeNull()
    expect(ladder.scope).toBe('block_group')
    expect(ladder.n).toBe(8)
    expect(ladder.groups.get('a')).toBe('bottom')
    expect(ladder.groups.get('h')).toBe('top')
    expect(ladder.topMedianPpsf).toBeGreaterThan(ladder.medianPpsf)
    expect(ladder.bottomMedianPpsf!).toBeLessThan(150)
  })

  it('falls back to tract scope when the block group is thin', () => {
    const comps = [
      sale('a', 100, false), sale('b', 110, false), sale('c', 300, false), sale('d', 320, false),
      sale('e', 200, true), // only one BG sale
    ]
    const ladder = computeBlockLadder(comps, 'T1')!
    expect(ladder.scope).toBe('tract')
    expect(ladder.n).toBe(5)
  })

  it('returns null without enough priced sales', () => {
    expect(computeBlockLadder([sale('a', 100), sale('b', 200)], 'T1')).toBeNull()
    expect(computeBlockLadder([], 'T1')).toBeNull()
  })

  it('falls back to salePrice/squareFeet when pricePerSqft is missing', () => {
    const comps = [
      { id: 'a', salePrice: 100000, squareFeet: 1000, sameBlockGroup: true, censusTract: 'T1' },
      { id: 'b', salePrice: 200000, squareFeet: 1000, sameBlockGroup: true, censusTract: 'T1' },
      { id: 'c', salePrice: 300000, squareFeet: 1000, sameBlockGroup: true, censusTract: 'T1' },
    ]
    const ladder = computeBlockLadder(comps, 'T1')!
    expect(ladder.medianPpsf).toBe(200)
  })
})

describe('compLadderPosition', () => {
  const comps = [
    sale('a', 100), sale('b', 110), sale('c', 120),
    sale('d', 195), sale('e', 205),
    sale('f', 300), sale('g', 315), sale('h', 330),
  ]
  const ladder = computeBlockLadder(comps, 'T1')!

  it('reports rung + ratios for a ladder member', () => {
    const pos = compLadderPosition({ id: 'f', pricePerSqft: 300 }, ladder)!
    expect(pos.group).toBe('top')
    expect(pos.ppsfVsMedian).toBeGreaterThan(1)
    expect(pos.ppsfVsTop).toBeCloseTo(1, 0)
  })

  it('out-of-pocket comps get ratios but no rung', () => {
    const pos = compLadderPosition({ id: 'x', pricePerSqft: 150, sameBlockGroup: false, censusTract: 'T2' }, ladder)!
    expect(pos.group).toBeNull()
    expect(pos.ppsfVsMedian).not.toBeNull()
  })

  it('returns null when no ladder exists', () => {
    expect(compLadderPosition({ id: 'a', pricePerSqft: 100 }, null)).toBeNull()
  })
})
