/**
 * Comp Scoring & Relaxation System
 *
 * All filters are scored (no hard/soft distinction). Comps are selected
 * by total score. When no comps pass at tight thresholds, filters are
 * relaxed in defined steps until comps are found.
 *
 * Relaxation steps (tightest → loosest):
 *   sqft_diff:      250 → 500 → 750 → 1000
 *   year_built_diff: 10 →  15 →  20 →   25
 *   sale_age:       180 → 270 → 360 →  540
 *   distance:       0.5 → 1.0 → 1.5 →  2.0
 */

import type { FilterType, FilterResult, AppraisalFilter } from './types'

// ─── Filter Scores ──────────────────────────────────────────────────────────

/** Score awarded when a filter passes. Higher = more important match. */
export const FILTER_SCORES: Partial<Record<FilterType, number>> = {
  building_style_match: 50,
  sqft_diff: 45,
  subdivision_match: 40,
  sale_age: 30,
  year_built_diff: 20,
  distance: 20,
}

/** Bonus points for very close distance (< 0.25 miles) */
const CLOSE_DISTANCE_BONUS = 10

/** Base score for all comps */
const BASE_SCORE = 100

// ─── Relaxation Steps ───────────────────────────────────────────────────────

/** Defined relaxation steps per filter type (index 0 = default/tightest) */
export const RELAXATION_STEPS: Partial<Record<FilterType, number[]>> = {
  sqft_diff:       [250, 500, 750, 1000],
  year_built_diff: [10, 15, 20, 25],
  sale_age:        [180, 270, 360, 540],
  distance:        [0.5, 1.0, 1.5, 2.0],
}

/** Total number of relaxation steps */
export const MAX_RELAXATION_STEPS = 4

/**
 * Build filter overrides for a given relaxation step (0-based).
 * Step 0 = default values, step 3 = loosest.
 * Filters not in RELAXATION_STEPS are left unchanged.
 */
export function getFiltersAtStep(baseFilters: AppraisalFilter[], step: number): AppraisalFilter[] {
  return baseFilters.map((f) => {
    const steps = RELAXATION_STEPS[f.type]
    if (!steps) return f
    const clampedStep = Math.min(step, steps.length - 1)
    return { ...f, value: steps[clampedStep] }
  })
}

// ─── Legacy exports (still used by passesHardFilters in client-side recalc) ─

/**
 * @deprecated No hard filter rejection. Kept for backward compatibility
 * with client-side recalc that checks passesHardFilters.
 * Now returns true for all comps — filtering is score-based.
 */
export const HARD_FILTER_TYPES: Set<FilterType> = new Set<FilterType>()
export const HARD_FILTER_RELAXATION_ORDER: Record<string, number> = {}
// Soft filter scores alias for backward compat
export const SOFT_FILTER_SCORES = FILTER_SCORES

export function passesHardFilters(_filterResults: FilterResult[]): boolean {
  // No hard filters — all comps pass. Selection is score-based.
  return true
}

// ─── Scoring ────────────────────────────────────────────────────────────────

/**
 * Calculate a comp's quality score based on all filter matches.
 * Higher score = better comp for ARV calculation.
 *
 * @param filterResults - Results from evaluating all filters on this comp
 * @param distanceMiles - Comp's distance from subject (for bonus scoring)
 * @returns Score from 100 (base) upward
 */
export function scoreComp(
  filterResults: FilterResult[],
  distanceMiles?: number | null,
): number {
  let score = BASE_SCORE

  for (const result of filterResults) {
    const points = FILTER_SCORES[result.type] ?? 0
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
 * @deprecated Use scoreComp directly — no hard filter distinction.
 */
export function isHardFilter(_filterType: FilterType): boolean {
  return false
}
