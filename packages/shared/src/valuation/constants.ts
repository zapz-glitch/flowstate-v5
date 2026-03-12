/**
 * Shared Valuation Constants
 *
 * Default rehab cost table and ARV tier determination.
 */

import type { RehabEstimate, RehabTable, TierRangeDefinition } from './types'
import { DEFAULT_TIER_RANGES } from './types'

// ─── Default Rehab Cost Table ──────────────────────────────────────────────────

export const DEFAULT_REHAB_TABLE: RehabTable = {
  under501k: [
    { perSqft: 25, minProfit: 30000 },
    { perSqft: 30, minProfit: 40000 },
    { perSqft: 35, minProfit: 40000 },
    { perSqft: 45, minProfit: 50000 },
    { perSqft: 60, minProfit: 50000 },
  ],
  '501kTo999k': [
    { perSqft: 30, minProfit: 50000 },
    { perSqft: 40, minProfit: 60000 },
    { perSqft: 45, minProfit: 60000 },
    { perSqft: 55, minProfit: 70000 },
    { perSqft: 75, minProfit: 70000 },
  ],
  '1mTo3m': [
    { perSqft: 60, minProfit: 100000 },
    { perSqft: 65, minProfit: 100000 },
    { perSqft: 70, minProfit: 100000 },
    { perSqft: 80, minProfit: 100000 },
    { perSqft: 100, minProfit: 100000 },
  ],
  over3m: [
    { perSqft: 80, minProfit: 150000 },
    { perSqft: 90, minProfit: 150000 },
    { perSqft: 100, minProfit: 150000 },
    { perSqft: 110, minProfit: 150000 },
    { perSqft: 120, minProfit: 150000 },
  ],
}

// ─── ARV Tier Determination ────────────────────────────────────────────────────

export function getArvTier(arv: number, tierRanges?: TierRangeDefinition[]): string {
  const ranges = tierRanges ?? DEFAULT_TIER_RANGES
  for (const range of ranges) {
    const aboveMin = range.minValue === null || arv >= range.minValue
    const belowMax = range.maxValue === null || arv < range.maxValue
    if (aboveMin && belowMax) return range.key
  }
  return ranges[ranges.length - 1]?.key ?? 'unknown'
}

export function getRehabEstimate(
  table: RehabTable,
  arv: number,
  levelIndex: number,
  tierRanges?: TierRangeDefinition[]
): RehabEstimate {
  const tier = getArvTier(arv, tierRanges)
  return table[tier]?.[levelIndex] ?? table[tier]?.[0] ?? { perSqft: 0, minProfit: 0 }
}
