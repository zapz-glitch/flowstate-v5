/**
 * Appraisal Evaluator Tests
 */

import { describe, it, expect } from 'vitest'
import { evaluateComparable, evaluateComparables } from './evaluator'
import type { NormalizedProperty, NormalizedComparable } from '../property-api/types'
import type { AppraisalFilter, AppraisalAdjustment } from './types'
import { DEFAULT_FILTERS, DEFAULT_ADJUSTMENTS } from './types'

// ─── Test Fixtures ─────────────────────────────────────────────────────────────

const createSubject = (overrides?: Partial<NormalizedProperty>): NormalizedProperty => ({
  id: 'subject-1',
  provider: 'corelogic',
  address: '123 Main St',
  city: 'Tampa',
  state: 'FL',
  zipCode: '33607',
  latitude: 27.9506,
  longitude: -82.4572,
  bedrooms: 3,
  bathrooms: 2,
  squareFeet: 2000,
  lotSizeAcres: 0.25,
  yearBuilt: 2000,
  propertyType: 'Single Family',
  stories: 1,
  lastSalePrice: 350000,
  lastSaleDate: '2023-01-15',
  assessedValue: 300000,
  marketValue: 350000,
  taxAmount: 5000,
  subdivision: 'Oak Hills',
  ...overrides,
})

const createComparable = (overrides?: Partial<NormalizedComparable>): NormalizedComparable => ({
  id: 'comp-1',
  provider: 'corelogic',
  address: '456 Oak Ave',
  city: 'Tampa',
  state: 'FL',
  zipCode: '33607',
  latitude: 27.9510,
  longitude: -82.4580,
  distanceMiles: 0.3,
  bedrooms: 3,
  bathrooms: 2,
  squareFeet: 2100,
  lotSizeAcres: 0.22,
  yearBuilt: 2002,
  propertyType: 'Single Family',
  salePrice: 375000,
  saleDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 30 days ago
  pricePerSqft: 179,
  raw: { subdivision: 'Oak Hills' },
  ...overrides,
})

// ─── Filter Tests ──────────────────────────────────────────────────────────────

describe('Filter Evaluators', () => {
  describe('subdivision_match filter', () => {
    it('should pass when subdivisions match', () => {
      const subject = createSubject({ subdivision: 'Oak Hills' })
      const comp = createComparable({ raw: { subdivision: 'Oak Hills' } })
      const filters: AppraisalFilter[] = [{ type: 'subdivision_match', enabled: true, value: 1 }]

      const result = evaluateComparable(subject, comp, filters, [])

      expect(result.shouldDisable).toBe(false)
      const filterResult = result.filterResults.find((f) => f.type === 'subdivision_match')
      expect(filterResult?.passed).toBe(true)
    })

    it('should fail when subdivisions do not match', () => {
      const subject = createSubject({ subdivision: 'Oak Hills' })
      const comp = createComparable({ raw: { subdivision: 'Pine Grove' } })
      const filters: AppraisalFilter[] = [{ type: 'subdivision_match', enabled: true, value: 1 }]

      const result = evaluateComparable(subject, comp, filters, [])

      expect(result.shouldDisable).toBe(true)
      expect(result.disableReasons.length).toBeGreaterThan(0)
    })

    it('should pass when subdivision data is not available', () => {
      const subject = createSubject({ subdivision: undefined })
      const comp = createComparable({ raw: {} })
      const filters: AppraisalFilter[] = [{ type: 'subdivision_match', enabled: true, value: 1 }]

      const result = evaluateComparable(subject, comp, filters, [])

      expect(result.shouldDisable).toBe(false)
    })
  })

  describe('sale_age filter', () => {
    it('should pass when sale is within threshold', () => {
      const subject = createSubject()
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      const comp = createComparable({ saleDate: thirtyDaysAgo })
      const filters: AppraisalFilter[] = [{ type: 'sale_age', enabled: true, value: 180 }]

      const result = evaluateComparable(subject, comp, filters, [])

      expect(result.shouldDisable).toBe(false)
    })

    it('should fail when sale is older than threshold', () => {
      const subject = createSubject()
      const twoHundredDaysAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      const comp = createComparable({ saleDate: twoHundredDaysAgo })
      const filters: AppraisalFilter[] = [{ type: 'sale_age', enabled: true, value: 180 }]

      const result = evaluateComparable(subject, comp, filters, [])

      expect(result.shouldDisable).toBe(true)
    })

    it('should fail when no sale date is available', () => {
      const subject = createSubject()
      const comp = createComparable({ saleDate: null })
      const filters: AppraisalFilter[] = [{ type: 'sale_age', enabled: true, value: 180 }]

      const result = evaluateComparable(subject, comp, filters, [])

      expect(result.shouldDisable).toBe(true)
    })
  })

  describe('sqft_diff filter', () => {
    it('should pass when sqft difference is within threshold', () => {
      const subject = createSubject({ squareFeet: 2000 })
      const comp = createComparable({ squareFeet: 2100 })
      const filters: AppraisalFilter[] = [{ type: 'sqft_diff', enabled: true, value: 250 }]

      const result = evaluateComparable(subject, comp, filters, [])

      expect(result.shouldDisable).toBe(false)
    })

    it('should fail when sqft difference exceeds threshold', () => {
      const subject = createSubject({ squareFeet: 2000 })
      const comp = createComparable({ squareFeet: 2500 })
      const filters: AppraisalFilter[] = [{ type: 'sqft_diff', enabled: true, value: 250 }]

      const result = evaluateComparable(subject, comp, filters, [])

      expect(result.shouldDisable).toBe(true)
    })
  })

  describe('year_built_diff filter', () => {
    it('should pass when year built difference is within threshold', () => {
      const subject = createSubject({ yearBuilt: 2000 })
      const comp = createComparable({ yearBuilt: 2005 })
      const filters: AppraisalFilter[] = [{ type: 'year_built_diff', enabled: true, value: 10 }]

      const result = evaluateComparable(subject, comp, filters, [])

      expect(result.shouldDisable).toBe(false)
    })

    it('should fail when year built difference exceeds threshold', () => {
      const subject = createSubject({ yearBuilt: 2000 })
      const comp = createComparable({ yearBuilt: 2015 })
      const filters: AppraisalFilter[] = [{ type: 'year_built_diff', enabled: true, value: 10 }]

      const result = evaluateComparable(subject, comp, filters, [])

      expect(result.shouldDisable).toBe(true)
    })
  })

  describe('distance filter', () => {
    it('should pass when distance is within threshold', () => {
      const subject = createSubject()
      const comp = createComparable({ distanceMiles: 0.3 })
      const filters: AppraisalFilter[] = [{ type: 'distance', enabled: true, value: 0.5 }]

      const result = evaluateComparable(subject, comp, filters, [])

      expect(result.shouldDisable).toBe(false)
    })

    it('should fail when distance exceeds threshold', () => {
      const subject = createSubject()
      const comp = createComparable({ distanceMiles: 0.8 })
      const filters: AppraisalFilter[] = [{ type: 'distance', enabled: true, value: 0.5 }]

      const result = evaluateComparable(subject, comp, filters, [])

      expect(result.shouldDisable).toBe(true)
    })
  })

  describe('disabled filters', () => {
    it('should skip disabled filters', () => {
      const subject = createSubject({ squareFeet: 2000 })
      const comp = createComparable({ squareFeet: 3000 }) // Would fail sqft_diff
      const filters: AppraisalFilter[] = [{ type: 'sqft_diff', enabled: false, value: 250 }]

      const result = evaluateComparable(subject, comp, filters, [])

      expect(result.shouldDisable).toBe(false)
      expect(result.filterResults.length).toBe(0)
    })
  })
})

// ─── Adjustment Tests ──────────────────────────────────────────────────────────

describe('Adjustment Calculators', () => {
  describe('bedroom adjustment', () => {
    it('should add positive adjustment when subject has more bedrooms', () => {
      const subject = createSubject({ bedrooms: 4 })
      const comp = createComparable({ bedrooms: 3 })
      const adjustments: AppraisalAdjustment[] = [{ type: 'bedroom', enabled: true, amount: 15000 }]

      const result = evaluateComparable(subject, comp, [], adjustments)

      expect(result.totalAdjustment).toBe(15000)
      const adjResult = result.adjustmentResults.find((a) => a.type === 'bedroom')
      expect(adjResult?.applied).toBe(true)
      expect(adjResult?.amount).toBe(15000)
    })

    it('should add negative adjustment when subject has fewer bedrooms', () => {
      const subject = createSubject({ bedrooms: 2 })
      const comp = createComparable({ bedrooms: 3 })
      const adjustments: AppraisalAdjustment[] = [{ type: 'bedroom', enabled: true, amount: 15000 }]

      const result = evaluateComparable(subject, comp, [], adjustments)

      expect(result.totalAdjustment).toBe(-15000)
    })

    it('should not apply adjustment when bedroom count is equal', () => {
      const subject = createSubject({ bedrooms: 3 })
      const comp = createComparable({ bedrooms: 3 })
      const adjustments: AppraisalAdjustment[] = [{ type: 'bedroom', enabled: true, amount: 15000 }]

      const result = evaluateComparable(subject, comp, [], adjustments)

      expect(result.totalAdjustment).toBe(0)
    })
  })

  describe('bathroom adjustment', () => {
    it('should add positive adjustment when subject has more bathrooms', () => {
      const subject = createSubject({ bathrooms: 3 })
      const comp = createComparable({ bathrooms: 2 })
      const adjustments: AppraisalAdjustment[] = [{ type: 'bathroom', enabled: true, amount: 10000 }]

      const result = evaluateComparable(subject, comp, [], adjustments)

      expect(result.totalAdjustment).toBe(10000)
    })
  })

  describe('old_comp_discount', () => {
    it('should not apply discount for recent sales (< 90 days)', () => {
      const subject = createSubject()
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      const comp = createComparable({ saleDate: thirtyDaysAgo, salePrice: 400000 })
      const adjustments: AppraisalAdjustment[] = [{ type: 'old_comp_discount', enabled: true, amount: 0, percent: 15 }]

      const result = evaluateComparable(subject, comp, [], adjustments)

      const adjResult = result.adjustmentResults.find((a) => a.type === 'old_comp_discount')
      expect(adjResult?.applied).toBe(false)
    })

    it('should apply discount for older sales (> 90 days)', () => {
      const subject = createSubject()
      const oneHundredDaysAgo = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
      const comp = createComparable({ saleDate: oneHundredDaysAgo, salePrice: 400000 })
      const adjustments: AppraisalAdjustment[] = [{ type: 'old_comp_discount', enabled: true, amount: 0, percent: 15 }]

      const result = evaluateComparable(subject, comp, [], adjustments)

      const adjResult = result.adjustmentResults.find((a) => a.type === 'old_comp_discount')
      expect(adjResult?.applied).toBe(true)
      expect(adjResult?.amount).toBeLessThan(0) // Discount is negative
    })
  })

  describe('combined adjustments', () => {
    it('should calculate total from multiple adjustments', () => {
      const subject = createSubject({ bedrooms: 4, bathrooms: 3 })
      const comp = createComparable({ bedrooms: 3, bathrooms: 2 })
      const adjustments: AppraisalAdjustment[] = [
        { type: 'bedroom', enabled: true, amount: 15000 },
        { type: 'bathroom', enabled: true, amount: 10000 },
      ]

      const result = evaluateComparable(subject, comp, [], adjustments)

      // +1 bedroom (+15000) and +1 bathroom (+10000)
      expect(result.totalAdjustment).toBe(25000)
    })
  })
})

// ─── Adjusted Price Tests ──────────────────────────────────────────────────────

describe('Adjusted Price Calculation', () => {
  it('should calculate adjusted price correctly', () => {
    const subject = createSubject({ bedrooms: 4 })
    const comp = createComparable({ bedrooms: 3, salePrice: 400000 })
    const adjustments: AppraisalAdjustment[] = [{ type: 'bedroom', enabled: true, amount: 15000 }]

    const result = evaluateComparable(subject, comp, [], adjustments)

    expect(result.originalPrice).toBe(400000)
    expect(result.adjustedPrice).toBe(415000) // 400000 + 15000
  })

  it('should return null adjusted price when no price data exists', () => {
    const subject = createSubject()
    const comp = createComparable({ salePrice: null, pricePerSqft: null, squareFeet: null })
    const adjustments: AppraisalAdjustment[] = [{ type: 'bedroom', enabled: true, amount: 15000 }]

    const result = evaluateComparable(subject, comp, [], adjustments)

    expect(result.adjustedPrice).toBeNull()
  })

  it('should derive original price from pricePerSqft when salePrice is missing', () => {
    const subject = createSubject({ bedrooms: 4 })
    const comp = createComparable({ bedrooms: 3, salePrice: null, pricePerSqft: 200, squareFeet: 1500 })
    const adjustments: AppraisalAdjustment[] = [{ type: 'bedroom', enabled: true, amount: 15000 }]

    const result = evaluateComparable(subject, comp, [], adjustments)

    expect(result.originalPrice).toBe(300000)
    expect(result.adjustedPrice).toBe(315000)
  })
})

// ─── Multiple Comparables Tests ────────────────────────────────────────────────

describe('evaluateComparables', () => {
  it('should evaluate multiple comparables', () => {
    const subject = createSubject()
    const comps = [
      createComparable({ id: 'comp-1', distanceMiles: 0.2 }),
      createComparable({ id: 'comp-2', distanceMiles: 0.4 }),
      createComparable({ id: 'comp-3', distanceMiles: 0.8 }), // Should fail distance filter
    ]
    const filters: AppraisalFilter[] = [{ type: 'distance', enabled: true, value: 0.5 }]

    const evaluations = evaluateComparables(subject, comps, filters, [])

    expect(evaluations.size).toBe(3)
    expect(evaluations.get('comp-1')?.shouldDisable).toBe(false)
    expect(evaluations.get('comp-2')?.shouldDisable).toBe(false)
    expect(evaluations.get('comp-3')?.shouldDisable).toBe(true)
  })
})

// ─── Default Filters/Adjustments Tests ─────────────────────────────────────────

describe('Default Values', () => {
  it('should have all default filters', () => {
    expect(DEFAULT_FILTERS.length).toBe(17)
    expect(DEFAULT_FILTERS.map((f) => f.type)).toContain('subdivision_match')
    expect(DEFAULT_FILTERS.map((f) => f.type)).toContain('neighborhood_match')
    expect(DEFAULT_FILTERS.map((f) => f.type)).toContain('building_style_match')
    expect(DEFAULT_FILTERS.map((f) => f.type)).toContain('construction_material_match')
    expect(DEFAULT_FILTERS.map((f) => f.type)).toContain('pool_match')
    expect(DEFAULT_FILTERS.map((f) => f.type)).toContain('garage_match')
    expect(DEFAULT_FILTERS.map((f) => f.type)).toContain('condition_match')
    expect(DEFAULT_FILTERS.map((f) => f.type)).toContain('stories_match')
    expect(DEFAULT_FILTERS.map((f) => f.type)).toContain('roof_material_match')
    expect(DEFAULT_FILTERS.map((f) => f.type)).toContain('foundation_match')
    expect(DEFAULT_FILTERS.map((f) => f.type)).toContain('sale_age')
    expect(DEFAULT_FILTERS.map((f) => f.type)).toContain('sqft_diff')
    expect(DEFAULT_FILTERS.map((f) => f.type)).toContain('year_built_diff')
    expect(DEFAULT_FILTERS.map((f) => f.type)).toContain('distance')
    expect(DEFAULT_FILTERS.map((f) => f.type)).toContain('property_type')
    expect(DEFAULT_FILTERS.map((f) => f.type)).toContain('lot_size_diff')
    expect(DEFAULT_FILTERS.map((f) => f.type)).toContain('road_barrier')
    // Spec-mandated default thresholds
    expect(DEFAULT_FILTERS.find((f) => f.type === 'sale_age')?.value).toBe(180)
    expect(DEFAULT_FILTERS.find((f) => f.type === 'sqft_diff')?.value).toBe(250)
    expect(DEFAULT_FILTERS.find((f) => f.type === 'year_built_diff')?.value).toBe(10)
    expect(DEFAULT_FILTERS.find((f) => f.type === 'lot_size_diff')?.value).toBe(2500)
  })

  it('should have all default adjustments', () => {
    expect(DEFAULT_ADJUSTMENTS.length).toBe(10)
    expect(DEFAULT_ADJUSTMENTS.map((a) => a.type)).toContain('old_comp_discount')
    expect(DEFAULT_ADJUSTMENTS.map((a) => a.type)).toContain('bedroom')
    expect(DEFAULT_ADJUSTMENTS.map((a) => a.type)).toContain('bathroom')
    expect(DEFAULT_ADJUSTMENTS.map((a) => a.type)).toContain('pool')
    expect(DEFAULT_ADJUSTMENTS.map((a) => a.type)).toContain('garage')
    expect(DEFAULT_ADJUSTMENTS.map((a) => a.type)).toContain('carport')
    expect(DEFAULT_ADJUSTMENTS.map((a) => a.type)).toContain('traffic_siding')
    expect(DEFAULT_ADJUSTMENTS.map((a) => a.type)).toContain('traffic_backing')
    expect(DEFAULT_ADJUSTMENTS.map((a) => a.type)).toContain('traffic_fronting')
    expect(DEFAULT_ADJUSTMENTS.map((a) => a.type)).toContain('basement_sqft')
  })

  it('stories is hard priority (1-story vs 1-story, 2-story vs 2-story); roof material is soft', () => {
    expect(DEFAULT_FILTERS.find((f) => f.type === 'stories_match')?.priority).toBe('hard')
    expect(DEFAULT_FILTERS.find((f) => f.type === 'roof_material_match')?.priority).toBe('soft')
  })
})

// ─── Apples-to-Apples Match Filters ────────────────────────────────────────────

describe('Match filters', () => {
  const matchSubject = (overrides?: Partial<NormalizedProperty>) =>
    createSubject({
      neighborhoodName: 'High Country',
      buildingCondition: 'Average',
      construction: { buildingStyle: 'Ranch', foundationType: 'Slab', type: 'Frame', exteriorWalls: 'Wood Siding', roofCover: 'Composition Shingle' },
      features: { poolType: 'In Ground', garageType: 'Attached', heating: 'Forced Air', cooling: 'Central' },
      ...overrides,
    })
  const matchComp = (overrides?: Partial<NormalizedComparable>) =>
    createComparable({
      subdivision: 'Oak Hills',
      neighborhoodName: 'High Country',
      buildingCondition: 'Good',
      stories: 1,
      construction: { buildingStyle: 'Ranch', foundationType: 'Slab', type: 'Frame', exteriorWalls: 'Wood Siding', roofCover: 'Composition Shingle' },
      features: { poolType: 'In Ground', garageType: 'Attached', heating: 'Forced Air', cooling: 'Central' },
      ...overrides,
    })
  const only = (type: AppraisalFilter['type'], priority?: 'hard' | 'soft'): AppraisalFilter[] =>
    [{ type, enabled: true, value: 1, priority }]

  it('neighborhood_match fails on mismatch, not_verified when missing', () => {
    expect(evaluateComparable(matchSubject(), matchComp({ neighborhoodName: 'Other Hood' }), only('neighborhood_match'), []).shouldDisable).toBe(true)
    expect(evaluateComparable(matchSubject(), matchComp({ neighborhoodName: null }), only('neighborhood_match'), []).shouldDisable).toBe(false)
    expect(evaluateComparable(matchSubject(), matchComp(), only('neighborhood_match'), []).filterResults[0].status).toBe('passed')
  })

  it('neighborhood_match passes on code equality alone', () => {
    // Names differ/missing but provider neighborhood codes agree → match
    const r = evaluateComparable(
      matchSubject({ neighborhoodName: null, neighborhoodCode: 'NB-4417' }),
      matchComp({ neighborhoodName: 'Other Hood', neighborhoodCode: 'NB-4417' }),
      only('neighborhood_match'),
      []
    )
    expect(r.shouldDisable).toBe(false)
    expect(r.filterResults[0].status).toBe('passed')
  })

  it('neighborhood_match not_verified when only one side has each field', () => {
    // Subject has code only, comp has name only → no comparable pair
    const r = evaluateComparable(
      matchSubject({ neighborhoodName: null, neighborhoodCode: 'NB-4417' }),
      matchComp({ neighborhoodName: 'High Country', neighborhoodCode: null }),
      only('neighborhood_match'),
      []
    )
    expect(r.filterResults[0].status).toBe('not_verified')
    expect(r.shouldDisable).toBe(false)
  })

  it('building_style_match fails on style mismatch', () => {
    const r = evaluateComparable(matchSubject(), matchComp({ construction: { buildingStyle: 'Colonial' } }), only('building_style_match'), [])
    expect(r.shouldDisable).toBe(true)
    expect(r.disableReasons[0]).toContain('Style mismatch')
  })

  it('construction_material_match fails on exterior wall mismatch', () => {
    const r = evaluateComparable(matchSubject(), matchComp({ construction: { type: 'Masonry', exteriorWalls: 'Brick' } }), only('construction_material_match'), [])
    expect(r.shouldDisable).toBe(true)
    // Missing comp data → not_verified pass
    const nv = evaluateComparable(matchSubject(), matchComp({ construction: undefined }), only('construction_material_match'), [])
    expect(nv.shouldDisable).toBe(false)
    expect(nv.filterResults[0].status).toBe('not_verified')
  })

  it('pool_match fails on presence mismatch; missing data is not_verified', () => {
    // Subject has pool, comp has explicit no-pool → fail
    const fail = evaluateComparable(
      matchSubject(),
      matchComp({ features: { poolType: '' } }),
      only('pool_match'),
      []
    )
    expect(fail.shouldDisable).toBe(true)
    // Missing comp data → not_verified, not a fail
    const nv = evaluateComparable(matchSubject(), matchComp({ features: { poolType: undefined } }), only('pool_match'), [])
    expect(nv.shouldDisable).toBe(false)
    expect(nv.filterResults[0].status).toBe('not_verified')
  })

  it('garage_match fails when subject has covered parking and comp has none', () => {
    // Present-but-empty fields signal "has data, no covered parking"
    const compNoGarage = createComparable({ features: { garageType: '', garageSquareFeet: 0, carportType: '' } })
    const r = evaluateComparable(matchSubject(), compNoGarage, only('garage_match'), [])
    expect(r.shouldDisable).toBe(true)
    // Carport counts as covered parking → match
    const compCarport = createComparable({ features: { carportType: 'Attached' } })
    expect(evaluateComparable(matchSubject(), compCarport, only('garage_match'), []).shouldDisable).toBe(false)
  })

  it('condition_match fails when comp condition is below subject', () => {
    const r = evaluateComparable(matchSubject(), matchComp({ buildingCondition: 'Poor' }), only('condition_match'), [])
    expect(r.shouldDisable).toBe(true)
    // Equal or better passes
    expect(evaluateComparable(matchSubject(), matchComp({ buildingCondition: 'Excellent' }), only('condition_match'), []).shouldDisable).toBe(false)
    expect(evaluateComparable(matchSubject(), matchComp({ buildingCondition: 'Average' }), only('condition_match'), []).shouldDisable).toBe(false)
    // Missing → not_verified
    const nv = evaluateComparable(matchSubject(), matchComp({ buildingCondition: null }), only('condition_match'), [])
    expect(nv.filterResults[0].status).toBe('not_verified')
  })

  it('stories_match records mismatch but does not disqualify (soft)', () => {
    const r = evaluateComparable(matchSubject(), matchComp({ stories: 2 }), only('stories_match', 'soft'), [])
    expect(r.shouldDisable).toBe(false)
    expect(r.filterResults[0].passed).toBe(false)
    expect(r.filterResults[0].status).toBe('failed')
  })

  it('stories_match tolerates a half-story difference (1.5-story comp)', () => {
    const r = evaluateComparable(matchSubject(), matchComp({ stories: 1.5 }), only('stories_match', 'hard'), [])
    expect(r.shouldDisable).toBe(false)
    expect(r.filterResults[0].passed).toBe(true)
  })

  it('stories_match hard-disqualifies a full-story mismatch (1 vs 2)', () => {
    const r = evaluateComparable(matchSubject(), matchComp({ stories: 2 }), only('stories_match', 'hard'), [])
    expect(r.shouldDisable).toBe(true)
    expect(r.filterResults[0].status).toBe('failed')
  })

  it('roof_material_match records mismatch but does not disqualify (soft)', () => {
    const r = evaluateComparable(
      matchSubject(),
      matchComp({ construction: { roofCover: 'Tile' } }),
      only('roof_material_match', 'soft'),
      []
    )
    expect(r.shouldDisable).toBe(false)
    expect(r.filterResults[0].passed).toBe(false)
  })
})
