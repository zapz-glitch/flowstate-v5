/**
 * Comp sale-type classification — transaction evidence first.
 *
 * The chain, per the product engineer's rule: a comp's class comes from
 *   1. vision (Clef, or the Luna fallback) — curb appeal + listing text
 *   2. a verified flip chain — the buy → resale pair is the renovation
 *      event itself
 *   3. price — corroboration ONLY. A premium-priced sale may carry the
 *      'after_renovation' class only when its own $/sf sits inside the
 *      band the vision-verified renovated comps already priced. No band,
 *      no class; outside the band, no class. Price never drives.
 *
 * flip resale / corroborated premium / corroborated above-AVM
 *                                          → after_renovation (ARV evidence)
 * distressed sale                          → as_is (investor evidence)
 * everything else                          → transitional (market tier)
 */

import type { NormalizedComparable } from '../property-api/types'
import type { ClassificationResult } from '../classification'

const ARV_PPSF_PREMIUM = 1.15
const ARV_SUBJECT_AVM_PREMIUM = 1.15

/** A band gets ±10% slack past the verified-renovated endpoints — a
 *  single-comp band is a point and needs room to corroborate. */
const BAND_SLACK = 0.10
const CONDITION_CONF_FLOOR = 30

function compPpsf(c: { pricePerSqft?: number | null; salePrice?: number | null; squareFeet?: number | null }): number | null {
  if (c.pricePerSqft != null && c.pricePerSqft > 0) return c.pricePerSqft
  if (c.salePrice != null && c.squareFeet != null && c.squareFeet > 0) return c.salePrice / c.squareFeet
  return null
}

/**
 * ARV evidence — three peer signals, any one qualifies the comp for the
 * ARV set (they cooperate; multiple qualifying comps average together):
 *   1. flip resale      — verified flip chain (resale leg)
 *   2. premium sale     — ≥15% over the comp's scope median $/sf
 *   3. above-own-AVM    — sale price above the comp's own AVM
 * Returns the evidence note, or null when no signal fires.
 */
export function arvEvidence(
  c: NormalizedComparable,
  subjectAvm?: number | null,
): { note: string; method: 'evidence_flip_chain' | 'evidence_premium' | 'evidence_avm' } | null {
  if (c.flip && c.flip.priorSalePrice > 0) {
    return {
      method: 'evidence_flip_chain',
      note: `Verified flip — bought $${c.flip.priorSalePrice.toLocaleString()} ${c.flip.daysHeld}d prior, resold +${c.flip.gainPct}%`,
    }
  }
  // Distressed transactions are investor/as-is evidence — never ARV,
  // even when the price reads premium.
  if (c.distressedSale === true || c.transaction?.isForeclosure === true) return null
  const ppsf = compPpsf(c)
  const scopeMed = c.ppsfMedians?.SD ?? c.ppsfMedians?.N4 ?? c.ppsfMedians?.N3
  if (ppsf != null && scopeMed != null && scopeMed > 0 && ppsf >= scopeMed * ARV_PPSF_PREMIUM) {
    return {
      method: 'evidence_premium',
      note: `Sold ${Math.round((ppsf / scopeMed) * 100 - 100)}% above scope median $/sf`,
    }
  }
  if (c.salePrice != null && c.avmValue != null && c.salePrice > c.avmValue) {
    return {
      method: 'evidence_avm',
      note: `Sold $${Math.round((c.salePrice - c.avmValue) / 1000)}k above own AVM`,
    }
  }
  // Fallback ARV check per spec — comp sold above the SUBJECT's AVM
  // (the subject's modeled as-is value): the premium implies renovation.
  if (c.salePrice != null && subjectAvm != null && c.salePrice > subjectAvm * ARV_SUBJECT_AVM_PREMIUM) {
    return {
      method: 'evidence_avm',
      note: `Sold ${Math.round((c.salePrice / subjectAvm) * 100 - 100)}% above subject AVM`,
    }
  }
  return null
}

/** The minimal read shape needed for corroboration — CompCurbAppealMap
 *  values satisfy this; kept structural so evidence maps from any source
 *  (Clef, Luna, listing text) plug in. */
export interface ConditionReads {
  [compId: string]: { condition?: string | null; confidence?: number | null } | undefined
}

/** The price band the vision-verified renovated comps established —
 *  [min, max] of their raw sale $/sf with ±10% slack. */
function renovatedBand(
  comps: NormalizedComparable[],
  reads: ConditionReads,
): { lo: number; hi: number } | null {
  const ppsfs = comps
    .filter((c) => {
      const r = reads[c.id]
      return r?.condition === 'renovated' && (r.confidence ?? 0) >= CONDITION_CONF_FLOOR
    })
    .map((c) => c.salePrice != null && c.squareFeet ? c.salePrice / c.squareFeet : null)
    .filter((v): v is number => v != null && v > 0)
  if (!ppsfs.length) return null
  return { lo: Math.min(...ppsfs) * (1 - BAND_SLACK), hi: Math.max(...ppsfs) * (1 + BAND_SLACK) }
}

/**
 * Evidence classification — transaction evidence first, price last:
 *   flip resale                      → after_renovation (the event itself)
 *   distressed sale                  → as_is (investor evidence)
 *   premium / above-AVM price signal → after_renovation ONLY inside the
 *     vision-verified renovated $/sf band; otherwise transitional
 *   everything else                  → transitional (market tier)
 */
export function classifyCompsByEvidence(
  comparables: NormalizedComparable[],
  subjectAvm?: number | null,
  conditionReads?: ConditionReads,
): Map<string, ClassificationResult> {
  const band = conditionReads ? renovatedBand(comparables, conditionReads) : null
  const classifications = new Map<string, ClassificationResult>()
  for (const comp of comparables) {
    const ev = arvEvidence(comp, subjectAvm)
    if (ev && ev.method === 'evidence_flip_chain') {
      classifications.set(comp.id, {
        classification: 'after_renovation',
        confidence: 90,
        method: ev.method,
        reasoning: ev.note,
        indicators: {},
      })
    } else if (ev) {
      // Price-only signals — premium/above-AVM — corroborate the class;
      // they cannot create it. In-band = corroborated; no band or out of
      // band = the sale reads as an ordinary market transaction.
      const ppsf = compPpsf(comp)
      const corroborated = band != null && ppsf != null && ppsf >= band.lo && ppsf <= band.hi
      if (corroborated) {
        classifications.set(comp.id, {
          classification: 'after_renovation',
          confidence: 80,
          method: ev.method,
          reasoning: `${ev.note} — price corroborates the verified-renovated band`,
          indicators: {},
        })
      } else {
        classifications.set(comp.id, {
          classification: 'transitional',
          confidence: 50,
          method: ev.method,
          reasoning: band == null
            ? `${ev.note} — no vision-verified renovated band; price alone does not carry ARV class`
            : `${ev.note} — price outside the verified-renovated band`,
          indicators: {},
        })
      }
    } else if (comp.distressedSale === true || comp.transaction?.isForeclosure === true) {
      classifications.set(comp.id, {
        classification: 'as_is',
        confidence: 85,
        method: 'evidence_distressed',
        reasoning: 'Distressed-flagged transaction — investor/as-is evidence',
        indicators: {},
      })
    } else {
      classifications.set(comp.id, {
        classification: 'transitional',
        confidence: 50,
        method: 'evidence_market',
        reasoning: 'Ordinary sale — no ARV or distress evidence; market-rate reference',
        indicators: {},
      })
    }
  }
  return classifications
}
