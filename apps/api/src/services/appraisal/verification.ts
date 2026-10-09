/**
 * ARV evidence verification — the "verify inputs before math" layer.
 *
 * Two checks stay separate:
 * - sale age: whether the transaction is inside the preferred sale-age window
 * - market fit: whether the sale price fits its current pocket $/sf
 *
 * Stamps per-comp verification as shadow evidence — flags, not gates:
 * nothing here disqualifies a comp; it marks what the evidence can support.
 */
import type { NormalizedComparable, NormalizedProperty } from '../property-api/types'
import { subjectRefPpsf } from './evaluator'

export interface CompEvidenceVerification {
  /** comp sale price vs its own AVM — corroborated / plausible / divergent / unverified */
  priceCheck: 'corroborated' | 'plausible' | 'divergent' | 'unverified'
  /** |salePrice − avm| / avm — null when no AVM exists */
  avmRatio: number | null
  /** Age check only: current inside the configured preferred sale-age window,
   *  stale outside it, unverified when no valid sale date exists. */
  staleness: 'current' | 'stale' | 'unverified'
  /** Whole days since sale — null when the date is missing or invalid */
  saleAgeDays: number | null
  /** Configured preferred sale-age window used for this stamp */
  preferredSaleAgeDays: number | null
  /** comp sale $/sf vs the CURRENT pocket median — a comp priced far below
   *  or above today's pocket is a market-fit problem, not an age problem. */
  marketFit: 'in_range' | 'below_pocket' | 'above_pocket' | 'unverified'
  /** Transaction noise: package deed / bulk sale / nominal sale / extreme
   *  outlier are not independent market evidence. */
  transactionCheck: 'clean' | 'package_deed' | 'bulk_sale' | 'nominal_sale' | 'extreme_outlier' | 'unverified'
  /** comp sale $/sf ÷ pocket reference $/sf — null when no reference */
  pocketRatio: number | null
  /** Human-readable flags for the audit/UI */
  flags: string[]
}

const compPpsf = (c: NormalizedComparable): number | null =>
  c.pricePerSqft ?? (c.salePrice != null && c.squareFeet ? c.salePrice / c.squareFeet : null)

/** Same-day, same-price deeds across a pool are package evidence — the same
 * deed may name multiple parcels, so identical price/date is objective proof
 * that these are not independent market observations. */
export function packageDeedIds(
  comps: Array<Pick<NormalizedComparable, 'id' | 'saleDate' | 'salePrice'>>,
): Set<string> {
  const groups = new Map<string, string[]>()
  for (const comp of comps) {
    if (!comp.id || !comp.saleDate || comp.salePrice == null || comp.salePrice <= 0) continue
    const key = `${comp.saleDate.slice(0, 10)}|${Math.round(comp.salePrice)}`
    groups.set(key, [...(groups.get(key) ?? []), comp.id])
  }
  return new Set([...groups.values()].filter((ids) => ids.length > 1).flat())
}

/** Same-day sales sharing a buyer or seller are split-price package/bulk
 * evidence even when the recorded prices differ. */
export function bulkSaleIds(
  comps: Array<Pick<NormalizedComparable, 'id' | 'saleDate' | 'transaction'>>,
): Set<string> {
  const groups = new Map<string, string[]>()
  for (const comp of comps) {
    if (!comp.id || !comp.saleDate) continue
    const parties = [...(comp.transaction?.buyerNames ?? []), ...(comp.transaction?.sellerNames ?? [])]
      .map((n) => n.toUpperCase().replace(/[^A-Z0-9]/g, ''))
      .filter(Boolean)
    for (const party of parties) {
      const key = `${comp.saleDate.slice(0, 10)}|${party}`
      groups.set(key, [...(groups.get(key) ?? []), comp.id])
    }
  }
  return new Set([...groups.values()].filter((ids) => new Set(ids).size > 1).flat())
}

export function verifyCompEvidence(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  poolRefPpsf?: number | null,
  preferredSaleAgeDays?: number | null,
  context?: {
    packageDeed?: boolean
    bulkSale?: boolean
    /** Evidence-based band the comp was classified into. */
    band?: string
    /** Median $/sf of the comp's own band cluster (same tract). When the
     *  comp is after_renovation, the noise check compares against THIS —
     *  an ARV comp at 200% of a distressed pocket is band evidence, not
     *  a transaction outlier. */
    bandRefPpsf?: number | null
  },
): CompEvidenceVerification {
  const flags: string[] = []
  let transactionCheck: CompEvidenceVerification['transactionCheck'] = 'clean'
  if (comp.salePrice != null && comp.salePrice > 0 && comp.salePrice < 10_000) {
    transactionCheck = 'nominal_sale'
    flags.push(`Nominal sale $${comp.salePrice.toLocaleString()} — deed transfer, not market evidence`)
  } else if (context?.packageDeed === true) {
    transactionCheck = 'package_deed'
    flags.push('Same-day, same-price package deed — not an independent market comp')
  } else if (context?.bulkSale === true) {
    transactionCheck = 'bulk_sale'
    flags.push('Same-day shared-party bulk sale — not independent market evidence')
  } else if (comp.salePrice == null || comp.salePrice <= 0) {
    transactionCheck = 'unverified'
  }

  // Extreme price outliers are transaction noise even when a vision read
  // labels the home nicely — a 3x-pocket sale is a different market.
  // Band-aware: an after_renovation comp is compared to its OWN band's
  // cluster — renovated sales sit far above the as-is-heavy pocket median
  // by definition; that premium is the ARV signal, not noise.
  const ppsfForNoise = compPpsf(comp)
  const noiseRef = context?.band === 'after_renovation' && context?.bandRefPpsf != null && context.bandRefPpsf > 0
    ? context.bandRefPpsf
    : poolRefPpsf
  const noiseRefLabel = context?.band === 'after_renovation' && context?.bandRefPpsf != null
    ? 'renovated-band'
    : 'current pocket'
  const pocketRatioForNoise = ppsfForNoise != null && noiseRef != null && noiseRef > 0
    ? ppsfForNoise / noiseRef
    : null
  if (transactionCheck === 'clean' && pocketRatioForNoise != null &&
      (pocketRatioForNoise <= 0.35 || pocketRatioForNoise >= 2.0)) {
    transactionCheck = 'extreme_outlier'
    flags.push(`Sale at $${Math.round(ppsfForNoise!)}/sf is ${Math.round(pocketRatioForNoise * 100)}% of ${noiseRefLabel} $${Math.round(noiseRef!)}/sf — extreme outlier, not market evidence`)
  }

  // Price cross-check — comp's recorded sale vs its own AVM. A big gap means
  // the recorded transaction may be stale, partial, or wrong (the 59th Way
  // case: $320k recorded vs ~$430k actual).
  let priceCheck: CompEvidenceVerification['priceCheck'] = 'unverified'
  let avmRatio: number | null = null
  if (comp.salePrice != null && comp.salePrice > 0 && comp.avmValue != null && comp.avmValue > 0) {
    avmRatio = Math.abs(comp.salePrice - comp.avmValue) / comp.avmValue
    priceCheck = avmRatio <= 0.20 ? 'corroborated' : avmRatio <= 0.40 ? 'plausible' : 'divergent'
    if (priceCheck === 'divergent') {
      flags.push(`Recorded sale $${comp.salePrice.toLocaleString()} diverges ${(avmRatio * 100).toFixed(0)}% from own AVM $${comp.avmValue.toLocaleString()} — verify transaction`)
    }
  }
  // No comp AVM stays priceCheck 'unverified' — a missing model value is a
  // corroboration gap (caution via exclusionReasons), never a veto on the
  // recorded sale itself.

  // Sale age — the only source of the `stale` stamp. The preferred window is
  // the base sale_age rule; wider sale_age_expansion tiers can admit a comp,
  // but do not make it fresh.
  let staleness: CompEvidenceVerification['staleness'] = 'unverified'
  let saleAgeDays: number | null = null
  const saleMs = comp.saleDate ? Date.parse(comp.saleDate) : Number.NaN
  if (Number.isFinite(saleMs)) {
    saleAgeDays = Math.max(0, Math.floor((Date.now() - saleMs) / 86_400_000))
    if (preferredSaleAgeDays == null || preferredSaleAgeDays <= 0) {
      staleness = 'unverified'
    } else if (saleAgeDays > preferredSaleAgeDays) {
      // Stale is recorded on the comp — the caution reads via
      // exclusionReasons. It is never a veto: in a stale market the
      // freshest renovated sale IS the evidence (doctrine).
      staleness = 'stale'
    } else {
      staleness = 'current'
    }
  } else {
    flags.push('No usable sale date — sale age unverified')
  }

  // Market fit — comp sale $/sf vs the current pocket reference. The comp's
  // OWN scope medians (SD/N4/N3 from its geography-context) are the
  // preferred reference — the comparison is its pocket, not the subject's;
  // subject medians/AVM are the fallback when the comp carries none.
  let marketFit: CompEvidenceVerification['marketFit'] = 'unverified'
  let pocketRatio: number | null = null
  const ref =
    comp.ppsfMedians?.SD ?? comp.ppsfMedians?.N4 ?? comp.ppsfMedians?.N3 ??
    poolRefPpsf ??
    subjectRefPpsf(subject)
  const ppsf = compPpsf(comp)
  if (ref != null && ppsf != null) {
    pocketRatio = ppsf / ref
    if (pocketRatio < 0.70) {
      marketFit = 'below_pocket'
      flags.push(`Sale at $${ppsf.toFixed(0)}/sf is ${(pocketRatio * 100).toFixed(0)}% of current pocket $${ref.toFixed(0)}/sf — below current pocket, verify market fit`)
    } else if (pocketRatio > 1.45) {
      marketFit = 'above_pocket'
      flags.push(`Sale at $${ppsf.toFixed(0)}/sf is ${(pocketRatio * 100).toFixed(0)}% of pocket — premium evidence, verify`)
    } else {
      marketFit = 'in_range'
    }
  }

  return { priceCheck, avmRatio, staleness, saleAgeDays, preferredSaleAgeDays: preferredSaleAgeDays ?? null, marketFit, transactionCheck, pocketRatio, flags }
}
