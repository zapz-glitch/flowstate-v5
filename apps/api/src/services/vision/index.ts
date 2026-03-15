/**
 * Vision Analysis Service
 *
 * Provides AI-powered vision analysis for property photos using OpenRouter.
 * Uses Cloudflare Browser Rendering to fetch photos, then OpenRouter LLM to analyze.
 *
 * OpenRouter supports multiple models via single API:
 * - google/gemini-2.0-flash-001 (default, fast and cheap)
 * - anthropic/claude-3.5-sonnet (high quality)
 * - openai/gpt-4o (alternative)
 *
 * Usage:
 *   import { createVisionService } from '../services/vision'
 *
 *   const vision = createVisionService(env)
 *
 *   // Analyze comp quality
 *   const scores = await vision.analyzeCompQuality(comparables, subject)
 */

import type { Env } from '../../types'
import type { NormalizedComparable, NormalizedProperty } from '../property-api/types'
import type {
  ZillowUrl,
  CompQualityScore,
  PropertyConditionAnalysis,
  CompVsSubjectAnalysis,
  VisionAnalysisResponse,
  FetchedPhotos,
} from './types'
import { generateZillowUrl, generateStreetViewUrl, generateSatelliteUrl } from './zillow'
import { VisionAnalyzer, createVisionAnalyzerFromEnv, VisionProviderType } from './analyzer'
import {
  createPhotoFetcher,
  fetchPropertyPhotos,
  fetchMultiplePropertyPhotos,
} from './photo-fetcher'
import {
  createCacheService,
  visionKey,
  zillowKey,
  CACHE_TTL,
} from '../cache'

// Re-export types
export type {
  ZillowUrl,
  CompQualityScore,
  PropertyConditionAnalysis,
  CompVsSubjectAnalysis,
  ConditionRating,
  ComparisonResult,
  VisionAnalysisResponse,
  FetchedPhotos,
} from './types'

export { generateZillowUrl, generateStreetViewUrl, generateSatelliteUrl } from './zillow'
export { createVisionAnalyzer, createVisionAnalyzerFromEnv } from './analyzer'
export type { VisionProviderType, VisionProviderConfig } from './analyzer'
export { createPhotoFetcher, fetchPropertyPhotos, fetchMultiplePropertyPhotos } from './photo-fetcher'

// ─── Service Interface ────────────────────────────────────────────────────────

export interface VisionService {
  /**
   * Generate Zillow URL for a property
   */
  getZillowUrl(property: {
    address: string
    city: string
    state: string
    zipCode: string
  }): ZillowUrl

  /**
   * Generate Zillow URLs for all comparables
   */
  getCompZillowUrls(comparables: NormalizedComparable[]): Map<string, ZillowUrl>

  /**
   * Analyze a single property's condition from photos
   */
  analyzePropertyCondition(
    photoUrls: string[],
    propertyContext?: {
      address?: string
      squareFeet?: number
      yearBuilt?: number
    }
  ): Promise<VisionAnalysisResponse>

  /**
   * Compare comp to subject property
   */
  compareCompToSubject(
    compPhotoUrls: string[],
    subjectPhotoUrls: string[],
    compId: string,
    subjectId: string
  ): Promise<CompVsSubjectAnalysis | null>

  /**
   * Analyze quality of all comps relative to subject
   * Returns quality scores that can be used to weight ARV calculation
   */
  analyzeCompQuality(
    comparables: NormalizedComparable[],
    subject: NormalizedProperty,
    options?: {
      /** Comp photo URLs by comp ID */
      compPhotoUrls?: Map<string, string[]>
      /** Subject photo URLs */
      subjectPhotoUrls?: string[]
      /** Max comps to analyze (limit API calls) */
      maxCompsToAnalyze?: number
    }
  ): Promise<CompQualityScore[]>

  /**
   * Check if vision analysis is available (API key configured)
   */
  isAvailable(): boolean

  /**
   * Get the current vision provider name (gemini, claude, openai, grok)
   */
  getProviderName(): VisionProviderType | null

  /**
   * Get the current model being used
   */
  getModel(): string | null

  /**
   * Fetch photos for a single property from Zillow
   */
  fetchPropertyPhotos(property: {
    propertyId: string
    address: string
    city: string
    state: string
    zipCode: string
    latitude?: number | null
    longitude?: number | null
  }): Promise<FetchedPhotos>

  /**
   * Fetch photos for multiple comparables from Zillow
   */
  fetchCompPhotos(
    comparables: NormalizedComparable[],
    options?: { maxComps?: number }
  ): Promise<Map<string, FetchedPhotos>>

  /**
   * Analyze comps with automatic photo fetching from Zillow
   * This is the main method for full vision-based comp analysis
   */
  analyzeCompsWithPhotos(
    comparables: NormalizedComparable[],
    subject: NormalizedProperty,
    options?: {
      maxCompsToAnalyze?: number
      fetchPhotos?: boolean
    }
  ): Promise<{
    qualityScores: CompQualityScore[]
    fetchedPhotos: Map<string, FetchedPhotos>
    subjectPhotos: FetchedPhotos | null
  }>
}

// ─── Implementation ───────────────────────────────────────────────────────────

class PropertyVisionService implements VisionService {
  private analyzer: VisionAnalyzer | null
  private env: Env

  constructor(env: Env) {
    this.env = env
    // Create analyzer using OpenRouter
    this.analyzer = createVisionAnalyzerFromEnv({
      OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
      OPENROUTER_MODEL: env.OPENROUTER_MODEL,
    })
  }

  isAvailable(): boolean {
    return this.analyzer !== null
  }

  getProviderName(): VisionProviderType | null {
    return this.analyzer?.getProviderName() ?? null
  }

  getModel(): string | null {
    return this.analyzer?.getModel() ?? null
  }

  getZillowUrl(property: {
    address: string
    city: string
    state: string
    zipCode: string
  }): ZillowUrl {
    return generateZillowUrl(property)
  }

  getCompZillowUrls(comparables: NormalizedComparable[]): Map<string, ZillowUrl> {
    const urlMap = new Map<string, ZillowUrl>()

    for (const comp of comparables) {
      urlMap.set(
        comp.id,
        generateZillowUrl({
          address: comp.address,
          city: comp.city,
          state: comp.state,
          zipCode: comp.zipCode,
        })
      )
    }

    return urlMap
  }

  async analyzePropertyCondition(
    photoUrls: string[],
    propertyContext?: {
      address?: string
      squareFeet?: number
      yearBuilt?: number
    }
  ): Promise<VisionAnalysisResponse> {
    if (!this.analyzer) {
      return {
        success: false,
        error: 'Vision analysis not configured - set OPENROUTER_API_KEY in environment',
        code: 'ANALYSIS_FAILED',
      }
    }

    // Check cache first if we have an address
    if (propertyContext?.address) {
      const cache = createCacheService(this.env)
      const cacheKey = visionKey(propertyContext.address)

      const cached = await cache.get<PropertyConditionAnalysis>(cacheKey)
      if (cached) {
        console.log('VisionService: Cache HIT for vision analysis', { address: propertyContext.address })
        return { success: true, data: cached, cached: true }
      }

      console.log('VisionService: Cache MISS, running vision analysis', { address: propertyContext.address })
      const result = await this.analyzer.analyzeCondition(photoUrls, propertyContext)

      // Cache successful results
      if (result.success && result.data) {
        await cache.set(cacheKey, result.data, { ttl: CACHE_TTL.VISION_ANALYSIS })
      }

      return result
    }

    // No address context, can't cache
    return this.analyzer.analyzeCondition(photoUrls, propertyContext)
  }

  async compareCompToSubject(
    compPhotoUrls: string[],
    subjectPhotoUrls: string[],
    compId: string,
    subjectId: string
  ): Promise<CompVsSubjectAnalysis | null> {
    if (!this.analyzer) {
      return null
    }

    const result = await this.analyzer.compareProperties(compPhotoUrls, subjectPhotoUrls, compId, subjectId)
    return result.analysis
  }

  async analyzeCompQuality(
    comparables: NormalizedComparable[],
    subject: NormalizedProperty,
    options?: {
      compPhotoUrls?: Map<string, string[]>
      subjectPhotoUrls?: string[]
      maxCompsToAnalyze?: number
    }
  ): Promise<CompQualityScore[]> {
    const maxComps = options?.maxCompsToAnalyze ?? 5
    const compPhotoUrls = options?.compPhotoUrls ?? new Map()
    const subjectPhotoUrls = options?.subjectPhotoUrls ?? []

    const scores: CompQualityScore[] = []

    // If no analyzer or no photos, return inferred scores based on data
    if (!this.analyzer || (compPhotoUrls.size === 0 && subjectPhotoUrls.length === 0)) {
      return comparables.map((comp) => this.inferCompQuality(comp, subject))
    }

    // Analyze top N comps
    const compsToAnalyze = comparables.slice(0, maxComps)

    for (const comp of compsToAnalyze) {
      const photos = compPhotoUrls.get(comp.id) ?? []

      if (photos.length > 0 && subjectPhotoUrls.length > 0) {
        // Compare comp to subject
        const comparison = await this.compareCompToSubject(
          photos,
          subjectPhotoUrls,
          comp.id,
          subject.id
        )

        if (comparison) {
          scores.push({
            compId: comp.id,
            qualityScore: this.comparisonToScore(comparison),
            weightAdjustment: comparison.qualityAdjustmentFactor,
            analysis: null,
            comparison,
            analysisSource: 'vision',
          })
          continue
        }
      }

      if (photos.length > 0) {
        // Analyze comp condition alone
        const result = await this.analyzePropertyCondition(photos, {
          address: comp.address,
          squareFeet: comp.squareFeet ?? undefined,
          yearBuilt: comp.yearBuilt ?? undefined,
        })

        if (result.success) {
          scores.push({
            compId: comp.id,
            qualityScore: this.conditionToScore(result.data),
            weightAdjustment: this.conditionToAdjustment(result.data),
            analysis: result.data,
            comparison: null,
            analysisSource: 'vision',
          })
          continue
        }
      }

      // Fall back to inferred
      scores.push(this.inferCompQuality(comp, subject))
    }

    // Add inferred scores for remaining comps
    for (const comp of comparables.slice(maxComps)) {
      scores.push(this.inferCompQuality(comp, subject))
    }

    return scores
  }

  /**
   * Infer comp quality from data without photos
   */
  private inferCompQuality(comp: NormalizedComparable, subject: NormalizedProperty): CompQualityScore {
    let qualityScore = 50 // Start neutral
    let weightAdjustment = 0

    // Adjust based on year built difference
    if (comp.yearBuilt && subject.yearBuilt) {
      const yearDiff = comp.yearBuilt - subject.yearBuilt
      if (yearDiff > 10) {
        qualityScore += 10
        weightAdjustment += 0.1
      } else if (yearDiff < -10) {
        qualityScore -= 10
        weightAdjustment -= 0.1
      }
    }

    // Adjust based on sqft (larger usually means nicer)
    if (comp.squareFeet && subject.squareFeet) {
      const sqftDiff = comp.squareFeet - (subject.squareFeet ?? 0)
      if (sqftDiff > 200) {
        qualityScore += 5
        weightAdjustment += 0.05
      } else if (sqftDiff < -200) {
        qualityScore -= 5
        weightAdjustment -= 0.05
      }
    }

    // Adjust based on price per sqft (higher usually means better condition)
    if (comp.pricePerSqft && subject.pricePerSqft) {
      const ppsqftDiff = comp.pricePerSqft - (subject.pricePerSqft ?? 0)
      if (ppsqftDiff > 20) {
        qualityScore += 10
        weightAdjustment += 0.1
      } else if (ppsqftDiff < -20) {
        qualityScore -= 10
        weightAdjustment -= 0.1
      }
    }

    return {
      compId: comp.id,
      qualityScore: Math.min(100, Math.max(0, qualityScore)),
      weightAdjustment: Math.min(1, Math.max(-1, weightAdjustment)),
      analysis: null,
      comparison: null,
      analysisSource: 'inferred',
    }
  }

  /**
   * Convert condition analysis to quality score
   */
  private conditionToScore(analysis: PropertyConditionAnalysis): number {
    const conditionScores: Record<string, number> = {
      excellent: 90,
      good: 70,
      fair: 50,
      poor: 30,
      unknown: 50,
    }
    return conditionScores[analysis.overallCondition] ?? 50
  }

  /**
   * Convert condition to weight adjustment
   */
  private conditionToAdjustment(analysis: PropertyConditionAnalysis): number {
    const adjustments: Record<string, number> = {
      excellent: 0.15,
      good: 0.05,
      fair: 0,
      poor: -0.15,
      unknown: 0,
    }
    return adjustments[analysis.overallCondition] ?? 0
  }

  /**
   * Convert comparison to quality score
   */
  private comparisonToScore(comparison: CompVsSubjectAnalysis): number {
    const baseScores: Record<string, number> = {
      better: 75,
      similar: 50,
      worse: 25,
      unknown: 50,
    }
    const base = baseScores[comparison.comparison] ?? 50

    // Adjust by confidence
    const confidenceMultiplier = comparison.confidence / 100

    // Blend toward neutral based on confidence
    return Math.round(base * confidenceMultiplier + 50 * (1 - confidenceMultiplier))
  }

  /**
   * Fetch photos for a single property from Zillow
   */
  async fetchPropertyPhotos(property: {
    propertyId: string
    address: string
    city: string
    state: string
    zipCode: string
    latitude?: number | null
    longitude?: number | null
  }): Promise<FetchedPhotos> {
    // Check cache first
    const cache = createCacheService(this.env)
    const fullAddress = `${property.address}, ${property.city}, ${property.state} ${property.zipCode}`
    const cacheKey = zillowKey(fullAddress)

    const cached = await cache.get<FetchedPhotos>(cacheKey)
    if (cached) {
      console.log('VisionService: Cache HIT for Zillow photos', { propertyId: property.propertyId })
      return cached
    }

    console.log('VisionService: Cache MISS, fetching Zillow photos', { propertyId: property.propertyId })
    const result = await fetchPropertyPhotos(property)

    // Cache successful results (photos found)
    if (result.photos.length > 0) {
      await cache.set(cacheKey, result, { ttl: CACHE_TTL.ZILLOW_DATA })
    }

    return result
  }

  /**
   * Fetch photos for multiple comparables from Zillow
   */
  async fetchCompPhotos(
    comparables: NormalizedComparable[],
    options?: { maxComps?: number }
  ): Promise<Map<string, FetchedPhotos>> {
    const maxComps = options?.maxComps ?? 10
    const compsToFetch = comparables.slice(0, maxComps)

    const properties = compsToFetch.map((comp) => ({
      propertyId: comp.id,
      address: comp.address,
      city: comp.city,
      state: comp.state,
      zipCode: comp.zipCode,
      latitude: comp.latitude,
      longitude: comp.longitude,
    }))

    return fetchMultiplePropertyPhotos(properties, {
      concurrency: 3,
      batchDelay: 500,
    })
  }

  /**
   * Analyze comps with automatic photo fetching from Zillow
   */
  async analyzeCompsWithPhotos(
    comparables: NormalizedComparable[],
    subject: NormalizedProperty,
    options?: {
      maxCompsToAnalyze?: number
      fetchPhotos?: boolean
    }
  ): Promise<{
    qualityScores: CompQualityScore[]
    fetchedPhotos: Map<string, FetchedPhotos>
    subjectPhotos: FetchedPhotos | null
  }> {
    const maxComps = options?.maxCompsToAnalyze ?? 5
    const shouldFetchPhotos = options?.fetchPhotos ?? true

    let compPhotoUrls = new Map<string, string[]>()
    let subjectPhotoUrls: string[] = []
    let fetchedPhotos = new Map<string, FetchedPhotos>()
    let subjectPhotos: FetchedPhotos | null = null

    // Fetch photos if requested and analyzer is available
    if (shouldFetchPhotos && this.analyzer) {
      // Fetch subject property photos
      subjectPhotos = await this.fetchPropertyPhotos({
        propertyId: subject.id,
        address: subject.address,
        city: subject.city,
        state: subject.state,
        zipCode: subject.zipCode,
        latitude: subject.latitude,
        longitude: subject.longitude,
      })
      subjectPhotoUrls = subjectPhotos.photos

      // Fetch comp photos
      fetchedPhotos = await this.fetchCompPhotos(comparables, { maxComps })

      // Build photo URL map
      for (const [compId, photos] of fetchedPhotos) {
        compPhotoUrls.set(compId, photos.photos)
      }
    }

    // Run quality analysis
    const qualityScores = await this.analyzeCompQuality(comparables, subject, {
      compPhotoUrls,
      subjectPhotoUrls,
      maxCompsToAnalyze: maxComps,
    })

    return {
      qualityScores,
      fetchedPhotos,
      subjectPhotos,
    }
  }
}

// ─── Factory Function ─────────────────────────────────────────────────────────

/**
 * Create a new vision service instance
 */
export function createVisionService(env: Env): VisionService {
  return new PropertyVisionService(env)
}
