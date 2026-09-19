/**
 * Filter Suggestion Engine
 *
 * When no comps pass all appraisal filters, this module analyzes which
 * filters to relax and by how much, prioritizing comps that are both
 * high-priced (good for ARV) and need the fewest changes.
 */

import type { NormalizedComparable } from '../property-api/types'
import type { AppraisalFilter, AppraisedComparable } from '../appraisal'
import { AnalysisError } from '../../utils/analysis-error'
import { HARD_FILTER_TYPES, HARD_FILTER_RELAXATION_ORDER, type FilterType as SharedFilterType } from '@flowstate-api/shared/appraisal'

const FILTER_LABELS: Record<string, string> = {
  subdivision_match: 'Subdivision Match',
  building_style_match: 'Building Style Match',
  sale_age: 'Sale Age',
  sqft_diff: 'Square Footage Difference',
  year_built_diff: 'Year Built Difference',
  distance: 'Distance',
}

interface CompFix {
  type: string
  action: 'disable' | 'increase'
  currentValue: number
  suggestedValue: number
  actualValue: number | string
}

interface CompFixAnalysis {
  compId: string
  address: string
  passedCount: number
  failedCount: number
  totalFilters: number
  fixes: CompFix[]
  sortScore: number
}

/**
 * Analyze each comp to determine the minimum filter changes needed.
 */
function analyzeCompFilterFailures(comparables: AppraisedComparable[]): CompFixAnalysis[] {
  return comparables.map((comp) => {
    const fixes: CompFix[] = []
    let passedCount = 0

    for (const fr of comp.evaluation.filterResults) {
      if (fr.passed) {
        passedCount++
        continue
      }
      // Only suggest fixes for HARD filters — soft filters don't reject comps
      if (!HARD_FILTER_TYPES.has(fr.type as SharedFilterType)) {
        continue
      }
      const actual = typeof fr.actualValue === 'number' ? fr.actualValue : 0
      const threshold = typeof fr.threshold === 'number' ? fr.threshold : 0
      fixes.push({ type: fr.type, action: 'increase', currentValue: threshold, suggestedValue: Math.ceil(actual * 1.1), actualValue: actual })
    }

    return {
      compId: comp.id,
      address: `${comp.address}, ${comp.city}`,
      passedCount,
      failedCount: fixes.length,
      totalFilters: comp.evaluation.filterResults.length,
      fixes,
      sortScore: 0,
    }
  })
}

/**
 * Score and sort comps by fix priority.
 *
 * Prefers comps that:
 * 1. Only fail low-priority filters (sale_age) over high-priority (sqft_diff, building_style_match)
 * 2. Need fewer total fixes
 * 3. Have higher sale price
 */
function rankByFixPriority(
  analysis: CompFixAnalysis[],
  allComparables: NormalizedComparable[],
): CompFixAnalysis[] {
  const sortedByPrice = [...allComparables]
    .filter((c) => c.salePrice != null && c.salePrice > 0)
    .sort((a, b) => b.salePrice! - a.salePrice!)
  const priceRankMap = new Map(sortedByPrice.map((c, i) => [c.id, i]))

  for (const comp of analysis) {
    const priceRank = priceRankMap.get(comp.compId) ?? sortedByPrice.length
    const pricePercentile = ((priceRank + 1) / sortedByPrice.length) * 100

    // Penalize comps that fail high-priority filters (sqft_diff=2, building_style=3)
    // Prefer comps that only fail low-priority filters (sale_age=1)
    const maxFixPriority = comp.fixes.reduce(
      (max, f) => Math.max(max, HARD_FILTER_RELAXATION_ORDER[f.type] ?? 1), 0
    )

    comp.sortScore = (maxFixPriority * 10) + comp.failedCount + (pricePercentile / 30)
  }

  analysis.sort((a, b) => a.sortScore - b.sortScore)
  return analysis
}

/**
 * Calculate the minimum ARV threshold needed to include a specific comp.
 */
function calculateSuggestedThreshold(
  compId: string,
  allComparables: NormalizedComparable[],
  baseThreshold: number,
): number {
  const sortedByPrice = [...allComparables]
    .filter((c) => c.salePrice != null && c.salePrice > 0)
    .sort((a, b) => b.salePrice! - a.salePrice!)
  const index = sortedByPrice.findIndex((c) => c.id === compId)
  if (index < 0) return baseThreshold

  const rawThreshold = Math.ceil(((index + 1) / sortedByPrice.length) * 100) + 5
  return Math.min(50, Math.max(rawThreshold, baseThreshold))
}

export interface FilterSuggestionResult {
  suggestedFilters: AppraisalFilter[]
  suggestedArvThreshold: number
  bestMatchAddress: string | null
  adviceText: string
}

/**
 * Analyze comps and return suggested filter changes (non-throwing).
 * Returns null if no suggestions can be made.
 */
export function getFilterSuggestions(
  comparables: AppraisedComparable[],
  allComparables: NormalizedComparable[],
  filters: AppraisalFilter[],
  baseThreshold: number,
): FilterSuggestionResult | null {
  const analysis = analyzeCompFilterFailures(comparables)
  const ranked = rankByFixPriority(analysis, allComparables)
  const bestMatch = ranked[0]

  if (!bestMatch || bestMatch.fixes.length === 0) return null

  const suggestedArvThreshold = calculateSuggestedThreshold(bestMatch.compId, allComparables, baseThreshold)

  const suggestedFilters = filters.map((f) => {
    const fix = bestMatch.fixes.find((fx) => fx.type === f.type)
    if (!fix) return f
    if (fix.action === 'disable') return { ...f, enabled: false }
    return { ...f, value: fix.suggestedValue }
  })

  const advice: string[] = []
  if (suggestedArvThreshold > baseThreshold) {
    advice.push(`ARV Threshold: ${baseThreshold}% → ${suggestedArvThreshold}%`)
  }
  for (const fix of bestMatch.fixes) {
    const label = FILTER_LABELS[fix.type] || fix.type
    if (fix.action === 'disable') {
      advice.push(`Disable "${label}"`)
    } else {
      advice.push(`"${label}": ${fix.currentValue} → ${fix.suggestedValue}`)
    }
  }

  return {
    suggestedFilters,
    suggestedArvThreshold,
    bestMatchAddress: bestMatch.address,
    adviceText: advice.join(', '),
  }
}

/**
 * Build the complete filter suggestion error with advice and suggested values.
 * Delegates to getFilterSuggestions() then throws an AnalysisError.
 */
export function throwFilterSuggestionError(
  comparables: AppraisedComparable[],
  allComparables: NormalizedComparable[],
  filters: AppraisalFilter[],
  baseThreshold: number,
): never {
  console.log(`[Evaluate] No comps passed. Analyzing ${allComparables.length} comps for suggestions...`)

  const suggestion = getFilterSuggestions(comparables, allComparables, filters, baseThreshold)

  if (suggestion) {
    console.log(`[Evaluate] Best match: ${suggestion.bestMatchAddress}`)
    console.log(`[Evaluate]   ${suggestion.adviceText}`)

    // Build verbose advice text for the error message
    const adviceText = `\n\nSuggested changes: ${suggestion.adviceText}`

    throw new AnalysisError(
      `No comparable sales passed the required filters (Square Footage, Sale Age). ` +
      `${allComparables.length} comps were evaluated but none met the hard filter criteria.${adviceText}`,
      { suggestedFilters: suggestion.suggestedFilters, suggestedArvThreshold: suggestion.suggestedArvThreshold },
    )
  }

  throw new AnalysisError(
    `No comparable sales passed the required filters (Square Footage, Sale Age). ` +
    `${allComparables.length} comps were evaluated but none met the hard filter criteria.`,
  )
}
