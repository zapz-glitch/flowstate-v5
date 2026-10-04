/**
 * Set-B evaluation — the trade-tricks methodology ported from the
 * calibration harness (scripts/ab-eval.py). Pure function over the same
 * enabled comp pool the legacy appraisal consumes.
 *
 * Semantics (calibrated against 27 live addresses):
 *   - evidence verification: stale/divergent sales never drive ARV
 *   - tier discipline: renovated preferred (sim ≥ 3) → median fallback
 *     → weak → retail-band — as-is/distressed are floor evidence only
 *   - contributions: marginal sqft (pool slope / 0.5–0.3 taper) + land
 *     (vacant-median → assessed-curve → per-parcel ×0.35, capped ±20%)
 *   - market area (rule 14): outside the closest populated geo tier a comp
 *     carries weight only when its size-adjusted value agrees with the
 *     pocket rate (±15%), stock matches, and no major road separates it
 *   - reconciliation (rules 6/15): 3–6 verified sales, closest tier first,
 *     rank-sum weighted — most weight to the best comp. No single-comp
 *     anchoring; a thin pool is flagged so the pipeline widens the search
 *   - condition adj: the URAR Condition line item — market gap when
 *     measurable, contributory (rehab × 70%) when not
 *   - outlier ceiling: top verified contribution in subject units;
 *     exceeding it needs ≥2 supporters
 *   - cascade: T0 anchor → T1 rescue → T2 pocket → T3 AVM → T4 assessed
 *     → T5 report-only
 */

// ── Constants (calibrated — see scoreboard.md) ────────────────────────────
export const B_ADJ_CAP_PCT = 0.25
export const B_OUTLIER_SUPPORT = 2
export const B_LAND_FACTOR = 0.35
export const B_LAND_CAP_PCT = 0.20
export const B_RETAIL_BAND = 0.70
/** Ceiling gate only — reconciliation has no similarity cutoff (rule 15). */
export const B_SIM_GATE = 0.60
/** Rule 14 — size-adjusted value must agree with the pocket rate. */
export const B_MARKET_AREA_PCT = 0.15
/** Rules 6/15 — reconcile at least 3 closed sales, 3–6 typical. */
export const B_MIN_RECONCILED = 3
export const B_MAX_RECONCILED = 6
/** Rule 13 — bed/bath adjustments stand only at similar size. */
export const B_SIMILAR_SIZE_PCT = 0.10
/** Rule 11 — contributory fallback share of rehab cost. */
export const B_REHAB_UPLIFT = 0.70
export const B_COND_MIN_CONF = 30
export const B_REHAB_FRACTION: Record<string, number> = {
  'Full Gut': 0.95,
  'Heavy Rehab': 0.85,
  'Full Cosmetic': 0.75,
  'Light Cosmetic': 0.45,
  Lipstick: 0.30,
}

// ── Minimal shapes (supersets of the serialized analysis fields) ──────────
export interface BSubject {
  squareFeet: number | null
  yearBuilt?: number | null
  censusTract?: string | null
  subdivision?: string | null
  landAssessedValue?: number | null
  /** County assessed improvement — the extractable improvement basis:
   *  sale − improvement×mktRatio = implied land value (land plays). */
  improvementAssessedValue?: number | null
  taxAssessment?: number | null
  assessedValue?: number | null
  avmValue?: number | null
  avm?: { value?: number | null } | null
  condition?: string | null
  lotSizeAcres?: number | null
  lotSizeSquareFeet?: number | null
}

export interface BComp {
  address?: string | null
  isEnabled: boolean
  salePrice?: number | null
  saleDate?: string | null
  squareFeet?: number | null
  pricePerSqft?: number | null
  adjustedPrice?: number | null
  distanceMiles?: number | null
  sameBlockGroup?: boolean | null
  censusTract?: string | null
  subdivision?: string | null
  yearBuilt?: number | null
  lotSizeAcres?: number | null
  lotSizeSquareFeet?: number | null
  landAssessedValue?: number | null
  /** County assessed improvement — the extractable improvement basis:
   *  sale − improvement×mktRatio = implied land value (land plays). */
  improvementAssessedValue?: number | null
  propertyType?: string | null
  crossesMajorRoad?: boolean | null
  disableReasons?: string[] | null
  classification?: { type?: string | null } | null
  curbAppeal?: {
    condition?: string | null
    confidence?: number | null
    summary?: string | null
  } | null
  evidenceVerification?: {
    staleness?: string | null
    priceCheck?: string | null
    /** comp sale $/sf ÷ pocket reference $/sf — the stale-admission
     *  time-adjustment factor source */
    pocketRatio?: number | null
    flags?: string[] | null
  } | null
  appraisalRules?: {
    totalAdjustment?: number | null
    /** Applied grid adjustments — lets rule 13 lift bed/bath out when the
     *  marginal size adjustment already prices the difference. */
    adjustments?: Array<{ type?: string | null; amount?: number | null }> | null
  } | null
  /** Listing sqft diverged >33% from provider — size normalization is
   *  unreliable; the comp can bound but never anchors. */
  sqftConflict?: string | null
  /** Unpermitted marketed-vs-tax divergence — buyers priced the marketed
   *  product so neither figure normalizes the sale. An appraiser throws
   *  it out: excluded from ARV evidence entirely. */
  sqftExcluded?: boolean | null
  /** Stale sale repriced to current pocket — the adjustment factor applied
   *  (1/pocketRatio, capped 2×). Only set in devalue+admitStale mode. */
  staleTimeAdjusted?: number
}

export interface BContribution {
  comp: BComp
  contrib: number
  /** The land-delta component of the contribution — serialized so the
   *  dashboard replays the same math on comp toggles. */
  landAdj?: number
  /** Reconciliation weight for drivers (sums to 1 across the reconciled
   *  set); the least-adjustment weight for comps that only sit in the pool. */
  weight: number
  tier: 'arv' | 'as_is' | 'unidentified'
  /** Price adjusted to the subject's size — the banding basis (rule 12). */
  sizeAdjusted?: number
  /** Gross adjustments (grid + size + land) as a share of sale price. */
  grossAdjPct?: number
  /** Role in the reconciliation — set on drivers only. */
  role?: 'primary' | 'support'
}

export interface BResult {
  arv: number | null
  flags: string[]
  drivers: BContribution[]
  contribs: BContribution[]
  bracket: 'ok' | 'all-smaller' | 'all-bigger'
  conf: 'high' | 'medium' | 'low' | 'none'
  source: string
  landRateSource?: string | null
  sqftRateSource?: string | null
  /** Pool rates + band thresholds — the shared inputs the client needs to
   *  replay contributions identically on comp toggles. */
  landRate?: number | null
  sqftRate?: number | null
  bandLo?: number | null
  bandHi?: number | null
  anchorAddress?: string | null
  ceiling?: number | null
  conditionAdj?: number | null
  healed?: boolean
  /** Fewer than 3 verified sales reconciled — the pipeline widens the
   *  search before accepting the answer (rule 6). */
  thin?: boolean
  /** Land-extraction evidence — implied land $/lot-sf per verified comp,
   *  the pocket land rate, and the subject's extracted land value.
   *  mode:'land_play' when the improvement is a rounding error. */
  land?: {
    pocketRate: number | null
    source: string | null
    subjectLandValue: number | null
    mode: 'land_play' | null
    comps: Array<{
      address?: string | null
      impliedLand: number
      landPpsf: number
      lotSf: number
      /** improvement basis — 'county' split or 'rcn-model' replacement estimate */
      basis: string
    }>
  } | null
}

// ── Helpers ───────────────────────────────────────────────────────────────
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`

export function bSubjectAvm(s: BSubject): number | null {
  return s.avmValue ?? s.avm?.value ?? null
}

export function bTierOf(c: BComp): 'arv' | 'as_is' | 'unidentified' {
  const t = (c.classification?.type ?? '').toLowerCase()
  if (t === 'after_renovation' || t === 'arv' || t === 'renovated') return 'arv'
  if (t === 'as_is' || t === 'investor' || t === 'distressed') return 'as_is'
  return 'unidentified'
}

export function bCondTier(c: BComp): 'renovated' | 'median' | 'premium' | 'distressed' | 'unknown' {
  const ca = c.curbAppeal ?? {}
  // Physical condition only — the 'tier:' token in the Clef summary is the
  // market/sale tier (arv/median/investor), NOT condition; reading it here
  // conflates the two axes and banded renovated comps as 'median'.
  // Parse the condition label that opens the summary ("Updated (3.2/4)").
  const summary = (ca.summary ?? '').toLowerCase()
  const condLabel = summary.split('(')[0].trim()
  if (['poor'].includes(condLabel)) return 'distressed'
  if (['renovated', 'updated'].includes(condLabel)) return 'renovated'
  if (['dated', 'maintained', 'original'].includes(condLabel)) return 'median'
  const cond = (ca.condition ?? '').toLowerCase()
  if ((ca.confidence ?? 0) < B_COND_MIN_CONF) return 'unknown'
  if (['renovated', 'updated', 'turnkey', 'move-in ready'].includes(cond)) return 'renovated'
  // Distressed is floor evidence — it can corroborate as-is pricing but
  // NEVER drives or anchors ARV.
  if (['distressed', 'needs_work', 'tear_down', 'teardown', 'fixer'].includes(cond)) return 'distressed'
  if (['dated', 'maintained', 'median', 'as_is', 'as-is'].includes(cond))
    return 'median'
  return 'unknown'
}

/** ARV-eligible condition — distressed is the only condition explicitly
 *  barred from ARV evidence (floor-only). */
const bArvCondOk = (c: BComp) => bCondTier(c) !== 'distressed'

const bIsUnfit = (c: BComp) =>
  c.evidenceVerification?.staleness === 'stale' ||
  c.evidenceVerification?.priceCheck === 'divergent' ||
  // Unpermitted marketed-vs-tax divergence — neither sqft figure normalizes
  // the sale (buyers priced the marketed product; the extra area can't be
  // verified). An appraiser throws it out — unusable as evidence at all.
  c.sqftExcluded === true

const bLotSf = (x: { lotSizeSquareFeet?: number | null; lotSizeAcres?: number | null }) =>
  x.lotSizeSquareFeet ?? (x.lotSizeAcres ? x.lotSizeAcres * 43560 : null)

// Raw sale $/sf is the liquidity signal — banding and price corroboration
// must read what the market actually paid, not a stored adjusted figure
// (serialized comps carry adjusted-price $/sf for display).
const bPpsfOf = (c: BComp) =>
  c.salePrice && c.squareFeet ? c.salePrice / c.squareFeet : c.pricePerSqft

/** OLS slope — price~size gradient across a point set. */
function olsSlope(pts: { x: number; y: number }[]): number | null {
  const n = pts.length
  if (n < 2) return null
  const mx = pts.reduce((a, p) => a + p.x, 0) / n
  const my = pts.reduce((a, p) => a + p.y, 0) / n
  const cov = pts.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0)
  const v = pts.reduce((a, p) => a + (p.x - mx) ** 2, 0)
  return v > 0 ? cov / v : null
}

const bMedian = (xs: number[]) =>
  xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null

// ── The evaluation ────────────────────────────────────────────────────────
export function evaluateB(
  subject: BSubject,
  items: BComp[],
  opts?: { rehabCost?: number | null; devalueToMedian?: boolean; admitStale?: boolean },
): BResult {
  const subSqft = subject.squareFeet
  const flags: string[] = []
  // Admit-stale rung — a comp too old to be 'current' isn't discarded, an
  // appraiser time-adjusts it: its sale reprices by its pocket ratio (the
  // gap between its $/sf and today's pocket), capped at 2× so a 50%-of-
  // pocket sale can't become a 3× phantom. Devalue-mode only.
  if (opts?.admitStale) {
    items = items.map((c) => {
      const ratio = c.evidenceVerification?.pocketRatio
      if (c.evidenceVerification?.staleness !== 'stale' || !ratio || ratio >= 1 || !c.salePrice) return c
      const adj = Math.min(1 / ratio, 2)
      return {
        ...c,
        salePrice: c.salePrice * adj,
        adjustedPrice: c.adjustedPrice != null ? c.adjustedPrice * adj : c.adjustedPrice,
        pricePerSqft: c.pricePerSqft != null ? c.pricePerSqft * adj : c.pricePerSqft,
        evidenceVerification: { ...c.evidenceVerification, staleness: 'current' as const },
        staleTimeAdjusted: adj,
      }
    })
  }
  const empty = (source: string): BResult => ({
    arv: null, flags, drivers: [], contribs: [], bracket: 'ok', conf: 'none', source,
  })

  // Pool: enabled comps with sale + size evidence. Soft-disabled comps
  // (boundary sale_age, geo name variants, size deltas, road barrier)
  // still compete — verification + similarity do the ranking. Hard gates
  // (nominal transfers, category/type mismatches) stay hard.
  const B_HARD_DISABLE = /non-market|type mismatch|nominal|not market|property category/i
  // 'Lot category mismatch' reads like a type gate but is a SIZE delta —
  // the land/lot curves exist to price it. Only true property-type
  // categories are hard.
  const B_LOT_DELTA = /lot category|lot size/i
  // A soft-disable rescues adjustable deltas — not category differences.
  // A comp >~75% off the subject's size is a different product class, not
  // something the size curve can honestly extrapolate.
  const bSizeBand = (c: BComp) => {
    if (subject.squareFeet == null || c.squareFeet == null) return true
    const ratio = c.squareFeet / subject.squareFeet
    // Devalue mode widens the rescue band — an oversized subject with no
    // ARV evidence gets answered by verified comps at a relaxed fit
    // (marginal-rate scaling prices the gap), never by hard refusal.
    const lo = opts?.devalueToMedian ? 0.33 : 0.5
    const hi = opts?.devalueToMedian ? 3 : 1.75
    return ratio >= lo && ratio <= hi
  }
  // Rescues must earn it: verified sale (corroborated/plausible — an
  // uncorroborated rescue is a guess, not evidence) and same side of the
  // road barrier (a road crossing is a submarket boundary, not a soft delta).
  const bSoftDisabled = (c: BComp) => {
    if (c.isEnabled || !(c.disableReasons?.length ?? 0)) return false
    if (!(c.disableReasons ?? []).every((r) => !B_HARD_DISABLE.test(r) || B_LOT_DELTA.test(r))) return false
    if (!bSizeBand(c)) return false
    const ver = c.evidenceVerification?.priceCheck
    if (ver !== 'corroborated' && ver !== 'plausible') return false
    if ((c.disableReasons ?? []).some((r) => /major road/i.test(r))) return false
    return true
  }
  let pool = items.filter((c) => (c.isEnabled || bSoftDisabled(c)) && c.salePrice && c.squareFeet)
  let source = 'T0 anchor'

  // T1 — adjustable-delta rescue (lot size). Comps killed ONLY on an
  // adjustable delta get rescued when they verify same pocket.
  if (!pool.length) {
    pool = items.filter((c) => {
      const reasons = c.disableReasons ?? []
      if (!(reasons.length === 1 && reasons[0].toLowerCase().includes('lot size'))) return false
      if (!c.salePrice || !c.squareFeet) return false
      if ((c.distanceMiles ?? 99) > 0.5) return false
      if (c.crossesMajorRoad) return false
      if (c.sameBlockGroup === false && subject.censusTract && c.censusTract
          && c.censusTract !== subject.censusTract) return false
      return true
    })
    if (pool.length) {
      source = 'T1 land-adjusted (lot-delta flagged, not modeled)'
      flags.push(`${pool.length} comp(s) rescued — only lot-size failed; land delta NOT adjusted`)
    }
  }

  // T2 — pocket-implied: same-tract median ppsf × subject sqft
  if (!pool.length) {
    const tractPpsf = items
      .filter((c) => c.salePrice && c.squareFeet && c.censusTract && c.censusTract === subject.censusTract)
      .map((c) => bPpsfOf(c)!)
      .sort((a, b) => a - b)
    if (subSqft && tractPpsf.length >= 3) {
      const med = tractPpsf[Math.floor(tractPpsf.length / 2)]
      return {
        arv: Math.round(med * subSqft), contribs: [], drivers: [], bracket: 'ok', conf: 'low',
        source: 'T2 pocket-implied',
        flags: [`T2 pocket-implied — ${tractPpsf.length} same-tract sales, median $${med.toFixed(0)}/sf`],
      }
    }
  }

  // T3 / T4 / T5 — AVM floor → assessed → report-only
  if (!pool.length) {
    const avm = bSubjectAvm(subject)
    if (avm) {
      return { arv: Math.round(avm), contribs: [], drivers: [], bracket: 'ok', conf: 'low',
        source: 'T3 AVM floor', flags: ['T3 as-is AVM floor — ARV ≥ AVM, uplift unverified'] }
    }
    const assessed = subject.assessedValue ?? subject.taxAssessment ?? null
    if (assessed) {
      return { arv: Math.round(assessed), contribs: [], drivers: [], bracket: 'ok', conf: 'none',
        source: 'T4 assessed', flags: ['T4 assessed fallback — county estimate'] }
    }
    return { ...empty('T5 report-only'), flags: ['T5 report-only — no comp evidence, no anchor'] }
  }

  // ── Marginal land rate — honest ladder ─────────────────────────────────
  const subLand = subject.landAssessedValue ?? null
  const subAvm = bSubjectAvm(subject)
  const mktRatio = subAvm && subject.taxAssessment ? subAvm / subject.taxAssessment : 1.4
  const slLot = bLotSf(subject)

  let landRate: number | null = null
  let landSource: string | null = null

  // T1 — vacant-land sales in the same tract
  const vacant = items
    .filter((c) =>
      (c.propertyType ?? '').toLowerCase().includes('land') &&
      c.salePrice && bLotSf(c) &&
      c.censusTract && c.censusTract === subject.censusTract)
    .map((c) => c.salePrice! / bLotSf(c)!)
    .sort((a, b) => a - b)
  if (vacant.length >= 2) {
    landRate = vacant[Math.floor(vacant.length / 2)]
    landSource = `T1 vacant-land median $${landRate.toFixed(2)}/sf (${vacant.length} sales)`
  } else {
    // T2 — assessed-land regression over same-tract parcels (≥5)
    const pts = items
      .filter((c) => bLotSf(c) && c.landAssessedValue &&
        c.censusTract && c.censusTract === subject.censusTract)
      .map((c) => ({ x: bLotSf(c)!, y: c.landAssessedValue! }))
    if (slLot && subLand) pts.push({ x: slLot, y: subLand })
    if (pts.length >= 5) {
      const slope = olsSlope(pts)
      if (slope != null) {
        landRate = Math.max(0, slope)
        landSource = `T2 assessed-curve slope $${landRate.toFixed(2)}/sf (${pts.length} parcels)`
      }
    }
  }
  if (landSource) flags.push(`land rate: ${landSource}`)

  // ── Marginal sqft rate — appraiser ladder ───────────────────────────────
  const fitPool = pool.filter((c) => !bIsUnfit(c) && c.salePrice && c.squareFeet)
  const fitTract = fitPool.filter((c) => c.censusTract && c.censusTract === subject.censusTract)
  let sqftRate: number | null = null
  let sqftRateSource: string | null = null
  for (const src of [fitTract, fitPool]) {
    if (src.length >= 5) {
      const slope = olsSlope(src.map((c) => ({ x: c.squareFeet!, y: c.salePrice! })))
      const avgPpsf = src.reduce((a, c) => a + (bPpsfOf(c) ?? 0), 0) / src.length
      if (slope != null && slope > 0 && slope < avgPpsf) {
        sqftRate = slope
        sqftRateSource = `T1 pool slope $${slope.toFixed(0)}/sf (${src.length} comps)`
        break
      }
    }
  }
  if (sqftRateSource) flags.push(`size rate: ${sqftRateSource}`)

  // ── Contributions — base + marginal size + land ─────────────────────────
  const contribs: BContribution[] = []
  for (const c of pool) {
    const compSqft = c.squareFeet!
    const ppsf = bPpsfOf(c)!
    // Rule 13 — no size double-count. The marginal size adjustment already
    // prices the area a bedroom/bathroom sits in, so the grid's bed/bath
    // dollars come back out unless the comp is the subject's size (room
    // count then differs at similar size and the grid line stands).
    const gridAdjs = (c.appraisalRules?.adjustments ?? []).filter((a) => a.amount)
    const roomAdj = gridAdjs
      .filter((a) => a.type === 'bedroom' || a.type === 'bathroom')
      .reduce((sum, a) => sum + (a.amount ?? 0), 0)
    const similarSize = Math.abs(subSqft! - compSqft) / subSqft! <= B_SIMILAR_SIZE_PCT
    const skipRooms = c.adjustedPrice != null && roomAdj !== 0 && !similarSize
    const base = (c.adjustedPrice ?? c.salePrice!) - (skipRooms ? roomAdj : 0)
    if (skipRooms)
      flags.push(`${c.address}: bed/bath adj ${roomAdj >= 0 ? '+' : '−'}${usd(Math.abs(roomAdj))} skipped — size adjustment already prices the difference`)
    let sizeAdj: number
    if (sqftRate != null) {
      sizeAdj = (subSqft! - compSqft) * sqftRate
    } else {
      const gap = Math.abs(subSqft! - compSqft) / compSqft
      const mf = gap <= 0.10 ? 0.50 : gap <= 0.25 ? 0.40 : 0.30
      sizeAdj = (subSqft! - compSqft) * ppsf * mf
    }
    const sizeAdjusted = base + sizeAdj
    let contrib = sizeAdjusted

    // Land adjustment — marginal-rate method when derivable, else the
    // conservative per-parcel fallback; always capped at ±20% of sale.
    let landAdj = 0
    const cLot = bLotSf(c)
    if (landRate != null && cLot && slLot) {
      landAdj = landRate * (slLot - cLot)
      if (landSource?.startsWith('T2')) landAdj *= mktRatio
    } else if (subLand && c.landAssessedValue) {
      landAdj = (subLand - c.landAssessedValue) * mktRatio * B_LAND_FACTOR
    }
    if (Math.abs(landAdj) >= 1000) {
      landAdj = Math.max(-B_LAND_CAP_PCT * c.salePrice!, Math.min(B_LAND_CAP_PCT * c.salePrice!, landAdj))
      contrib += landAdj
      flags.push(`${c.address}: land adj ${landAdj >= 0 ? '+' : '−'}$${Math.abs(landAdj).toLocaleString('en-US', { maximumFractionDigits: 0 })} [${landSource ?? 'T3 per-parcel'}] (cap ±${usd(B_LAND_CAP_PCT * c.salePrice!)})`)
    }

    // Gross adjustment — every dollar moved, in either direction: the grid
    // lines that stand, the size adjustment, the land adjustment. Above the
    // cap a comp is a last resort (rule 15).
    const gridGross = gridAdjs.length
      ? gridAdjs
          .filter((a) => !(skipRooms && (a.type === 'bedroom' || a.type === 'bathroom')))
          .reduce((sum, a) => sum + Math.abs(a.amount ?? 0), 0)
      : Math.abs(c.appraisalRules?.totalAdjustment ?? 0)
    const appliedLand = Math.abs(landAdj) >= 1000 ? Math.abs(landAdj) : 0
    const adjPct = (gridGross + Math.abs(sizeAdj) + appliedLand) / c.salePrice!
    const weight = (1 / (1 + adjPct)) * (adjPct > B_ADJ_CAP_PCT ? 0.5 : 1)
    if (c.staleTimeAdjusted)
      flags.push(`${c.address}: stale sale time-adjusted +${((c.staleTimeAdjusted - 1) * 100).toFixed(0)}% to current pocket`)
    contribs.push({ comp: c, contrib, weight, tier: bTierOf(c), landAdj, sizeAdjusted, grossAdjPct: adjPct })
  }

  // ── Evidence verification — stale/divergent never drive ARV ─────────────
  const unfit = contribs.filter((x) => bIsUnfit(x.comp))
  for (const x of unfit) {
    const reason = x.comp.sqftExcluded
      ? 'unpermitted marketed-vs-tax sqft divergence — denominator unverifiable, excluded'
      : (x.comp.evidenceVerification?.flags ?? []).join('; ').slice(0, 90)
    flags.push(`${x.comp.address}: verification — ${reason}`)
  }
  const verifiedPool = contribs.filter((x) => !unfit.includes(x))

  // ── Land extraction — sale − contributory improvement = implied land ────
  // The appraiser's extraction method: each verified sale yields an implied
  // $/lot-sf when the county splits land vs improvement assessments. The
  // pocket land rate prices the subject's dirt independently of the
  // improved-product comps — the answer a land play actually needs.
  const impliedPts = verifiedPool
    .map((x) => {
      const lot = bLotSf(x.comp)
      if (lot == null || lot <= 0 || x.comp.salePrice == null) return null
      // Improvement basis: county split × market ratio preferred; fallback =
      // replacement-cost model (sqft × $110 × (1 − 2%/yr depreciation, cap
      // 80%) — the appraiser's substitute when the county doesn't split.
      const impBasis =
        x.comp.improvementAssessedValue != null && x.comp.improvementAssessedValue > 0
          ? { value: x.comp.improvementAssessedValue * mktRatio, src: 'county' as const }
          : x.comp.squareFeet != null && x.comp.yearBuilt != null
            ? {
                value: x.comp.squareFeet * 110 *
                  (1 - Math.min(0.02 * Math.max(0, new Date().getFullYear() - x.comp.yearBuilt), 0.8)),
                src: 'rcn-model' as const,
              }
            : null
      if (!impBasis) return null
      const implied = x.comp.salePrice - impBasis.value
      // Sanity: land must be positive and the sale can't be >90% land
      // (a near-total land share on an improved sale is a bad split).
      if (implied <= 0 || implied > x.comp.salePrice * 0.9) return null
      return {
        address: x.comp.address,
        impliedLand: Math.round(implied), landPpsf: implied / lot, lotSf: lot,
        basis: impBasis.src,
        sameBlockGroup: x.comp.sameBlockGroup === true,
      }
    })
    .filter((p): p is NonNullable<typeof p> => p != null)
  const bgLandPts = impliedPts.filter((p) => p.sameBlockGroup)
  const landRatePts = bgLandPts.length >= 2 ? bgLandPts : impliedPts
  const pocketLandRate = landRatePts.length >= 2 ? bMedian(landRatePts.map((p) => p.landPpsf)) : null
  const slLotForLand = bLotSf(subject)
  const subjectLandValue =
    pocketLandRate != null && slLotForLand != null ? Math.round(pocketLandRate * slLotForLand) : null
  // Land-play detection — the improvement is a rounding error on the parcel
  // (<25% of assessment) or the extracted land value outruns the improved
  // answer. The dirt is the product.
  const impShare =
    subject.improvementAssessedValue != null && subject.assessedValue != null && subject.assessedValue > 0
      ? subject.improvementAssessedValue / subject.assessedValue
      : null
  const landMode =
    impShare != null && impShare < 0.25 ? 'land_play' as const
    : null
  if (landMode && subjectLandValue != null)
    flags.push(`land play — improvement is ${(impShare! * 100).toFixed(0)}% of assessment; extracted land value ${usd(subjectLandValue)} (${landRatePts.length} implied sales at ~$${pocketLandRate!.toFixed(0)}/lot-sf)`)
  const land: BResult['land'] = {
    pocketRate: pocketLandRate,
    source: bgLandPts.length >= 2 ? `same-BG implied (${bgLandPts.length})` : impliedPts.length >= 2 ? `pool implied (${impliedPts.length})` : null,
    subjectLandValue,
    mode: landMode,
    comps: impliedPts.map((p) => ({ address: p.address, impliedLand: p.impliedLand, landPpsf: p.landPpsf, lotSf: p.lotSf, basis: p.basis })),
  }

  // ── Similarity scoring ──────────────────────────────────────────────────
  const similarity = (x: BContribution): number => {
    const c = x.comp
    let s = 0
    const d = c.distanceMiles
    if (d != null) s += Math.max(0, 1 - d) * 3.0
    if (c.sameBlockGroup) s += 3.0
    else if (subject.censusTract && c.censusTract === subject.censusTract) s += 2.0
    if (c.subdivision && c.subdivision === subject.subdivision) s += 2.0
    const yd = c.yearBuilt && subject.yearBuilt ? Math.abs(c.yearBuilt - subject.yearBuilt) : null
    if (yd != null) s += yd <= 10 ? 1.5 : yd <= 20 ? 0.75 : 0
    const sd = c.squareFeet && subject.squareFeet ? Math.abs(c.squareFeet - subject.squareFeet) : null
    if (sd != null) s += sd <= 150 ? 1.5 : sd <= 300 ? 0.75 : 0
    return s
  }

  // ── Band discipline — Clef's condition verdict is preferred. When it
  // can't classify (no listing/unavailable), price position stands in:
  // top tercile = upper band, middle = median, bottom = floor. Rule 12 —
  // the position is ranked on price adjusted to the subject's size, inside
  // the subject's own tract when it has enough sales (raw $/sf makes big
  // houses look cheap; a far pocket's prices aren't this pocket's bands). ─
  const sizeAdjOf = (x: BContribution) => x.sizeAdjusted ?? x.contrib
  const inTract = (c: BComp) => !!subject.censusTract && c.censusTract === subject.censusTract
  const tractVerified = verifiedPool.filter((x) => inTract(x.comp))
  const bandVals = (tractVerified.length >= 5 ? tractVerified : verifiedPool)
    .map(sizeAdjOf)
    .sort((a, b) => a - b)
  const bandQ = (f: number) =>
    bandVals.length ? bandVals[Math.min(bandVals.length - 1, Math.floor(bandVals.length * f))] : null
  const bandLo = bandQ(1 / 3)
  const bandHi = bandQ(2 / 3)
  const bandOf = (x: BContribution): 'upper' | 'median' | 'floor' => {
    const ct = bCondTier(x.comp)
    if (ct === 'distressed') return 'floor'
    const p = sizeAdjOf(x)
    const priceBand =
      bandLo != null && bandHi != null
        ? p >= bandHi ? 'upper' : p >= bandLo ? 'median' : 'floor'
        : null
    if (priceBand != null && ct !== 'unknown') {
      // Verdict + price disagree by a full band → the liquidity event wins:
      // a "renovated" label that sold at floor prices isn't ARV evidence,
      // and a "dated" comp buyers paid top-tercile for IS upper evidence.
      if (priceBand === 'floor' && (ct === 'renovated' || ct === 'premium')) return 'floor'
      // Price corroboration — a renovated/premium claim that sold at
      // median prices is median evidence. Vision hints at condition;
      // the sale price is what the market actually paid for it.
      if (priceBand === 'median' && (ct === 'renovated' || ct === 'premium')) return 'median'
      if (priceBand === 'upper' && ct === 'median') return 'upper'
    }
    if (ct === 'renovated' || ct === 'premium') return 'upper'
    if (ct === 'median') return 'median'
    return priceBand ?? 'median'
  }

  // ── Geography tiers (rule 1) — block group, then tract, then the
  // neighborhood by name, then the widened pool. A name is a hint: near
  // matches (spelling, EXT/SUB/phase) land in the neighborhood tier and
  // still have to pass the market-area value check below. ────────────────
  const subdivKey = (v?: string | null) =>
    (v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b(unit|un|phase|ph|the|of|addition|add|ext|extension|sub|subdivision|sec|section|annex|\d+)\b/g, '')
      .replace(/\s+/g, ' ').trim() || null
  const editDistance = (a: string, b: string) => {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
    for (let i = 1; i <= a.length; i++) {
      const row = [i]
      for (let j = 1; j <= b.length; j++)
        row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = row
    }
    return prev[b.length]
  }
  const subKey = subdivKey(subject.subdivision)
  const sameNeighborhood = (c: BComp) => {
    const k = subdivKey(c.subdivision)
    if (!subKey || !k) return false
    if (k === subKey) return true
    const [shorter, longer] = k.length <= subKey.length ? [k, subKey] : [subKey, k]
    if (longer.startsWith(`${shorter} `)) return true
    return shorter.length >= 6 && editDistance(k, subKey) <= 2
  }
  const geoTier = (c: BComp): 1 | 2 | 3 | 4 =>
    c.sameBlockGroup === true ? 1 : inTract(c) ? 2 : sameNeighborhood(c) ? 3 : 4
  const B_TIER_LABEL = { 1: 'block group', 2: 'tract', 3: 'neighborhood', 4: 'widened pool' } as const

  // Last-resort evidence (rule 15) — usable only to complete the minimum
  // in a thin pool, one at most, reason stated: size math untrusted, gross
  // adjustments over the cap, or a sale outside the configured comp-age
  // window (time-adjusted stale sales have already been repriced).
  const lastResortReason = (x: BContribution): string | null =>
    x.comp.sqftConflict ? `size unverified (${x.comp.sqftConflict})`
    : (x.grossAdjPct ?? 0) > B_ADJ_CAP_PCT
      ? `${((x.grossAdjPct ?? 0) * 100).toFixed(0)}% gross adjustment over the ${(B_ADJ_CAP_PCT * 100).toFixed(0)}% cap`
    : !opts?.admitStale && (x.comp.disableReasons ?? []).some((r) => /sale too old/i.test(r))
      ? 'sale outside the comp-age window'
    : null
  const stockMismatch = (c: BComp) =>
    (c.disableReasons ?? []).some((r) => /year built|style|stories|foundation|construction/i.test(r))
  const mid = (xs: number[]) => {
    const s = xs.slice().sort((a, b) => a - b)
    const h = Math.floor(s.length / 2)
    return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2
  }

  // ── Reconciliation set (rules 5/6/14/15) ────────────────────────────────
  // The closest populated tier sets the pocket rate. Comps outside it carry
  // weight only inside the subject's market area. Selection walks out one
  // tier at a time and only while short of three sales.
  const selectReconciled = (cands: BContribution[]): BContribution[] => {
    if (!cands.length) return []
    const tierOf = (x: BContribution) => geoTier(x.comp)
    const closest = Math.min(...cands.map(tierOf)) as 1 | 2 | 3 | 4
    const closestSet = cands.filter((x) => tierOf(x) === closest)
    const trusted = closestSet.filter((x) => !lastResortReason(x))
    const pocketRate = mid((trusted.length ? trusted : closestSet).map((x) => x.contrib))
    const inArea = cands.filter((x) => {
      if (tierOf(x) === closest) return true
      const off = x.contrib / pocketRate - 1
      const why =
        Math.abs(off) > B_MARKET_AREA_PCT
          ? `size-adjusted ${usd(x.contrib)} is ${(Math.abs(off) * 100).toFixed(0)}% ${off > 0 ? 'above' : 'below'} the ${B_TIER_LABEL[closest]} pocket rate ${usd(pocketRate)}`
        : stockMismatch(x.comp) ? 'housing stock differs (era/style)'
        : x.comp.crossesMajorRoad ? 'a major road separates it'
        : null
      if (why) flags.push(`${x.comp.address}: outside the market area — ${why}; carries no weight`)
      return !why
    })
    const verdict = (x: BContribution) => (verifiedUpper(x) ? 0 : 1)
    const saleTime = (x: BContribution) => (x.comp.saleDate ? Date.parse(x.comp.saleDate) || 0 : 0)
    const rank = (a: BContribution, b: BContribution) =>
      tierOf(a) - tierOf(b) || verdict(a) - verdict(b) ||
      (a.grossAdjPct ?? 0) - (b.grossAdjPct ?? 0) || saleTime(b) - saleTime(a) ||
      (a.comp.distanceMiles ?? 99) - (b.comp.distanceMiles ?? 99)
    const normal = inArea.filter((x) => !lastResortReason(x)).sort(rank)
    let chosen: BContribution[] = []
    let reached: 1 | 2 | 3 | 4 = closest
    for (const t of [1, 2, 3, 4] as const) {
      if (chosen.length >= B_MIN_RECONCILED) break
      const add = normal.filter((x) => tierOf(x) === t)
      if (add.length) reached = t
      chosen.push(...add)
    }
    chosen = chosen.slice(0, B_MAX_RECONCILED)
    if (reached !== closest && chosen.length)
      flags.push(`widened to the ${B_TIER_LABEL[reached]} — the ${B_TIER_LABEL[closest]} alone had fewer than ${B_MIN_RECONCILED} trustworthy sales`)
    if (chosen.length < B_MIN_RECONCILED) {
      const fallback = inArea.filter((x) => lastResortReason(x)).sort(rank)[0]
      if (fallback) {
        chosen.push(fallback)
        flags.push(`${fallback.comp.address}: admitted to complete the minimum — ${lastResortReason(fallback)} (thin pool, least weight)`)
      }
    }
    return chosen
  }

  // Upper band = ARV evidence: not stamped as-is/distressed, condition not
  // proven median. An unclassified sale that passed the rules is still
  // evidence, just unverdicted.
  const upperEligible = verifiedPool.filter((x) =>
    x.tier !== 'as_is' && bArvCondOk(x.comp) && bandOf(x) === 'upper')
  // Verified-renovated — a positive condition claim (renovated/premium)
  // that the price corroborates. Band corroboration needs a real pool:
  // a 2-comp "band" always crowns something upper, so degenerate pools
  // fall back to the pocket rate — a renovated sale should clear the
  // pocket's going $/sf (pocketRatio >= 1). This is the only evidence
  // that earns the renovated verdict's ranking preference.
  const verifiedUpper = (x: BContribution) => {
    if (bCondTier(x.comp) !== 'renovated' && bCondTier(x.comp) !== 'premium') return false
    if (bandVals.length >= 3) return bandOf(x) === 'upper'
    const pr = x.comp.evidenceVerification?.pocketRatio
    return pr != null ? pr >= 1.0 : bandOf(x) === 'upper'
  }

  const medianComps = verifiedPool.filter((x) => bandOf(x) === 'median')
  let drivers: BContribution[]
  let medianTier = false
  if (opts?.devalueToMedian) {
    // Devalue rung — upper-band evidence couldn't verify (e.g. a lone
    // premium comp >20% above AVM with no support). The ladder drops a
    // tier and the median pool answers what it can support — flagged.
    drivers = selectReconciled(medianComps)
    medianTier = true
    if (drivers.length)
      flags.push('devalued — upper-band evidence unverifiable; median-tier pool answers')
  } else {
    drivers = selectReconciled(upperEligible)
    for (const x of drivers)
      if (x.tier === 'unidentified')
        flags.push(`${x.comp.address}: unclassified driver — rules passed, no sale-type verdict`)
      else if (bCondTier(x.comp) === 'unknown')
        flags.push(`${x.comp.address}: price-banded driver — no condition verdict, banded top-tercile of the pocket`)
    if (!drivers.length) {
      drivers = selectReconciled(medianComps)
      medianTier = true
      for (const x of drivers)
        flags.push(`${x.comp.address}: median-tier driver — no verified renovated evidence`)
    }
  }
  if (!drivers.length) {
    flags.push('no retail-priced evidence — ARV withheld (as-is sales are floor evidence only)')
    return { arv: null, flags, contribs, drivers: [], bracket: 'ok', conf: 'none', source,
      landRateSource: landSource, sqftRateSource }
  }

  // ── Condition adjustment (rule 11) — the URAR Condition line item. A
  // median-tier set is lifted to the as-repaired value: the pocket's own
  // renovated-vs-median gap when it can be measured, else the contributory
  // share of rehab cost. ──────────────────────────────────────────────────
  let conditionAdj: number | null = null
  if (medianTier) {
    let condAdj = 0
    let condSrc: string | null = null
    const pocketUpper = upperEligible.filter((x) => inTract(x.comp))
    if (pocketUpper.length >= 2) {
      const gap = mid(pocketUpper.map((x) => x.contrib)) - mid(drivers.map((x) => x.contrib))
      if (gap > 0) {
        const frac = B_REHAB_FRACTION[subject.condition ?? ''] ?? 0.5
        condAdj = gap * frac
        condSrc = `T1 market gap ${usd(gap)} × ${frac.toFixed(2)} (${subject.condition})`
      }
    }
    if (!condSrc && opts?.rehabCost) {
      condAdj = opts.rehabCost * B_REHAB_UPLIFT
      condSrc = `T2 contributory — ${usd(opts.rehabCost)} rehab cost × ${(B_REHAB_UPLIFT * 100).toFixed(0)}%`
    }
    if (condAdj >= 1000) {
      conditionAdj = condAdj
      flags.push(`condition adj +${usd(condAdj)} [${condSrc}] — median-priced sales → as-repaired value`)
    } else {
      flags.push('condition uplift unverified — ARV at the median-tier reconciliation')
    }
  }
  const valueOf = (x: BContribution) => x.contrib + (conditionAdj ?? 0)

  // ── Weighted reconciliation (rule 6) — rank-sum weights: the best comp
  // (closest tier, verified condition, least adjustment) carries the most,
  // each next comp one step less. Never a single-comp anchor when three
  // sales exist; a thin set is flagged so the pipeline widens the search. ─
  const rankTotal = (drivers.length * (drivers.length + 1)) / 2
  drivers.forEach((x, i) => {
    x.weight = (drivers.length - i) / rankTotal
    x.role = i === 0 ? 'primary' : 'support'
  })
  const primary = drivers[0]
  let arv = drivers.reduce((sum, x) => sum + x.weight * valueOf(x), 0)
  const thin = drivers.length < B_MIN_RECONCILED
  if (primary.comp.sameBlockGroup === true && verifiedUpper(primary))
    flags.push(`${primary.comp.address}: same-block renovated comp — the pocket's going ARV rate`)
  flags.push(`reconciled ${drivers.length} sale(s): ` + drivers
    .map((x) => `${x.comp.address} ${(x.weight * 100).toFixed(0)}% @ ${usd(valueOf(x))}`).join(' · '))
  if (drivers.length > 1) {
    const vals = drivers.map(valueOf)
    flags.push(`supporting range ${usd(Math.min(...vals))}–${usd(Math.max(...vals))}`)
  }
  if (thin)
    flags.push(`thin evidence — ${drivers.length} verified sale(s), minimum ${B_MIN_RECONCILED} not met; widen the search`)

  // ── Outlier ceiling — top verified contribution in subject units ────────
  // Similarity-gated: a far-out comp can't stretch the ceiling into price
  // territory its own evidence doesn't cover — the bound must come from
  // comps that actually resemble the subject (same gate as the median-only
  // path: within 60% of the pool's best similarity).
  const margRate = (c: BComp): number => {
    if (sqftRate != null) return sqftRate
    const gap = Math.abs(subSqft! - c.squareFeet!) / c.squareFeet!
    return (bPpsfOf(c) ?? 0) * (gap <= 0.10 ? 0.50 : gap <= 0.25 ? 0.40 : 0.30)
  }
  const topSimPool = verifiedPool.length ? Math.max(...verifiedPool.map(similarity)) : 0
  const gatedVerified = verifiedPool.filter((x) => similarity(x) >= 0.6 * topSimPool)
  const ceilingPoolC = gatedVerified.length ? gatedVerified : verifiedPool
  const rawCeiling = Math.max(...ceilingPoolC.map((x) =>
    x.comp.salePrice! + Math.max(0, subSqft! - x.comp.squareFeet!) * margRate(x.comp)))
  const topContrib = Math.max(...ceilingPoolC.map((x) => x.contrib))
  const ceiling = Math.min(rawCeiling, topContrib)
  const supporters = drivers.filter((x) => valueOf(x) >= ceiling).length
  // A condition-lifted answer never clears the pocket's top verified sale
  // (rule 11), whatever its support.
  const cappedOutlier = arv > ceiling && (supporters < B_OUTLIER_SUPPORT || conditionAdj != null)
  if (cappedOutlier) {
    flags.push(`ARV ${usd(arv)} exceeds size-adjusted ceiling ${usd(ceiling)} with ${supporters} supporter(s) — capped`)
    arv = ceiling
  }

  // ── Bracketing ───────────────────────────────────────────────────────────
  let bracket: BResult['bracket'] = 'ok'
  const sizes = drivers.map((x) => x.comp.squareFeet!)
  if (subSqft && sizes.every((s) => s < subSqft)) bracket = 'all-smaller'
  if (subSqft && sizes.every((s) => s > subSqft)) bracket = 'all-bigger'
  if (bracket !== 'ok') flags.push(`bracketing: driver set is ${bracket} — no size bracket`)

  const conf: BResult['conf'] =
    bracket !== 'ok' || cappedOutlier ? 'low'
    : thin ? 'low'
    : drivers.length >= 3 && !flags.length ? 'high'
    : drivers.length >= 3 ? 'medium' : 'low'

  // HBU check — 'land_play' needs proof the dirt IS the deal, not just a
  // valuable lot. Three legitimate triggers:
  //   1. county split says the improvement is a rounding error (<25%)
  //   2. dirt-dominance: extracted land outruns the improved read by 1.5×+
  //      (a 1.0× read on a big maintained lot is context, not a teardown)
  //   3. teardown-grade condition + land over the read
  // Extraction evidence always serializes — only the verdict is gated.
  if (land.mode == null && land.subjectLandValue != null) {
    const dominates = arv > 0 && land.subjectLandValue > arv * 1.5
    const teardownRead = /gut|teardown/i.test(subject.condition ?? '') &&
      land.subjectLandValue > arv
    if (dominates || teardownRead) {
      land.mode = 'land_play'
      flags.push(`land play — extracted land ${usd(land.subjectLandValue)} outruns the improved read ${usd(arv)}; the dirt is the deal`)
    } else {
      flags.push(`land context — extracted dirt ${usd(land.subjectLandValue)} (valuable lot, not a teardown signal)`)
    }
  }

  return {
    arv: Math.round(arv), flags, drivers, contribs, bracket, conf, source,
    landRateSource: landSource, sqftRateSource,
    landRate, sqftRate, bandLo, bandHi,
    anchorAddress: primary.comp.address ?? null, ceiling, conditionAdj, healed: false,
    thin, land,
  }
}
