/**
 * Shared ARV Calculation
 *
 * Calculates After Repair Value from comparable sales.
 *
 * ARV Formula:
 *   adjustedPrice   = salePrice ± appraisal rule adjustments
 *   netPricePerSqft = adjustedPrice / comp.squareFeet
 *   compARV         = netPricePerSqft × subject.squareFeet
 *   ARV             = avg(compARV) across all enabled comps
 */

import type { FilterResult } from './types'

/** Minimal comp shape needed for ARV calculation and best-comp picking */
export interface ArvCompLike {
  isEnabled: boolean
  adjustedPrice: number | null
  salePrice: number | null
  squareFeet: number | null
  distanceMiles: number | null
  filterResults: FilterResult[]
}

/**
 * Calculate ARV from enabled comparables.
 * Formula: avg(adjustedPrice / comp.squareFeet × subject.squareFeet)
 */
export function calculateARV(comps: ArvCompLike[], subjectSqft?: number | null): number {
  const enabled = comps.filter((c) => c.isEnabled)

  const compArvValues: number[] = []
  for (const comp of enabled) {
    const adjustedPrice = comp.adjustedPrice ?? comp.salePrice
    const compSqft = comp.squareFeet
    if (adjustedPrice != null && adjustedPrice > 0 && compSqft != null && compSqft > 0) {
      const netPricePerSqft = adjustedPrice / compSqft
      // Use subject sqft for the comp ARV projection; fall back to comp sqft if not available
      const targetSqft = subjectSqft && subjectSqft > 0 ? subjectSqft : compSqft
      compArvValues.push(netPricePerSqft * targetSqft)
    }
  }

  if (compArvValues.length === 0) return 0

  const avgArv = compArvValues.reduce((sum, v) => sum + v, 0) / compArvValues.length
  return Math.round(avgArv)
}

/**
 * Pick the best N comps from a list of enabled comps.
 * Sorts by: subdivision match first → highest filter-pass rate → closest distance.
 */
export function pickBestComps<T extends ArvCompLike>(enabledComps: T[], max: number): T[] {
  const scored = enabledComps.map((comp) => {
    const filters = comp.filterResults
    const passRate = filters.length > 0
      ? filters.filter((f) => f.passed).length / filters.length
      : 1
    const subMatch = filters.find((f) => f.type === 'subdivision_match')?.passed ?? false
    return { comp, passRate, subMatch, distance: comp.distanceMiles ?? 999 }
  })

  scored.sort((a, b) => {
    // Subdivision match first
    if (a.subMatch && !b.subMatch) return -1
    if (!a.subMatch && b.subMatch) return 1
    // Then by pass rate (descending)
    if (b.passRate !== a.passRate) return b.passRate - a.passRate
    // Then by distance (ascending)
    return a.distance - b.distance
  })

  return scored.slice(0, max).map((s) => s.comp)
}

/**
 * Calculate average square footage of enabled comps.
 */
export function getCompAvgSqft(comps: ArvCompLike[]): number {
  const enabled = comps.filter((c) => c.isEnabled)
  const sqfts = enabled
    .map((c) => c.squareFeet)
    .filter((s): s is number => s != null && s > 0)
  if (sqfts.length === 0) return 0
  return sqfts.reduce((a, b) => a + b, 0) / sqfts.length
}
