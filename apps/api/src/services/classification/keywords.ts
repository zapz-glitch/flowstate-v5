/**
 * Classification Keywords
 *
 * Keywords used to identify As-Is vs After-Renovation properties
 * from property descriptions and Zillow facts/features.
 */

// ─── Keyword Lists ────────────────────────────────────────────────────────────

/** Strong as-is signals — single match is usually enough */
export const STRONG_AS_IS_KEYWORDS = [
  'investor special',
  'handyman special',
  'fixer upper',
  'fixer-upper',
  'investment opportunity',
  'investor opportunity',
  'cash only',
  'cash buyers',
  'no fha',
  'no va',
  'no financing',
  'as-is',
  'as is',
  'sold as-is',
  'needs work',
  'needs renovation',
  'needs tlc',
  'needs rehab',
  'needs repairs',
  'diamond in the rough',
  'foreclosure',
  'reo',
  'bank owned',
  'short sale',
  'distressed',
  'estate sale',
  'probate',
]

/** Supporting as-is signals — reinforce strong signals */
export const SUPPORTING_AS_IS_KEYWORDS = [
  'fixer',
  'where is',
  'needs updating',
  'needs some love',
  'motivated seller',
  'must sell',
  'priced to sell',
  'potential',
  'bring your vision',
  'make it your own',
  'great bones',
  'good bones',
  'solid bones',
  'original',
  'vintage',
  'retro',
  'dated',
  'older home',
  'cosmetic',
  'classic',
]

/** Strong after-renovation signals — single match is usually enough */
export const STRONG_AFTER_RENO_KEYWORDS = [
  'renovated',
  'remodeled',
  'completely renovated',
  'fully renovated',
  'gut renovation',
  'gut rehab',
  'newly renovated',
  'turnkey',
  'turn key',
  'turn-key',
  'move-in ready',
  'move in ready',
  'nothing to do',
  'just move in',
  'like new',
  'better than new',
  'mint condition',
]

/** Supporting after-renovation signals — reinforce strong signals */
export const SUPPORTING_AFTER_RENO_KEYWORDS = [
  'updated',
  'upgraded',
  'restored',
  'refreshed',
  'new kitchen',
  'new bath',
  'new bathroom',
  'new bathrooms',
  'new roof',
  'new hvac',
  'new a/c',
  'new ac',
  'new flooring',
  'new floors',
  'new appliances',
  'new windows',
  'new plumbing',
  'new electrical',
  'new water heater',
  'modern',
  'contemporary',
  'designer',
  'custom',
  'luxury',
  'upscale',
  'high-end',
  'premium',
  'showroom',
  'freshly painted',
  'fresh paint',
  'new paint',
  'stainless steel',
  'granite',
  'quartz',
  'marble',
  'hardwood',
  'lvp',
  'luxury vinyl',
  'tile floors',
  'open concept',
  'open floor plan',
  'open layout',
  'smart home',
  'energy efficient',
  'solar',
  'tankless',
  'pristine',
  'immaculate',
  'spotless',
]

// Flat exports kept for backwards compat in other modules
export const AS_IS_KEYWORDS = [...STRONG_AS_IS_KEYWORDS, ...SUPPORTING_AS_IS_KEYWORDS]
export const AFTER_RENOVATION_KEYWORDS = [...STRONG_AFTER_RENO_KEYWORDS, ...SUPPORTING_AFTER_RENO_KEYWORDS]

// ─── Confidence Level ─────────────────────────────────────────────────────────

export type DescriptionConfidence = 'high' | 'medium' | 'low'

// ─── Analysis Result ──────────────────────────────────────────────────────────

export interface DescriptionAnalysis {
  /** Which way the description leans */
  signal: 'as_is' | 'after_renovation' | 'neutral'
  /** How confident we are in the signal */
  confidence: DescriptionConfidence
  /** Human-readable summary of what we found */
  summary: string
  /** Strong keyword matches driving the signal */
  strongMatches: string[]
  /** Supporting keyword matches */
  supportingMatches: string[]
  /** True if any investment-oriented language found */
  investmentIndicators: boolean
  /** True if any retail-ready language found */
  retailReadyIndicators: boolean
}

// ─── Analysis Function ────────────────────────────────────────────────────────

/**
 * Analyze property description and/or Zillow features for classification signals.
 *
 * Confidence levels:
 *   high   — ≥1 strong keyword on the winning side, with 2:1 advantage or no opposing strong signals
 *   medium — only supporting keywords present, or strong signals on both sides
 *   low    — no keywords matched, or only very weak signals
 */
export function analyzeDescriptionKeywords(
  description: string,
  features?: string[]
): DescriptionAnalysis {
  // Combine description + features into one searchable blob
  const parts: string[] = [description]
  if (features && features.length > 0) {
    parts.push(features.join(' '))
  }
  const text = parts.join(' ').toLowerCase()

  // ── Match keywords ──────────────────────────────────────────────────────
  const strongAsIs = STRONG_AS_IS_KEYWORDS.filter((kw) => text.includes(kw))
  const supportAsIs = SUPPORTING_AS_IS_KEYWORDS.filter((kw) => text.includes(kw))
  const strongReno = STRONG_AFTER_RENO_KEYWORDS.filter((kw) => text.includes(kw))
  const supportReno = SUPPORTING_AFTER_RENO_KEYWORDS.filter((kw) => text.includes(kw))

  const asIsTotal = strongAsIs.length + supportAsIs.length
  const renoTotal = strongReno.length + supportReno.length

  // ── Determine signal ────────────────────────────────────────────────────
  let signal: DescriptionAnalysis['signal'] = 'neutral'
  let confidence: DescriptionConfidence = 'low'

  if (strongAsIs.length === 0 && strongReno.length === 0 && asIsTotal === 0 && renoTotal === 0) {
    // No keywords at all
    signal = 'neutral'
    confidence = 'low'
  } else if (strongAsIs.length > 0 || strongReno.length > 0) {
    // At least one strong signal present — decide by which side dominates
    if (strongAsIs.length > 0 && strongReno.length === 0) {
      signal = 'as_is'
      confidence = 'high'
    } else if (strongReno.length > 0 && strongAsIs.length === 0) {
      signal = 'after_renovation'
      confidence = 'high'
    } else {
      // Strong signals on BOTH sides — call it medium for the dominant side
      signal = strongAsIs.length >= strongReno.length ? 'as_is' : 'after_renovation'
      confidence = 'medium'
    }
  } else {
    // Only supporting keywords
    if (asIsTotal > 0 && renoTotal === 0) {
      signal = 'as_is'
      confidence = 'medium'
    } else if (renoTotal > 0 && asIsTotal === 0) {
      signal = 'after_renovation'
      confidence = 'medium'
    } else if (asIsTotal > renoTotal) {
      signal = 'as_is'
      confidence = 'low'
    } else if (renoTotal > asIsTotal) {
      signal = 'after_renovation'
      confidence = 'low'
    } else {
      signal = 'neutral'
      confidence = 'low'
    }
  }

  // ── Build summary ───────────────────────────────────────────────────────
  const summaryParts: string[] = []

  if (strongAsIs.length > 0) {
    summaryParts.push(`Strong as-is indicators: ${strongAsIs.slice(0, 3).join(', ')}`)
  }
  if (supportAsIs.length > 0 && asIsTotal <= 4) {
    summaryParts.push(`Supporting as-is: ${supportAsIs.slice(0, 2).join(', ')}`)
  }
  if (strongReno.length > 0) {
    summaryParts.push(`Strong renovation indicators: ${strongReno.slice(0, 3).join(', ')}`)
  }
  if (supportReno.length > 0 && renoTotal <= 4) {
    summaryParts.push(`Supporting renovation: ${supportReno.slice(0, 2).join(', ')}`)
  }

  let summary: string
  if (summaryParts.length === 0) {
    summary = features && features.length > 0
      ? 'No strong classification keywords found in description or listing features.'
      : 'No classification keywords found in description.'
  } else {
    summary = summaryParts.join('. ') + '.'
  }

  return {
    signal,
    confidence,
    summary,
    strongMatches: [...strongAsIs, ...strongReno],
    supportingMatches: [...supportAsIs, ...supportReno],
    investmentIndicators: strongAsIs.length > 0 || supportAsIs.length > 0,
    retailReadyIndicators: strongReno.length > 0 || supportReno.length > 0,
  }
}
