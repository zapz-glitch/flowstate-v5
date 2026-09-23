/**
 * Comp Screen — the deterministic exception layer + price-band split.
 *
 * Layer 2 (this file, screenCompPool): ranks every evaluated comparable by
 * a weighted "closeness to the subject" score built from Jev's per-attribute
 * nouls (services/jev attribute screen). The appraisal preset supplies the
 * weights — required (hard) filters count full, preferred (soft) half,
 * disabled filters contribute nothing. Unlike the binary appraisal gate,
 * nothing here disqualifies: a comp that failed a rule but is otherwise
 * closest to the subject is exactly the "exception" this layer exists to
 * keep. The top SCREEN_POOL_TARGET comps form the screened pool.
 *
 * Layer 3 (splitPriceBands): partitions the screened pool by price regime.
 * ARV band = comps priced within ARV_BAND_PCT below the pool's highest
 * price (top-of-market retail evidence). As-is band = comps within
 * AS_IS_BAND_PCT above the pool's lowest price (the investor floor —
 * what an investor would pay as-is). Bands are mutually exclusive: a comp
 * inside both (only possible on a tight-spread pool) goes to the anchor it
 * sits relatively closer to. Each band keeps at most SCREEN_BUCKET_TARGET
 * comps by screen score — nobody is forced in to hit a count.
 */

import type { AppraisedComparable, AppraisalFilter, FilterType } from '../appraisal/types'
import { defaultFilterPriority } from '../appraisal/types'
import {
  COMP_ATTRIBUTE_KEYS,
  COMP_ATTRIBUTE_TO_FILTER,
  COMP_ATTRIBUTE_QUESTION_VERSION,
  type CompAttributeKey,
  type JevOutcomeClassification,
} from '../jev'

export { COMP_ATTRIBUTE_QUESTION_VERSION }

/** Layer-2 pool size: the closest-N candidates that proceed to banding. */
export const SCREEN_POOL_TARGET = 10
/** Layer-3 per-bucket target — as close to 5 as the pool allows, never forced. */
export const SCREEN_BUCKET_TARGET = 5
/** ARV band: comps priced within this fraction below the pool's top price. */
export const ARV_BAND_PCT = 0.10
/** As-is band: comps priced within this fraction above the pool's floor price. */
export const AS_IS_BAND_PCT = 0.10

const HARD_WEIGHT = 1
const SOFT_WEIGHT = 0.5

/** One attribute's evidence for a comp: Jev's judgment + the rule outcome. */
export interface CompScreenAttribute {
  attribute: CompAttributeKey
  /** The appraisal filter governing this attribute's weight/threshold */
  filterType: FilterType
  /** Jev's 0–1 match probability (null when the comp wasn't scored) */
  jevScore: number | null
  /** The deterministic rule outcome on the same attribute — audit only */
  ruleStatus: 'passed' | 'failed' | 'not_verified' | 'disabled' | 'not_evaluated'
  /** Preset weight: required (hard) = 1, preferred (soft) = 0.5, disabled = 0 */
  weight: number
}

export interface CompScreenEntry {
  compId: string
  /** Weighted mean of Jev attribute scores — higher = closer to the subject */
  score: number
  /** 1-based rank across all candidates (1 = closest) */
  rank: number
  /** Whether the comp made the top-N screened pool */
  inPool: boolean
  /** Price band assignment — mutually exclusive, null = outside both bands */
  band: 'arv' | 'as_is' | null
  /** Rank within its band (1 = closest to subject in that band) */
  bandRank: number | null
  attributes: CompScreenAttribute[]
}

export interface CompScreenResult {
  entries: CompScreenEntry[]
  /** The screened pool (entries with inPool), rank order */
  pool: CompScreenEntry[]
}

/**
 * Rank every candidate comp by weighted attribute-closeness. Comps that
 * Jev never scored keep a score of 0 on weighted attributes — they rank
 * last rather than being dropped, so the audit trail covers the whole pool.
 */
export function screenCompPool(
  comps: AppraisedComparable[],
  attributeScores: Record<string, Partial<Record<CompAttributeKey, number>>>,
  filters: AppraisalFilter[],
  poolTarget: number = SCREEN_POOL_TARGET,
): CompScreenResult {
  const entries: CompScreenEntry[] = comps.map((comp) => {
    const attributes: CompScreenAttribute[] = COMP_ATTRIBUTE_KEYS.map((attribute) => {
      const filterType = COMP_ATTRIBUTE_TO_FILTER[attribute]
      const filter = filters.find((f) => f.type === filterType)
      const enabled = filter?.enabled ?? true
      const weight = !enabled
        ? 0
        : (filter?.priority ?? defaultFilterPriority(filterType)) === 'hard'
          ? HARD_WEIGHT
          : SOFT_WEIGHT
      const ruleResult = comp.evaluation?.filterResults.find((r) => r.type === filterType)
      const ruleStatus: CompScreenAttribute['ruleStatus'] = !enabled
        ? 'disabled'
        : ruleResult?.status ?? (ruleResult ? (ruleResult.passed ? 'passed' : 'failed') : 'not_evaluated')
      return {
        attribute,
        filterType,
        jevScore: attributeScores[comp.id]?.[attribute] ?? null,
        ruleStatus,
        weight,
      }
    })
    const totalWeight = attributes.reduce((sum, a) => sum + a.weight, 0)
    const score =
      totalWeight > 0
        ? attributes.reduce((sum, a) => sum + a.weight * (a.jevScore ?? 0), 0) / totalWeight
        : 0
    return { compId: comp.id, score, rank: 0, inPool: false, band: null, bandRank: null, attributes }
  })

  const compById = new Map(comps.map((c) => [c.id, c]))
  entries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const ca = compById.get(a.compId)
    const cb = compById.get(b.compId)
    const distance = (ca?.distanceMiles ?? Infinity) - (cb?.distanceMiles ?? Infinity)
    if (distance !== 0) return distance
    return (cb?.saleDate ? Date.parse(cb.saleDate) : 0) - (ca?.saleDate ? Date.parse(ca.saleDate) : 0)
  })
  entries.forEach((entry, index) => {
    entry.rank = index + 1
    entry.inPool = index < poolTarget
  })
  return { entries, pool: entries.filter((e) => e.inPool) }
}

export interface PriceBandSplit {
  /** ≤bucketTarget comp ids in the top-of-market band (ARV evidence) */
  arvIds: string[]
  /** ≤bucketTarget comp ids in the bottom-of-market band (as-is investor floor) */
  asIsIds: string[]
  /** Highest priced comp in the pool — the ARV band anchor (null if no prices) */
  arvAnchor: number | null
  /** Lowest priced comp in the pool — the as-is band anchor */
  asIsAnchor: number | null
  /** Band membership before the per-bucket cut */
  arvBandSize: number
  asIsBandSize: number
}

function bandPrice(comp: AppraisedComparable): number | null {
  const price = comp.adjustedSalePrice ?? comp.salePrice
  return price != null && price > 0 ? price : null
}

/**
 * Split the screened pool into the ARV band (within bandPct under the top
 * price) and the as-is band (within bandPct over the floor price). A comp
 * qualifying for both — only possible when the pool's whole spread is
 * under ~2×bandPct — is assigned to the anchor it's relatively closer to,
 * so a comp can never sit in both valuation buckets.
 */
export function splitPriceBands(
  pool: CompScreenEntry[],
  compsById: Map<string, AppraisedComparable>,
  opts?: { arvBandPct?: number; asIsBandPct?: number; bucketTarget?: number },
): PriceBandSplit {
  const arvBandPct = opts?.arvBandPct ?? ARV_BAND_PCT
  const asIsBandPct = opts?.asIsBandPct ?? AS_IS_BAND_PCT
  const bucketTarget = opts?.bucketTarget ?? SCREEN_BUCKET_TARGET

  const priced = pool
    .map((entry) => ({ entry, comp: compsById.get(entry.compId) }))
    .filter((p): p is { entry: CompScreenEntry; comp: AppraisedComparable } => !!p.comp)
    .map((p) => ({ ...p, price: bandPrice(p.comp) }))
    .filter((p): p is { entry: CompScreenEntry; comp: AppraisedComparable; price: number } => p.price != null)

  if (priced.length === 0) {
    return { arvIds: [], asIsIds: [], arvAnchor: null, asIsAnchor: null, arvBandSize: 0, asIsBandSize: 0 }
  }

  const arvAnchor = Math.max(...priced.map((p) => p.price))
  const asIsAnchor = Math.min(...priced.map((p) => p.price))
  const arvFloor = arvAnchor * (1 - arvBandPct)
  const asIsCeiling = asIsAnchor * (1 + asIsBandPct)

  const inArv = priced.filter((p) => p.price >= arvFloor)
  const inAsIs = priced.filter((p) => p.price <= asIsCeiling)

  // Mutual exclusivity: overlap members go to whichever anchor they sit
  // relatively closer to; an exact tie keeps the comp in the ARV band.
  const arvMembership = new Set(inArv.map((p) => p.entry.compId))
  for (const p of inAsIs) {
    if (!arvMembership.has(p.entry.compId)) continue
    const arvDistance = (arvAnchor - p.price) / arvAnchor
    const asIsDistance = (p.price - asIsAnchor) / asIsAnchor
    if (asIsDistance < arvDistance) arvMembership.delete(p.entry.compId)
  }
  const asIsMembership = new Set(inAsIs.map((p) => p.entry.compId).filter((id) => !arvMembership.has(id)))

  const byScore = (a: CompScreenEntry, b: CompScreenEntry) => b.score - a.score
  const arvBand = inArv.filter((p) => arvMembership.has(p.entry.compId)).sort((a, b) => byScore(a.entry, b.entry))
  const asIsBand = inAsIs.filter((p) => asIsMembership.has(p.entry.compId)).sort((a, b) => byScore(a.entry, b.entry))

  arvBand.forEach((p, index) => {
    p.entry.band = index < bucketTarget ? 'arv' : null
    p.entry.bandRank = index + 1
  })
  asIsBand.forEach((p, index) => {
    p.entry.band = index < bucketTarget ? 'as_is' : null
    p.entry.bandRank = index + 1
  })

  return {
    arvIds: arvBand.slice(0, bucketTarget).map((p) => p.entry.compId),
    asIsIds: asIsBand.slice(0, bucketTarget).map((p) => p.entry.compId),
    arvAnchor,
    asIsAnchor,
    arvBandSize: arvBand.length,
    asIsBandSize: asIsBand.length,
  }
}

// ─── Run metadata (persisted on the analysis response) ──────────────────────

/** Per-run record for the whole screen pipeline — display/A-B measurement. */
export interface AttributeScreenRun {
  status: 'completed' | 'skipped' | 'unavailable'
  reason?: string
  mode: 'enabled' | 'shadow'
  questionVersion: typeof COMP_ATTRIBUTE_QUESTION_VERSION
  model?: string
  latencyMs?: number
  inputTokens?: number
  /** Candidates Jev scored */
  scoredCount?: number
  /** Candidates that made the screened pool */
  poolCount?: number
  counts?: { arv: number; asIs: number }
  anchors?: { arvAnchor: number | null; asIsAnchor: number | null }
  stateHashes?: string[]
  classifiedAt?: string
  /**
   * Counterfactual (shadow mode only): what the screen's routing would have
   * produced through the same deterministic math — same valuation service,
   * same Group B summarizer. Display only; never feeds production figures.
   */
  shadowValuation?: {
    arv: number | null
    arvComps: number
    asIsValue: number | null
    asIsComps: number
    buyPrice: number | null
    projectedProfit: number | null
    projectedROI: number | null
    recommendation: string | null
    deltas: { arv: number | null; asIsValue: number | null; buyPrice: number | null }
    assessment?: JevOutcomeClassification
    arvCompIds: string[]
    asIsCompIds: string[]
  }
}
