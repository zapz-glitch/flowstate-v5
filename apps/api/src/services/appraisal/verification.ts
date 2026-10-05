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
  /** comp sale $/sf ÷ pocket reference $/sf — null when no reference */
  pocketRatio: number | null
  /** Human-readable flags for the audit/UI */
  flags: string[]
}

const compPpsf = (c: NormalizedComparable): number | null =>
  c.pricePerSqft ?? (c.salePrice != null && c.squareFeet ? c.salePrice / c.squareFeet : null)

export function verifyCompEvidence(
  subject: NormalizedProperty,
  comp: NormalizedComparable,
  poolRefPpsf?: number | null,
  preferredSaleAgeDays?: number | null,
): CompEvidenceVerification {
  const flags: string[] = []

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
  } else if (comp.salePrice != null && comp.salePrice > 0) {
    flags.push('No comp AVM — sale price uncorroborated')
  }

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
      staleness = 'stale'
      flags.push(`Sale is ${saleAgeDays} days old — outside preferred ${preferredSaleAgeDays}-day window`)
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

  return { priceCheck, avmRatio, staleness, saleAgeDays, preferredSaleAgeDays: preferredSaleAgeDays ?? null, marketFit, pocketRatio, flags }
}
