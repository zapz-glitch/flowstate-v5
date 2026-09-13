/**
 * Buybox Auto-Derivation Tests
 *
 * Verifies the hands-off derivation of rehab level and major items
 * from property data and classification signals.
 */

import { describe, it, expect } from 'vitest'
import { deriveBuybox } from './derivation'
import { MAJOR_ITEMS } from '../valuation/types'
import type { NormalizedProperty, NormalizedPermit } from '../property-api/types'
import type { ClassificationResult } from '../vision/types'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CURRENT_YEAR = new Date().getFullYear()

const createProperty = (overrides?: Partial<NormalizedProperty>): NormalizedProperty => ({
  id: 'subject-1',
  provider: 'corelogic',
  address: '123 Main St',
  city: 'Tampa',
  state: 'FL',
  zipCode: '33607',
  latitude: 27.95,
  longitude: -82.45,
  bedrooms: 3,
  bathrooms: 2,
  squareFeet: 1800,
  lotSizeAcres: 0.2,
  yearBuilt: 1995,
  propertyType: 'Single Family',
  stories: 1,
  lastSalePrice: 300000,
  lastSaleDate: '2024-01-15',
  assessedValue: 280000,
  marketValue: 320000,
  taxAmount: 4500,
  ...overrides,
})

const classify = (
  classification: 'as_is' | 'after_renovation' | 'transitional',
  confidence = 80,
  conditionScore?: number
): ClassificationResult => ({
  classification,
  confidence,
  method: 'batch_photo_analysis',
  indicators: {},
  reasoning: 'test',
  ...(conditionScore !== undefined && {
    photoAnalysis: {
      conditionScore,
      indicators: [],
      renovationLevel: 'cosmetic',
    },
  }),
})

// ─── Rehab Level Derivation ───────────────────────────────────────────────────

describe('deriveBuybox — rehab level', () => {
  it('maps as_is to Heavy Rehab (index 3)', () => {
    const result = deriveBuybox(createProperty(), classify('as_is'))
    expect(result.rehabLevelIndex).toBe(3)
    expect(result.rehabLevelName).toBe('Heavy Rehab')
    expect(result.derived).toBe(true)
  })

  it('maps transitional to Full Cosmetic (index 2)', () => {
    const result = deriveBuybox(createProperty(), classify('transitional'))
    expect(result.rehabLevelIndex).toBe(2)
  })

  it('maps after_renovation to Light Cosmetic (index 1)', () => {
    const result = deriveBuybox(createProperty(), classify('after_renovation'))
    expect(result.rehabLevelIndex).toBe(1)
  })

  it('bumps to Down to Stud when condition score is very low', () => {
    const result = deriveBuybox(createProperty(), classify('transitional', 80, 20))
    expect(result.rehabLevelIndex).toBe(4)
    expect(result.rehabReason).toContain('condition score')
  })

  it('drops to Lipstick for confirmed renovated + excellent condition', () => {
    const result = deriveBuybox(createProperty(), classify('after_renovation', 90, 92))
    expect(result.rehabLevelIndex).toBe(0)
  })

  it('defaults to Full Cosmetic with reason when no classification', () => {
    const result = deriveBuybox(createProperty(), undefined)
    expect(result.rehabLevelIndex).toBe(2)
    expect(result.rehabReason).toContain('defaulted')
  })

  it('bumps pre-1960 as_is to Down to Stud', () => {
    const result = deriveBuybox(createProperty({ yearBuilt: 1955 }), classify('as_is'))
    expect(result.rehabLevelIndex).toBe(4)
    expect(result.rehabReason).toContain('1955')
  })

  it('respects caller-specified rehabLevelIndex', () => {
    const result = deriveBuybox(createProperty(), classify('as_is'), { rehabLevelIndex: 0 })
    expect(result.rehabLevelIndex).toBe(0)
    expect(result.rehabReason).toContain('Caller-specified')
  })
})

// ─── Major Items Derivation (permit-age engine) ───────────────────────────────

const permit = (overrides?: Partial<NormalizedPermit>): NormalizedPermit => ({
  permitId: 'p1',
  permitNumber: 'P-1',
  status: 'Finaled',
  effectiveDate: '2015-06-01',
  expirationDate: null,
  projectType: 'Roof Replacement',
  projectCategory: null,
  classificationTypes: [],
  description: null,
  jobValue: null,
  contractorName: null,
  areaSquareFeet: null,
  ...overrides,
})

describe('deriveBuybox — major items (permit-age engine)', () => {
  it('charges items whose latest permit evidence exceeds the threshold', () => {
    const permits = [
      permit({ permitId: 'p-roof', projectType: 'Roof', effectiveDate: '2000-01-01' }),
      permit({ permitId: 'p-hvac', projectType: 'HVAC Install', effectiveDate: '2005-01-01' }),
    ]
    const result = deriveBuybox(createProperty(), classify('as_is'), undefined, { permits })
    const ids = result.majorItems.filter((m) => m.enabled).map((m) => m.id)

    expect(ids).toContain('roof') // ~26y > 20y threshold
    expect(ids).toContain('hvac') // ~21y > 15y threshold
    // Big-four no-permit rule: 1995 house → water heater assumed original
    // (~30y ≥ 10y threshold) → charged; septic stays evidence-gated
    expect(ids).toContain('water_heater')
    expect(ids).not.toContain('septic')
  })

  it('does NOT charge items with recent permit evidence', () => {
    const recentYear = CURRENT_YEAR - 5
    const permits = [
      permit({ permitId: 'p-roof', projectType: 'Re-Roof', effectiveDate: `${recentYear}-01-01` }),
    ]
    const result = deriveBuybox(createProperty(), classify('as_is'), undefined, { permits })
    const roof = result.majorItemAssessments?.find((a) => a.id === 'roof')

    expect(roof?.evidenceStatus).toBe('verified')
    expect(roof?.enabled).toBe(false)
    expect(roof?.cost).toBe(0)
    expect(result.majorItems.map((m) => m.id)).not.toContain('roof')
  })

  it('boundary: permit exactly at threshold IS charged (end-of-life reached)', () => {
    const thresholdYear = CURRENT_YEAR - 20 // roof threshold = 20
    const permits = [
      permit({ permitId: 'p-roof', projectType: 'Roof', effectiveDate: `${thresholdYear}-06-01` }),
    ]
    const result = deriveBuybox(createProperty(), classify('as_is'), undefined, { permits })
    const roof = result.majorItemAssessments?.find((a) => a.id === 'roof')

    expect(roof?.ageYears).toBe(20)
    expect(roof?.enabled).toBe(true)
    expect(roof?.cost).toBe(10000)
  })

  it('permit one year under threshold is NOT charged', () => {
    const year = CURRENT_YEAR - 19
    const permits = [
      permit({ permitId: 'p-roof', projectType: 'Roof', effectiveDate: `${year}-06-01` }),
    ]
    const result = deriveBuybox(createProperty(), classify('as_is'), undefined, { permits })
    const roof = result.majorItemAssessments?.find((a) => a.id === 'roof')

    expect(roof?.ageYears).toBe(19)
    expect(roof?.enabled).toBe(false)
    expect(roof?.cost).toBe(0)
  })

  it('thresholds work independently per item', () => {
    const year = CURRENT_YEAR - 18
    const permits = [
      permit({ permitId: 'p-roof', projectType: 'Roof', effectiveDate: `${year}-01-01` }),
      permit({ permitId: 'p-wh', projectType: 'Water Heater', effectiveDate: `${year}-01-01` }),
      permit({ permitId: 'p-hvac', projectType: 'HVAC', effectiveDate: `${year}-01-01` }),
    ]
    const result = deriveBuybox(createProperty(), classify('as_is'), undefined, { permits })
    const a = result.majorItemAssessments ?? []

    expect(a.find((x) => x.id === 'roof')?.enabled).toBe(false) // 18 < 20
    expect(a.find((x) => x.id === 'hvac')?.enabled).toBe(true) // 18 ≥ 15
    expect(a.find((x) => x.id === 'water_heater')?.enabled).toBe(true) // 18 ≥ 10
  })

  it('settings overrides change the outcome without code changes', () => {
    const year = CURRENT_YEAR - 12
    const permits = [
      permit({ permitId: 'p-roof', projectType: 'Roof', effectiveDate: `${year}-01-01` }),
    ]
    // Default: 12y < 20y → not charged. Override threshold to 10 → charged at override cost.
    const result = deriveBuybox(createProperty(), classify('as_is'), undefined, {
      permits,
      majorItemConfig: { roof: { ageThreshold: 10, cost: 14000 } },
    })
    const roof = result.majorItemAssessments?.find((a) => a.id === 'roof')

    expect(roof?.enabled).toBe(true)
    expect(roof?.cost).toBe(14000)
    expect(roof?.thresholdYears).toBe(10)
  })

  it('no permits on an old house → big four assumed original and charged', () => {
    const result = deriveBuybox(createProperty({ yearBuilt: 1970 }), classify('as_is'), undefined, {
      permits: [],
    })
    const a = result.majorItemAssessments ?? []
    const ids = result.majorItems.filter((m) => m.enabled).map((m) => m.id)

    for (const id of ['roof', 'hvac', 'water_heater', 'electric_panel'] as const) {
      const item = a.find((x) => x.id === id)
      expect(item?.evidenceStatus).toBe('unknown')
      expect(item?.enabled).toBe(true)
      expect(item?.reason).toContain('assumed original install')
      expect(ids).toContain(id)
    }
    // Charged big-four assumptions don't count toward the unknown tally —
    // only the still-ungated items (replumb/foundation/etc.) do
    const unknownNote = result.notes.find((n) => n.includes('UNKNOWN'))
    expect(unknownNote).toBeDefined()
    expect(unknownNote).toContain(`${MAJOR_ITEMS.length - 4} major item(s)`)
  })

  it('no permits on a young house → big four not charged when under threshold', () => {
    const youngYear = CURRENT_YEAR - 8 // 8y < every big-four threshold (10/15/20/30)
    const result = deriveBuybox(createProperty({ yearBuilt: youngYear }), classify('as_is'), undefined, {
      permits: [],
    })
    const a = result.majorItemAssessments ?? []

    for (const id of ['roof', 'hvac', 'water_heater', 'electric_panel'] as const) {
      const item = a.find((x) => x.id === id)
      expect(item?.enabled).toBe(false)
      expect(item?.cost).toBe(0)
      expect(item?.reason).toContain('not charged')
    }
  })

  it('no permit evidence → plumbing and foundation never assumed', () => {
    const result = deriveBuybox(createProperty({ yearBuilt: 1960 }), classify('as_is'), undefined, {
      permits: [],
    })
    const a = result.majorItemAssessments ?? []
    const ids = result.majorItems.filter((m) => m.enabled).map((m) => m.id)

    for (const id of ['replumb', 'foundation', 'rewire', 'septic'] as const) {
      const item = a.find((x) => x.id === id)
      expect(item?.evidenceStatus).toBe('unknown')
      expect(item?.enabled).toBe(false)
      expect(item?.reason).toContain('not charged')
    }
    expect(ids).not.toContain('replumb')
    expect(ids).not.toContain('foundation')
    // These remain genuine unknowns — flagged in the notes
    expect(result.notes.some((n) => n.includes('UNKNOWN'))).toBe(true)
  })

  it('no permits + unknown build year → big four assumed due', () => {
    const result = deriveBuybox(createProperty({ yearBuilt: null }), classify('as_is'), undefined, {
      permits: [],
    })
    const a = result.majorItemAssessments ?? []

    for (const id of ['roof', 'hvac', 'water_heater', 'electric_panel'] as const) {
      const item = a.find((x) => x.id === id)
      expect(item?.enabled).toBe(true)
      expect(item?.reason).toContain('build year unknown')
    }
  })

  it('conflicting evidence (newer cancelled permit) → CONFLICTING, uses older valid date', () => {
    const permits = [
      permit({ permitId: 'p-old', projectType: 'Roof', effectiveDate: '2005-01-01', status: 'Finaled' }),
      permit({ permitId: 'p-cancel', projectType: 'Roof', effectiveDate: '2020-01-01', status: 'Cancelled' }),
    ]
    const result = deriveBuybox(createProperty(), classify('as_is'), undefined, { permits })
    const roof = result.majorItemAssessments?.find((a) => a.id === 'roof')

    expect(roof?.evidenceStatus).toBe('conflicting')
    expect(roof?.evidenceDate).toBe('2005-01-01')
    expect(roof?.enabled).toBe(true) // ~21y ≥ 20y threshold
  })

  it('manual item + triggered permit item charged exactly once', () => {
    const permits = [
      permit({ permitId: 'p-roof', projectType: 'Roof', effectiveDate: '2000-01-01' }),
    ]
    const callerItems = [{ id: 'roof' as const, enabled: true, cost: 12000 }]
    const result = deriveBuybox(createProperty(), classify('as_is'), { majorItems: callerItems }, { permits })

    const roofLines = result.majorItems.filter((m) => m.id === 'roof')
    expect(roofLines).toHaveLength(1)
    expect(roofLines[0].cost).toBe(12000) // manual cost wins
    const roofAssessment = result.majorItemAssessments?.find((a) => a.id === 'roof')
    expect(roofAssessment?.deduplicated).toBe(true)
    expect(roofAssessment?.cost).toBe(0)
  })

  it('every enabled item carries a justification reason', () => {
    const permits = [
      permit({ permitId: 'p-roof', projectType: 'Roof', effectiveDate: '2000-01-01' }),
    ]
    const result = deriveBuybox(createProperty(), classify('as_is'), undefined, { permits })
    for (const item of result.majorItems.filter((m) => m.enabled)) {
      expect(item.reason.length).toBeGreaterThan(10)
    }
  })

  it('vision renovation level beats classification-derived level', () => {
    const result = deriveBuybox(createProperty(), classify('after_renovation'), undefined, {
      visionLevelIndex: 3,
      visionConfidence: 82,
    })
    expect(result.rehabLevelIndex).toBe(3)
    expect(result.rehabLevelSource).toBe('vision')
    expect(result.rehabReason).toContain('Computer-vision')
  })

  it('caller rehabLevelIndex overrides vision (audited as manual)', () => {
    const result = deriveBuybox(createProperty(), classify('as_is'), { rehabLevelIndex: 0 }, {
      visionLevelIndex: 3,
      visionConfidence: 82,
    })
    expect(result.rehabLevelIndex).toBe(0)
    expect(result.rehabLevelSource).toBe('manual_override')
  })
})

// ─── Deduction Defaults ───────────────────────────────────────────────────────

describe('deriveBuybox — deduction defaults', () => {
  it('applies standard deduction defaults', () => {
    const result = deriveBuybox(createProperty(), classify('as_is'))
    expect(result.closingCostsPercent).toBe(10)
    expect(result.carryingCostsPercent).toBe(5)
    expect(result.wholesaleFee).toBe(10000)
    expect(result.additionPlay).toBe(0)
  })

  it('respects caller overrides', () => {
    const result = deriveBuybox(createProperty(), classify('as_is'), {
      closingCostsPercent: 12,
      carryingCostsPercent: 7,
      wholesaleFee: 15000,
      additionPlay: 5000,
    })
    expect(result.closingCostsPercent).toBe(12)
    expect(result.carryingCostsPercent).toBe(7)
    expect(result.wholesaleFee).toBe(15000)
    expect(result.additionPlay).toBe(5000)
  })
})
