/**
 * Comp sale-type classification — the pocket's own sales decide.
 *
 * Product-engineer rule (docs/FILTER-LADDER.md). A comp is ARV evidence in
 * one of two ways:
 *   1. a real flip — bought, then resold 30 to 365 days later. The resale
 *      IS the renovation event.
 *   2. it sits in the TOP PRICE GROUP of its pocket. Price classes come
 *      from grouping the pocket's sales at their natural breaks, the way a
 *      person reads them: investor-priced, ordinary dated/original, clearly
 *      renovated. A sale in the top group is taken as a renovated product.
 *
 * There is no percentage test — not against the subject's AVM, the comp's
 * AVM, or a pocket median. Condition reads (Clef/Luna) are a bonus: they
 * vouch for a lone top sale and arbitrate a full-tier conflict, but a
 * missing read never blocks the class, because photos and listing text are
 * not always available.
 *
 * Whether a comp may DRIVE the ARV is a separate question answered by the
 * evaluation rules (`isEnabled`) — being in the top group is never enough
 * on its own.
 *
 *   flip resale / top price group  → after_renovation (ARV)
 *   distressed sale / bottom group → as_is (Investor)
 *   everything else                → transitional (Median)
 */

import type { NormalizedComparable, NormalizedProperty } from '../property-api/types'
import type { ClassificationResult } from '../classification'
import { groupPocketSales, type PriceGroupResult } from './price-groups'

const CONDITION_CONF_FLOOR = 30
/** A flip is a buy and a resale 30 to 365 days apart. */
const FLIP_MIN_DAYS = 30
const FLIP_MAX_DAYS = 365

function compPpsf(c: { pricePerSqft?: number | null; salePrice?: number | null; squareFeet?: number | null }): number | null {
  if (c.pricePerSqft != null && c.pricePerSqft > 0) return c.pricePerSqft
  if (c.salePrice != null && c.squareFeet != null && c.squareFeet > 0) return c.salePrice / c.squareFeet
  return null
}

/** The minimal read shape needed for corroboration — CompCurbAppealMap
 *  values satisfy this; kept structural so evidence maps from any source
 *  (Clef, Luna, listing text) plug in. The probability fields carry the
 *  model's own scored evidence — the conflict arbiter's input. */
export interface ConditionReads {
  [compId: string]: {
    condition?: string | null
    confidence?: number | null
    renovatedProbability?: number | null
    asIsProbability?: number | null
  } | undefined
}


type PocketSubject = Pick<NormalizedProperty,
  'censusTract' | 'censusBlockGroup' | 'subdivision' | 'neighborhoodName' | 'propertyType'>

export type PocketScope = 'tract' | 'block_group' | 'neighborhood'
export interface PocketGroups extends PriceGroupResult {
  /** The area whose sales were grouped — null when the pocket has no sales */
  scope: PocketScope | null
}

const isRealFlip = (c: NormalizedComparable) =>
  c.flip != null && c.flip.priorSalePrice > 0 &&
  c.flip.daysHeld >= FLIP_MIN_DAYS && c.flip.daysHeld <= FLIP_MAX_DAYS

const isDistressed = (c: NormalizedComparable) =>
  c.distressedSale === true || c.transaction?.isForeclosure === true

const normName = (v?: string | null) => v?.toLowerCase().replace(/[^a-z0-9]/g, '') || null
const normType = (v?: string | null) => v?.toLowerCase().replace(/[^a-z]/g, '') || null

/**
 * Group the sales in the subject's pocket. Only sales that PASS THE RULES
 * and sit INSIDE the pocket are read — tract first, then block group, then
 * neighborhood name — and never a mix: prices from outside would describe a
 * market the subject does not have. Three or four sales are enough.
 */
export function pocketPriceGroups(
  comps: NormalizedComparable[],
  subject: PocketSubject | null | undefined,
  conditionReads?: ConditionReads,
): PocketGroups {
  const subjectType = normType(subject?.propertyType)
  const sameKind = (c: NormalizedComparable) => {
    const t = normType(c.propertyType)
    return subjectType == null || t == null || t === subjectType
  }
  // Rules first, then groups: a comp that does not pass the evaluation
  // rules is never part of a price group. (Comps that have not been through
  // the rules yet carry no verdict and are read as-is.)
  const judged = comps.some((c) => (c as { isEnabled?: boolean }).isEnabled !== undefined)
  const passesRules = (c: NormalizedComparable) =>
    !judged || (c as { isEnabled?: boolean }).isEnabled === true
  const priced = comps.filter((c) => compPpsf(c) != null && sameKind(c) && passesRules(c))
  const names = new Set([subject?.subdivision, subject?.neighborhoodName].map(normName).filter((v): v is string => v != null))
  const scopes: Array<[PocketScope, NormalizedComparable[]]> = [
    ['tract', priced.filter((c) => subject?.censusTract != null && c.censusTract === subject.censusTract)],
    ['block_group', priced.filter((c) => c.sameBlockGroup === true ||
      (subject?.censusBlockGroup != null && c.censusBlockGroup === subject.censusBlockGroup))],
    ['neighborhood', priced.filter((c) => [c.subdivision, c.neighborhoodName].map(normName).some((v) => v != null && names.has(v)))],
  ]
  // The tightest area that actually has sales to read.
  const picked = scopes.find(([, list]) => list.length >= 3) ?? scopes.find(([, list]) => list.length >= 2)
  if (!picked) return { groups: new Map(), outliers: new Set(), groupCount: 0, topRange: null, scope: null }
  const [scope, pocket] = picked
  // A lone top sale may stand when something vouches for it: a real flip,
  // or a confident renovated read.
  const vouched = new Set(pocket.filter((c) => {
    const read = conditionReads?.[c.id]
    return isRealFlip(c) || (read?.condition === 'renovated' && (read.confidence ?? 0) >= CONDITION_CONF_FLOOR)
  }).map((c) => c.id))
  return { ...groupPocketSales(pocket.map((c) => ({ id: c.id, ppsf: compPpsf(c) })), vouched), scope }
}

/**
 * ARV evidence for one comp, given its pocket's price groups. Returns the
 * evidence note, or null when the comp is not ARV evidence.
 */
export function arvEvidence(
  c: NormalizedComparable,
  pocket?: PocketGroups | null,
): { note: string; method: 'evidence_flip_chain' | 'evidence_price_group' } | null {
  if (isRealFlip(c)) {
    return {
      method: 'evidence_flip_chain',
      note: `Verified flip — bought $${c.flip!.priorSalePrice.toLocaleString()} ${c.flip!.daysHeld}d prior, resold +${c.flip!.gainPct}%`,
    }
  }
  // Distressed transactions are investor/as-is evidence — never ARV, even
  // when the price sits high.
  if (isDistressed(c)) return null
  if (pocket?.groups.get(c.id) === 'top') {
    const range = pocket.topRange
    return {
      method: 'evidence_price_group',
      note: range
        ? `Top price group in the ${pocket.scope?.replace('_', ' ') ?? 'pocket'} — $${Math.round(range.lo)}–$${Math.round(range.hi)}/sf`
        : 'Top price group in the pocket',
    }
  }
  return null
}

/**
 * Evidence classification — flips first, then the pocket's price groups:
 *   flip resale (30–365d)      → after_renovation
 *   distressed sale            → as_is
 *   top price group            → after_renovation
 *   bottom price group         → as_is (investor-priced)
 *   middle / no pattern / lone outlier / outside the pocket → transitional
 *
 * `pool` is the full comp set whose pocket defines the groups — pass it
 * when `comparables` is only part of the pool (a widened batch).
 */
export function classifyCompsByEvidence(
  comparables: NormalizedComparable[],
  subject: PocketSubject | null | undefined,
  conditionReads?: ConditionReads,
  pool?: NormalizedComparable[],
): Map<string, ClassificationResult> {
  const pocket = pocketPriceGroups(pool ?? comparables, subject, conditionReads)
  const classifications = new Map<string, ClassificationResult>()
  for (const comp of comparables) {
    const ev = arvEvidence(comp, pocket)
    const group = pocket.groups.get(comp.id)
    if (ev) {
      classifications.set(comp.id, {
        classification: 'after_renovation',
        confidence: ev.method === 'evidence_flip_chain' ? 90 : 75,
        method: ev.method,
        reasoning: ev.note,
        indicators: {},
      })
    } else if (isDistressed(comp)) {
      classifications.set(comp.id, {
        classification: 'as_is',
        confidence: 85,
        method: 'evidence_distressed',
        reasoning: 'Distressed-flagged transaction — investor/as-is evidence',
        indicators: {},
      })
    } else if (group === 'bottom') {
      classifications.set(comp.id, {
        classification: 'as_is',
        confidence: 70,
        method: 'evidence_price_group',
        reasoning: 'Bottom price group in the pocket — investor-priced sale',
        indicators: {},
      })
    } else {
      classifications.set(comp.id, {
        classification: 'transitional',
        confidence: 50,
        method: 'evidence_market',
        reasoning: pocket.outliers.has(comp.id)
          ? 'Priced far above the pocket with no sale beside it — outlier, not a price class'
          : group === 'middle'
            ? 'Middle price group in the pocket — ordinary market sale'
            : (comp as { isEnabled?: boolean }).isEnabled === false
              ? 'Did not pass the evaluation rules — not part of a price group'
              : 'Outside the pocket price groups — market-rate reference',
        indicators: {},
      })
    }
  }

  // Conflict arbitration — when the evidence class and the vision
  // condition disagree by a full tier (vision 'distressed' but the sale
  // priced like a renovation, or vision 'renovated' on an investor-priced
  // sale), neither signal gets to win by default: the model's own
  // probabilities arbitrate — whichever pole it scored higher takes the
  // class. No usable read → transitional (neither story proved). Flip
  // chains are exempt — a recorded buy→resale is a transaction event,
  // stronger than any model read.
  if (conditionReads) {
    const COND_TIER: Record<string, number> = {
      renovated: 2, dated: 1, maintained: 1, transitional: 1, worn: 1,
      distressed: 0, as_is: 0, needs_work: 0, poor: 0,
    }
    const CLASS_TIER = { as_is: 0, transitional: 1, after_renovation: 2 } as const
    for (const comp of comparables) {
      const cls = classifications.get(comp.id)
      if (!cls || cls.method === 'evidence_flip_chain') continue
      const read = conditionReads[comp.id]
      const condTier = read?.condition ? COND_TIER[read.condition] : undefined
      if (condTier === undefined || (read!.confidence ?? 0) < CONDITION_CONF_FLOOR) continue
      if (Math.abs(CLASS_TIER[cls.classification] - condTier) < 2) continue
      const rp = read!.renovatedProbability ?? null
      const ap = read!.asIsProbability ?? null
      const resolved = rp != null && ap != null
        ? rp > ap ? 'after_renovation' : ap > rp ? 'as_is' : 'transitional'
        : 'transitional'
      if (resolved !== cls.classification) {
        classifications.set(comp.id, {
          classification: resolved,
          confidence: Math.max(rp ?? 0, ap ?? 0, 40),
          method: 'conflict_arbiter',
          reasoning: `class ${cls.classification} vs vision ${read!.condition} — model scores reno ${rp ?? '?'}% vs as-is ${ap ?? '?'}% → ${resolved}`,
          indicators: {},
        })
      }
    }
  }
  return classifications
}
