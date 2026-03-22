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
import { HARD_FILTER_TYPES } from '@flowstate-api/shared/appraisal'

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
      if (!HARD_FILTER_TYPES.has(fr.type)) {
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
 * Score and sort comps by fewest fixes needed + highest price rank.
 * Higher-priced comps with fewer fixes score better.
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
    comp.sortScore = comp.failedCount + (pricePercentile / 30)
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

/**
 * Build the complete filter suggestion error with advice and suggested values.
 * Throws an AnalysisError with suggestedFilters and suggestedArvThreshold.
 */
export function throwFilterSuggestionError(
  comparables: AppraisedComparable[],
  allComparables: NormalizedComparable[],
  filters: AppraisalFilter[],
  baseThreshold: number,
): never {
  console.log(`[Evaluate] No comps passed. Analyzing ${allComparables.length} comps for suggestions...`)

  const analysis = analyzeCompFilterFailures(comparables)
  const ranked = rankByFixPriority(analysis, allComparables)
  const bestMatch = ranked[0]

  const suggestedArvThreshold = bestMatch
    ? calculateSuggestedThreshold(bestMatch.compId, allComparables, baseThreshold)
    : baseThreshold

  if (bestMatch) {
    console.log(`[Evaluate] Best match: ${bestMatch.address} (${bestMatch.passedCount}/${bestMatch.totalFilters} passed, ${bestMatch.failedCount} fixes needed)`)
    console.log(`[Evaluate]   Suggested threshold: ${suggestedArvThreshold}%`)
    console.log(`[Evaluate]   Fixes: ${bestMatch.fixes.map((f) => `${f.type}: ${f.action === 'disable' ? 'disable' : `${f.currentValue}→${f.suggestedValue}`}`).join(', ')}`)
  }

  // Build suggested filter values
  const suggestedFilters = filters.map((f) => {
    const fix = bestMatch?.fixes.find((fx) => fx.type === f.type)
    if (!fix) return f
    if (fix.action === 'disable') return { ...f, enabled: false }
    return { ...f, value: fix.suggestedValue }
  })

  // Build advice text
  const advice: string[] = []
  if (suggestedArvThreshold > baseThreshold) {
    advice.push(`ARV Threshold: ${baseThreshold}% → ${suggestedArvThreshold}% (to include this comp in the candidate pool)`)
  }
  if (bestMatch) {
    for (const fix of bestMatch.fixes) {
      const label = FILTER_LABELS[fix.type] || fix.type
      if (fix.action === 'disable') {
        advice.push(`Disable "${label}" (no match available)`)
      } else {
        advice.push(`"${label}": ${fix.currentValue} → ${fix.suggestedValue} (comp has ${fix.actualValue})`)
      }
    }
  }

  const adviceText = advice.length > 0 && bestMatch
    ? `\n\nTo match the closest comp (${bestMatch.address}, ${bestMatch.passedCount}/${bestMatch.totalFilters} filters passed), change ${advice.length} setting${advice.length > 1 ? 's' : ''}:\n${advice.map((a, i) => `${i + 1}. ${a}`).join('\n')}`
    : ''

  throw new AnalysisError(
    `No comparable sales passed the required filters (Square Footage, Sale Age). ` +
    `${allComparables.length} comps were evaluated but none met the hard filter criteria.${adviceText}`,
    { suggestedFilters, suggestedArvThreshold },
  )
}
