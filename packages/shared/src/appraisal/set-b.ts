/**
 * Set-B evaluation — the trade-tricks methodology ported from the
 * calibration harness (scripts/ab-eval.py). Pure function over the same
 * enabled comp pool the legacy appraisal consumes.
 *
 * HARNESS_VERSION bumps on every rule change — it's stamped on every
 * saved run so a result is provably attributable to the code that made
 * it (an old answer can never pass as a new one).
 *
 * Semantics (calibrated against 27 live addresses):
 *   - evidence verification: stale/divergent sales never drive ARV
 *   - tier discipline: renovated preferred (sim ≥ 3) → median fallback
 *     → weak → retail-band — as-is/distressed are floor evidence only
 *   - contributions: marginal sqft (pool slope / 0.5–0.3 taper) + land
 *     (vacant-median → assessed-curve → per-parcel ×0.35, capped ±20%)
 *   - anchoring: most-similar verified comp sets ARV; the driver set
 *     bounds the range — it never blends
 *   - self-heal: an anchor that is the floor of its own driver set
 *     re-anchors to the median-contribution driver
 *   - condition adj: the URAR Condition line item — tier spread when
 *     measurable, contributory (rehab × 80%) when not
 *   - outlier ceiling: top verified contribution in subject units;
 *     exceeding it needs ≥2 supporters
 *   - cascade: T0 anchor → T1 rescue → T2 pocket → T3 AVM → T4 assessed
 *     → T5 report-only
 *
 * Tricks of the trade — every rule below was earned by a live case in
 * the A/B run (27 addresses, B=26 / A=2; decision 2026-10-03, this port
 * at 5953349, retry loop at c0f7bcc). When a change moves one of these,
 * it should be deliberate — the case named is the reason the rule exists.
 * Full record: docs/B-HARNESS-PLUS-TRICKS-OF-THE-TRADE.md
 * Proofs:       apps/api/tests/set-b-tricks.test.ts
 *
 *   1. marginal sqft rate        — 18810 Geraci Rd: flat $/sf invented $104k
 *   2. marginal land ladder      — Ruskin / Emerald Ln lot pricing
 *   3. >25% adj cap → half weight — appraiser norm is ~10–15% net
 *   4. stale/divergent never drive — Eagle Run, Toledo, Lenwood, Oak Crest
 *   5. tier discipline            — Tampa: as-is pools can't price ARV
 *   6. anchor, don't blend        — Cayuga: blending ran +31% over evidence
 *   7. similarity gate 60%        — Marie St / 109th Ave weak-driver drag
 *   8. self-heal floor anchor     — Indianapolis
 *   9. URAR condition line        — Carlton Dr / Banjo reno premium
 *  10. outlier ceiling, 2 votes  — Geraci / Woodcrest / Longwood
 *  11. verify-and-retry ladder    — widen → deepen → labeled floor
 */

// ── Constants (calibrated — see scoreboard.md) ────────────────────────────
export const B_ADJ_CAP_PCT = 0.25      // trick 3
export const B_OUTLIER_SUPPORT = 2     // trick 10
export const B_LAND_FACTOR = 0.35      // trick 2, T3 per-parcel
export const B_LAND_CAP_PCT = 0.20     // trick 2, cap
export const B_RETAIL_BAND = 0.70      // trick 5, unlabeled fallback
export const B_SIM_GATE = 0.60         // trick 7
export const B_MIN_SIM = 3.0           // trick 7, driver floor
export const B_COND_MIN_CONF = 30      // trick 5, Clef confidence floor
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
  neighborhoodName?: string | null
  landAssessedValue?: number | null
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
  neighborhoodName?: string | null
  yearBuilt?: number | null
  lotSizeAcres?: number | null
  lotSizeSquareFeet?: number | null
  landAssessedValue?: number | null
  propertyType?: string | null
  crossesMajorRoad?: boolean | null
  disableReasons?: string[] | null
  /** A recorded buy → resale 30–365 days apart. The resale is the proof of
   *  the renovation, so an own-AVM divergence does not bar it from driving. */
  verifiedFlip?: boolean | null
  classification?: { type?: string | null } | null
  curbAppeal?: {
    condition?: string | null
    confidence?: number | null
    summary?: string | null
  } | null
  /** Clef advisory digests per pipeline stage (A=post-pull, B=post-geocode,
   *  C=post-enrichment). Agent-assist only — never feeds a B verdict. */
  clefDigest?: { A?: unknown; B?: unknown; C?: unknown } | null
  evidenceVerification?: {
    /** Age only — stale means outside the preferred sale-age window. */
    staleness?: string | null
    saleAgeDays?: number | null
    preferredSaleAgeDays?: number | null
    /** Price fit against the comp's current pocket — separate from age. */
    marketFit?: string | null
    transactionCheck?: string | null
    priceCheck?: string | null
    flags?: string[] | null
  } | null
  appraisalRules?: { totalAdjustment?: number | null } | null
}

export interface BContribution {
  comp: BComp
  contrib: number
  weight: number
  tier: 'arv' | 'as_is' | 'unidentified'
  /** URAR ceiling: needs >25% total adjustment — bound, not a driver. */
  boundOnly?: boolean
}

export interface BDecision {
  compAddress?: string | null
  stage: string
  rule: string
  verdict: string
  value?: number | string | null
  note?: string
}

export interface BResult {
  arv: number | null
  flags: string[]
  decisions?: BDecision[]
  drivers: BContribution[]
  contribs: BContribution[]
  bracket: 'ok' | 'all-smaller' | 'all-bigger'
  conf: 'high' | 'medium' | 'low' | 'none'
  source: string
  landRateSource?: string | null
  sqftRateSource?: string | null
  anchorAddress?: string | null
  ceiling?: number | null
  conditionAdj?: number | null
  healed?: boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`

export const HARNESS_VERSION = 'og-2026.10.05.6'

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
  const summary = (ca.summary ?? '').toLowerCase()
  const cond = (ca.condition ?? '').toLowerCase()
  // Structured vision condition wins; legacy tier:* text is fallback only.
  // A weak confidence score cannot be rescued by old summary text.
  if (['distressed', 'needs_work'].includes(cond)) return 'distressed'
  if (ca.condition != null && (ca.confidence ?? 0) < B_COND_MIN_CONF) return 'unknown'
  if (['renovated', 'updated', 'turnkey', 'move-in ready'].includes(cond)) return 'renovated'
  if (['dated', 'maintained', 'median', 'as_is', 'as-is'].includes(cond)) return 'median'
  if (['premium', 'luxury'].includes(cond)) return 'premium'
  if (summary.includes('tier:premium') || summary.includes('tier:luxury')) return 'premium'
  if (summary.includes('tier:median')) return 'median'
  return 'unknown'
}

/** A premium-priced comp stays fit when the class chain explains the
 *  premium — verified-renovated, vision-premium, or a resale event. An
 *  above-pocket comp that CAN'T explain its price is an outlier. */
const bExplainsPremium = (c: BComp) =>
  bTierOf(c) === 'arv' ||
  bCondTier(c) === 'premium' ||
  bCondTier(c) === 'renovated'

const bIsUnfit = (c: BComp) => {
  const evidence = c.evidenceVerification
  const staleByAge = evidence?.staleness === 'stale' && evidence.saleAgeDays != null
  const marketFit = evidence?.marketFit ??
    // Legacy records used staleness for pocket-price fit. Preserve their
    // exclusion while keeping the labels separate going forward.
    (evidence?.staleness === 'above_pocket' ? 'above_pocket'
      : evidence?.staleness === 'stale' ? 'below_pocket'
        : null)
  return staleByAge ||
    evidence?.transactionCheck === 'package_deed' ||
    evidence?.transactionCheck === 'nominal_sale' ||
    evidence?.transactionCheck === 'bulk_sale' ||
    evidence?.transactionCheck === 'extreme_outlier' ||
    marketFit === 'below_pocket' ||
    (marketFit === 'above_pocket' && !bExplainsPremium(c)) ||
    // A verified flip is exempt from the own-AVM divergence screen: the
    // AVM lags a renovation, and the buy → resale pair is stronger proof.
    (evidence?.priceCheck === 'divergent' && c.verifiedFlip !== true)
}

// ── Condition class — one resolved label per comp ─────────────────────────
// The curve: renovated → maintained → dated → distressed → unclassified.
// The Clef curb read (vision on listing photos + description) is the ONLY
// condition vote — comps are never classified by sale-type label or guess.
// Unclassified comps get slotted into bands by price at band time.
export function bConditionClass(c: BComp): 'renovated' | 'maintained' | 'dated' | 'distressed' | 'unclassified' {
  const cond = (c.curbAppeal?.condition ?? '').toLowerCase()
  const conf = c.curbAppeal?.confidence ?? 0
  if (conf >= B_COND_MIN_CONF && cond) {
    if (['renovated', 'updated', 'turnkey', 'move-in ready'].includes(cond)) return 'renovated'
    if (['as_is', 'as-is', 'distressed', 'needs_work', 'teardown'].includes(cond)) return 'distressed'
    // Owner curve: maintained is the middle band; dated tops the
    // dated/distressed bottom band.
    if (['maintained', 'median'].includes(cond)) return 'maintained'
    if (['dated', 'original', 'needs_updates'].includes(cond)) return 'dated'
    return 'maintained'
  }
  return 'unclassified'
}

const bLotSf = (x: { lotSizeSquareFeet?: number | null; lotSizeAcres?: number | null }) =>
  x.lotSizeSquareFeet ?? (x.lotSizeAcres ? x.lotSizeAcres * 43560 : null)

const bPpsfOf = (c: BComp) =>
  c.pricePerSqft ?? (c.salePrice && c.squareFeet ? c.salePrice / c.squareFeet : null)

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
  opts?: { rehabCost?: number | null },
): BResult {
  const subSqft = subject.squareFeet
  const flags: string[] = []
  const decisions: BDecision[] = []
  const dec = (d: BDecision) => { decisions.push(d) }
  const fin = (r: BResult): BResult => ({ ...r, decisions })
  const empty = (source: string): BResult => ({
    arv: null, flags, drivers: [], contribs: [], bracket: 'ok', conf: 'none', source,
  })

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

  // Pool: enabled comps with sale + size evidence
  let pool = items.filter((c) => c.isEnabled && c.salePrice && c.squareFeet)
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

  // T1b — near-miss rescue + market-conditions adjustment. Same-pocket
  // comps (same tract/BG, no road) killed ONLY on sale-age or label
  // mismatches come back — with their price time-adjusted to the pocket's
  // own measured trend, the way an appraiser does it. Sales ≤365d
  // eligible; the trend is the OLS $/sf-per-month slope over cleaned
  // same-tract sales; unmeasurable trend → −10% stale haircut past 180d.
  {
    const SOFT_KILL = /sale age|sale too old|geo scope|subdivision|neighborhood/i
    const refMs = Math.max(...items.map((c) => Date.parse(c.saleDate ?? '') || 0)) || Date.now()
    const daysOld = (d?: string | null) => d ? (refMs - Date.parse(d)) / 864e5 : null
    const trendPts = items
      .filter((c) => c.salePrice && c.squareFeet && c.saleDate &&
        c.censusTract && c.censusTract === subject.censusTract &&
        bTierOf(c) !== 'as_is' && !bIsUnfit(c))
      .map((c) => ({ x: daysOld(c.saleDate)! / 30.44, y: bPpsfOf(c)! }))
      .sort((a, b) => a.x - b.x)
    let trendPerMo: number | null = null
    if (trendPts.length >= 5 && trendPts[trendPts.length - 1].x - trendPts[0].x >= 3) {
      const slope = olsSlope(trendPts)
      const med = trendPts[Math.floor(trendPts.length / 2)].y
      if (slope != null && med > 0) trendPerMo = -slope / med // +/− % per month of sale age
    }
    if (trendPerMo != null) flags.push(`pocket trend: ${trendPerMo >= 0 ? '+' : '−'}${Math.abs(trendPerMo * 100).toFixed(1)}%/mo over ${trendPts.length} tract sale(s)`)

    const rescued = items.filter((c) => {
      if (pool.includes(c)) return false
      const reasons = c.disableReasons ?? []
      if (!reasons.length || !reasons.every((r) => SOFT_KILL.test(r))) return false
      if (!c.salePrice || !c.squareFeet || !c.saleDate) return false
      if (c.crossesMajorRoad) return false
      const samePocket = c.sameBlockGroup === true ||
        (!!subject.censusTract && c.censusTract === subject.censusTract)
      if (!samePocket) return false
      const age = daysOld(c.saleDate)!
      if (age > 365) return false
      return true
    })
    for (const c of rescued) {
      const ageMo = daysOld(c.saleDate)! / 30.44
      let factor = 1
      if (trendPerMo != null) factor = Math.max(0.9, Math.min(1.1, 1 + trendPerMo * ageMo))
      else if (ageMo > 6) factor = 0.9
      c.adjustedPrice = Math.round(c.salePrice! * factor)
      flags.push(`${c.address}: rescued — ${(c.disableReasons ?? []).join('; ').slice(0, 60)}; time-adj ${factor >= 1 ? '+' : '−'}${Math.abs((1 - factor) * 100).toFixed(0)}%`)
      dec({ compAddress: c.address, stage: 'rescue', rule: 'T1b soft-kill', verdict: 'rescued',
        value: Math.round((factor - 1) * 1000) / 10, note: `time-adj ${(factor * 100 - 100).toFixed(0)}%` })
    }
    if (rescued.length) pool = [...pool, ...rescued]
  }

  // T2 — pocket tiers. The neighborhood's own sales classify themselves:
  // pool same-scope sales (tract first, then block group, then
  // neighborhood name), clean them — as-is/bounded-low and stale or
  // divergent sales out, $/sf IQR outliers out — then split the survivors
  // into three bands by price position: top = ARV evidence, middle =
  // market median (sanity-checks the AVM), bottom = investor/as-is
  // average. The ARV band carries the answer at subject size; the bands
  // stay visible in the flag trail.
  if (!pool.length) {
    const normName = (v?: string | null) => v?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? null
    const pocketFor = (keep: (c: BComp) => boolean) =>
      items.filter((c) =>
        keep(c) && c.salePrice && c.squareFeet && !bIsUnfit(c))
    const scopes: { label: string; pool: BComp[] }[] = [
      { label: 'tract', pool: pocketFor((c) => !!subject.censusTract && c.censusTract === subject.censusTract) },
      { label: 'block group', pool: pocketFor((c) => c.sameBlockGroup === true) },
      { label: 'neighborhood', pool: pocketFor((c) =>
        !!normName(c.subdivision) && normName(c.subdivision) === normName(subject.subdivision)
        || !!normName(c.neighborhoodName) && normName(c.neighborhoodName) === normName(subject.neighborhoodName)) },
    ]
    for (const { label, pool: pocket } of scopes) {
      const ps = pocket.map((c) => ({ c, ppsf: bPpsfOf(c)! }))
        .filter((x) => x.ppsf > 0).sort((a, b) => a.ppsf - b.ppsf)
      if (ps.length < 3) continue
      const q1 = ps[Math.floor(ps.length * 0.25)].ppsf
      const q3 = ps[Math.floor(ps.length * 0.75)].ppsf
      const iqr = q3 - q1
      const clean = iqr > 0 ? ps.filter((x) => x.ppsf >= q1 - 1.5 * iqr && x.ppsf <= q3 + 1.5 * iqr) : ps
      if (clean.length < 3) continue
      const dropped = ps.length - clean.length
      const med = (xs: typeof clean) => xs[Math.floor(xs.length / 2)].ppsf
      // Condition bands — the curve: renovated → maintained → dated/
      // distressed. One member still makes a band. Curb read is the
      // ONLY condition vote; comps with no read slot into the band
      // nearest their $/sf — filled by price, never guessed.
      const inBand = (band: 'renovated' | 'maintained' | 'dated' | 'distressed') =>
        clean.filter((x) => bConditionClass(x.c) === band)
      const distressed = [...inBand('dated'), ...inBand('distressed')]
        .sort((a, b) => a.ppsf - b.ppsf)
      const maintained = inBand('maintained')
      const renovated = inBand('renovated')
      const unclassified = clean.filter((x) => bConditionClass(x.c) === 'unclassified')
      // Price-fill only works when the pocket has at least one labeled
      // comp to anchor a band; a fully unlabeled pocket keeps its own
      // median rather than collapsing into one band. Slot by band edges:
      // priced at/above the renovated zone → renovated; inside or above
      // maintained → maintained; below everything → distressed.
      const anyLabeled = distressed.length + maintained.length + renovated.length > 0
      if (anyLabeled) for (const x of unclassified) {
        const renovatedMin = renovated.length ? Math.min(...renovated.map((y) => y.ppsf)) : Infinity
        const maintainedMin = maintained.length ? Math.min(...maintained.map((y) => y.ppsf)) : Infinity
        const distressedMax = distressed.length ? Math.max(...distressed.map((y) => y.ppsf)) : -Infinity
        const target =
          x.ppsf >= renovatedMin ? renovated
          : x.ppsf >= maintainedMin ? maintained
          : x.ppsf <= distressedMax ? distressed
          : x.ppsf < maintainedMin ? distressed
          : maintained
        target.push(x)
        target.sort((a, b) => a.ppsf - b.ppsf)
      }
      // Tight bands — a band that's wide isn't a band. Members priced
      // >10% off their band's median get evicted to the band their price
      // actually fits; the core group is what prices the answer.
      for (const band of [distressed, maintained, renovated]) {
        if (band.length < 2) continue
        const bMed = med(band)
        const evicted = band.filter((x) => Math.abs(x.ppsf / bMed - 1) > 0.10)
        for (const x of evicted) {
          band.splice(band.indexOf(x), 1)
          const dst = x.ppsf >= (renovated.length ? Math.min(...renovated.map((y) => y.ppsf)) : Infinity) ? renovated
            : x.ppsf >= (maintained.length ? Math.min(...maintained.map((y) => y.ppsf)) : Infinity) ? maintained
            : distressed
          dst.push(x)
          dst.sort((a, b) => a.ppsf - b.ppsf)
          flags.push(`${x.c.address}: evicted — $${x.ppsf.toFixed(0)}/sf vs band median $${bMed.toFixed(0)}/sf (>10%)`)
          dec({ compAddress: x.c.address, stage: 'band', rule: 'tight-band', verdict: 'evicted',
            value: x.ppsf, note: `vs band median $${bMed.toFixed(0)}/sf` })
        }
      }
      // band member's implied subject price is its sale plus the size
      // delta at a tapered rate, never flat $/sf.
      const implied = (x: { c: BComp; ppsf: number }) => {
        let v = x.c.salePrice!
        if (subSqft && x.c.squareFeet) {
          const gap = Math.abs(subSqft - x.c.squareFeet) / x.c.squareFeet
          const mf = gap <= 0.10 ? 0.50 : gap <= 0.25 ? 0.40 : 0.30
          v += (subSqft - x.c.squareFeet) * x.ppsf * mf
        }
        // Land — same ladder + ±20% cap as the driver path. A pocket
        // member on half the subject's acreage isn't the same value.
        const cLot = bLotSf(x.c)
        let landAdj = 0
        if (landRate != null && cLot && slLot) {
          landAdj = landRate * (slLot - cLot)
          if (landSource?.startsWith('T2')) landAdj *= mktRatio
        } else if (subLand && x.c.landAssessedValue) {
          landAdj = (subLand - x.c.landAssessedValue) * mktRatio * B_LAND_FACTOR
        }
        if (Math.abs(landAdj) >= 1000) {
          landAdj = Math.max(-B_LAND_CAP_PCT * x.c.salePrice!, Math.min(B_LAND_CAP_PCT * x.c.salePrice!, landAdj))
        }
        return v + landAdj
      }
      if (!subSqft) break
      // Carrier cascade — renovated band is the ARV set; a pocket with
      // no renovated evidence prices at maintained (that's what the
      // pocket IS, not a penalty); a dated/distressed pocket falls to
      // its best-rated sale — the nicest curb read it has.
      const curbScore = (x: typeof clean[number]) =>
        Number((x.c.curbAppeal?.summary ?? '').match(/\((\d\.?\d?)\/4\)/)?.[1] ?? 0)
      const carriers = renovated.length ? renovated
        : maintained.length ? maintained
        : distressed.length ? distressed.sort((a, b) => curbScore(b) - curbScore(a)).slice(0, Math.max(1, Math.ceil(distressed.length / 3)))
        : clean // pocket with zero labeled comps — its own median carries
      const bandNote = ' — ' + [
        distressed.length ? `distressed $${med(distressed).toFixed(0)}/sf` : null,
        maintained.length ? `maintained $${med(maintained).toFixed(0)}/sf` : null,
        renovated.length ? `renovated $${med(renovated).toFixed(0)}/sf` : null,
      ].filter(Boolean).join(' · ')
      const arvImplied = carriers.map((x) => implied(x)).sort((a, b) => a - b)
      let arv = arvImplied[Math.floor(arvImplied.length / 2)]
      // ARV cannot sit below the maintained band — maintained homes
      // selling above the answer means the band was read wrong. The
      // floor is the band's median implied, not its top member.
      const maintainedMed = maintained.length
        ? bMedian(maintained.map((x) => implied(x))) : null
      if (renovated.length > 0 && maintainedMed != null && arv < maintainedMed) {
        flags.push(`ARV ${usd(arv)} below maintained band — floored at maintained median ${usd(maintainedMed)}`)
        dec({ stage: 'answer', rule: 'maintained-floor', verdict: 'floored', value: maintainedMed,
          note: `from ${usd(arv)}` })
        arv = maintainedMed
      }
      flags.push(
        `T2 pocket-tiers [${label}] — ${clean.length} cleaned sale(s)` +
        (dropped ? ` (${dropped} outlier/bounded-low dropped)` : '') + bandNote)
      return fin({
        arv: Math.round(arv), contribs: [], bracket: 'ok', conf: 'low',
        source: `T2 pocket-tiers [${label}]`,
        drivers: carriers.map((x) => ({
          comp: x.c, contrib: Math.round(implied(x)), weight: 0, tier: 'arv' as const,
        })),
        flags,
      })
    }
  }

  // T3 / T4 / T5 — AVM floor → assessed → report-only
  if (!pool.length) {
    const avm = bSubjectAvm(subject)
    if (avm) {
      return fin({ arv: Math.round(avm), contribs: [], drivers: [], bracket: 'ok', conf: 'low',
        source: 'T3 AVM floor', flags: ['T3 as-is AVM floor — ARV ≥ AVM, uplift unverified'] })
    }
    const assessed = subject.assessedValue ?? subject.taxAssessment ?? null
    if (assessed) {
      return fin({ arv: Math.round(assessed), contribs: [], drivers: [], bracket: 'ok', conf: 'none',
        source: 'T4 assessed', flags: ['T4 assessed fallback — county estimate'] })
    }
    return fin({ ...empty('T5 report-only'), flags: ['T5 report-only — no comp evidence, no anchor'] })
  }

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
    const base = c.adjustedPrice ?? c.salePrice!
    let contrib: number
    if (sqftRate != null) {
      contrib = base + (subSqft! - compSqft) * sqftRate
    } else {
      const gap = Math.abs(subSqft! - compSqft) / compSqft
      const mf = gap <= 0.10 ? 0.50 : gap <= 0.25 ? 0.40 : 0.30
      contrib = base + (subSqft! - compSqft) * ppsf * mf
    }

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

    // URAR ceiling — a comp needing >25% total adjustment isn't a comp.
    // Measured on whichever engine asks the most of it: the grid's own
    // totalAdjustment, or our marginal reprice (size + land) vs its sale.
    // Over the line it becomes a bound — it can't drive or anchor.
    const marginalPct = Math.abs(contrib - base) / c.salePrice!
    const adjPct = Math.max(
      Math.abs(c.appraisalRules?.totalAdjustment ?? 0) / c.salePrice!,
      marginalPct,
    )
    const boundOnly = adjPct > B_ADJ_CAP_PCT
    if (boundOnly) flags.push(`${c.address}: needs ±${(adjPct * 100).toFixed(0)}% adjustment — bound, not a driver`)
    if (boundOnly) dec({ compAddress: c.address, stage: 'contrib', rule: 'urar-cap-25', verdict: 'bound',
      value: Math.round(adjPct * 1000) / 10, note: 'total adjustment >25%' })
    const weight = (1 / (1 + adjPct)) * (boundOnly ? 0.5 : 1)
    contribs.push({ comp: c, contrib, weight, tier: bTierOf(c), boundOnly })
  }

  // ── Evidence verification — stale/divergent never drive ARV ─────────────
  const unfit = contribs.filter((x) => bIsUnfit(x.comp))
  for (const x of unfit) {
    flags.push(`${x.comp.address}: verification — ${(x.comp.evidenceVerification?.flags ?? []).join('; ').slice(0, 90)}`)
    dec({ compAddress: x.comp.address, stage: 'pool', rule: 'verification', verdict: 'dropped',
      note: (x.comp.evidenceVerification?.flags ?? []).join('; ').slice(0, 90) })
  }
  const verifiedPool = contribs.filter((x) => !unfit.includes(x))
  // Flips allowed through despite an own-AVM divergence stay visible — the
  // gap is worth watching even though it does not bar the comp.
  for (const x of verifiedPool) {
    if (x.comp.verifiedFlip === true && x.comp.evidenceVerification?.priceCheck === 'divergent') {
      flags.push(`${x.comp.address}: verified flip kept despite own-AVM divergence — watch the gap`)
    }
  }

  // ── Similarity scoring ──────────────────────────────────────────────────
  const similarity = (x: BContribution): number => {
    const c = x.comp
    let s = 0
    const d = c.distanceMiles
    if (d != null) s += Math.max(0, 1 - d) * 3.0
    if (subject.censusTract && c.censusTract === subject.censusTract) s += 3.0
    if (c.sameBlockGroup) s += 2.0
    if (c.subdivision && c.subdivision === subject.subdivision) s += 1.5
    else if (c.neighborhoodName && subject.neighborhoodName
        && c.neighborhoodName === subject.neighborhoodName) s += 1.0
    const yd = c.yearBuilt && subject.yearBuilt ? Math.abs(c.yearBuilt - subject.yearBuilt) : null
    if (yd != null) s += yd <= 10 ? 1.5 : yd <= 20 ? 0.75 : 0
    const sd = c.squareFeet && subject.squareFeet ? Math.abs(c.squareFeet - subject.squareFeet) : null
    if (sd != null) s += sd <= 150 ? 1.5 : sd <= 300 ? 0.75 : 0
    return s
  }

  // ── Tier discipline — renovated preferred → median fallback → retail ────
  // Over-adjusted comps are bounds, not drivers — they sit in verifiedPool
  // (and the ceiling) but can never anchor or support.
  const driverPool = verifiedPool.filter((x) => !x.boundOnly)
  const medianComps = driverPool.filter((x) => bCondTier(x.comp) === 'median')
  const preferred = driverPool.filter((x) =>
    x.tier === 'arv' && !['median', 'distressed'].includes(bCondTier(x.comp)) && similarity(x) >= B_MIN_SIM)
  let drivers: BContribution[]
  if (preferred.length) {
    drivers = preferred
  } else if (medianComps.length) {
    drivers = medianComps
    for (const x of medianComps) {
      flags.push(`${x.comp.address}: median-tier driver — no high-similarity renovated evidence`)
      dec({ compAddress: x.comp.address, stage: 'class', rule: 'tier-discipline', verdict: 'median-driver' })
    }
  } else {
    const weak = driverPool.filter((x) => x.tier === 'arv' && !['median', 'distressed'].includes(bCondTier(x.comp)))
    if (weak.length) {
      flags.push(`non-median comps below similarity floor (${B_MIN_SIM}) — falling to median`)
      drivers = medianComps.length ? medianComps : weak
    } else {
      const topPpsf = driverPool.length
        ? Math.max(...driverPool.map((x) => bPpsfOf(x.comp) ?? 0))
        : null
      const retail = driverPool.filter((x) =>
        x.tier !== 'as_is' && !['median', 'distressed'].includes(bCondTier(x.comp)) &&
        topPpsf != null && (bPpsfOf(x.comp) ?? 0) >= B_RETAIL_BAND * topPpsf)
      if (!retail.length) {
        // Median-only evidence — the band IS the answer. No AVM uplift:
        // the pocket's own maintained sales are the evidence; the AVM
        // is an algorithm we don't control and carries no weight.
        if (medianComps.length) {
          const topSim = Math.max(...medianComps.map(similarity))
          const gatedMedian = medianComps.filter((x) => similarity(x) >= 0.6 * topSim)
          const medianCeiling = Math.max(...gatedMedian.map((x) => x.contrib))
          flags.push(`median-tier evidence only — ARV at median ceiling ${usd(medianCeiling)}`)
          return fin({ arv: Math.round(medianCeiling), flags, contribs, drivers: medianComps,
            bracket: 'ok', conf: 'low', source: 'median ceiling', landRateSource: landSource, sqftRateSource })
        }
        flags.push('no retail-priced evidence — ARV withheld (as-is sales are floor evidence only)')
        return fin({ arv: null, flags, contribs, drivers: [], bracket: 'ok', conf: 'none', source,
          landRateSource: landSource, sqftRateSource })
      }
      drivers = retail
      flags.push(`no ARV-tier labels — ARV driven on ${drivers.length} retail-marked comp(s); ${contribs.length - retail.length} as-is-priced sale(s) excluded from ARV`)
    }
  }

  // ── Geo hierarchy — tract, then block group, then neighborhood ──────────
  // Owner decision (findings log): every class pick looks for same-tract
  // drivers first, then same-block-group, then same neighborhood name —
  // renovated anchors, medians, and as-is alike. A comp outside all three
  // drives only when nothing closer exists. Names are normalized —
  // spelling variants ("ES SPINK PROP" vs "WHITLEY HEIGHTS") don't split
  // a pocket.
  const geoNorm = (v?: string | null) => v?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? null
  const geoTier = (c: BComp): 0 | 1 | 2 | 3 => {
    // Tract/BG membership requires no major-road crossing — a comp across
    // the road may be in the census polygon but it isn't the same pocket.
    // It can still fall back to a neighborhood-name match below.
    const near = !c.crossesMajorRoad
    if (near && subject.censusTract && c.censusTract && c.censusTract === subject.censusTract) return 0
    if (near && c.sameBlockGroup === true) return 1
    if (geoNorm(c.subdivision) && geoNorm(c.subdivision) === geoNorm(subject.subdivision)) return 2
    if (geoNorm(c.neighborhoodName) && geoNorm(c.neighborhoodName) === geoNorm(subject.neighborhoodName)) return 2
    return 3
  }
  const GEO_LABEL = ['tract', 'block group', 'neighborhood'] as const
  const tightestGeo = (xs: BContribution[]): BContribution[] => {
    if (!xs.length) return xs
    const best = Math.min(...xs.map((x) => geoTier(x.comp))) as 0 | 1 | 2 | 3
    if (best === 3) return xs
    return xs.filter((x) => geoTier(x.comp) === best)
  }
  const geoKept = tightestGeo(drivers)
  const geoTierName = GEO_LABEL[Math.min(...drivers.map((x) => geoTier(x.comp))) as 0 | 1 | 2]
  if (geoKept.length !== drivers.length) {
    for (const x of drivers.filter((x) => !geoKept.includes(x))) {
      flags.push(`${x.comp.address}: dropped from drivers — outside the ${geoTierName} scope`)
      dec({ compAddress: x.comp.address, stage: 'geo', rule: 'geo-tier', verdict: 'dropped',
        note: `outside ${geoTierName}` })
    }
    drivers = geoKept
  }

  // ── Reconciliation anchoring — most-similar comp drives, rest bounds ────
  const ranked = drivers.slice().sort((a, b) =>
    similarity(b) - similarity(a) || b.weight - a.weight)
  let anchor = ranked[0] ?? null
  if (!anchor) return fin({ arv: null, flags, contribs, drivers: [], bracket: 'ok', conf: 'none', source,
    landRateSource: landSource, sqftRateSource })
  let anchorScore = similarity(anchor)

  // Similarity gate — drop drivers below 60% of the anchor's score
  if (drivers.length > 1) {
    const gated = drivers.filter((x) => similarity(x) >= B_SIM_GATE * anchorScore)
    for (const x of drivers.filter((x) => !gated.includes(x))) {
      flags.push(`${x.comp.address}: dropped from drivers — similarity ${similarity(x).toFixed(1)} below gate (${(B_SIM_GATE * anchorScore).toFixed(1)})`)
      dec({ compAddress: x.comp.address, stage: 'gate', rule: 'similarity-60', verdict: 'dropped',
        value: Number(similarity(x).toFixed(2)) })
    }
    if (gated.length) drivers = gated
  }

  // ── Band microscope — >30% above the pocket's own band is an outlier ────
  // The appraiser move: a comp pricing that far past the band gets
  // scrutinized, not trusted. The band outranks a deviating driver —
  // the comp is probably a different product, so it's set aside as a
  // bound and the next-strongest evidence drives.
  for (let guard = 0; guard < 5 && anchor; guard++) {
    const bandMembers = driverPool.filter((x) => x !== anchor &&
      (bConditionClass(x.comp) === 'renovated' || x.tier === 'arv'))
    // One comp is still a band — the pocket's evidence outranks a
    // deviating driver even when the band is a single sale.
    const band = bandMembers.length ? bMedian(bandMembers.map((x) => x.contrib)) : null
    if (band == null || anchor.contrib <= 1.30 * band) break
    flags.push(`${anchor.comp.address}: contribution ${usd(anchor.contrib)} is +${Math.round((anchor.contrib / band - 1) * 100)}% above the renovated band ${usd(band)} (${bandMembers.length} members) — suspected outlier, set aside`)
    dec({ compAddress: anchor.comp.address, stage: 'microscope', rule: 'band-deviation-30', verdict: 'set-aside',
      value: anchor.contrib, note: `+${Math.round((anchor.contrib / band - 1) * 100)}% above ${usd(band)} band` })
    drivers = drivers.filter((x) => x !== anchor)
    const next = ranked.find((x) => drivers.includes(x))
    if (!next) {
      flags.push(`no driver survives — ARV set at the band median ${usd(band)}`)
      return fin({ arv: Math.round(band), flags, contribs, drivers: [], bracket: 'ok', conf: 'low',
        source: `${source} — band median`, landRateSource: landSource, sqftRateSource })
    }
    anchor = next
  }

  let arv = anchor.contrib
  anchorScore = similarity(anchor)
  const support = ranked.filter((x) => drivers.includes(x) && x !== anchor)
  flags.push(`anchored to ${anchor.comp.address} (similarity ${anchorScore.toFixed(1)})`)
  dec({ compAddress: anchor.comp.address, stage: 'answer', rule: 'anchor', verdict: 'anchored',
    value: anchor.contrib, note: `similarity ${anchorScore.toFixed(1)}` })
  if (support.length) {
    const lo = Math.min(...support.map((x) => x.contrib))
    const hi = Math.max(...support.map((x) => x.contrib))
    flags.push(`supporting range ${usd(lo)}–${usd(hi)} (${support.length} comp(s) — bound, not blended)`)
    if (anchor.contrib > hi) flags.push('anchor above supporting range — top of evidence')
    else if (anchor.contrib < lo) flags.push('anchor below supporting range — check whether a better comp should drive')
  }

  // ── Self-heal — anchor must be representative, not the floor ────────────
  let healed = false
  if (drivers.length > 1) {
    const driverMedian = bMedian(drivers.map((x) => x.contrib))!
    const suspect = anchor.contrib < 0.8 * driverMedian ||
      (support.length > 0 && anchor.contrib < Math.min(...support.map((x) => x.contrib)))
    if (suspect) {
      const healedAnchor = drivers.reduce((a, b) =>
        Math.abs(b.contrib - driverMedian) < Math.abs(a.contrib - driverMedian) ? b : a)
      if (healedAnchor !== anchor) {
        flags.push(`self-heal: anchor ${(anchor.comp.address ?? '').slice(0, 30)} was the evidence floor ` +
          `(${usd(anchor.contrib)} vs driver median ${usd(driverMedian)}) — re-anchored to ${(healedAnchor.comp.address ?? '').slice(0, 30)}`)
        dec({ compAddress: anchor.comp.address, stage: 'answer', rule: 'self-heal', verdict: 'demoted',
          value: anchor.contrib, note: `evidence floor vs ${usd(driverMedian)} median` })
        dec({ compAddress: healedAnchor.comp.address, stage: 'answer', rule: 'self-heal', verdict: 'anchored',
          value: healedAnchor.contrib })
        anchor = healedAnchor
        arv = anchor.contrib
        healed = true
      }
    }
  }

  // ── No modeled condition uplift ────────────────────────────────────────
  // Investor rule (owner decision): a median-tier answer serves at face
  // value. The old URAR uplift — rehab × 80% or a tier-spread bump —
  // inflated ARV on invented premium; you can't exit on modeled value.
  // If the pocket proves a renovated band, that band prices it — the
  // maintained evidence stands on its own here.
  const conditionAdj: number | null = null
  if (drivers.length && drivers.every((x) => bCondTier(x.comp) === 'median')) {
    flags.push('median-tier anchor — ARV serves at maintained-market value (no modeled uplift)')
  }

  // ── Outlier ceiling — top verified contribution in subject units ────────
  const margRate = (c: BComp): number => {
    if (sqftRate != null) return sqftRate
    const gap = Math.abs(subSqft! - c.squareFeet!) / c.squareFeet!
    return (bPpsfOf(c) ?? 0) * (gap <= 0.10 ? 0.50 : gap <= 0.25 ? 0.40 : 0.30)
  }
  const rawCeiling = Math.max(...pool.map((c) =>
    c.salePrice! + Math.max(0, subSqft! - c.squareFeet!) * margRate(c)))
  const topContrib = Math.max(...verifiedPool.map((x) => x.contrib))
  const ceiling = Math.min(rawCeiling, topContrib)
  const supporters = drivers.filter((x) => x.contrib >= ceiling).length
  const cappedOutlier = arv > ceiling && supporters < B_OUTLIER_SUPPORT
  if (cappedOutlier) {
    flags.push(`ARV ${usd(arv)} exceeds size-adjusted ceiling ${usd(ceiling)} with ${supporters} supporter(s) — capped`)
    dec({ stage: 'answer', rule: 'outlier-ceiling', verdict: 'capped', value: ceiling, note: `from ${usd(arv)}` })
    arv = ceiling
  }

  // ── Maintained-band floor — ARV can't sit below the band ────────────────
  // Maintained homes selling above the answer means the anchor (or its
  // renovated label) was read wrong — the floor is the band's median.
  const maintainedVals = medianComps.map((x) => x.contrib)
  if (maintainedVals.length >= 2 && arv != null && arv < bMedian(maintainedVals)!) {
    flags.push(`ARV ${usd(arv)} below maintained band — floored at maintained median ${usd(bMedian(maintainedVals)!)}`)
    dec({ stage: 'answer', rule: 'maintained-floor', verdict: 'floored', value: bMedian(maintainedVals)!, note: `from ${usd(arv)}` })
    arv = bMedian(maintainedVals)!
  }

  // ── Bracketing ───────────────────────────────────────────────────────────
  let bracket: BResult['bracket'] = 'ok'
  const sizes = drivers.map((x) => x.comp.squareFeet!)
  if (subSqft && sizes.every((s) => s < subSqft)) bracket = 'all-smaller'
  if (subSqft && sizes.every((s) => s > subSqft)) bracket = 'all-bigger'
  if (bracket !== 'ok') flags.push(`bracketing: driver set is ${bracket} — no size bracket`)

  const conf: BResult['conf'] =
    bracket !== 'ok' || cappedOutlier ? 'low'
    : drivers.length >= 3 && !flags.length ? 'high'
    : drivers.length >= 3 ? 'medium' : 'low'

  return fin({
    arv: Math.round(arv), flags, drivers, contribs, bracket, conf, source,
    landRateSource: landSource, sqftRateSource,
    anchorAddress: anchor.comp.address ?? null, ceiling, conditionAdj, healed,
  })
}
