/**
 * Comp badges — the server↔client trust contract.
 *
 * One dictionary, both sides: the server computes every badge from the
 * same evidence the rules used; the card only renders. Never let the
 * dashboard re-derive these — the badge IS the server's verdict.
 *
 *   price     — the comp's evidence class (what the sale says):
 *               renovated | median | as_is
 *   condition — the vision read (what the photos say):
 *               reno | dated | distressed | unverified
 *   pocket    — in the subject's census pocket (tract/block-group), or
 *               outside it priced equal/above/below (±15% scope $/sf)
 *   trust     — verified | partial | unverified — the run's stamps
 *   checks    — pocket · size · fresh · price-fit · market-fit · transaction
 *   widenedOn — which relaxed rules admitted the comp (empty = strict)
 */

export interface CompBadges {
  price: 'renovated' | 'median' | 'as_is' | null
  condition: 'reno' | 'dated' | 'distressed' | 'unverified' | null
  pocket: 'in' | 'equal' | 'above' | 'below' | 'unknown' | null
  /** How the pocket match was earned — tightest scope wins:
   *  block (block group) | tract | name (neighborhood label) | null (out) */
  pocketVia: 'tract' | 'block' | 'name' | null
  trust: 'verified' | 'partial' | 'unverified' | null
  checks: {
    pocket: boolean | null
    size: boolean | null
    fresh: boolean | null
    priceFit: boolean | null
    marketFit: boolean | null
    transaction: boolean | null
  }
  widenedOn: string[]
}

const POCKET_EQ_TOLERANCE = 0.15

function classToPrice(cls: string | null | undefined): CompBadges['price'] {
  if (cls === 'after_renovation') return 'renovated'
  if (cls === 'transitional') return 'median'
  if (cls === 'as_is') return 'as_is'
  return null
}

function condToBadge(cond: string | null | undefined): CompBadges['condition'] {
  if (cond == null) return null
  if (cond === 'renovated') return 'reno'
  if (cond === 'distressed' || cond === 'as_is' || cond === 'needs_work' || cond === 'poor') return 'distressed'
  if (cond === 'unverified' || cond === 'unknown' || cond === 'pending') return 'unverified'
  return 'dated' // dated / maintained / transitional / worn — the middle
}

function scopeMedian(m?: { SD?: number | null; N4?: number | null; N3?: number | null } | null): number | null {
  if (!m) return null
  return m.SD ?? m.N4 ?? m.N3 ?? null
}

interface BadgeComp {
  id?: string
  censusTract?: string | null
  sameBlockGroup?: boolean | null
  subdivision?: string | null
  neighborhoodName?: string | null
  ppsfMedians?: { SD?: number | null; N4?: number | null; N3?: number | null } | null
  evaluation?: { filterResults?: { type: string; passed: boolean }[] } | null
  /** Wire shape is flat strings: priceCheck verdict, staleness label,
   *  pocketRatio + flags. */
  evidenceVerification?: {
    priceCheck?: string | null
    staleness?: string | null
    saleAgeDays?: number | null
    marketFit?: string | null
    transactionCheck?: string | null
    pocketRatio?: number | null
    flags?: string[] | null
  } | null
}

const PASS_VERDICTS = new Set(['corroborated', 'plausible', 'market', 'market_verified'])
const FAIL_VERDICTS = new Set(['divergent', 'suspect'])
const FAIL_MARKET_FIT = new Set(['below_pocket'])
const FAIL_TRANSACTION = new Set(['package_deed', 'nominal_sale', 'extreme_outlier'])

export function compBadges(
  comp: BadgeComp,
  opts: {
    subjectCensusTract?: string | null
    subjectSubdivision?: string | null
    subjectNeighborhood?: string | null
    subjectPpsfMedians?: { SD?: number | null; N4?: number | null; N3?: number | null } | null
    condition?: { condition?: string | null } | null
    classification?: string | null
    /** The run's relaxed filters — a failed comp filter named here was
     *  admitted by that rung. */
    expansionApplied?: string[]
  } = {},
): CompBadges {
  const filters = comp.evaluation?.filterResults ?? []
  const passed = (type: string) => {
    const r = filters.find((f) => f.type === type)
    return r ? r.passed : null
  }

  // ── pocket — membership names the level (tract > block > name);
  //  outside the pocket the badge shows the value gap instead ──
  const tractMatch = comp.censusTract != null && comp.censusTract === opts.subjectCensusTract
  const blockMatch = comp.sameBlockGroup === true
  const nameMatch =
    (comp.subdivision != null && opts.subjectSubdivision != null &&
      comp.subdivision.toLowerCase() === opts.subjectSubdivision.toLowerCase()) ||
    (comp.neighborhoodName != null && opts.subjectNeighborhood != null &&
      comp.neighborhoodName.toLowerCase() === opts.subjectNeighborhood.toLowerCase())
  const pocketVia: CompBadges['pocketVia'] = blockMatch ? 'block' : tractMatch ? 'tract' : nameMatch ? 'name' : null
  let pocket: CompBadges['pocket'] = null
  if (tractMatch || blockMatch) pocket = 'in'
  else {
    const ref = scopeMedian(opts.subjectPpsfMedians)
    const own = scopeMedian(comp.ppsfMedians)
    if (ref != null && own != null && ref > 0) {
      const ratio = own / ref
      pocket = Math.abs(ratio - 1) <= POCKET_EQ_TOLERANCE ? 'equal' : ratio > 1 ? 'above' : 'below'
    } else pocket = 'unknown'
  }

  // ── trust ──
  const ev = comp.evidenceVerification
  const priceVerdict = ev?.priceCheck ?? null
  const stale = ev?.staleness ?? null
  const staleByAge = stale === 'stale' && ev?.saleAgeDays != null
  const marketFit = ev?.marketFit ??
    // Legacy records stored pocket-price fit in staleness.
    (stale === 'above_pocket' ? 'above_pocket' : stale === 'stale' ? 'below_pocket' : null)
  const premiumExplained = opts.classification === 'after_renovation' || opts.condition?.condition === 'renovated'
  let trust: CompBadges['trust'] = null
  if (ev) {
    const failedPrice = priceVerdict != null && FAIL_VERDICTS.has(priceVerdict)
    const failedMarket = FAIL_MARKET_FIT.has(marketFit ?? '') || (marketFit === 'above_pocket' && !premiumExplained)
    const failedTransaction = FAIL_TRANSACTION.has(ev.transactionCheck ?? '')
    if (failedPrice || failedMarket || failedTransaction || staleByAge) trust = 'unverified'
    else if (priceVerdict != null && PASS_VERDICTS.has(priceVerdict) && stale === 'current' && (marketFit == null || marketFit === 'in_range')) trust = 'verified'
    else trust = 'partial'
  }

  // ── widenedOn — failed filters the run's expansion rescued ──
  const relaxed = new Set(opts.expansionApplied ?? [])
  const widenedOn = filters.filter((f) => !f.passed && relaxed.has(f.type)).map((f) => f.type)

  return {
    price: classToPrice(opts.classification),
    pocketVia,
    condition: condToBadge(opts.condition?.condition),
    pocket,
    trust,
    checks: {
      // pocket = the geography checks as a group (any geo label passing counts)
      pocket: passed('subdivision') === true || passed('geo_scope') === true || pocketVia != null,
      size: passed('sqft_diff'),
      fresh: ev == null ? passed('sale_age') : stale === 'current' ? true : ev.saleAgeDays != null ? false : passed('sale_age'),
      // 'unverified' = no AVM to corroborate against — not a pass, not a
      // fail; only a real corroborated/plausible verdict counts green.
      priceFit: priceVerdict == null ? null : PASS_VERDICTS.has(priceVerdict) ? true : FAIL_VERDICTS.has(priceVerdict) ? false : null,
      marketFit: marketFit == null ? null : marketFit === 'in_range' || (marketFit === 'above_pocket' && premiumExplained),
      transaction: ev?.transactionCheck == null ? null : !FAIL_TRANSACTION.has(ev.transactionCheck),
    },
    widenedOn,
  }
}
