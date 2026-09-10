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
    const defaults: Record<FilterType, number> = {
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

  it('selects the 3 highest-priced valid comps and stops', () => {
    const comps = [
      comp('c1', { salePrice: 250000 }),
      comp('c2', { salePrice: 400000 }),
      comp('c3', { salePrice: 300000 }),
      comp('c4', { salePrice: 350000 }),
      comp('c5', { salePrice: 200000 }),
    ]
    const r = service.evaluate(subject(), comps, { filters: lax, adjustments: [] })

    expect(r.selectedCompIds).toEqual(['c2', 'c4', 'c3'])
    const statuses = Object.fromEntries(r.comparables.map((c) => [c.id, c.arvStatus]))
    expect(statuses['c2']).toBe('selected')
    expect(statuses['c4']).toBe('selected')
    expect(statuses['c3']).toBe('selected')
    expect(statuses['c1']).toBe('not_examined')
    expect(statuses['c5']).toBe('not_examined')
    expect(r.insufficientComps).toBe(false)
  })

  it('ARV = mean adjusted $/sqft × subject sqft', () => {
    // 3 comps all 1500 sqft → ppsf = price/1500; subject 1500 sqft
    const comps = [
      comp('c1', { salePrice: 300000, squareFeet: 1500 }),
      comp('c2', { salePrice: 360000, squareFeet: 1500 }),
      comp('c3', { salePrice: 330000, squareFeet: 1500 }),
    ]
    const r = service.evaluate(subject(), comps, { filters: lax, adjustments: [] })
    // mean ppsf = (200 + 240 + 220)/3 = 220 → ARV = 220 × 1500 = 330000
    expect(r.arv).toBe(330000)
  })

  it('returns INSUFFICIENT_COMPS when fewer than 3 valid and expansion exhausted', () => {
    const comps = [comp('c1'), comp('c2')]
    const r = service.evaluateWithFallback(subject(), comps, { filters: lax, adjustments: [] })

    expect(r.fallbackUsed).toBe('insufficient')
    expect(r.insufficientComps).toBe(true)
    expect(r.selectedCompIds?.length).toBe(2)
  })

  it('expands geography before relaxing sale age', () => {
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
      expansion: { allowGeographicExpansion: true, allowOlderSales: false },
    })

    expect(r.fallbackUsed).toBe('geographic_expansion')
    expect(r.expansionApplied).toContain('geographic')
    expect(r.expansionApplied).not.toContain('older_sales')
    expect(r.selectedCompIds).toContain('out1')
  })

  it('uses older sales only when allowed, with configured discount', () => {
    const comps = [
      comp('recent1', { salePrice: 300000, saleDate: daysAgo(30) }),
      comp('recent2', { salePrice: 310000, saleDate: daysAgo(45) }),
      comp('old1', { salePrice: 400000, saleDate: daysAgo(300) }), // >180d, <360d
    ]
    const r = service.evaluateWithFallback(subject(), comps, {
      filters: [
        { type: 'sale_age', enabled: true, value: 180 },
        { type: 'distance', enabled: true, value: 1.0 },
      ],
      adjustments: [],
      expansion: {
        allowGeographicExpansion: true,
        allowOlderSales: true,
        olderSaleAgeMultiplier: 2,
        olderSaleDiscountPercent: 15,
      },
    })

    expect(r.fallbackUsed).toBe('older_sales')
    expect(r.expansionApplied).toContain('older_sales')
    expect(r.selectedCompIds).toContain('old1')
    // old comp gets the configured market-correction discount
    const old = r.comparables.find((c) => c.id === 'old1')
    const discount = old?.evaluation.adjustmentResults.find((a) => a.type === 'old_comp_discount')
    expect(discount?.applied).toBe(true)
    expect(discount?.amount).toBeLessThan(0)
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
