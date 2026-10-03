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
 */

// ── Constants (calibrated — see scoreboard.md) ────────────────────────────
export const B_ADJ_CAP_PCT = 0.25
export const B_OUTLIER_SUPPORT = 2
export const B_LAND_FACTOR = 0.35
export const B_LAND_CAP_PCT = 0.20
export const B_RETAIL_BAND = 0.70
export const B_SIM_GATE = 0.60
export const B_MIN_SIM = 3.0
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
    flags?: string[] | null
  } | null
  appraisalRules?: { totalAdjustment?: number | null } | null
}

export interface BContribution {
  comp: BComp
  contrib: number
  weight: number
  tier: 'arv' | 'as_is' | 'unidentified'
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
  anchorAddress?: string | null
  ceiling?: number | null
  conditionAdj?: number | null
  healed?: boolean
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
  const summary = (ca.summary ?? '').toLowerCase()
  if (summary.includes('tier:distressed') || summary.includes('tier:floor')) return 'distressed'
  if (summary.includes('tier:median')) return 'median'
  if (summary.includes('tier:premium') || summary.includes('tier:luxury')) return 'premium'
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
  c.evidenceVerification?.priceCheck === 'divergent'

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
  const empty = (source: string): BResult => ({
    arv: null, flags, drivers: [], contribs: [], bracket: 'ok', conf: 'none', source,
  })

  // Pool: enabled comps with sale + size evidence. Soft-disabled comps
  // (boundary sale_age, geo name variants, size deltas, road barrier)
  // still compete — verification + similarity do the ranking. Hard gates
  // (nominal transfers, category/type mismatches) stay hard.
  const B_HARD_DISABLE = /non-market|category mismatch|type mismatch|nominal|not market/i
  // A soft-disable rescues adjustable deltas — not category differences.
  // A comp >~75% off the subject's size is a different product class, not
  // something the size curve can honestly extrapolate.
  const bSizeBand = (c: BComp) => {
    if (subject.squareFeet == null || c.squareFeet == null) return true
    const ratio = c.squareFeet / subject.squareFeet
    return ratio >= 0.5 && ratio <= 1.75
  }
  // Rescues must earn it: verified sale (corroborated/plausible — an
  // uncorroborated rescue is a guess, not evidence) and same side of the
  // road barrier (a road crossing is a submarket boundary, not a soft delta).
  const bSoftDisabled = (c: BComp) => {
    if (c.isEnabled || !(c.disableReasons?.length ?? 0)) return false
    if (!(c.disableReasons ?? []).every((r) => !B_HARD_DISABLE.test(r))) return false
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

    // Adjustment-cap downweight — >25% net adj halves the weight
    const adjPct = Math.abs(c.appraisalRules?.totalAdjustment ?? 0) / c.salePrice!
    const capped = adjPct > B_ADJ_CAP_PCT
    if (capped) flags.push(`${c.address}: ${(adjPct * 100).toFixed(0)}% adj > cap — downweighted`)
    const weight = (1 / (1 + adjPct)) * (capped ? 0.5 : 1)
    contribs.push({ comp: c, contrib, weight, tier: bTierOf(c) })
  }

  // ── Evidence verification — stale/divergent never drive ARV ─────────────
  const unfit = contribs.filter((x) => bIsUnfit(x.comp))
  for (const x of unfit) {
    flags.push(`${x.comp.address}: verification — ${(x.comp.evidenceVerification?.flags ?? []).join('; ').slice(0, 90)}`)
  }
  const verifiedPool = contribs.filter((x) => !unfit.includes(x))

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

  // ── Tier discipline — renovated preferred → median fallback → retail ────
  const medianComps = verifiedPool.filter((x) => bCondTier(x.comp) === 'median')
  // Upper band = any comp not stamped as-is/distressed whose condition
  // isn't proven median — an unclassified or Clef-unidentified sale that
  // passed the rules is still evidence, just unverdicted. Only explicit
  // as_is sales and proven-median conditions stay out.
  const preferred = verifiedPool.filter((x) =>
    x.tier !== 'as_is' && bArvCondOk(x.comp) && bCondTier(x.comp) !== 'median' && similarity(x) >= B_MIN_SIM)
  let drivers: BContribution[]
  if (preferred.length) {
    drivers = preferred
    for (const x of preferred)
      if (x.tier === 'unidentified')
        flags.push(`${x.comp.address}: unclassified driver — rules passed, no sale-type verdict`)
      else if (bCondTier(x.comp) === 'unknown')
        flags.push(`${x.comp.address}: no condition verdict — Clef/listing unavailable, driving on sale + rules evidence`)
  } else if (medianComps.length) {
    drivers = medianComps
    for (const x of medianComps)
      flags.push(`${x.comp.address}: median-tier driver — no high-similarity renovated evidence`)
  } else {
    const weak = verifiedPool.filter((x) => x.tier !== 'as_is' && bArvCondOk(x.comp) && bCondTier(x.comp) !== 'median')
    if (weak.length) {
      flags.push(`non-median comps below similarity floor (${B_MIN_SIM}) — falling to median`)
      drivers = medianComps.length ? medianComps : weak
    } else {
      const topPpsf = verifiedPool.length
        ? Math.max(...verifiedPool.map((x) => bPpsfOf(x.comp) ?? 0))
        : null
      const retail = verifiedPool.filter((x) =>
        x.tier !== 'as_is' && bArvCondOk(x.comp) && bCondTier(x.comp) !== 'median' &&
        topPpsf != null && (bPpsfOf(x.comp) ?? 0) >= B_RETAIL_BAND * topPpsf)
      if (!retail.length) {
        // Median-only evidence — similarity-gated ceiling + AVM uplift
        if (medianComps.length) {
          const topSim = Math.max(...medianComps.map(similarity))
          const gatedMedian = medianComps.filter((x) => similarity(x) >= 0.6 * topSim)
          const medianCeiling = Math.max(...gatedMedian.map((x) => x.contrib))
          const avm = bSubjectAvm(subject)
          if (avm && avm > medianCeiling) {
            flags.push(`median-tier evidence only (ceiling ${usd(medianCeiling)}) — ARV set at subject AVM ${usd(avm)} (corroborated uplift)`)
            return { arv: Math.round(avm), flags, contribs, drivers: medianComps,
              bracket: 'ok', conf: 'low', source: 'median+AVM uplift', landRateSource: landSource, sqftRateSource }
          }
          flags.push(`median-tier evidence only — ARV at median ceiling ${usd(medianCeiling)} (uplift unverified)`)
          return { arv: Math.round(medianCeiling), flags, contribs, drivers: medianComps,
            bracket: 'ok', conf: 'low', source: 'median ceiling', landRateSource: landSource, sqftRateSource }
        }
        flags.push('no retail-priced evidence — ARV withheld (as-is sales are floor evidence only)')
        return { arv: null, flags, contribs, drivers: [], bracket: 'ok', conf: 'none', source,
          landRateSource: landSource, sqftRateSource }
      }
      drivers = retail
      flags.push(`no ARV-tier labels — ARV driven on ${drivers.length} retail-marked comp(s); ${contribs.length - retail.length} as-is-priced sale(s) excluded from ARV`)
    }
  }

  // ── Reconciliation anchoring — most-similar comp drives, rest bounds ────
  const ranked = drivers.slice().sort((a, b) =>
    similarity(b) - similarity(a) || b.weight - a.weight)
  let anchor = ranked[0] ?? null
  if (!anchor) return { arv: null, flags, contribs, drivers: [], bracket: 'ok', conf: 'none', source,
    landRateSource: landSource, sqftRateSource }
  const anchorScore = similarity(anchor)

  // Similarity gate — drop drivers below 60% of the anchor's score
  if (drivers.length > 1) {
    const gated = drivers.filter((x) => similarity(x) >= B_SIM_GATE * anchorScore)
    for (const x of drivers.filter((x) => !gated.includes(x)))
      flags.push(`${x.comp.address}: dropped from drivers — similarity ${similarity(x).toFixed(1)} below gate (${(B_SIM_GATE * anchorScore).toFixed(1)})`)
    if (gated.length) drivers = gated
  }

  let arv = anchor.contrib
  const support = ranked.filter((x) => drivers.includes(x) && x !== anchor)
  flags.push(`anchored to ${anchor.comp.address} (similarity ${anchorScore.toFixed(1)})`)
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
        anchor = healedAnchor
        arv = anchor.contrib
        healed = true
      }
    }
  }

  // ── Condition adjustment — the URAR Condition line item ─────────────────
  let conditionAdj: number | null = null
  if (drivers.length && drivers.every((x) => bCondTier(x.comp) === 'median')) {
    const premium = contribs.filter((x) => bCondTier(x.comp) === 'premium')
    let condAdj = 0
    let condSrc: string | null = null
    if (premium.length >= 2 && medianComps.length) {
      const premMed = bMedian(premium.map((x) => x.contrib))!
      const medMed = bMedian(medianComps.map((x) => x.contrib))!
      const spread = medMed ? premMed / medMed - 1 : 0
      if (spread > 0) {
        const frac = B_REHAB_FRACTION[subject.condition ?? ''] ?? 0.5
        condAdj = arv * spread * frac
        condSrc = `T1 tier spread ${(spread * 100).toFixed(0)}% × ${frac.toFixed(2)} (${subject.condition})`
      }
    } else {
      const rehab = opts?.rehabCost
      if (rehab) {
        condAdj = rehab * 0.8
        condSrc = `T2 contributory — ${usd(rehab)} rehab cost × 80%`
      }
    }
    if (condAdj >= 1000) {
      arv += condAdj
      conditionAdj = condAdj
      flags.push(`condition adj +${usd(condAdj)} [${condSrc}] — median-priced anchor → as-repaired value`)
    } else {
      flags.push('condition uplift unverified — ARV at median-tier anchor')
    }
  }

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
  const supporters = drivers.filter((x) => x.contrib >= ceiling).length
  const cappedOutlier = arv > ceiling && supporters < B_OUTLIER_SUPPORT
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
    : drivers.length >= 3 && !flags.length ? 'high'
    : drivers.length >= 3 ? 'medium' : 'low'

  return {
    arv: Math.round(arv), flags, drivers, contribs, bracket, conf, source,
    landRateSource: landSource, sqftRateSource,
    anchorAddress: anchor.comp.address ?? null, ceiling, conditionAdj, healed,
  }
}
