/**
 * Price groups — how a pocket's sales sort themselves into classes.
 *
 * Product rule (docs/FILTER-LADDER.md): a person reading a pocket's sales
 * sees them fall into groups — investor-priced at the bottom, ordinary
 * dated/original sales in the middle, clearly renovated at the top. There
 * is NO percentage test against an AVM or a median. The groups come from
 * the natural breaks in the pocket's own $/sf, and ONLY from sales inside
 * the pocket: borrowing prices from outside it would describe a market the
 * subject does not have.
 *
 * Pure and deterministic. Three or four sales are enough to see groups.
 */

export type PriceGroup = 'top' | 'middle' | 'bottom'

export interface PriceGroupResult {
  /** Group per sale id. A sale that is not in the map was not grouped. */
  groups: Map<string, PriceGroup>
  /** Lone sales far above the pocket with nothing beside them */
  outliers: Set<string>
  /** How many distinct groups the pocket showed (1 = no visible pattern) */
  groupCount: number
  /** $/sf range of the top group, for the report */
  topRange: { lo: number; hi: number } | null
}

/** A break between groups must be clearly wider than the pocket's ordinary
 *  spacing between neighbouring sales — otherwise it is one group. */
const BREAK_VS_TYPICAL_GAP = 2
/** A lone top sale needs at least this many sales beside it, unless the
 *  caller vouches for it (a flip, or a confident renovated read). */
const TOP_GROUP_MIN_SUPPORT = 2

interface Sale { id: string; ppsf: number }

/** Lower median — with only two or three gaps the upper one IS the break,
 *  so the ordinary spacing has to be read from the smaller side. */
const median = (xs: number[]) => {
  const s = xs.slice().sort((a, b) => a - b)
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0
}

/** Split sorted sales at the widest gaps that qualify as real breaks. */
function splitAtBreaks(sorted: Sale[], maxGroups: number): Sale[][] {
  if (sorted.length < 2) return [sorted]
  const gaps = sorted.slice(1).map((s, i) => ({ at: i + 1, size: s.ppsf - sorted[i].ppsf }))
  const typical = median(gaps.map((g) => g.size))
  // With every sale evenly spaced there is no pattern to read.
  const real = gaps
    .filter((g) => g.size > 0 && g.size >= typical * BREAK_VS_TYPICAL_GAP && g.size > typical)
    .sort((a, b) => b.size - a.size || a.at - b.at)
    .slice(0, maxGroups - 1)
    .map((g) => g.at)
    .sort((a, b) => a - b)
  const out: Sale[][] = []
  let from = 0
  for (const at of real) { out.push(sorted.slice(from, at)); from = at }
  out.push(sorted.slice(from))
  return out
}

/**
 * Group one pocket's sales by $/sf.
 * `vouched` holds ids that may stand alone at the top — a real flip, or a
 * sale the condition read confidently calls renovated.
 */
export function groupPocketSales(
  sales: Array<{ id: string; ppsf: number | null | undefined }>,
  vouched: ReadonlySet<string> = new Set(),
): PriceGroupResult {
  const outliers = new Set<string>()
  let pool: Sale[] = sales
    .filter((s): s is Sale => s.ppsf != null && Number.isFinite(s.ppsf) && s.ppsf > 0)
    .sort((a, b) => a.ppsf - b.ppsf || a.id.localeCompare(b.id))
  const groups = new Map<string, PriceGroup>()
  if (pool.length < 2) {
    for (const s of pool) groups.set(s.id, 'middle')
    return { groups, outliers, groupCount: pool.length ? 1 : 0, topRange: null }
  }

  let parts = splitAtBreaks(pool, 3)
  // Outlier ceiling — a top "group" that is one unvouched sale standing
  // alone is noise (a lot-value buy, a tax-driven price), not a class. Set
  // it aside and read the pattern again without it.
  for (let guard = 0; guard < pool.length; guard++) {
    const top = parts[parts.length - 1]
    if (parts.length < 2 || top.length >= TOP_GROUP_MIN_SUPPORT || top.every((s) => vouched.has(s.id))) break
    for (const s of top) outliers.add(s.id)
    pool = pool.filter((s) => !outliers.has(s.id))
    if (pool.length < 2) { parts = [pool]; break }
    parts = splitAtBreaks(pool, 3)
  }

  const label = (i: number): PriceGroup =>
    parts.length === 1 ? 'middle'
      : i === parts.length - 1 ? 'top'
      : parts.length === 3 && i === 0 ? 'bottom'
      : 'middle'
  parts.forEach((part, i) => part.forEach((s) => groups.set(s.id, label(i))))
  const top = parts.length > 1 ? parts[parts.length - 1] : null
  return {
    groups,
    outliers,
    groupCount: parts.length,
    topRange: top && top.length ? { lo: top[0].ppsf, hi: top[top.length - 1].ppsf } : null,
  }
}
