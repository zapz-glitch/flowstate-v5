/**
 * Shared Valuation Constants
 *
 * Default rehab cost table and ARV tier determination.
 */

import type { ArvTier, RehabEstimate, RehabTable } from './types'

// ─── Default Rehab Cost Table ──────────────────────────────────────────────────

export const DEFAULT_REHAB_TABLE: RehabTable = {
  under501k: [
    { perSqft: 25, minProfit: 30000 },
    { perSqft: 30, minProfit: 40000 },
    { perSqft: 35, minProfit: 40000 },
    { perSqft: 45, minProfit: 50000 },
    { perSqft: 60, minProfit: 50000 },
    { perSqft: 40, minProfit: 30000 },
    { perSqft: 50, minProfit: 40000 },
  ],
  '501kTo999k': [
    { perSqft: 30, minProfit: 50000 },
    { perSqft: 40, minProfit: 60000 },
    { perSqft: 45, minProfit: 60000 },
    { perSqft: 55, minProfit: 70000 },
    { perSqft: 75, minProfit: 70000 },
    { perSqft: 50, minProfit: 60000 },
    { perSqft: 60, minProfit: 70000 },
  ],
  '1mTo3m': [
    { perSqft: 60, minProfit: 100000 },
    { perSqft: 65, minProfit: 100000 },
    { perSqft: 70, minProfit: 100000 },
    { perSqft: 80, minProfit: 100000 },
    { perSqft: 100, minProfit: 100000 },
    { perSqft: 75, minProfit: 100000 },
    { perSqft: 85, minProfit: 100000 },
  ],
  over3m: [
    { perSqft: 80, minProfit: 150000 },
    { perSqft: 90, minProfit: 150000 },
    { perSqft: 100, minProfit: 150000 },
    { perSqft: 110, minProfit: 150000 },
    { perSqft: 120, minProfit: 150000 },
    { perSqft: 105, minProfit: 150000 },
    { perSqft: 115, minProfit: 150000 },
  ],
}

// ─── ARV Tier Determination ────────────────────────────────────────────────────

export function getArvTier(arv: number): ArvTier {
  if (arv >= 3000000) return 'over3m'
  if (arv >= 1000000) return '1mTo3m'
  if (arv >= 501000) return '501kTo999k'
  return 'under501k'
}

export function getRehabEstimate(
  table: RehabTable,
  arv: number,
  levelIndex: number
): RehabEstimate {
  const tier = getArvTier(arv)
  return table[tier][levelIndex] ?? table[tier][0]
}
