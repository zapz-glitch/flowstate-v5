/**
 * Evaluation Report Tests
 *
 * Verifies the justified report attached to every completed evaluation.
 */

import { describe, it, expect } from 'vitest'
import { buildEvaluationReport } from './report'
import { deriveBuybox } from './derivation'
import { createValuationService } from '../valuation'
import type { PropertyBundle } from '../property-api'
import type { NormalizedProperty, NormalizedComparable } from '../property-api/types'
import type { AppraisalResultWithFallback, WeightedARVResult } from '../appraisal'
import type { ClassificationResult } from '../vision/types'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const subject: NormalizedProperty = {
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
  yearBuilt: 1972,
  propertyType: 'Single Family',
  stories: 1,
  lastSalePrice: 280000,
  lastSaleDate: '2024-06-01',
  assessedValue: 260000,
  marketValue: 300000,
  taxAmount: 4200,
}

const comp: NormalizedComparable = {
  id: 'comp-1',
  provider: 'corelogic',
  address: '456 Oak Ave',
  city: 'Tampa',
  state: 'FL',
  zipCode: '33607',
  latitude: 27.951,
  longitude: -82.46,
  bedrooms: 3,
  bathrooms: 2,
  squareFeet: 1750,
  lotSizeAcres: 0.2,
  yearBuilt: 1970,
  propertyType: 'Single Family',
  salePrice: 390000,
  saleDate: '2026-05-01',
  pricePerSqft: 223,
  distanceMiles: 0.3,
}

const bundle: PropertyBundle = {
  property: subject,
  comparables: [comp],
  enrichment: {},
  fetchedAt: new Date().toISOString(),
} as unknown as PropertyBundle

const appraisal: AppraisalResultWithFallback = {
  subject,
  comparables: [
    {
      ...comp,
      isEnabled: true,
      adjustedSalePrice: 395000,
      evaluation: {
        shouldDisable: false,
        disableReasons: [],
        filterResults: [],
        adjustmentResults: [],
        totalAdjustment: 5000,
        adjustedPrice: 395000,
      },
    },
  ] as unknown as AppraisalResultWithFallback['comparables'],
  enabledCount: 1,
  disabledCount: 0,
  appliedFilters: [],
  appliedAdjustments: [],
  arv: 395000,
  avgPricePerSqft: 225,
  medianSalePrice: 395000,
  fallbackUsed: 'none',
}

const subjectClassification: ClassificationResult = {
  classification: 'as_is',
  confidence: 82,
  method: 'batch_photo_analysis',
  indicators: {},
  reasoning: 'Distressed condition visible',
}

const weightedARV: WeightedARVResult = {
  arv: 395000,
  asIsValue: 300000,
  afterRenovationValue: 395000,
  spread: 95000,
  weightBreakdown: [
    {
      compId: 'comp-1',
      price: 395000,
      weight: 1,
      normalizedWeight: 1,
      factors: {
        distance: 1.5,
        sqftSimilarity: 1.4,
        recency: 1.3,
        classificationMatch: 2,
        confidenceBonus: 1.1,
        filterPassRate: 1.4,
      },
      classification: 'after_renovation',
      isPrimaryMatch: false,
      tier: 3,
    },
  ],
  asIsCompIds: [],
  afterRenovationCompIds: ['comp-1'],
  transitionalCompIds: [],
  bestCompId: 'comp-1',
  scenarios: [],
  methodology: 'Classification-weighted ARV',
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('buildEvaluationReport', () => {
  const valuationService = createValuationService()
  // Subject permits (1972 build) — old evidence triggers several major items
  const subjectPermits = [
    { permitId: 'p-roof', permitNumber: null, status: 'Finaled', effectiveDate: '1998-01-01', expirationDate: null, projectType: 'Roof', projectCategory: null, classificationTypes: [], description: null, jobValue: null, contractorName: null, areaSquareFeet: null },
    { permitId: 'p-hvac', permitNumber: null, status: 'Finaled', effectiveDate: '1999-01-01', expirationDate: null, projectType: 'HVAC', projectCategory: null, classificationTypes: [], description: null, jobValue: null, contractorName: null, areaSquareFeet: null },
    { permitId: 'p-wh', permitNumber: null, status: 'Finaled', effectiveDate: '2001-01-01', expirationDate: null, projectType: 'Water Heater', projectCategory: null, classificationTypes: [], description: null, jobValue: null, contractorName: null, areaSquareFeet: null },
    { permitId: 'p-elec', permitNumber: null, status: 'Finaled', effectiveDate: '1985-01-01', expirationDate: null, projectType: 'Electrical Panel', projectCategory: null, classificationTypes: [], description: null, jobValue: null, contractorName: null, areaSquareFeet: null },
  ]
  const derived = deriveBuybox(subject, subjectClassification, undefined, { permits: subjectPermits })
  const valuation = valuationService.calculateValuation({
    arv: 395000,
    subjectSqft: 1800,
    compAvgSqft: 1750,
    rehabLevelIndex: derived.rehabLevelIndex,
    majorItems: derived.majorItems,
    closingCostsPercent: derived.closingCostsPercent,
    carryingCostsPercent: derived.carryingCostsPercent,
    wholesaleFee: derived.wholesaleFee,
  })

  const report = buildEvaluationReport({
    bundle,
    appraisalResult: appraisal,
    subjectClassification,
    weightedARVResult: weightedARV,
    derivedBuybox: derived,
    valuation,
    steps: [
      { step: 'property_fetch', label: 'Property Fetch', status: 'completed', durationMs: 1200 },
      { step: 'photo_fetch', label: 'Photo Fetch', status: 'fallback', detail: 'No photos' },
    ],
    fallbacksUsed: ['photos_unavailable'],
  })

  it('produces a complete justified report', () => {
    expect(report.pipelineVersion).toBe('5.0')
    expect(report.steps).toHaveLength(2)
    expect(report.fallbacksUsed).toContain('photos_unavailable')
    expect(report.subject.classification).toBe('as_is')
  })

  it('justifies the ARV with comp drivers', () => {
    expect(report.arv.value).toBe(395000)
    expect(report.arv.drivers).toHaveLength(1)
    expect(report.arv.drivers[0].compId).toBe('comp-1')
    expect(report.arv.drivers[0].weight).toBe(1)
    expect(report.arv.compPool.enabled).toBe(1)
    expect(report.arv.compPool.fallbackUsed).toBe('none')
  })

  it('justifies rehab derivation and itemizes deductions', () => {
    // as_is + built 1972 → Heavy Rehab minimum
    expect(report.rehab.levelIndex).toBeGreaterThanOrEqual(3)
    expect(report.rehab.reason).toContain('as_is')
    // Old permit evidence triggers multiple age-exceeded items
    expect(report.rehab.majorItems.length).toBeGreaterThanOrEqual(3)
    // Renovation ledger present with a rehab-tier base line
    expect(report.rehab.ledger?.some((l) => l.source === 'rehab_tier')).toBe(true)
    // deductions itemized: base rehab + major items + closing + carrying + profit
    expect(report.deductions.length).toBeGreaterThanOrEqual(4)
    for (const d of report.deductions) {
      expect(d.reason.length).toBeGreaterThan(5)
      expect(d.amount).toBeLessThanOrEqual(0)
    }
  })

  it('reports outcome and confidence', () => {
    expect(report.outcome.maxBuyPrice).toBe(valuation.buyPrice)
    expect(report.outcome.recommendation).toBe(valuation.recommendation)
    expect(['high', 'medium', 'low']).toContain(report.confidence)
    expect(report.confidenceReasons.length).toBeGreaterThan(0)
  })

  it('degrades to low confidence with no classification and comp fallback', () => {
    const degraded = buildEvaluationReport({
      bundle,
      appraisalResult: { ...appraisal, fallbackUsed: 'nearest_comps', fallbackReason: 'test' },
      subjectClassification: undefined,
      weightedARVResult: undefined,
      derivedBuybox: deriveBuybox(subject, undefined),
      valuation,
      steps: [],
      fallbacksUsed: ['photos_unavailable', 'classification_failed'],
    })
    expect(degraded.confidence).toBe('low')
    expect(degraded.subject.classification).toBeNull()
    expect(degraded.arv.compPool.fallbackUsed).toBe('nearest_comps')
  })
})
