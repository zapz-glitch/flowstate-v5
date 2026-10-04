/**
 * Appraisal Rules — deterministic spec coverage
 *
 * Boundary and rule tests for the appraisal filters, adjustments, and
 * the top-3 ARV comp selection with INSUFFICIENT_COMPS.
 */

import { describe, it, expect } from 'vitest'
import { evaluateComparable } from './evaluator'
import { createAppraisalService } from './index'
import type { AppraisalFilter, AppraisalAdjustment } from './types'
import { DEFAULT_FILTERS } from './types'
import type { NormalizedProperty, NormalizedComparable } from '../property-api/types'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const daysAgo = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

const subject = (overrides?: Partial<NormalizedProperty>): NormalizedProperty => ({
  id: 'subj-1',
  provider: 'corelogic',
  address: '100 Subject St',
  city: 'Tampa',
  state: 'FL',
  zipCode: '33607',
  latitude: 27.95,
  longitude: -82.45,
  bedrooms: 3,
  bathrooms: 2,
  squareFeet: 1500,
  lotSizeAcres: null,
  lotSizeSquareFeet: 8000,
  yearBuilt: 1990,
  propertyType: 'Single Family Residence',
  stories: 1,
  subdivision: 'Oak Park',
  lastSalePrice: null,
  lastSaleDate: null,
  assessedValue: null,
  marketValue: null,
  taxAmount: null,
  ...overrides,
})

const comp = (id: string, overrides?: Partial<NormalizedComparable>): NormalizedComparable => ({
  id,
  provider: 'corelogic',
  address: `${id} Comp Rd`,
  city: 'Tampa',
  state: 'FL',
  zipCode: '33607',
  latitude: 27.95,
  longitude: -82.45,
  distanceMiles: 0.4,
  bedrooms: 3,
  bathrooms: 2,
  squareFeet: 1500,
  lotSizeAcres: null,
  lotSizeSquareFeet: 8100,
  yearBuilt: 1990,
  propertyType: 'Single Family Residence',
  salePrice: 300000,
  saleDate: daysAgo(60),
  pricePerSqft: 200,
  subdivision: 'Oak Park',
  ...overrides,
})

const only = (filters: FilterType[]) =>
  filters.map((type) => {
    const defaults: Partial<Record<FilterType, number>> = {
      subdivision_match: 1,
      sale_age: 180,
      sqft_diff: 250,
      year_built_diff: 10,
      distance: 1.0,
      property_type: 1,
      lot_size_diff: 2500,
      road_barrier: 1,
    }
    return { type, enabled: true, value: defaults[type] } as AppraisalFilter
  })

type FilterType = AppraisalFilter['type']

// ─── Sale Age ─────────────────────────────────────────────────────────────────

describe('sale_age filter', () => {
  it('passes a comp exactly 180 days old', () => {
    const r = evaluateComparable(subject(), comp('c1', { saleDate: daysAgo(180) }), only(['sale_age']), [])
    expect(r.shouldDisable).toBe(false)
  })

  it('fails a comp 181 days old', () => {
    const r = evaluateComparable(subject(), comp('c1', { saleDate: daysAgo(181) }), only(['sale_age']), [])
    expect(r.shouldDisable).toBe(true)
    expect(r.disableReasons[0]).toContain('181 days')
  })

  it('uses the configured threshold, not a hardcoded 180', () => {
    const filters: AppraisalFilter[] = [{ type: 'sale_age', enabled: true, value: 90 }]
    const r = evaluateComparable(subject(), comp('c1', { saleDate: daysAgo(120) }), filters, [])
    expect(r.shouldDisable).toBe(true)
    expect(r.filterResults[0].threshold).toBe(90)
  })
})

// ─── Subdivision ──────────────────────────────────────────────────────────────

describe('subdivision_match filter', () => {
  it('passes same subdivision', () => {
    const r = evaluateComparable(subject(), comp('c1', { subdivision: 'oak park' }), only(['subdivision_match']), [])
    expect(r.shouldDisable).toBe(false)
  })

  it('fails different subdivision', () => {
    const r = evaluateComparable(subject(), comp('c1', { subdivision: 'Other Estates' }), only(['subdivision_match']), [])
    expect(r.shouldDisable).toBe(true)
    expect(r.disableReasons[0]).toContain('Subdivision mismatch')
  })
})

// ─── Square Footage ───────────────────────────────────────────────────────────

describe('sqft_diff filter', () => {
  it('passes comp exactly +250 sqft', () => {
    const r = evaluateComparable(subject(), comp('c1', { squareFeet: 1750 }), only(['sqft_diff']), [])
    expect(r.shouldDisable).toBe(false)
  })

  it('fails comp at +251 sqft', () => {
    const r = evaluateComparable(subject(), comp('c1', { squareFeet: 1751 }), only(['sqft_diff']), [])
    expect(r.shouldDisable).toBe(true)
  })
})

// ─── Property Type ────────────────────────────────────────────────────────────

describe('property_type filter', () => {
  it('passes same property type', () => {
    const r = evaluateComparable(subject(), comp('c1'), only(['property_type']), [])
    expect(r.shouldDisable).toBe(false)
  })

  it('fails different property type', () => {
    const r = evaluateComparable(subject(), comp('c1', { propertyType: 'Condominium' }), only(['property_type']), [])
    expect(r.shouldDisable).toBe(true)
    expect(r.disableReasons[0]).toContain('Property type mismatch')
  })

  it('reports not_verified when type data is missing', () => {
    const r = evaluateComparable(subject(), comp('c1', { propertyType: null }), only(['property_type']), [])
    expect(r.shouldDisable).toBe(false)
    expect(r.filterResults[0].status).toBe('not_verified')
  })
})

// ─── Year Built ───────────────────────────────────────────────────────────────

describe('year_built_diff filter', () => {
  it('passes comp exactly at configured limit', () => {
    const r = evaluateComparable(subject(), comp('c1', { yearBuilt: 2000 }), only(['year_built_diff']), [])
    expect(r.shouldDisable).toBe(false)
  })

  it('fails comp outside configured limit', () => {
    const r = evaluateComparable(subject(), comp('c1', { yearBuilt: 2001 }), only(['year_built_diff']), [])
    expect(r.shouldDisable).toBe(true)
  })
})

// ─── Lot Size ─────────────────────────────────────────────────────────────────

describe('lot_size_diff filter', () => {
  it('passes within ±2500 sqft', () => {
    const r = evaluateComparable(subject(), comp('c1', { lotSizeSquareFeet: 10500 }), only(['lot_size_diff']), [])
    expect(r.shouldDisable).toBe(false)
  })

  it('fails outside ±2500 sqft', () => {
    const r = evaluateComparable(subject(), comp('c1', { lotSizeSquareFeet: 10501 }), only(['lot_size_diff']), [])
    expect(r.shouldDisable).toBe(true)
    expect(r.disableReasons[0]).toContain('Lot size')
  })

  it('uses acres when sqft missing', () => {
    // subject 8000 sqft; comp 0.24 acres ≈ 10,454 sqft → diff ~2454 → pass
    const r = evaluateComparable(subject(), comp('c1', { lotSizeSquareFeet: null, lotSizeAcres: 0.24 }), only(['lot_size_diff']), [])
    expect(r.shouldDisable).toBe(false)
  })
})

// ─── Road Barrier ─────────────────────────────────────────────────────────────

describe('road_barrier filter', () => {
  it('reports not_verified when geospatial data is unavailable', () => {
    const r = evaluateComparable(subject(), comp('c1'), only(['road_barrier']), [])
    expect(r.shouldDisable).toBe(false)
    expect(r.filterResults[0].status).toBe('not_verified')
    expect(r.filterResults[0].reason).toContain('not verified')
  })

  it('fails when data shows the comp across a major road', () => {
    const r = evaluateComparable(subject(), comp('c1', { crossesMajorRoad: true }), only(['road_barrier']), [])
    expect(r.shouldDisable).toBe(true)
    expect(r.disableReasons[0]).toContain('major road')
  })

  it('passes when data confirms no barrier', () => {
    const r = evaluateComparable(subject(), comp('c1', { crossesMajorRoad: false }), only(['road_barrier']), [])
    expect(r.shouldDisable).toBe(false)
    expect(r.filterResults[0].status).toBe('passed')
  })
})

// ─── Standard Adjustments ─────────────────────────────────────────────────────

const adj = (type: AppraisalAdjustment['type'], amount: number, percent?: number): AppraisalAdjustment => ({
  type,
  enabled: true,
  amount,
  percent,
})

describe('standard adjustments', () => {
  it('bedroom adjustment scales by difference', () => {
    const r = evaluateComparable(subject(), comp('c1', { bedrooms: 2 }), [], [adj('bedroom', 15000)])
    const a = r.adjustmentResults.find((x) => x.type === 'bedroom')
    expect(a?.applied).toBe(true)
    expect(a?.amount).toBe(15000) // subject +1 bed → comp adjusted up
  })

  it('bathroom adjustment applies ±$10k per bath', () => {
    const r = evaluateComparable(subject(), comp('c1', { bathrooms: 3 }), [], [adj('bathroom', 10000)])
    const a = r.adjustmentResults.find((x) => x.type === 'bathroom')
    expect(a?.applied).toBe(true)
    expect(a?.amount).toBe(-10000) // comp has more baths → adjust comp down
  })

  it('pool adjustment compares subject vs comp', () => {
    const s = subject({ features: { poolType: 'In Ground' } })
    const withPool = evaluateComparable(s, comp('c1', { features: { poolType: 'In Ground' } }), [], [adj('pool', 10000)])
    expect(withPool.adjustmentResults.find((x) => x.type === 'pool')?.applied).toBe(false) // both have → no adj

    const without = evaluateComparable(s, comp('c1'), [], [adj('pool', 10000)])
    const a = without.adjustmentResults.find((x) => x.type === 'pool')
    expect(a?.applied).toBe(true)
    expect(a?.amount).toBe(10000)
  })

  it('garage adjustment applies when only subject has garage', () => {
    const s = subject({ features: { garageType: 'Attached', garageSquareFeet: 400 } })
    const r = evaluateComparable(s, comp('c1'), [], [adj('garage', 10000)])
    const a = r.adjustmentResults.find((x) => x.type === 'garage')
    expect(a?.applied).toBe(true)
    expect(a?.amount).toBe(10000)
  })

  it('carport adjustment applies when only subject has carport', () => {
    const s = subject({ features: { carportType: 'Attached', carportSpaces: 1 } })
    const r = evaluateComparable(s, comp('c1'), [], [adj('carport', 5000)])
    const a = r.adjustmentResults.find((x) => x.type === 'carport')
    expect(a?.applied).toBe(true)
    expect(a?.amount).toBe(5000)
  })
})

// ─── Traffic / Commercial Adjustments ─────────────────────────────────────────

describe('traffic adjustments', () => {
  const trafficAdj = (type: AppraisalAdjustment['type'], amount: number, percent: number): AppraisalAdjustment => ({
    type, enabled: true, amount, percent, valueThreshold: 500000,
  })

  it('siding under $500K → flat deduction', () => {
    const c = comp('c1', { salePrice: 300000, siteInfluence: 'sides_traffic' })
    const r = evaluateComparable(subject(), c, [], [trafficAdj('traffic_siding', 10000, 10)])
    const a = r.adjustmentResults.find((x) => x.type === 'traffic_siding')
    expect(a?.applied).toBe(true)
    expect(a?.amount).toBe(-10000)
  })

  it('backing under $500K → flat deduction', () => {
    const c = comp('c1', { salePrice: 300000, siteInfluence: 'backs_commercial' })
    const r = evaluateComparable(subject(), c, [], [trafficAdj('traffic_backing', 10000, 15)])
    const a = r.adjustmentResults.find((x) => x.type === 'traffic_backing')
    expect(a?.amount).toBe(-10000)
  })

  it('fronting under $500K → flat deduction', () => {
    const c = comp('c1', { salePrice: 300000, siteInfluence: 'fronts_traffic' })
    const r = evaluateComparable(subject(), c, [], [trafficAdj('traffic_fronting', 15000, 20)])
    const a = r.adjustmentResults.find((x) => x.type === 'traffic_fronting')
    expect(a?.amount).toBe(-15000)
  })

  it('siding over $500K → percent deduction', () => {
    const c = comp('c1', { salePrice: 600000, siteInfluence: 'sides_commercial' })
    const r = evaluateComparable(subject(), c, [], [trafficAdj('traffic_siding', 10000, 10)])
    const a = r.adjustmentResults.find((x) => x.type === 'traffic_siding')
    expect(a?.amount).toBe(-60000) // 10% of $600k
  })

  it('backing over $500K → percent deduction', () => {
    const c = comp('c1', { salePrice: 600000, siteInfluence: 'backs_traffic' })
    const r = evaluateComparable(subject(), c, [], [trafficAdj('traffic_backing', 10000, 15)])
    const a = r.adjustmentResults.find((x) => x.type === 'traffic_backing')
    expect(a?.amount).toBe(-90000) // 15% of $600k
  })

  it('fronting over $500K → percent deduction', () => {
    const c = comp('c1', { salePrice: 600000, siteInfluence: 'fronts_commercial' })
    const r = evaluateComparable(subject(), c, [], [trafficAdj('traffic_fronting', 15000, 20)])
    const a = r.adjustmentResults.find((x) => x.type === 'traffic_fronting')
    expect(a?.amount).toBe(-120000) // 20% of $600k
  })

  it('never counts traffic twice — mutually exclusive exposure', () => {
    const c = comp('c1', { salePrice: 300000, siteInfluence: 'fronts_traffic' })
    const r = evaluateComparable(subject(), c, [], [
      trafficAdj('traffic_siding', 10000, 10),
      trafficAdj('traffic_backing', 10000, 15),
      trafficAdj('traffic_fronting', 15000, 20),
    ])
    const applied = r.adjustmentResults.filter((x) => x.applied)
    expect(applied).toHaveLength(1)
    expect(applied[0].type).toBe('traffic_fronting')
  })

  it('not applied when exposure data unavailable', () => {
    const r = evaluateComparable(subject(), comp('c1'), [], [trafficAdj('traffic_fronting', 15000, 20)])
    const a = r.adjustmentResults.find((x) => x.type === 'traffic_fronting')
    expect(a?.applied).toBe(false)
    expect(a?.reason).toContain('not verified')
  })
})

// ─── Basement / Guest-House 50% Rule ──────────────────────────────────────────

describe('basement_sqft adjustment', () => {
  it('credits basement at 50% of normal $/sqft', () => {
    // comp: 1500 sqft @ $200/sqft = $300k; 500 sqft basement → deduct 50% of 500×$200 = $50k
    const c = comp('c1', { basementSquareFeet: 500, pricePerSqft: 200, salePrice: 300000 })
    const r = evaluateComparable(subject(), c, [], [adj('basement_sqft', 0, 50)])
    const a = r.adjustmentResults.find((x) => x.type === 'basement_sqft')
    expect(a?.applied).toBe(true)
    expect(a?.amount).toBe(-50000)
  })

  it('uses configurable percent', () => {
    const c = comp('c1', { basementSquareFeet: 500, pricePerSqft: 200 })
    const r = evaluateComparable(subject(), c, [], [adj('basement_sqft', 0, 60)])
    const a = r.adjustmentResults.find((x) => x.type === 'basement_sqft')
    expect(a?.amount).toBe(-40000) // 40% discount of $100k basement value
  })

  it('not applied without basement data', () => {
    const r = evaluateComparable(subject(), comp('c1'), [], [adj('basement_sqft', 0, 50)])
    expect(r.adjustmentResults.find((x) => x.type === 'basement_sqft')?.applied).toBe(false)
  })
})

// ─── ARV Comp Selection (top-3, early stop, INSUFFICIENT_COMPS) ───────────────

describe('ARV comp selection', () => {
  const service = createAppraisalService()
  // Permissive filters — isolate selection logic
  const lax: AppraisalFilter[] = [
    { type: 'distance', enabled: true, value: 5 },
  ]

  it('selects only in-band comps — within 10% of the top-priced eligible comp', () => {
    const comps = [
      comp('c1', { salePrice: 250000 }),
      comp('c2', { salePrice: 400000 }),
      comp('c3', { salePrice: 300000 }),
      comp('c4', { salePrice: 350000 }),
      comp('c5', { salePrice: 200000 }),
      comp('c6', { salePrice: 380000 }),
    ]
    const r = service.evaluate(subject(), comps, { filters: lax, adjustments: [] })

    // Top = c2 ($400k) → band floor $360k → only c2 + c6 qualify for ARV.
    // c4 ($350k) and c3 ($300k) pass the rules but fall below the band.
    expect(r.selectedCompIds).toEqual(['c2', 'c6'])
    const statuses = Object.fromEntries(r.comparables.map((c) => [c.id, c.arvStatus]))
    expect(statuses['c2']).toBe('selected')
    expect(statuses['c6']).toBe('selected')
    expect(statuses['c4']).toBe('not_examined')
    expect(statuses['c3']).toBe('not_examined')
    expect(statuses['c1']).toBe('not_examined')
    expect(statuses['c5']).toBe('not_examined')
    // Insufficiency keys off eligible (rules-passing) count, not the band —
    // 6 eligible comps means no expansion despite only 2 driving ARV.
    expect(r.insufficientComps).toBe(false)
  })

  it('ARV = mean adjusted $/sqft × subject sqft', () => {
    // 3 comps all 1500 sqft → ppsf = price/1500; subject 1500 sqft
    // c1 ($300k) is below the 10% band of top comp c2 ($360k → floor $324k)
    const comps = [
      comp('c1', { salePrice: 300000, squareFeet: 1500 }),
      comp('c2', { salePrice: 360000, squareFeet: 1500 }),
      comp('c3', { salePrice: 330000, squareFeet: 1500 }),
    ]
    const r = service.evaluate(subject(), comps, { filters: lax, adjustments: [] })
    // mean ppsf = (240 + 220)/2 = 230 → ARV = 230 × 1500 = 345000
    expect(r.arv).toBe(345000)
  })

  it('relaxes to nearest recent comps when fewer than 3 valid and expansion exhausted', () => {
    const comps = [comp('c1'), comp('c2')]
    const r = service.evaluateWithFallback(subject(), comps, { filters: lax, adjustments: [] })

    expect(r.fallbackUsed).toBe('nearest_comps')
    expect(r.insufficientComps).toBe(false)
    expect(r.selectedCompIds?.length).toBe(2)
  })

  it('returns INSUFFICIENT_COMPS only when no comps sold within the age window', () => {
    const comps = [comp('c1', { saleDate: daysAgo(900) }), comp('c2', { saleDate: daysAgo(800) })]
    const r = service.evaluateWithFallback(subject(), comps, { filters: lax, adjustments: [] })

    expect(r.fallbackUsed).toBe('insufficient')
    expect(r.insufficientComps).toBe(true)
  })

  it('ranks same-street and closer comps above newer-but-farther comps', () => {
    // All comps pass the lax rules and land in the price band — ranking is
    // what decides selection. Subject is on "100 Subject St".
    const comps = [
      comp('newfar', { address: '5 Faraway Ln', distanceMiles: 0.9, saleDate: daysAgo(10), salePrice: 390000 }),
      comp('samestreet', { address: '220 Subject St', distanceMiles: 0.3, saleDate: daysAgo(120), salePrice: 380000 }),
      comp('closest', { address: '88 Nearby Rd', distanceMiles: 0.1, saleDate: daysAgo(80), salePrice: 385000 }),
      comp('mid', { address: '12 Elsewhere Dr', distanceMiles: 0.5, saleDate: daysAgo(60), salePrice: 395000 }),
    ]
    const r = service.evaluate(subject(), comps, { filters: lax, adjustments: [] })

    // Same street outranks everything; distance orders the rest
    expect(r.selectedCompIds).toEqual(['samestreet', 'closest', 'mid'])
  })

  it('street name matching ignores suffix abbreviations and house numbers', () => {
    const comps = [
      comp('c1', { address: '999 Woodland Cove', distanceMiles: 0.4, salePrice: 390000 }),
      comp('c2', { address: '5 Woodland Cv', distanceMiles: 0.4, salePrice: 380000 }),
    ]
    const subj = subject({ address: '123 Woodland Cv, San Antonio, TX 78266' })
    const r = service.evaluate(subj, comps, { filters: lax, adjustments: [] })
    // Both on the same street — ordering falls through to distance/recency
    expect(r.selectedCompIds?.length).toBe(2)
    expect(r.fallbackUsed).toBeUndefined()
  })

  it('nearest_comps fallback picks the closest qualifying sale, not just the newest', () => {
    // Only 2 eligible comps → nearest_comps tier. Prices kept inside the
    // 10% band so both survive into selection; the newer comp is farther
    // away, the older-but-closer one should rank first.
    const comps = [
      comp('far', { distanceMiles: 0.9, saleDate: daysAgo(30), salePrice: 400000 }),
      comp('near', { distanceMiles: 0.05, saleDate: daysAgo(90), salePrice: 380000 }),
    ]
    const r = service.evaluateWithFallback(subject(), comps, { filters: lax, adjustments: [] })

    expect(r.fallbackUsed).toBe('nearest_comps')
    expect(r.selectedCompIds?.[0]).toBe('near')
  })

  it('leaves the subdivision before dropping the neighborhood', () => {
    // 2 in-subdivision comps + 2 out-of-subdivision comps in range
    const comps = [
      comp('in1', { subdivision: 'Oak Park', salePrice: 300000 }),
      comp('in2', { subdivision: 'Oak Park', salePrice: 310000 }),
      comp('out1', { subdivision: 'Other', distanceMiles: 1.5, salePrice: 320000 }),
      comp('out2', { subdivision: 'Other', distanceMiles: 1.8, salePrice: 305000 }),
    ]
    const r = service.evaluateWithFallback(subject(), comps, {
      filters: [
        { type: 'subdivision_match', enabled: true, value: 1 },
        { type: 'distance', enabled: true, value: 1.0 },
      ],
      adjustments: [],
      expansion: { allowGeographicExpansion: true, allowYearBuiltExpansion: false },
    })

    expect(r.fallbackUsed).toBe('subdivision_expansion')
    expect(r.expansionApplied).toContain('subdivision')
    expect(r.expansionApplied).not.toContain('year_built')
    expect(r.selectedCompIds).toContain('out1')
  })

  it('tries verified neighborhood comps before leaving to raw geography', () => {
    // 2 in-subdivision comps + 2 out-of-subdivision comps. One out comp
    // shares the subject's neighborhood name — it wins the neighborhood
    // tier over the unrelated out comp.
    const subj = subject({ neighborhoodName: 'Arlington Hills' })
    const comps = [
      comp('in1', { subdivision: 'Oak Park', salePrice: 300000 }),
      comp('in2', { subdivision: 'Oak Park', salePrice: 310000 }),
      comp('nb', { subdivision: 'Other', neighborhoodName: 'Arlington Hills', distanceMiles: 0.8, salePrice: 320000 }),
      comp('far', { subdivision: 'Elsewhere', neighborhoodName: 'Westside', distanceMiles: 0.7, salePrice: 400000 }),
    ]
    const r = service.evaluateWithFallback(subj, comps, {
      filters: [
        { type: 'subdivision_match', enabled: true, value: 1 },
        { type: 'neighborhood_match', enabled: true, value: 1 },
        { type: 'distance', enabled: true, value: 1.0 },
      ],
      adjustments: [],
      expansion: { allowGeographicExpansion: true, allowYearBuiltExpansion: false },
    })

    expect(r.fallbackUsed).toBe('neighborhood_expansion')
    expect(r.expansionApplied).toContain('neighborhood')
    expect(r.selectedCompIds).toContain('nb')
    // The unrelated comp is NOT rescued at this tier — its only chance was
    // the neighborhood evidence, which failed.
    expect(r.selectedCompIds).not.toContain('far')
    const nb = r.comparables.find((c) => c.id === 'nb')
    // subdivision failure stays on the audit trail — rescued, not erased
    expect(
      nb?.evaluation?.filterResults.some(
        (f) => f.type === 'subdivision_match' && !f.passed && f.status === 'failed'
      )
    ).toBe(true)
  })

  it('neighborhood code alone is enough when names differ or are missing', () => {
    const subj = subject({ neighborhoodName: null, neighborhoodCode: 'NB-4417' })
    const comps = [
      comp('in1', { subdivision: 'Oak Park', salePrice: 300000 }),
      comp('in2', { subdivision: 'Oak Park', salePrice: 310000 }),
      comp('code', { subdivision: 'Other', neighborhoodCode: 'NB-4417', distanceMiles: 0.8, salePrice: 320000 }),
    ]
    const r = service.evaluateWithFallback(subj, comps, {
      filters: [
        { type: 'subdivision_match', enabled: true, value: 1 },
        { type: 'distance', enabled: true, value: 1.0 },
      ],
      adjustments: [],
      expansion: { allowGeographicExpansion: true, allowYearBuiltExpansion: false },
    })

    expect(r.fallbackUsed).toBe('neighborhood_expansion')
    expect(r.selectedCompIds).toContain('code')
  })

  it('out-of-neighborhood comps skip the neighborhood tier and fall through to geography', () => {
    const subj = subject({ neighborhoodName: 'Arlington Hills' })
    const comps = [
      comp('in1', { subdivision: 'Oak Park', salePrice: 300000 }),
      comp('in2', { subdivision: 'Oak Park', salePrice: 310000 }),
      comp('geo1', { subdivision: 'Other', neighborhoodName: 'Westside', distanceMiles: 1.5, salePrice: 320000 }),
      comp('geo2', { subdivision: 'Other', neighborhoodName: null, neighborhoodCode: null, distanceMiles: 1.8, salePrice: 305000 }),
    ]
    const r = service.evaluateWithFallback(subj, comps, {
      filters: [
        { type: 'subdivision_match', enabled: true, value: 1 },
        { type: 'distance', enabled: true, value: 1.0 },
      ],
      adjustments: [],
      expansion: { allowGeographicExpansion: true, allowYearBuiltExpansion: false },
    })

    // No verified neighborhood comps → tier 3 fails through to radius×2
    expect(r.fallbackUsed).toBe('subdivision_expansion')
    expect(r.expansionApplied).not.toContain('neighborhood')
    expect(r.selectedCompIds).toContain('geo1')
  })

  it('still enforces other hard rules at the neighborhood tier', () => {
    // Same-neighborhood comp with an intrinsic hard failure (year) must
    // NOT be rescued — neighborhood only carries location failures.
    const subj = subject({ neighborhoodName: 'Arlington Hills', yearBuilt: 2008 })
    const comps = [
      comp('in1', { subdivision: 'Oak Park', yearBuilt: 2008, salePrice: 300000 }),
      comp('in2', { subdivision: 'Oak Park', yearBuilt: 2008, salePrice: 310000 }),
      comp('nb_old', { subdivision: 'Other', neighborhoodName: 'Arlington Hills', yearBuilt: 1975, salePrice: 320000 }), // 33yr off — beyond ±14
    ]
    const r = service.evaluateWithFallback(subj, comps, {
      filters: [
        { type: 'subdivision_match', enabled: true, value: 1 },
        { type: 'year_built_diff', enabled: true, value: 10 },
        { type: 'distance', enabled: true, value: 1.0 },
      ],
      adjustments: [],
      expansion: {
        allowGeographicExpansion: true,
        allowYearBuiltExpansion: true,
        yearBuiltExpansionSteps: [2, 4],
      },
    })

    const nbOld = r.comparables.find((c) => c.id === 'nb_old')
    expect(nbOld?.isEnabled).toBe(false)
    expect(r.selectedCompIds ?? []).not.toContain('nb_old')
  })

  it('widens year-built inside the subdivision before leaving it', () => {
    // 2 strict-year + 1 older-era in-subdivision comps, and 1 strict-year
    // out-of-subdivision comp. Policy: widen year_built while keeping
    // subdivision — never pick the closer-but-outside sale when an
    // in-subdivision sale within the widened tolerance exists.
    // Subject is built 2008 → strict ±10, steps +2/+4 → ±12, ±14.
    const comps = [
      comp('recent1', { subdivision: 'Oak Park', yearBuilt: 2006, salePrice: 300000 }),
      comp('recent2', { subdivision: 'Oak Park', yearBuilt: 2004, salePrice: 310000 }),
      comp('old_in', { subdivision: 'Oak Park', yearBuilt: 1996, salePrice: 400000 }), // 12yr off
      comp('out1', { subdivision: 'Other', yearBuilt: 2008, distanceMiles: 0.9, salePrice: 320000 }),
    ]
    const r = service.evaluateWithFallback(subject({ yearBuilt: 2008 }), comps, {
      filters: [
        { type: 'subdivision_match', enabled: true, value: 1 },
        { type: 'year_built_diff', enabled: true, value: 10 },
        { type: 'distance', enabled: true, value: 1.0 },
      ],
      adjustments: [],
      expansion: {
        allowGeographicExpansion: true,
        allowYearBuiltExpansion: true,
        yearBuiltExpansionSteps: [2, 4],
      },
    })

    expect(r.fallbackUsed).toBe('year_built_expansion')
    expect(r.expansionApplied).toEqual(['year_built'])
    // The older-era in-subdivision comp wins over the strict-year
    // out-of-subdivision comp — and its audit shows threshold ±12
    expect(r.selectedCompIds).toContain('old_in')
    expect(r.selectedCompIds).not.toContain('out1')
    const oldIn = r.comparables.find((c) => c.id === 'old_in')
    const yearRule = oldIn?.evaluation?.filterResults.find((f) => f.type === 'year_built_diff')
    expect(yearRule?.passed).toBe(true)
    expect(yearRule?.threshold).toBe(12)
  })

  it('matches subdivision units/phases to their parent development', () => {
    // Jacksonville scenario: subject "SWEETWATER CREEK" must match the
    // plat-filed unit names inside the same community — but not genuinely
    // different subdivisions.
    const filters: AppraisalFilter[] = [{ type: 'subdivision_match', enabled: true, value: 1 }]
    const subj = subject({ subdivision: 'SWEETWATER CREEK' })

    for (const name of [
      'SWEETWATER CREEK',
      'SWEETWATER CREEK SOUTH',
      'SWEETWATER CREEK S UT 2E',
      'SWEETWATER CREEK S UNIT 2W',
      'SWEETWATER CREEK PH 03',
    ]) {
      const r = evaluateComparable(subj, comp('c', { subdivision: name }), filters, [])
      const f = r.filterResults.find((x) => x.type === 'subdivision_match')
      expect(f?.passed, name).toBe(true)
    }

    for (const name of ['GRAND LAKES', 'PARKSIDE LAKES PH 01', 'OAKWOOD']) {
      const r = evaluateComparable(subj, comp('c', { subdivision: name }), filters, [])
      const f = r.filterResults.find((x) => x.type === 'subdivision_match')
      expect(f?.passed, name).toBe(false)
      expect(f?.status).toBe('failed')
    }
  })

  it('building_style_match is required by default — verified mismatches disqualify', () => {
    // Product rule: like-for-like style. A verified Ranch-vs-Colonial
    // mismatch is a hard failure that no expansion tier can rescue —
    // missing style data stays not_verified and never kills the comp.
    const styleComps = [
      comp('match', { construction: { buildingStyle: 'Ranch' }, salePrice: 280000 }),
      comp('m1', { construction: { buildingStyle: 'Colonial' }, salePrice: 400000 }),
      comp('m2', { construction: { buildingStyle: 'Colonial' }, salePrice: 390000 }),
      comp('m3', { construction: { buildingStyle: 'Colonial' }, salePrice: 380000 }),
    ]
    const r = service.evaluateWithFallback(
      subject({ construction: { buildingStyle: 'Ranch' } }),
      styleComps,
      {
        filters: DEFAULT_FILTERS,
        adjustments: [],
      }
    )

    // The 3 Colonial comps are disqualified — hard style failure, and
    // rescue tiers only carry location failures
    for (const id of ['m1', 'm2', 'm3']) {
      const c = r.comparables.find((x) => x.id === id)
      expect(c?.isEnabled).toBe(false)
      expect(
        c?.evaluation?.filterResults.some(
          (f) => f.type === 'building_style_match' && !f.passed && f.status === 'failed'
        )
      ).toBe(true)
    }
    expect(r.selectedCompIds ?? []).toContain('match')
    expect(r.selectedCompIds ?? []).toHaveLength(1)
  })

  it('never relaxes sale age — a 300-day-old comp is dead at every tier', () => {
    const comps = [
      comp('recent1', { salePrice: 300000, saleDate: daysAgo(30) }),
      comp('recent2', { salePrice: 310000, saleDate: daysAgo(45) }),
      comp('stale', { salePrice: 400000, saleDate: daysAgo(300) }), // >180d absolute
    ]
    const r = service.evaluateWithFallback(subject(), comps, {
      filters: [
        { type: 'sale_age', enabled: true, value: 180 },
        { type: 'distance', enabled: true, value: 1.0 },
      ],
      adjustments: [],
      expansion: {
        allowGeographicExpansion: true,
        allowYearBuiltExpansion: true,
        yearBuiltExpansionSteps: [2, 4],
      },
    })

    // Sale age is absolute — the stale comp is never enabled, even by the
    // nearest-comps last resort (it only carries location failures).
    const stale = r.comparables.find((c) => c.id === 'stale')
    expect(stale?.isEnabled).toBe(false)
    expect(r.selectedCompIds ?? []).not.toContain('stale')
    // And its sale_age failure stays on the audit trail
    expect(
      stale?.evaluation?.filterResults.some(
        (f) => f.type === 'sale_age' && !f.passed && f.status === 'failed'
      )
    ).toBe(true)
  })

  it('a comp beyond the widest year tolerance is dead at every tier', () => {
    // Canoe Creek scenario: subject built 2008, comp built 2025 (17yr off).
    // The year ladder reaches ±14 max — 17yr breaches every tier, so this
    // comp must die even when the search leaves the subdivision.
    const comps = [
      comp('in1', { subdivision: 'Oak Park', yearBuilt: 2008, salePrice: 300000 }),
      comp('in2', { subdivision: 'Oak Park', yearBuilt: 2008, salePrice: 310000 }),
      comp('new_out', {
        subdivision: 'Seaton Crk Reserve Ph 3',
        yearBuilt: 2025, // 17yr off the 2008 subject — beyond ±14 max
        salePrice: 330000,
        distanceMiles: 1.2,
      }),
    ]
    const r = service.evaluateWithFallback(subject({ yearBuilt: 2008 }), comps, {
      filters: [
        { type: 'subdivision_match', enabled: true, value: 1 },
        { type: 'year_built_diff', enabled: true, value: 10 },
        { type: 'sale_age', enabled: true, value: 180 },
        { type: 'distance', enabled: true, value: 1.0 },
      ],
      adjustments: [],
      expansion: {
        allowGeographicExpansion: true,
        allowYearBuiltExpansion: true,
        yearBuiltExpansionSteps: [2, 4],
        geographicDistanceMultiplier: 2,
      },
    })

    // The 2025 comp is never enabled — 17yr breaches even the widest tier
    const newOut = r.comparables.find((c) => c.id === 'new_out')
    expect(newOut?.isEnabled).toBe(false)
    expect(r.selectedCompIds ?? []).not.toContain('new_out')
    // The failed hard rule stays on the audit trail
    expect(
      newOut?.evaluation?.filterResults.some(
        (f) => f.type === 'year_built_diff' && !f.passed && f.status === 'failed'
      )
    ).toBe(true)
  })

  it('respects expansion disabled → INSUFFICIENT_COMPS', () => {
    const comps = [
      comp('in1'),
      comp('out1', { subdivision: 'Other' }),
      comp('out2', { subdivision: 'Other' }),
    ]
    const r = service.evaluateWithFallback(subject(), comps, {
      filters: [{ type: 'subdivision_match', enabled: true, value: 1 }],
      adjustments: [],
      expansion: { enabled: false },
    })

    expect(r.fallbackUsed).toBe('insufficient')
    expect(r.insufficientComps).toBe(true)
  })

  it('disqualified comps keep their failure reasons (audit trail)', () => {
    const comps = [
      comp('good1'), comp('good2'), comp('good3'),
      comp('bad', { saleDate: daysAgo(400) }),
    ]
    const r = service.evaluate(subject(), comps, {
      filters: [{ type: 'sale_age', enabled: true, value: 180 }],
      adjustments: [],
    })

    const bad = r.comparables.find((c) => c.id === 'bad')
    expect(bad?.arvStatus).toBe('disqualified')
    expect(bad?.evaluation.disableReasons.length).toBeGreaterThan(0)
    expect(bad?.evaluation.filterResults.find((f) => f.type === 'sale_age')?.status).toBe('failed')
  })
})

// ─── User-configured priority (Required vs Preferred) ──────────────────────────

describe('filter priority (required vs preferred)', () => {
  it('preferred (soft) sqft_diff: a verified failure is recorded but does not disqualify', () => {
    const filters: AppraisalFilter[] = [{ type: 'sqft_diff', enabled: true, value: 250, priority: 'soft' }]
    const r = evaluateComparable(subject(), comp('c1', { squareFeet: 2000 }), filters, [])
    expect(r.shouldDisable).toBe(false)
    expect(r.filterResults.find((f) => f.type === 'sqft_diff')?.passed).toBe(false)
  })

  it('required (hard) building_style_match: a verified mismatch disqualifies', () => {
    const filters: AppraisalFilter[] = [{ type: 'building_style_match', enabled: true, value: 1, priority: 'hard' }]
    const r = evaluateComparable(
      subject({ construction: { buildingStyle: 'Ranch' } }),
      comp('c1', { construction: { buildingStyle: 'Colonial' } }),
      filters,
      []
    )
    expect(r.shouldDisable).toBe(true)
  })

  it('same building_style_match at preferred (soft) does not disqualify', () => {
    const filters: AppraisalFilter[] = [{ type: 'building_style_match', enabled: true, value: 1, priority: 'soft' }]
    const r = evaluateComparable(
      subject({ construction: { buildingStyle: 'Ranch' } }),
      comp('c1', { construction: { buildingStyle: 'Colonial' } }),
      filters,
      []
    )
    expect(r.shouldDisable).toBe(false)
    expect(r.filterResults.find((f) => f.type === 'building_style_match')?.passed).toBe(false)
  })

  it('a disabled filter produces no evaluation result at all', () => {
    const filters: AppraisalFilter[] = [{ type: 'subdivision_match', enabled: false, value: 1 }]
    const r = evaluateComparable(subject(), comp('c1', { subdivision: 'Far Away' }), filters, [])
    expect(r.filterResults).toHaveLength(0)
    expect(r.shouldDisable).toBe(false)
  })
})
