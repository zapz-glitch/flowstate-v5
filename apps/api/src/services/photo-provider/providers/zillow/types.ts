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
  /** Property status */
  status?: 'for_sale' | 'pending' | 'sold' | 'off_market'
  /** Days on market */
  daysOnMarket?: number
  /** Property features (raw strings like "3 bed", "2 bath") */
  features?: string[]
  /** Price history */
  priceHistory?: Array<{
    date: string
    price: number
    event: string
  }>
  // ─── Structured Property Data (parsed from features/page) ────────────────
  /** Number of bedrooms (parsed from features) */
  bedrooms?: number
  /** Number of bathrooms (parsed from features) */
  bathrooms?: number
  /** Square footage (parsed from features) */
  squareFeet?: number
  /** Year built */
  yearBuilt?: number
  /** Foundation type (e.g., Slab, Crawl Space, Basement) */
  foundationType?: string
  /** Monthly HOA fee in dollars */
  hoaFee?: number
  /** Most recent sale date (from price history) */
  lastSaleDate?: string
  /** Most recent sale price (from price history) */
  lastSalePrice?: number
  // ─── Home Details (from Facts & Features section) ─────────────────────────
  /** Detailed home features extracted from Zillow Facts & Features */
  homeDetails?: {
    parking?: string
    heating?: string
    cooling?: string
    appliances?: string[]
    flooring?: string
    exteriorFeatures?: string[]
    roof?: string
    construction?: string
    lotSize?: string
    stories?: number
    pool?: boolean
    waterfront?: boolean
    view?: string
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
}
