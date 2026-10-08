/**
 * Block-group price ladder — the pocket's sales ranked by $/sf and split
 * at natural breaks (groupPocketSales). The ladder is the market's own
 * read on the price bands: the top cluster's median is what renovated
 * stock trades for in the subject's block group; the bottom cluster is
 * the as-is/investor band. The appraiser reads each comp's rung +
 * ratio-to-median to lean toward ARV-priced, ruleset-matching comps
 * instead of trusting unverified condition evidence.
 *
 * Deterministic — no model calls. Spec: median-relative pricing evidence
 * for the Opus appraiser (the ladder is computed in code; Opus weighs it).
 */
import { groupPocketSales, type PriceGroup } from './price-groups'

export interface BlockLadder {
  /** 'block_group' when ≥3 priced same-block-group sales exist, else the
   *  same-tract fallback ladder. */
  scope: 'block_group' | 'tract'
  /** Priced sales in the ladder pool. */
  n: number
  medianPpsf: number
  /** $/sf median of the top (ARV-band) cluster — null when the pocket
   *  reads as one group or the rung is empty. */
  topMedianPpsf: number | null
  /** $/sf median of the bottom (as-is/investor-band) cluster. */
  bottomMedianPpsf: number | null
  topRange: { lo: number; hi: number } | null
  bottomRange: { lo: number; hi: number } | null
  /** Rung per comp id — 'top' | 'middle' | 'bottom'. */
  groups: Map<string, PriceGroup>
}

interface LadderComp {
  id: string
  sameBlockGroup?: boolean | null
  censusTract?: string | null
  pricePerSqft?: number | null
  salePrice?: number | null
  squareFeet?: number | null
}

const ppsfOf = (c: LadderComp): number | null =>
  c.pricePerSqft ?? (c.salePrice != null && c.squareFeet ? c.salePrice / c.squareFeet : null)

const med = (xs: number[]): number | null => {
  if (!xs.length) return null
  const s = xs.slice().sort((a, b) => a - b)
  return s[Math.floor((s.length - 1) / 2)]
}

const range = (xs: number[] | undefined): { lo: number; hi: number } | null =>
  xs && xs.length ? { lo: Math.min(...xs), hi: Math.max(...xs) } : null

/**
 * Ladder over the subject's block group — falls back to the subject's
 * census tract when fewer than 3 priced same-block-group sales exist.
 * Returns null when there isn't enough priced evidence for any ladder.
 */
export function computeBlockLadder(comps: LadderComp[], subjectTract?: string | null): BlockLadder | null {
  const bg = comps.filter((c) => c.sameBlockGroup === true)
  const tract = subjectTract != null ? comps.filter((c) => c.censusTract === subjectTract) : []
  const pool = bg.length >= 3 ? bg : tract
  const priced = pool
    .map((c) => ({ id: c.id, ppsf: ppsfOf(c) }))
    .filter((s): s is { id: string; ppsf: number } => s.ppsf != null && s.ppsf > 0)
  if (priced.length < 3) return null
  const { groups, topRange } = groupPocketSales(priced)
  const byGroup = new Map<PriceGroup, number[]>()
  for (const s of priced) {
    const g = groups.get(s.id) ?? 'middle'
    byGroup.set(g, [...(byGroup.get(g) ?? []), s.ppsf])
  }
  return {
    scope: bg.length >= 3 ? 'block_group' : 'tract',
    n: priced.length,
    medianPpsf: med(priced.map((s) => s.ppsf))!,
    topMedianPpsf: med(byGroup.get('top') ?? []),
    bottomMedianPpsf: med(byGroup.get('bottom') ?? []),
    topRange,
    bottomRange: range(byGroup.get('bottom')),
    groups,
  }
}

/**
 * One comp's position on the ladder — its rung plus $/sf ratios to the
 * pocket median and the top-cluster (ARV-band) median. Out-of-pocket
 * comps still get the ratios — the appraiser sees their price relative
 * to the subject's pocket even though they carry no rung.
 */
export function compLadderPosition(
  comp: LadderComp,
  ladder: BlockLadder | null,
): { group: PriceGroup | null; ppsfVsMedian: number | null; ppsfVsTop: number | null } | null {
  if (!ladder) return null
  const p = ppsfOf(comp)
  return {
    group: ladder.groups.get(comp.id) ?? null,
    ppsfVsMedian: p != null && ladder.medianPpsf ? Math.round((p / ladder.medianPpsf) * 100) / 100 : null,
    ppsfVsTop: p != null && ladder.topMedianPpsf ? Math.round((p / ladder.topMedianPpsf) * 100) / 100 : null,
  }
}
