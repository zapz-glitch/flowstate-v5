/**
 * Evidence-band computation — the deterministic half of the banding
 * verification spec (docs/BANDING-VERIFICATION-SPEC.md §2).
 *
 * Per band (as_is / median / arv): classify → single-membership +
 * transitional edge-exclusion → 1.5×IQR trim on unit rate → scale each
 * survivor to subject GLA (linear inside ±15%, band-local β_k power
 * scaling beyond) → edges → DISREGARD ladder.
 *
 * Pure module: no IO, no API imports — BComp comes from set-b.ts.
 */

import type { BComp } from './set-b'

export type BandName = 'as_is' | 'median' | 'arv'

export interface BandSubject {
  squareFeet?: number | null
  censusTract?: string | null
  censusBlockGroup?: string | null
  subdivision?: string | null
  neighborhoodName?: string | null
}

export interface BandResult {
  band: BandName
  low: number | null
  high: number | null
  mid: number | null
  n: number
  memberIds: string[]
  /** IQR-trimmed comps — excluded from everything. */
  trimmedIds: string[]
  /** Transitional comps — counted in IQR, barred from edges. */
  edgeExcludedIds: string[]
  /** 'ok' | disregard reasons from the §6 ladder. */
  method: 'ok' | 'insufficient_data' | 'extreme_variance' | 'stale' | 'bimodal'
}

export interface EvidenceBands {
  as_is: BandResult
  median: BandResult
  arv: BandResult
}

type CompRow = BComp & { id: string }

/** Band-local GLA elasticity — §6 resolution 2. */
const BETA: Record<BandName, number> = { as_is: 0.2, median: 0.4, arv: 0.55 }

/** ±15% GLA window uses strict linear projection instead of power scaling. */
const LINEAR_GLA_WINDOW = 0.15

/** A comp whose unit rate sits within 5% of an ADJACENT band's median is
 *  transitional: it counts in its band's IQR but cannot set an edge. */
const TRANSITIONAL_TOLERANCE = 0.05

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

const quartile = (s: number[], q: number): number => {
  const pos = (s.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  const lo = s[base]!
  const hi = s[base + 1] ?? lo
  return lo + rest * (hi - lo)
}

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null

const stdev = (xs: number[]): number | null => {
  if (xs.length < 2) return null
  const m = mean(xs)!
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length)
}

/** Priceable + enabled comps only — un-priceable members can never set a
 *  band edge (spec: missing evidence must not silently fill a band). */
const priceable = (c: CompRow): c is CompRow & { salePrice: number; squareFeet: number } =>
  c.isEnabled !== false && c.salePrice != null && c.salePrice > 0 &&
  c.squareFeet != null && c.squareFeet > 0

/** Primary band assignment — dominant condition only, single membership.
 *  No condition read → no band (unknown can't prove a dominant rating). */
function classifyBand(c: CompRow): BandName | null {
  const type = c.classification?.type ?? null
  const cond = c.curbAppeal?.condition ?? null
  // Verified flip resale is ARV proof regardless of the vision read.
  if (type === 'after_renovation') return 'arv'
  if (type === 'as_is') return 'as_is'
  // Transitional classification: fall to the vision/condition read.
  if (cond === 'renovated') return 'arv'
  if (cond === 'maintained') return 'median'
  if (cond === 'dated' || cond === 'distressed') return 'as_is'
  return null
}

/** Distress/transaction evidence that forces as_is even with a vision read. */
const isDistressFlagged = (c: CompRow): boolean => {
  const ev = c.evidenceVerification
  if (ev?.transactionCheck === 'nominal_sale') return true
  if (ev?.marketFit === 'below_pocket' && (c.curbAppeal?.condition === 'distressed')) return true
  return false
}

export function computeEvidenceBands(
  comps: CompRow[],
  subject: BandSubject,
  opts: { staleDays?: number; beta?: Partial<Record<BandName, number>> } = {},
): EvidenceBands {
  const beta = { ...BETA, ...opts.beta }
  const staleDays = opts.staleDays ?? 180
  const aSub = subject.squareFeet ?? null

  const members: Record<BandName, CompRow[]> = { as_is: [], median: [], arv: [] }
  for (const c of comps) {
    if (!priceable(c)) continue
    const band = isDistressFlagged(c) ? 'as_is' : classifyBand(c)
    if (band) members[band].push(c)
  }

  const unitRate = (c: CompRow) => c.salePrice! / c.squareFeet!
  const bandMedianRate = (b: BandName) => median(members[b].map(unitRate))

  const adjacent: Record<BandName, BandName[]> = {
    as_is: ['median'],
    median: ['as_is', 'arv'],
    arv: ['median'],
  }

  const build = (band: BandName): BandResult => {
    const pool = members[band]
    const empty: BandResult = {
      band, low: null, high: null, mid: null, n: 0,
      memberIds: [], trimmedIds: [], edgeExcludedIds: [], method: 'insufficient_data',
    }
    if (pool.length === 0) return empty

    // Stale-market rule — ARV band only (spec §6).
    if (band === 'arv') {
      const newest = pool.reduce<number>((acc, c) => {
        const t = c.saleDate ? new Date(c.saleDate).getTime() : 0
        return Math.max(acc, t)
      }, 0)
      if (newest > 0 && (Date.now() - newest) / 86_400_000 > staleDays) {
        return { ...empty, n: pool.length, memberIds: pool.map((c) => c.id), method: 'stale' }
      }
    }

    // 1.5×IQR trim on unit rate — transitional members included.
    const rates = pool.map(unitRate).sort((a, b) => a - b)
    const q1 = quartile(rates, 0.25)
    const q3 = quartile(rates, 0.75)
    const iqr = q3 - q1
    const lo = q1 - 1.5 * iqr
    const hi = q3 + 1.5 * iqr
    const kept = pool.filter((c) => unitRate(c) >= lo && unitRate(c) <= hi)
    const trimmedIds = pool.filter((c) => !kept.includes(c)).map((c) => c.id)

    if (kept.length < 2) {
      return { ...empty, n: kept.length, memberIds: kept.map((c) => c.id), trimmedIds, method: 'insufficient_data' }
    }

    // Transitional flag — within 5% of an adjacent band's median unit rate.
    const edgeExcluded = kept.filter((c) =>
      adjacent[band].some((adj) => {
        const adjMed = bandMedianRate(adj)
        return adjMed != null && Math.abs(unitRate(c) - adjMed) / adjMed <= TRANSITIONAL_TOLERANCE
      }))
    const edgeSet = kept.filter((c) => !edgeExcluded.includes(c))
    const edgePool = edgeSet.length >= 2 ? edgeSet : kept // all-transitional edge case: fall back so the band doesn't collapse

    // Extreme variance — CV > 0.25 on unit rates → disregard edges.
    const keptRates = kept.map(unitRate)
    const cv = (stdev(keptRates) ?? 0) / (mean(keptRates) ?? 1)
    if (cv > 0.25) {
      return {
        ...empty, n: kept.length, memberIds: kept.map((c) => c.id), trimmedIds,
        edgeExcludedIds: edgeExcluded.map((c) => c.id), method: 'extreme_variance',
      }
    }

    // Bimodal check — sorted scaled prices with a >20% interior gap.
    const scale = (c: CompRow): number => {
      if (aSub == null || aSub <= 0) return c.salePrice!
      const ai = c.squareFeet!
      const ratio = Math.abs(ai - aSub) / aSub
      if (ratio <= LINEAR_GLA_WINDOW) return unitRate(c) * aSub
      return c.salePrice! * Math.pow(aSub / ai, beta[band])
    }
    const scaled = edgePool.map(scale).sort((a, b) => a - b)
    const gaps = scaled.slice(1).map((v, i) => (v - scaled[i]!) / scaled[i]!)
    if (gaps.some((g) => g > 0.2)) {
      return {
        ...empty, n: kept.length, memberIds: kept.map((c) => c.id), trimmedIds,
        edgeExcludedIds: edgeExcluded.map((c) => c.id), method: 'bimodal',
      }
    }

    return {
      band,
      low: scaled[0]!,
      high: scaled[scaled.length - 1]!,
      mid: median(scaled),
      n: kept.length,
      memberIds: kept.map((c) => c.id),
      trimmedIds,
      edgeExcludedIds: edgeExcluded.map((c) => c.id),
      method: 'ok',
    }
  }

  return {
    as_is: build('as_is'),
    median: build('median'),
    arv: build('arv'),
  }
}

/** ±10% edge check + IoU — spec §4. Returns per-edge errors and the
 *  overlap score; the caller applies the pass thresholds. */
export function bandEdgeCheck(
  agentLow: number, agentHigh: number,
  evidenceLow: number, evidenceHigh: number,
): { epsLow: number; epsHigh: number; iou: number } {
  const epsLow = Math.abs(agentLow - evidenceLow) / evidenceLow
  const epsHigh = Math.abs(agentHigh - evidenceHigh) / evidenceHigh
  const inter = Math.max(0, Math.min(agentHigh, evidenceHigh) - Math.max(agentLow, evidenceLow))
  const union = Math.max(agentHigh, evidenceHigh) - Math.min(agentLow, evidenceLow)
  return { epsLow, epsHigh, iou: union > 0 ? inter / union : 0 }
}
