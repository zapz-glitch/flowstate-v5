/**
 * Zillow-specific Types
 *
 * Types for fetching property data and photos from Zillow.
 */

import type { UsageMetrics, TimingMetrics } from '../../../core/types'

// ─── Zillow Listing Data ─────────────────────────────────────────────────────

export interface ZillowListingData {
  /** Zillow URL analyzed */
  zillowUrl: string
  /** Photo URLs found */
  photos: string[]
  /** Property description */
  description?: string
  /** Listed/sold price */
  price?: number
  /** Price per square foot */
  pricePerSqft?: number
  /** Property status */
  status?: 'for_sale' | 'pending' | 'sold' | 'off_market'
  /** Days on market */
  daysOnMarket?: number
  /** Original list date */
  listDate?: string
  /** Property features (raw strings like "3 bed", "2 bath") */
  features?: string[]
  /** Price history */
  priceHistory?: Array<{
    date: string
    price: number
    event: string
  }>

  // ─── Property Details ─────────────────────────────────────────────────────
  bedrooms?: number
  bathrooms?: number
  squareFeet?: number
  lotSize?: string
  lotSizeAcres?: number
  yearBuilt?: number
  propertyType?: string
  style?: string
  stories?: number

  // ─── Construction & Systems ───────────────────────────────────────────────
  foundationType?: string
  roof?: string
  construction?: string
  heating?: string
  cooling?: string

  // ─── Parking ──────────────────────────────────────────────────────────────
  parking?: string
  garageSpaces?: number

  // ─── Financial ────────────────────────────────────────────────────────────
  hoaFee?: number
  taxAmount?: number
  estimatedMonthlyPayment?: number
  lastSaleDate?: string
  lastSalePrice?: number

  // ─── Amenities ────────────────────────────────────────────────────────────
  appliances?: string[]
  flooring?: string[]
  exteriorFeatures?: string[]
  pool?: boolean
  waterfront?: boolean
  view?: string

  // ─── Location ─────────────────────────────────────────────────────────────
  neighborhood?: string
  walkScore?: number
  transitScore?: number

  // ─── Agent ────────────────────────────────────────────────────────────────
  agent?: {
    name?: string
    phone?: string
    brokerage?: string
  }

  /** What's Special highlights from Zillow listing */
  whatsSpecial?: string[]
}

// ─── Property Condition (from photo analysis) ────────────────────────────────

export type ConditionRating = 'excellent' | 'good' | 'fair' | 'poor' | 'unknown'

export interface PropertyCondition {
  overallCondition: ConditionRating
  confidence: number
  exterior?: {
    condition: ConditionRating
    notes: string[]
  }
  interior?: {
    condition: ConditionRating
    notes: string[]
  }
  rehabNeeds?: 'none' | 'cosmetic' | 'moderate' | 'significant' | 'full_renovation'
  summary: string
}

// ─── Zillow Property Identifier ─────────────────────────────────────────────

export interface ZillowPropertyIdentifier {
  propertyId: string
  address: string
  city: string
  state: string
  zipCode: string
}

// ─── Comp Analysis Result ────────────────────────────────────────────────────

export interface CompZillowResult {
  compId: string
  /** Zillow listing data */
  listing?: ZillowListingData
  /** Property condition from photos */
  condition?: PropertyCondition
  /** Comparison to subject property */
  comparisonToSubject?: {
    comparison: 'better' | 'similar' | 'worse' | 'unknown'
    confidence: number
    qualityAdjustment: number // -1 to 1, used for ARV weighting
    reasoning: string
  }
  /** Whether result was served from cache */
  fromCache?: boolean
  /** Error if fetch failed */
  error?: string
  /** Token usage */
  usage?: UsageMetrics
  /** Timing */
  timing?: TimingMetrics
}

// ─── Fetch Options ───────────────────────────────────────────────────────────

export interface ZillowFetchOptions {
  /** Analyze property condition from photos */
  analyzeCondition?: boolean
  /** Compare to subject property photos */
  compareToSubject?: {
    photos: string[]
    propertyId: string
  }
  /** Max photos to analyze */
  maxPhotos?: number
  /** Skip cache and fetch fresh data from Gemini URL context */
  skipCache?: boolean
  /** Skip JSON extraction (faster, HTML-only — use for comps where we only need photos + description) */
  skipJsonExtraction?: boolean
}
