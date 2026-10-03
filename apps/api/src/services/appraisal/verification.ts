/**
 * ARV evidence verification — the "verify inputs before math" layer.
 *
 * An appraiser's first move on a comp isn't adjusting it, it's checking
 * whether the sale can be trusted to say anything at all: is the recorded
 * price real (vs the comp's own AVM), and is it CURRENT (vs today's pocket
 * pricing — pocket = subdivision/N4/tract level, never zip or 2mi).
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
  /** comp sale $/sf vs the CURRENT pocket median — a comp priced far below
   *  today's pocket is stale evidence (old price or a different market),
   *  not as-is proof. 'above_pocket' marks the symmetric premium case. */
  staleness: 'current' | 'stale' | 'above_pocket' | 'unverified'
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

  // Staleness — comp sale $/sf vs the current pocket reference. The comp's
  // OWN scope medians (SD/N4/N3 from its geography-context) are the
  // preferred reference — the comparison is its pocket, not the subject's;
  // subject medians/AVM are the fallback when the comp carries none.
  let staleness: CompEvidenceVerification['staleness'] = 'unverified'
  let pocketRatio: number | null = null
  const ref =
    comp.ppsfMedians?.SD ?? comp.ppsfMedians?.N4 ?? comp.ppsfMedians?.N3 ??
    poolRefPpsf ??
    subjectRefPpsf(subject)
  const ppsf = compPpsf(comp)
  if (ref != null && ppsf != null) {
    pocketRatio = ppsf / ref
    if (pocketRatio < 0.70) {
      staleness = 'stale'
      flags.push(`Sale at $${ppsf.toFixed(0)}/sf is ${(pocketRatio * 100).toFixed(0)}% of current pocket $${ref.toFixed(0)}/sf — stale or different-market evidence`)
    } else if (pocketRatio > 1.45) {
      staleness = 'above_pocket'
      flags.push(`Sale at $${ppsf.toFixed(0)}/sf is ${(pocketRatio * 100).toFixed(0)}% of pocket — premium evidence, verify`)
    } else {
      staleness = 'current'
    }
  }

  return { priceCheck, avmRatio, staleness, pocketRatio, flags }
}
