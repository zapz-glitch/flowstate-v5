/**
 * Quality Weighting Service
 *
 * Single source of truth for quality-weighted ARV calculations.
 * Consolidates duplicate logic from analyze.ts and valuation service.
 *
 * The weighting algorithm:
 * - Base weight of 1.0 for each comp
 * - Better condition comps are weighted LOWER (0.8) - their higher prices
 *   should contribute less because subject is in worse condition
 * - Worse condition comps are weighted HIGHER (1.2) - their lower prices
 *   should contribute more because subject is in better condition
 * - Similar condition comps keep base weight (1.0)
 */

import type { CompQualityScore } from '../../vision/types'
import type { ComparisonResult } from '../../vision/types'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ComparablePrice {
  compId: string
  price: number
  isEnabled: boolean
}

export interface QualityWeightingResult {
  weightedArv: number | null
  weights: Map<string, number>
  totalWeight: number
  contributingComps: number
}

export interface WeightingOptions {
  /**
   * Weight multiplier for comps in better condition than subject.
   * Lower value = less contribution to ARV (since subject is worth less).
   * Default: 0.8
   */
  betterWeight?: number

  /**
   * Weight multiplier for comps in worse condition than subject.
   * Higher value = more contribution to ARV (since subject is worth more).
   * Default: 1.2
   */
  worseWeight?: number

  /**
   * Weight for comps with similar condition.
   * Default: 1.0
   */
  similarWeight?: number

  /**
   * Weight for comps with unknown comparison.
   * Default: 1.0
   */
  unknownWeight?: number

  /**
   * Minimum weight allowed (prevents zero/negative weights).
   * Default: 0.1
   */
  minWeight?: number

  /**
   * Maximum weight allowed (prevents extreme weights).
   * Default: 3.0
   */
  maxWeight?: number
}

const DEFAULT_OPTIONS: Required<WeightingOptions> = {
  betterWeight: 0.8,
  worseWeight: 1.2,
  similarWeight: 1.0,
  unknownWeight: 1.0,
  minWeight: 0.1,
  maxWeight: 3.0,
}

// ─── Weighting Functions ──────────────────────────────────────────────────────

/**
 * Calculate weight for a comp based on its comparison to subject
 */
export function calculateCompWeight(
  comparison: ComparisonResult | undefined,
  options: WeightingOptions = {}
): number {
  const opts = { ...DEFAULT_OPTIONS, ...options }

  let weight: number
  switch (comparison) {
    case 'better':
      weight = opts.betterWeight
      break
    case 'worse':
      weight = opts.worseWeight
      break
    case 'similar':
      weight = opts.similarWeight
      break
    default:
      weight = opts.unknownWeight
  }

  // Clamp to min/max
  return Math.min(opts.maxWeight, Math.max(opts.minWeight, weight))
}

/**
 * Calculate weight from quality adjustment factor
 * Used when we have the numeric adjustment factor from vision analysis
 */
export function calculateWeightFromAdjustment(
  adjustmentFactor: number | undefined,
  options: WeightingOptions = {}
): number {
  const opts = { ...DEFAULT_OPTIONS, ...options }

  if (adjustmentFactor === undefined) {
    return opts.unknownWeight
  }

  // adjustmentFactor ranges from -1 to 1
  // Positive = comp is better, negative = comp is worse
  // We want: better comp = lower weight, worse comp = higher weight
  const weight = 1 - (adjustmentFactor * 0.2) // Maps [-1,1] to [1.2, 0.8]

  return Math.min(opts.maxWeight, Math.max(opts.minWeight, weight))
}

/**
 * Calculate quality-weighted ARV from comparables and their quality scores
 */
export function calculateQualityWeightedArv(
  comparables: ComparablePrice[],
  qualityScores: CompQualityScore[],
  options: WeightingOptions = {}
): QualityWeightingResult {
  const enabledComps = comparables.filter((c) => c.isEnabled && c.price > 0)

  if (enabledComps.length === 0) {
    return {
      weightedArv: null,
      weights: new Map(),
      totalWeight: 0,
      contributingComps: 0,
    }
  }

  const scoreMap = new Map(qualityScores.map((s) => [s.compId, s]))
  const weights = new Map<string, number>()

  let weightedSum = 0
  let totalWeight = 0
  let contributingComps = 0

  for (const comp of enabledComps) {
    const score = scoreMap.get(comp.compId)

    // Calculate weight based on comparison result or adjustment factor
    let weight: number
    if (score?.comparison?.comparison) {
      weight = calculateCompWeight(score.comparison.comparison, options)
    } else if (score?.weightAdjustment !== undefined) {
      weight = 1 + (score.weightAdjustment ?? 0)
    } else {
      weight = options.unknownWeight ?? DEFAULT_OPTIONS.unknownWeight
    }

    // Clamp weight
    const minWeight = options.minWeight ?? DEFAULT_OPTIONS.minWeight
    const maxWeight = options.maxWeight ?? DEFAULT_OPTIONS.maxWeight
    weight = Math.min(maxWeight, Math.max(minWeight, weight))

    weights.set(comp.compId, weight)
    weightedSum += comp.price * weight
    totalWeight += weight
    contributingComps++
  }

  if (totalWeight === 0) {
    return {
      weightedArv: null,
      weights,
      totalWeight: 0,
      contributingComps,
    }
  }

  return {
    weightedArv: Math.round(weightedSum / totalWeight),
    weights,
    totalWeight,
    contributingComps,
  }
}

/**
 * Calculate quality-weighted ARV using simple comparison results
 * This is the simplified version used in the route handler
 */
export function calculateSimpleQualityWeightedArv(
  comparables: ComparablePrice[],
  comparisonMap: Map<string, ComparisonResult>,
  options: WeightingOptions = {}
): QualityWeightingResult {
  const enabledComps = comparables.filter((c) => c.isEnabled && c.price > 0)

  if (enabledComps.length === 0) {
    return {
      weightedArv: null,
      weights: new Map(),
      totalWeight: 0,
      contributingComps: 0,
    }
  }

  const weights = new Map<string, number>()
  let weightedSum = 0
  let totalWeight = 0
  let contributingComps = 0

  for (const comp of enabledComps) {
    const comparison = comparisonMap.get(comp.compId)
    const weight = calculateCompWeight(comparison, options)

    weights.set(comp.compId, weight)
    weightedSum += comp.price * weight
    totalWeight += weight
    contributingComps++
  }

  if (totalWeight === 0) {
    return {
      weightedArv: null,
      weights,
      totalWeight: 0,
      contributingComps,
    }
  }

  return {
    weightedArv: Math.round(weightedSum / totalWeight),
    weights,
    totalWeight,
    contributingComps,
  }
}

// ─── Quality Score Utilities ──────────────────────────────────────────────────

/**
 * Calculate average quality score from a list of scores
 */
export function calculateAverageQualityScore(qualityScores: CompQualityScore[]): number | null {
  const analyzedScores = qualityScores.filter((s) => s.analysisSource === 'vision')

  if (analyzedScores.length === 0) {
    return null
  }

  const sum = analyzedScores.reduce((acc, s) => acc + s.qualityScore, 0)
  return Math.round(sum / analyzedScores.length)
}

/**
 * Get summary of quality analysis
 */
export function getQualitySummary(qualityScores: CompQualityScore[]): {
  total: number
  visionAnalyzed: number
  inferred: number
  betterThanSubject: number
  similarToSubject: number
  worseThanSubject: number
  avgQualityScore: number | null
} {
  const visionAnalyzed = qualityScores.filter((s) => s.analysisSource === 'vision')
  const inferred = qualityScores.filter((s) => s.analysisSource === 'inferred')

  const betterThanSubject = qualityScores.filter((s) => s.comparison?.comparison === 'better').length
  const similarToSubject = qualityScores.filter((s) => s.comparison?.comparison === 'similar').length
  const worseThanSubject = qualityScores.filter((s) => s.comparison?.comparison === 'worse').length

  return {
    total: qualityScores.length,
    visionAnalyzed: visionAnalyzed.length,
    inferred: inferred.length,
    betterThanSubject,
    similarToSubject,
    worseThanSubject,
    avgQualityScore: calculateAverageQualityScore(qualityScores),
  }
}
