/**
 * Full Integration Test - Property Analysis Flow
 *
 * This test makes REAL API calls to:
 * - CoreLogic API (property data, comparables)
 * - Gemini API (Zillow data via URL Context)
 *
 * Run with: npm run test -- src/routes/analyze.integration.test.ts
 *
 * Required environment variables (in .dev.vars):
 * - CORELOGIC_CLIENT_ID, CORELOGIC_CLIENT_SECRET
 * - GEMINI_API_KEY
 */

import { describe, it, expect } from 'vitest'
import { createPropertyApi } from '../services/property-api'
import { createAppraisalService, DEFAULT_FILTERS, DEFAULT_ADJUSTMENTS } from '../services/appraisal'
import { createZillowFetcherFromEnv, generateZillowUrl } from '../services/photo-provider'
import { calculateSimpleQualityWeightedArv } from '../services/vision/scoring'
import type { Env } from '../types'
import type { ComparisonResult } from '../services/vision/types'
import type { AppraisedComparable } from '../services/appraisal'

// Build env from process.env for testing
function buildTestEnv(): Partial<Env> {
  return {
    CORELOGIC_CLIENT_ID: process.env.CORELOGIC_CLIENT_ID,
    CORELOGIC_CLIENT_SECRET: process.env.CORELOGIC_CLIENT_SECRET,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_MODEL: process.env.OPENROUTER_MODEL,
  }
}

// Check if we have required API keys
const env = buildTestEnv()
const hasCoreLogic = !!(env.CORELOGIC_CLIENT_ID && env.CORELOGIC_CLIENT_SECRET)
const hasOpenRouter = !!env.OPENROUTER_API_KEY

const describeIfCoreLogic = hasCoreLogic ? describe : describe.skip
const describeIfBoth = hasCoreLogic && hasOpenRouter ? describe : describe.skip

describeIfCoreLogic('Full Analysis Flow - CoreLogic Only', () => {
  // Test with a real Tampa address
  const testAddress = {
    streetAddress: '4507 W Kensington Ave',
    city: 'Tampa',
    state: 'FL',
    zipCode: '33629',
  }

  it('should search for property and get basic data', async () => {
    const propertyApi = createPropertyApi(env as Env)

    const result = await propertyApi.searchProperty({
      streetAddress: testAddress.streetAddress,
      city: testAddress.city,
      state: testAddress.state,
      zipCode: testAddress.zipCode,
    })

    console.log('Property search result:', JSON.stringify(result, null, 2))

    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.address).toBeTruthy()
      expect(result.data.city).toBeTruthy()
      expect(result.data.state).toBeTruthy()
      expect(result.data.zipCode).toBeTruthy()

      console.log(`Found: ${result.data.address}, ${result.data.city}, ${result.data.state}`)
      console.log(`Property ID: ${result.data.id}`)
      console.log(`Beds: ${result.data.bedrooms}, Baths: ${result.data.bathrooms}`)
      console.log(`Sqft: ${result.data.squareFeet}, Year: ${result.data.yearBuilt}`)
    }
  }, 30000)

  it('should get comparables and calculate ARV', async () => {
    const propertyApi = createPropertyApi(env as Env)
    const appraisalService = createAppraisalService()

    // First get the property
    const propertyResult = await propertyApi.searchProperty({
      streetAddress: testAddress.streetAddress,
      city: testAddress.city,
      state: testAddress.state,
      zipCode: testAddress.zipCode,
    })

    expect(propertyResult.success).toBe(true)
    if (!propertyResult.success) return

    const property = propertyResult.data

    // Get comparables from PropertyApi
    const compsResult = await propertyApi.getComparables({
      propertyId: property.id,
      radiusMiles: 1,
      maxComps: 10,
      monthsBack: 12,
      subjectSqft: property.squareFeet ?? undefined,
      subjectPropertyType: property.propertyType ?? undefined,
    })

    expect(compsResult.success).toBe(true)
    if (!compsResult.success) return

    // Apply appraisal rules using evaluate()
    const appraisalResult = appraisalService.evaluate(property, compsResult.data.comparables, {
      filters: DEFAULT_FILTERS,
      adjustments: DEFAULT_ADJUSTMENTS,
    })

    console.log('Appraisal result summary:', {
      arv: appraisalResult.arv,
      compCount: appraisalResult.comparables.length,
      enabledCount: appraisalResult.enabledCount,
    })

    expect(appraisalResult.comparables.length).toBeGreaterThan(0)
    expect(appraisalResult.arv).toBeGreaterThan(0)

    // Log first few comps
    for (const comp of appraisalResult.comparables.slice(0, 3)) {
      console.log(`Comp: ${comp.address}`)
      console.log(`  Price: $${comp.salePrice?.toLocaleString()}, Distance: ${comp.distanceMiles?.toFixed(2)} mi`)
      console.log(`  Enabled: ${comp.isEnabled}, Adjusted: $${comp.adjustedSalePrice?.toLocaleString()}`)
    }
  }, 60000)
})

describeIfBoth('Full Analysis Flow - With Vision Analysis', () => {
  const testAddress = {
    streetAddress: '4507 W Kensington Ave',
    city: 'Tampa',
    state: 'FL',
    zipCode: '33629',
  }

  it('should complete full analysis with Zillow data and vision scoring', async () => {
    const propertyApi = createPropertyApi(env as Env)
    const appraisalService = createAppraisalService()
    const zillowFetcher = createZillowFetcherFromEnv(env as Env)

    expect(zillowFetcher).not.toBeNull()
    if (!zillowFetcher) return

    // Step 1: Get property
    console.log('\n=== Step 1: Property Search ===')
    const propertyResult = await propertyApi.searchProperty({
      streetAddress: testAddress.streetAddress,
      city: testAddress.city,
      state: testAddress.state,
      zipCode: testAddress.zipCode,
    })

    expect(propertyResult.success).toBe(true)
    if (!propertyResult.success) return
    const property = propertyResult.data
    console.log(`Found property: ${property.address}, ${property.city}`)

    // Step 2: Get comparables
    console.log('\n=== Step 2: Get Comparables ===')
    const compsResult = await propertyApi.getComparables({
      propertyId: property.id,
      radiusMiles: 1,
      maxComps: 5, // Limit for API calls
      monthsBack: 12,
      subjectSqft: property.squareFeet ?? undefined,
      subjectPropertyType: property.propertyType ?? undefined,
    })

    expect(compsResult.success).toBe(true)
    if (!compsResult.success) return

    // Apply appraisal rules
    const appraisalResult = appraisalService.evaluate(property, compsResult.data.comparables, {
      filters: DEFAULT_FILTERS,
      adjustments: DEFAULT_ADJUSTMENTS,
    })

    const comps = appraisalResult.comparables
    console.log(`Found ${comps.length} comparables, ARV: $${appraisalResult.arv.toLocaleString()}`)

    // Step 3: Fetch Zillow data for subject
    console.log('\n=== Step 3: Fetch Subject Zillow Data ===')
    const subjectZillow = await zillowFetcher.fetchListing({
      propertyId: property.id,
      address: property.address,
      city: property.city,
      state: property.state,
      zipCode: property.zipCode,
    })

    console.log(`Subject photos found: ${subjectZillow.listing?.photos.length ?? 0}`)
    if (subjectZillow.listing?.description) {
      console.log(`Subject description: ${subjectZillow.listing.description.substring(0, 100)}...`)
    }

    // Step 4: Fetch Zillow data for comps
    console.log('\n=== Step 4: Fetch Comp Zillow Data ===')
    const compZillowResults = await Promise.all(
      comps.slice(0, 3).map((comp: AppraisedComparable) =>
        zillowFetcher.fetchListing(
          {
            propertyId: comp.id,
            address: comp.address,
            city: comp.city,
            state: comp.state,
            zipCode: comp.zipCode,
          },
          { analyzeCondition: true }
        )
      )
    )

    for (const result of compZillowResults) {
      console.log(`\nComp ${result.compId}:`)
      console.log(`  Photos: ${result.listing?.photos.length ?? 0}`)
      console.log(`  Condition: ${result.condition?.overallCondition ?? 'N/A'}`)
      console.log(`  Status: ${result.listing?.status ?? 'N/A'}`)
      if (result.error) {
        console.log(`  Error: ${result.error}`)
      }
    }

    // Step 5: Compare comps to subject
    console.log('\n=== Step 5: Compare Comps to Subject ===')
    const subjectPhotos = subjectZillow.listing?.photos ?? []
    const comparisonMap = new Map<string, ComparisonResult>()

    if (subjectPhotos.length > 0) {
      for (const compResult of compZillowResults) {
        const compPhotos = compResult.listing?.photos ?? []
        if (compPhotos.length > 0) {
          const comp = comps.find((c: AppraisedComparable) => c.id === compResult.compId)
          const comparison = await zillowFetcher.compareToSubject(
            {
              propertyId: compResult.compId,
              address: comp?.address ?? '',
              city: comp?.city ?? '',
              state: comp?.state ?? '',
              zipCode: comp?.zipCode ?? '',
            },
            compPhotos,
            subjectPhotos,
            property.id
          )

          if (comparison.comparisonToSubject) {
            const result = comparison.comparisonToSubject.comparison
            if (result !== 'unknown') {
              comparisonMap.set(compResult.compId, result as ComparisonResult)
            }
            console.log(`\nComp ${compResult.compId} vs Subject:`)
            console.log(`  Comparison: ${result}`)
            console.log(`  Confidence: ${comparison.comparisonToSubject.confidence}%`)
            console.log(`  Adjustment: ${comparison.comparisonToSubject.qualityAdjustment}`)
            console.log(`  Reasoning: ${comparison.comparisonToSubject.reasoning}`)
          }
        }
      }
    } else {
      console.log('No subject photos available for comparison')
    }

    // Step 6: Calculate quality-weighted ARV
    console.log('\n=== Step 6: Calculate Quality-Weighted ARV ===')
    const comparablePrices = comps.map((c: AppraisedComparable) => ({
      compId: c.id,
      price: c.adjustedSalePrice ?? 0,
      isEnabled: c.isEnabled,
    }))

    const weightingResult = calculateSimpleQualityWeightedArv(comparablePrices, comparisonMap)

    console.log(`\nOriginal ARV: $${appraisalResult.arv.toLocaleString()}`)
    console.log(`Quality-Weighted ARV: $${weightingResult.weightedArv?.toLocaleString() ?? 'N/A'}`)
    console.log(`Difference: $${weightingResult.weightedArv ? (weightingResult.weightedArv - appraisalResult.arv).toLocaleString() : 'N/A'}`)

    // Verify we got reasonable results
    expect(weightingResult.weightedArv).not.toBeNull()
    expect(weightingResult.weightedArv).toBeGreaterThan(0)
  }, 180000) // 3 minute timeout for all API calls
})

describe('Unit Tests (no API calls)', () => {
  it('should generate correct Zillow URL', () => {
    const url = generateZillowUrl({
      propertyId: 'test',
      address: '123 Main Street',
      city: 'Tampa',
      state: 'FL',
      zipCode: '33607',
    })

    expect(url).toBe('https://www.zillow.com/homes/123-main-street-tampa-fl-33607_rb/')
  })

  it('should calculate weighted ARV correctly', () => {
    const comps = [
      { compId: 'comp1', price: 400000, isEnabled: true },
      { compId: 'comp2', price: 420000, isEnabled: true },
      { compId: 'comp3', price: 380000, isEnabled: true },
    ]

    // comp1 is better than subject (should lower weight)
    // comp2 is similar (normal weight)
    // comp3 is worse than subject (should increase weight)
    const comparisons = new Map<string, ComparisonResult>([
      ['comp1', 'better'],
      ['comp2', 'similar'],
      ['comp3', 'worse'],
    ])

    const result = calculateSimpleQualityWeightedArv(comps, comparisons)

    // Weighted ARV should be between min and max prices
    expect(result.weightedArv).not.toBeNull()
    expect(result.weightedArv!).toBeGreaterThanOrEqual(380000)
    expect(result.weightedArv!).toBeLessThanOrEqual(420000)

    console.log(`Weighted ARV: $${result.weightedArv?.toLocaleString() ?? 'N/A'}`)
    console.log('Weights:', Object.fromEntries(result.weights))
  })
})
