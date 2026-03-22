/**
 * Comp Scoring System
 *
 * Scores comps based on soft filter matches after hard filters pass.
 * Used by both API (server-side evaluation) and dashboard (client-side recalc).
 *
 * Hard filters (sqft_diff, sale_age): must pass — comp rejected if failed
 * Soft filters (subdivision, style, distance, year_built): add score points
 */

import type { FilterType, FilterResult } from './types'

/** Default scores for each soft filter type */
export const SOFT_FILTER_SCORES: Partial<Record<FilterType, number>> = {
  subdivision_match: 40,
  building_style_match: 25,
  distance: 20,
  year_built_diff: 15,
}

/** Bonus points for very close distance (< 0.25 miles) */
const CLOSE_DISTANCE_BONUS = 10

/** Hard filter types that must pass */
export const HARD_FILTER_TYPES: Set<FilterType> = new Set(['sqft_diff', 'sale_age'])

/** Base score for all comps that pass hard filters */
const BASE_SCORE = 100

/**
 * Check if a comp passes all hard filters.
 * Returns true if all enabled hard filters passed.
 */
export function passesHardFilters(filterResults: FilterResult[]): boolean {
  return filterResults
    .filter((r) => HARD_FILTER_TYPES.has(r.type))
    .every((r) => r.passed)
}

/**
 * Calculate a comp's quality score based on soft filter matches.
 * Higher score = better comp for ARV calculation.
 *
 * @param filterResults - Results from evaluating all filters on this comp
 * @param distanceMiles - Comp's distance from subject (for bonus scoring)
 * @returns Score from 100 (base, no soft matches) to 200 (all soft filters match + bonuses)
 */
export function scoreComp(
  filterResults: FilterResult[],
  distanceMiles?: number | null,
): number {
  let score = BASE_SCORE

  for (const result of filterResults) {
    // Skip hard filters — they're pass/fail, not scored
    if (HARD_FILTER_TYPES.has(result.type)) continue

    const points = SOFT_FILTER_SCORES[result.type] ?? 0
    if (result.passed && points > 0) {
      score += points
    }
  }

  // Bonus for very close proximity
  if (distanceMiles != null && distanceMiles < 0.25) {
    score += CLOSE_DISTANCE_BONUS
  }

  return score
}

/**
 * Determine if a filter type is hard (required) or soft (preferred).
 */
export function isHardFilter(filterType: FilterType): boolean {
  return HARD_FILTER_TYPES.has(filterType)
}
