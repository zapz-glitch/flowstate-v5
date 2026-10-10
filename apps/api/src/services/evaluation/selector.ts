/**
 * The deterministic selector — the comp-selection seat of the corelogic
 * harness. No model in the final decision: the Markdown doctrines are
 * the human-readable spec; every rule here is tested TypeScript.
 *
 * Rule ledger (every comp carries its verdict + the rules that decided):
 *   R1 geo eligibility — census GEOIDs + subdivision + neighborhood +
 *      distance; OFF_POCKET excludes, tract is the floor.
 *   R2 physical eligibility — foundation/construction/style/size/era;
 *      gross mismatches exclude, recoverable differences ADJUST —
 *      never auto-reject a strong comp.
 *   R3 sale recency — hard 365-day cap; inside the window
 *      stale-but-usable is a recoverable caution.
 *   R4 anomaly — divergent AVM, unexplained premium, investor-band
 *      pricing, hard shared exclusions.
 *   R5 condition band — ARV picks come from after_renovation stock,
 *      transitional = median fallback, as_is never picks.
 *   R6 price envelope — the posted ARV anchors inside the picks'
 *      sale-price envelope ±10% (d7).
 *   R7 foreign-pocket validation — a comp outside the subject's
 *      subdivision/neighborhood picks only when its own pocket's median
 *      sits inside the subject pocket's envelope (extension, not import).
 *
 * The same d1–d8 gate that grades a model verdict verifies the pick;
 * a reject completes on the deterministic engine — Sonnet never engages.
 */

import { gradeVerdict } from './verdict-grade'
import { groupPocketSales } from './price-groups'
import { compMatchProfile } from './observable'
import { exclusionReasons } from './appraiser'
import { validateAgentSelection } from './index'
import type { AgentSelection, HarnessEvidence, Phase1Context, SelectionAttempt } from './index'
import type { AppraisedComparable } from '../appraisal/types'
import type { AppraiserResult } from './appraiser'
import type { CompMatchProfile } from './observable'

const GEO_TIER_RANK: Record<CompMatchProfile['geoTier'], number> = {
  BLOCK_GROUP: 0,
  NEIGHBORHOOD: 1,
  SUBDIVISION: 2,
  TRACT: 3,
  OFF_POCKET: 4,
}

type PriceGroup = 'top' | 'middle' | 'bottom'
type Verdict = 'picked' | 'eligible' | 'excluded' | 'unpriceable'

/** Pick doctrine — one true comp is enough, 2-3 is the working set,
 *  never pad. A pick has to BE a true comp: physically matched
 *  (sqft twin/close) with few exceptions (<=2 recoverable diffs).
 *  Selection stops when the bar runs out; a single verified comp
 *  outranks three filled-out picks. */
const MAX_PICKS = 3
const MIN_PICKS = 1
/** The true-comp bar — the strongest physical dim (sqft) must be
 *  twin-or-close AND the comp can carry at most 2 recoverable
 *  exceptions. Below the bar the evidence is context, not a pick. */
const TRUE_COMP_MAX_DIFFS = 2
/** Extreme-variance anomaly threshold — a comp this likely to carry an
 *  unexplained premium never makes the ARV pool. */
const ANOMALY_P = 0.7
/** Physical eligibility bounds (R2) — inside these the difference is
 *  recoverable (adjust); outside it excludes. */
const PHYS = {
  sqftDeltaPct: { recoverable: 25, disqualifying: 50 },
  yearBuiltDelta: { recoverable: 25, disqualifying: 50 },
  lotDeltaPct: { recoverable: 100, disqualifying: 300 },
  bedsDelta: 2,
  bathsDelta: 1.5,
}

interface CompAudit {
  id: string
  verdict: Verdict
  rules: string[]
  reasons: string[]
  recoverable: string[]
  missingData: string[]
}

type MatchDim = 'exact' | 'close' | 'recoverable' | 'hard_failure' | 'unknown'

/** Per-dimension labels — the raw value AND the label are both preserved
 *  per field; a comp never collapses into one score. pricePosition is
 *  where the comp sold inside ITS pocket's ladder; priceEvidence is how
 *  useful that sale is for THIS subject's renovated value — two separate
 *  questions, two separate labels. */
interface CompLabels {
  geo: CompMatchProfile['geoTier']
  sqft: MatchDim
  year: MatchDim
  lot: MatchDim
  style: 'match' | 'differs' | 'unknown'
  saleAge: 'fresh' | 'stale' | 'aged_out' | 'unknown'
  pricePosition: 'top' | 'median' | 'bottom' | 'outlier' | 'unknown'
  priceEvidence: 'arv' | 'median' | 'as_is' | 'none'
  sanity: 'clean' | 'anomalous'
  /** Recoverable physical differences — "fewest exceptions wins". */
  diffs: number
}

interface RankedComp {
  id: string
  comp: HarnessEvidence['comps'][number]
  profile: CompMatchProfile
  group: PriceGroup
  ppsf: number
  audit: CompAudit
  labels?: CompLabels
}

/** Ladder rung for a comp — the stamped group when present, else the
 *  median/top ratios decide (top ≥85% of the pocket's top median,
 *  bottom <85% of overall median). */
function priceGroupOf(comp: HarnessEvidence['comps'][number]): PriceGroup {
  const g = comp.priceLadder?.group
  if (g === 'top' || g === 'middle' || g === 'bottom') return g
  const vsTop = comp.priceLadder?.ppsfVsTop
  const vsMed = comp.priceLadder?.ppsfVsMedian
  if (typeof vsTop === 'number' && vsTop >= 0.85) return 'top'
  if (typeof vsMed === 'number' && vsMed < 0.85) return 'bottom'
  return 'middle'
}

/** R4 anomaly rule-out — the outsized-premium sales and AVM
 *  contradictions that make a comp unpriceable evidence even inside
 *  the pocket. */
function anomaliesOf(comp: HarnessEvidence['comps'][number]): string[] {
  const anomalies: string[] = []
  const v = comp.evidenceVerification as Record<string, unknown> | null | undefined
  if (v?.priceCheck === 'divergent') anomalies.push('R4 divergent-avm')
  const up = comp.observables?.unexplainedPremiumP
  if (typeof up === 'number' && up >= ANOMALY_P) {
    anomalies.push(`R4 unexplained-premium(p=${up.toFixed(2)})`)
  }
  return anomalies
}

/** R2 physical eligibility — gross mismatches exclude; everything inside
 *  the recoverable band is an ADJUSTMENT, not a rejection. A block-group
 *  comp with stucco-over-frame is a price-tweak, not a lost comp.
 *  Block-group members get the T2 band — every bound widened 25% — a
 *  geo-verified neighbor keeps its physical diffs recoverable longer
 *  (first-principles preference, not a hard barrier). */
const BG_LENIENCY = 1.25
function physicalEligibility(p: CompMatchProfile, bg = false): { excludes: string[]; recoverable: string[] } {
  const excludes: string[] = []
  const recoverable: string[] = []
  const widen = (b: { recoverable: number; disqualifying: number }) =>
    bg ? { recoverable: b.recoverable * BG_LENIENCY, disqualifying: b.disqualifying * BG_LENIENCY } : b
  const band = (v: number | null, name: string, b0: { recoverable: number; disqualifying: number }, unit: string) => {
    if (v == null) return
    const b = widen(b0)
    const a = Math.abs(v)
    if (a > b.disqualifying) excludes.push(`R2 ${name} ${v > 0 ? '+' : ''}${Math.round(v)}${unit} beyond ±${Math.round(b.disqualifying)}${unit}`)
    else if (a > b.recoverable) recoverable.push(`${name} ${v > 0 ? '+' : ''}${Math.round(v)}${unit}`)
  }
  band(p.sqftDeltaPct, 'size', PHYS.sqftDeltaPct, '%')
  band(p.yearBuiltDelta, 'era', PHYS.yearBuiltDelta, 'y')
  band(p.lotDeltaPct, 'lot', PHYS.lotDeltaPct, '%')
  if (p.bedsDelta != null && Math.abs(p.bedsDelta) >= PHYS.bedsDelta) recoverable.push(`beds ${p.bedsDelta > 0 ? '+' : ''}${p.bedsDelta}`)
  if (p.bathsDelta != null && Math.abs(p.bathsDelta) >= PHYS.bathsDelta) recoverable.push(`baths ${p.bathsDelta > 0 ? '+' : ''}${p.bathsDelta}`)
  if (p.storiesMatch === false) recoverable.push('stories mismatch')
  if (p.foundationMatch === false) recoverable.push('foundation mismatch')
  if (p.constructionMatch === false) recoverable.push('construction mismatch')
  if (p.exteriorWallsMatch === false) recoverable.push('exterior walls mismatch')
  if (p.roofTypeMatch === false) recoverable.push('roof type mismatch')
  return { excludes, recoverable }
}

/** Post the code-computed selection as an AppraiserResult so the gate
 *  ladder, trace shape, and trust floor stay identical to a model run. */
export function runDeterministicSelector(
  ctx: Phase1Context,
  evidence: HarnessEvidence,
): AppraiserResult {
  const subject = evidence.subject
  // The preset filter ladder (±10yr, 210-day, style-match) belongs to the
  // legacy manual flow — under TS-as-executioner those tolerances are
  // recoverable ADJUSTMENTS, not vetoes. Eligibility is owned by R1–R6
  // below: geo tier, gross physical mismatch, anomalies, priceability.
  // Preset-disabled comps still carry their disableReasons into the audit
  // as recoverable notes when they survive the real rules.
  const pool = evidence.comps.filter((c) => c.id)
  const audits: CompAudit[] = []
  const ranked: RankedComp[] = []

  for (const comp of pool) {
    const audit: CompAudit = { id: comp.id!, verdict: 'eligible', rules: [], reasons: [], recoverable: [], missingData: [] }
    audits.push(audit)

    const ppsf = comp.salePrice != null && comp.squareFeet != null && comp.squareFeet > 0
      ? comp.salePrice / comp.squareFeet : 0
    if (!(ppsf > 0)) {
      audit.verdict = 'unpriceable'
      audit.rules.push('R6')
      audit.missingData.push(comp.salePrice == null ? 'salePrice' : 'squareFeet')
      continue
    }
    if (comp.yearBuilt == null) audit.missingData.push('yearBuilt')
    if (!comp.saleDate) audit.missingData.push('saleDate')
    if (comp.sameBlockGroup == null && comp.censusTract == null && comp.subdivision == null) audit.missingData.push('geo')

    const profile = compMatchProfile(subject, comp)
    const group = priceGroupOf(comp)

    // R1 geo — off-pocket excludes; tract is the pocket floor, ranked last.
    if (profile.geoTier === 'OFF_POCKET') {
      audit.verdict = 'excluded'
      audit.rules.push('R1')
      audit.reasons.push(`R1 off-pocket — no geo match${comp.distanceMiles != null ? ` (${comp.distanceMiles.toFixed(1)}mi)` : ''}`)
      ranked.push({ id: comp.id!, comp, profile, group, ppsf, audit })
      continue
    }

    // R2 physical eligibility — gross mismatch excludes; recoverable
    // differences are adjustments that ride the pick, not rejections.
    const phys = physicalEligibility(profile, profile.geoTier === 'BLOCK_GROUP')
    if (phys.excludes.length) {
      audit.verdict = 'excluded'
      audit.rules.push('R2')
      audit.reasons.push(...phys.excludes)
      ranked.push({ id: comp.id!, comp, profile, group, ppsf, audit })
      continue
    }
    audit.recoverable.push(...phys.recoverable)

    // R3 sale recency — hard 365-day cap (user rule): a comp sold more
    // than a year ago is out entirely. Between the preferred window and
    // the cap the staleness is a recoverable caution, never a veto.
    const ageDays = comp.saleDate ? Math.floor((Date.now() - new Date(comp.saleDate).getTime()) / 864e5) : null
    const window = evidence.rules.preferredSaleAgeDays
    const SALE_AGE_CAP_DAYS = 365
    if (ageDays != null && ageDays > SALE_AGE_CAP_DAYS) {
      audit.verdict = 'excluded'
      audit.rules.push('R3')
      audit.reasons.push(`R3 sale ${ageDays}d old — beyond 365d cap`)
    } else if (ageDays != null && ageDays > window) {
      audit.recoverable.push(`stale ${ageDays}d vs ${window}d`)
    }

    // R4 anomalies + the shared hard exclusions (investor-band, divergent
    // price, non-market sale). 'caution:'/'weak geo' stay advisory.
    const anomalies = anomaliesOf(comp)
    const shared = exclusionReasons(comp, evidence)
      .filter((r) =>
        !r.startsWith('caution')
        && !r.startsWith('weak geo')
        // 'disabled by the filter rules' IS the preset ladder — the
        // R-rules own eligibility here, so its catch-all veto is dropped;
        // the comp's disableReasons ride the pick as recoverable notes.
        && r !== 'disabled by the filter rules')
      .map((r) => `R4 ${r}`)
    const hard = [...anomalies, ...shared]
    if (hard.length) {
      audit.verdict = 'excluded'
      audit.rules.push('R4')
      audit.reasons.push(...hard)
      ranked.push({ id: comp.id!, comp, profile, group, ppsf, audit })
      continue
    }
    audit.rules.push('R1', 'R2', 'R3', 'R4')
    if (!comp.isEnabled && Array.isArray(comp.disableReasons)) {
      audit.recoverable.push(
        ...comp.disableReasons.map((r) => `preset-tolerance: ${r}`),
      )
    }
    ranked.push({ id: comp.id!, comp, profile, group, ppsf, audit })
  }

  const clean = ranked.filter((r) => r.audit.verdict === 'eligible')
  // Selector-side band ladder — the stamped priceLadder was computed over
  // preset-ENABLED comps only, which starves every band when the preset
  // ladder over-disables (Madeira: 3/71 enabled → empty ARV band → forced
  // median fallback regardless of the pocket's real top cluster). Re-group
  // the clean pocket set: outliers never set the bands here either.
  const pocketClean = clean.filter((r) => r.profile.geoTier !== 'OFF_POCKET')
  const selGrouping = pocketClean.length >= 3
    ? groupPocketSales(pocketClean.map((r) => ({ id: r.id, ppsf: r.ppsf })))
    : null
  for (const r of clean) {
    const g = selGrouping?.groups.get(r.id)
    if (g) r.group = g
  }
  // Ladder outliers are code-flagged anomalies — a sale standing alone
  // above the pocket's top cluster (the $3.3M waterfront mansion in a
  // $700k interior pocket) is geography without price evidence. R4.
  for (const r of ranked) {
    if (r.audit.verdict === 'eligible' && selGrouping?.outliers.has(r.id)) {
      r.audit.verdict = 'excluded'
      r.audit.rules.push('R4')
      r.audit.reasons.push(`R4 ladder-outlier — $${Math.round(r.ppsf)}/sf stands alone above the pocket's top cluster`)
    }
  }
  // Explicit outsized-premium bound — >2.5x the clean pocket's median
  // $/sf is the same anomaly even when the ladder didn't flag it.
  const pocketPpsfs = pocketClean.map((r) => r.ppsf).sort((a, b) => a - b)
  const pocketMedian = pocketPpsfs.length ? pocketPpsfs[Math.floor((pocketPpsfs.length - 1) / 2)] : 0
  for (const r of ranked) {
    if (r.audit.verdict === 'eligible' && pocketMedian > 0 && r.ppsf > pocketMedian * 2.5) {
      r.audit.verdict = 'excluded'
      r.audit.rules.push('R4')
      r.audit.reasons.push(`R4 outsized-premium — $${Math.round(r.ppsf)}/sf is ${(r.ppsf / pocketMedian).toFixed(1)}x the pocket median`)
    }
  }
  // clean is re-derived below after the outlier pass.
  const cleanSet = new Set(ranked.filter((r) => r.audit.verdict === 'eligible').map((r) => r.id))
  clean.length = 0
  clean.push(...ranked.filter((r) => cleanSet.has(r.id)))
  // The three price groups the run reports — ARV band / median / as-is —
  // over clean comps only (outliers never set the bands).
  const groupStats = (g: PriceGroup) => {
    const xs = clean.filter((r) => r.group === g).map((r) => r.ppsf).sort((a, b) => a - b)
    return xs.length ? { n: xs.length, medianPpsf: xs[Math.floor((xs.length - 1) / 2)] } : null
  }
  const arvBand = groupStats('top')
  const medianBand = groupStats('middle')
  const asIsBand = groupStats('bottom')

  // Lexicographic pick order — compare the most important criterion
  // first, move to the next only on a tie: geo tier → fewest recoverable
  // diffs → physical twin count → Decisions arv-fitness → price position.
  // A strong attribute can never compensate for a higher-priority
  // weakness; there is no weighted score anywhere in the pick path.
  const twinCount = (r: RankedComp) =>
    r.labels ? [r.labels.sqft, r.labels.year, r.labels.lot].filter((d) => d === 'exact').length : 0
  const rank = (a: RankedComp, b: RankedComp) =>
    GEO_TIER_RANK[a.profile.geoTier] - GEO_TIER_RANK[b.profile.geoTier]
    || (a.labels?.diffs ?? 9) - (b.labels?.diffs ?? 9)
    || twinCount(b) - twinCount(a)
    || (b.comp.observables?.arvFitnessP ?? 0.5) - (a.comp.observables?.arvFitnessP ?? 0.5)
    || b.ppsf - a.ppsf

  // R5 condition band decides the pick pool — an as-is/distressed sale at
  // median price is still as-is evidence and cannot drive an ARV verdict
  // (d4). as-is comps are reported as the as-is band, never picked.
  const condClass = (r: RankedComp): string | null =>
    (r.comp.classification as { type?: string } | null | undefined)?.type ?? null
  const isAsIs = (r: RankedComp) => condClass(r) === 'as_is'
  // ARV-qualified — same definition the gate uses (carriesArvEvidence):
  // verified flip, renovated classification, Renovated/Updated condition
  // label, or ARV comp tier. Providers that don't populate one field still
  // qualify through the others.
  const isRenovated = (r: RankedComp) =>
    (r.comp as { verifiedFlip?: boolean }).verifiedFlip === true ||
    condClass(r) === 'after_renovation' ||
    (r.comp.conditionLabel === 'Renovated' || r.comp.conditionLabel === 'Updated') ||
    r.comp.compTier === 'arv' ||
    (condClass(r) !== 'as_is' && r.group === 'top')
  for (const r of clean) if (isAsIs(r)) r.audit.rules.push('R5:as-is-band')
  // Investor-band pricing is as-is evidence in code too — a bottom-rung
  // comp never picks, same rule as a labeled as_is comp (R5).
  const asIsPriced = (r: RankedComp) => isAsIs(r) || r.group === 'bottom'
  // Per-dimension labels (doctrine: raw + label, never one score). A comp
  // with one recoverable diff and one with three are different evidence
  // even at the same geo tier — `diffs` counts the exceptions.
  const physDim = (delta: number | null, twin: number, close: number, mod: number): MatchDim =>
    delta == null ? 'unknown'
      : Math.abs(delta) <= twin ? 'exact'
      : Math.abs(delta) <= close ? 'close'
      : Math.abs(delta) <= mod ? 'recoverable' : 'hard_failure'
  for (const r of ranked) {
    const bg = r.profile.geoTier === 'BLOCK_GROUP'
    const mod = (b: number) => bg ? b * BG_LENIENCY : b
    // Style is a preference, never a veto (doctrine): a matching style
    // ranks higher via diffs/twins, a mismatch is one recoverable
    // difference — it can never exclude on its own.
    const styleDiffs = r.audit.recoverable.filter((x) =>
      /style|stories|foundation|construction|exterior|roof|beds|baths/i.test(x)).length
    r.labels = {
      geo: r.profile.geoTier,
      sqft: physDim(r.profile.sqftDeltaPct, 10, 15, mod(PHYS.sqftDeltaPct.recoverable)),
      year: physDim(r.profile.yearBuiltDelta, 5, 10, mod(PHYS.yearBuiltDelta.recoverable)),
      lot: physDim(r.profile.lotDeltaPct, 25, 50, mod(PHYS.lotDeltaPct.recoverable)),
      style: styleDiffs > 0 ? 'differs' : 'match',
      saleAge: r.audit.reasons.some((x) => x.includes('365d cap')) ? 'aged_out'
        : r.audit.recoverable.some((x) => x.startsWith('stale')) ? 'stale'
        : r.comp.saleDate ? 'fresh' : 'unknown',
      pricePosition: selGrouping?.outliers.has(r.id) ? 'outlier'
        : r.group === 'top' ? 'top' : r.group === 'bottom' ? 'bottom' : 'median',
      priceEvidence: r.audit.verdict === 'excluded' || r.audit.verdict === 'unpriceable' ? 'none'
        : asIsPriced(r) ? 'as_is' : isRenovated(r) ? 'arv' : 'median',
      sanity: r.audit.rules.includes('R4') ? 'anomalous' : 'clean',
      diffs: r.audit.recoverable.length,
    }
  }
  const arvPool = clean.filter((r) => !asIsPriced(r) && isRenovated(r)).sort(rank)
  const medianPool = clean.filter((r) => !asIsPriced(r) && !isRenovated(r)).sort(rank)
  const medianFallback = arvPool.length === 0

  // d1 pocket anchoring — pricing weight stays in the block group (or the
  // tract when the pool has no BG comps at all). Mirrors verdict-grade:
  // a driver outside the pocket fails while any in-pocket comp remains
  // unpicked, so in-pocket comps fill picks FIRST — across both bands —
  // and drivers are only ever in-pocket picks. Off-pocket picks stay
  // supporting evidence (a warn at most).
  const subjectTract = (subject.censusTract as string | null | undefined) ?? null
  // Pocket test identical to the gate's (verdict-grade inBg/inPocket):
  // sameBlockGroup or a stage-A/B Clef digest geoFit — NOT the looser
  // matchProfile tier, so what the selector picks is what d1 counts.
  const digestGeoFit = (r: RankedComp): string | null => {
    const rec = (r.comp as { clefDigest?: Record<string, Record<string, unknown>> | null }).clefDigest
    // Stage B only — identical to the gate. A stage-A geoFit is a stale
    // pre-observable verdict; trusting it marked off-pocket comps in-BG.
    const v = rec?.B?.geoFit
    return typeof v === 'string' ? v : null
  }
  const inBg = (r: RankedComp) =>
    r.comp.sameBlockGroup === true || ['block_group', 'same_pocket'].includes(digestGeoFit(r) ?? '')
  const inPocket = (r: RankedComp) =>
    inBg(r) || (subjectTract != null && r.comp.censusTract === subjectTract)
  // Picks draw from the gate's whole pocket — BG first, then tract —
  // never only-BG (a 2-comp BG can't fill a pick set on its own).
  const inPocketPick = inPocket

  // Similarity-qualified pocket median $/sf — the base price position is
  // labeled against. Pocket members only (the gate's own in-pocket
  // test), arm's-length and non-outlier by construction of `clean`.
  // Twin-gated: ≥3 pocket comps sqft-close to the subject → median over
  // those; else the broad pocket median rides flagged as the wider read.
  const pocketMembers = clean.filter(inPocketPick)
  const pocketTwins = pocketMembers.filter((r) => r.labels?.sqft === 'exact' || r.labels?.sqft === 'close')
  const medianBase = (pocketTwins.length >= 3 ? pocketTwins : pocketMembers)
    .map((r) => r.ppsf).sort((a, b) => a - b)
  const qualifiedMedianPpsf = medianBase.length
    ? medianBase[Math.floor((medianBase.length - 1) / 2)]
    : 0
  const medianScope = pocketTwins.length >= 3 ? 'similarity-qualified' : 'broad-pocket'

  // Picks: ARV-qualified comps always join the set first (even below
  // MIN_PICKS — d4 wants every qualified comp used), then in-pocket
  // comps from either band, then the remaining median fill.
  // d1 pocket anchoring in the ordering itself: EVERY pickable in-pocket
  // comp outranks every off-pocket comp — an off-pocket ARV comp never
  // cuts ahead of an in-pocket median comp while pocket stock remains.
  // Inside each side, ARV-qualified comps first, then the rank.
  const pickable = clean.filter((r) => !asIsPriced(r))
  const arvFirst = (a: RankedComp, b: RankedComp) =>
    Number(arvPool.includes(b)) - Number(arvPool.includes(a)) || rank(a, b)
  const bgFirst = (a: RankedComp, b: RankedComp) =>
    Number(inBg(b)) - Number(inBg(a)) || arvFirst(a, b)
  const ordered = [
    ...pickable.filter(inPocketPick).sort(bgFirst),
    ...pickable.filter((r) => !inPocketPick(r)).sort(arvFirst),
  ]
  // True-comp bar: sqft twin/close + fewest exceptions — the lexicographic
  // order already surfaces the least-acceptance matches first, the bar
  // decides where the set ENDS. Nothing below the bar picks; when no comp
  // clears it, take the single best-ranked comp and flag the run thin.
  const isTrueComp = (r: RankedComp) =>
    (r.labels?.sqft === 'exact' || r.labels?.sqft === 'close') &&
    (r.labels?.diffs ?? 9) <= TRUE_COMP_MAX_DIFFS

  // R7 foreign-pocket validation — a comp OUTSIDE the subject's own
  // subdivision/neighborhood only picks when its pocket proves consistent:
  // the same median check the subject pocket gets, run on the foreign
  // subdivision. ≥2 pool members in that subdivision → their median $/sf
  // must sit within ±25% of the subject pocket's qualified median (an
  // extension of the neighborhood, not a pricier or cheaper pocket — the
  // 3757-Oakman-class miss). A foreign singleton has no pocket to validate;
  // it picks only when its own $/sf already sits inside the subject
  // pocket's envelope. Failing both, the comp stays context — labeled, not
  // deleted.
  const normGeo = (v?: string | null) => v?.toLowerCase().replace(/[^a-z0-9]/g, '') || null
  const subjectSubKey =
    normGeo(subject.subdivision as string | null | undefined) ??
    normGeo(subject.neighborhoodName as string | null | undefined)
  const foreignKey = (r: RankedComp): string | null => {
    if (r.profile.geoTier !== 'TRACT') return null
    const k = normGeo(r.comp.subdivision) ?? normGeo(r.comp.neighborhoodName)
    return k && k !== subjectSubKey ? k : null
  }
  const foreignGroups = new Map<string, RankedComp[]>()
  for (const r of clean) {
    const k = foreignKey(r)
    if (k) {
      const g = foreignGroups.get(k) ?? []
      g.push(r)
      foreignGroups.set(k, g)
    }
  }
  const FOREIGN_BAND_LO = 0.75
  const FOREIGN_BAND_HI = 1.33
  const inBand = (ppsf: number) =>
    qualifiedMedianPpsf > 0 && ppsf >= qualifiedMedianPpsf * FOREIGN_BAND_LO && ppsf <= qualifiedMedianPpsf * FOREIGN_BAND_HI
  const medianOf = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b)
    return s.length ? s[Math.floor((s.length - 1) / 2)] : 0
  }
  const foreignOk = (r: RankedComp): boolean => {
    const k = foreignKey(r)
    if (!k) return true
    const members = foreignGroups.get(k) ?? []
    if (members.length >= 2) {
      const fm = medianOf(members.map((m) => m.ppsf))
      if (qualifiedMedianPpsf > 0) {
        if (!inBand(fm)) {
          r.audit.reasons.push(
            `R7 foreign-pocket — ${k} median $${Math.round(fm)}/sf vs subject pocket $${Math.round(qualifiedMedianPpsf)}/sf (outside ±25%)`
          )
          return false
        }
        return true
      }
      // No subject-pocket baseline — the set's own presence is the evidence.
      return true
    }
    if (!inBand(r.ppsf)) {
      r.audit.reasons.push(
        `R7 foreign-singleton — $${Math.round(r.ppsf)}/sf outside subject pocket envelope ($${Math.round(qualifiedMedianPpsf * FOREIGN_BAND_LO)}–${Math.round(qualifiedMedianPpsf * FOREIGN_BAND_HI)}/sf)`
      )
      return false
    }
    return true
  }

  const truePicks = ordered.filter((r) => isTrueComp(r) && foreignOk(r))
  const picks = truePicks.length > 0
    ? truePicks.slice(0, MAX_PICKS)
    : ordered.slice(0, MIN_PICKS)
  // Drivers carry the pricing weight — in-pocket picks only (the set is
  // already <=3 true comps, so every in-pocket pick drives). When the pool
  // has zero clean in-pocket comps we fall back to the raw ranking and let
  // the gate grade the pocket risk honestly.
  const driverIds = [...picks.filter(inBg), ...picks.filter((p) => !inBg(p) && inPocketPick(p))]
    .slice(0, MAX_PICKS).map((p) => p.id)
  if (driverIds.length === 0) driverIds.push(...picks.slice(0, MIN_PICKS).map((p) => p.id))
  for (const p of picks) p.audit.verdict = 'picked'

  const attempts: SelectionAttempt[] = []
  if (picks.length < 1 || !subject.squareFeet) {
    return {
      selection: null,
      model: 'deterministic-selector',
      attempts,
      clarifications: [],
      debugNotes: [
        `selector: 0 qualified comps in ${medianFallback ? 'median' : 'arv'} band — nothing clears the true-comp bar`,
        `groups: arv=${arvBand?.n ?? 0} median=${medianBand?.n ?? 0} as-is=${asIsBand?.n ?? 0} of ${ranked.length} priced`,
        ...audits.filter((a) => a.verdict === 'excluded').slice(0, 8).map((a) => `${a.id}: ${a.reasons.join('; ')}`),
        ...(subject.squareFeet ? [] : ['subject squareFeet missing — cannot price $/sqft']),
      ],
      unavailable: false,
    }
  }

  const ppsfs = picks.map((p) => p.ppsf).sort((a, b) => a - b)
  const medianPpsf = ppsfs.length % 2 ? ppsfs[(ppsfs.length - 1) / 2] : (ppsfs[ppsfs.length / 2 - 1] + ppsfs[ppsfs.length / 2]) / 2
  // R6: the ARV anchors inside the ARV-qualified pool's price envelope
  // ±10% — the same bounds d7 measures (qualified comps' sale prices
  // widened 10%). With thin qualified evidence the picks' own envelope
  // binds instead — extrapolating past the top sale fails either way.
  // ARV prices off the ARV-qualified picks when they exist — doctrine:
  // "ARV comps that match our rules, if none then median." Median-of-all-
  // picks only anchors when the ARV band genuinely came up empty.
  const arvPicks = picks.filter((p) => arvPool.includes(p))
  const pricedPpsfs = (arvPicks.length >= 1 ? arvPicks : picks)
    .map((p) => p.ppsf).sort((a, b) => a - b)
  const pricingMedian = pricedPpsfs.length % 2
    ? pricedPpsfs[(pricedPpsfs.length - 1) / 2]
    : (pricedPpsfs[pricedPpsfs.length / 2 - 1] + pricedPpsfs[pricedPpsfs.length / 2]) / 2
  const rawArv = pricingMedian * (subject.squareFeet ?? 0)
  const qualifiedPrices = arvPool.map((r) => r.comp.salePrice!).filter((p) => p != null && p > 0)
  const envSource = qualifiedPrices.length >= 2 ? qualifiedPrices : picks.map((p) => p.comp.salePrice!)
  const prices = envSource.slice().sort((a, b) => a - b)
  const arv = Math.round(Math.min(Math.max(rawArv, prices[0] * 0.9), prices[prices.length - 1] * 1.1) / 500) * 500

  const bgPicks = picks.filter((p) => p.profile.geoTier === 'BLOCK_GROUP').length
  const medianFitness = picks.map((p) => p.comp.observables?.arvFitnessP ?? 0.5).sort((a, b) => a - b)[Math.floor((picks.length - 1) / 2)]
  const missingInPicks = picks.reduce((n, p) => n + p.audit.missingData.length, 0)
  const thinPool = picks.length < 2
  const staleDrivers = picks.some((p) =>
    driverIds.includes(p.id)
    && p.comp.saleDate != null
    && (Date.now() - new Date(p.comp.saleDate).getTime()) / 864e5 > evidence.rules.preferredSaleAgeDays * 2)
  const conf: AgentSelection['conf'] =
    thinPool || medianFallback || staleDrivers || missingInPicks > 0 ? 'low'
    : picks.length >= 3 && bgPicks >= 2 && medianFitness >= 0.6 ? 'high'
    : picks.length >= 2 ? 'medium'
    : 'low'

  // Per-pick recoverable differences ride as zero-dollar adjustment
  // notes — the audit trail says exactly what the pick adjusted for.
  const adjustments: AgentSelection['adjustments'] = {}
  for (const p of picks) {
    if (p.audit.recoverable.length || p.audit.missingData.length) {
      adjustments[p.id] = [
        ...p.audit.recoverable.map((r) => ({ type: 'recoverable_difference', amount: 0, note: r })),
        ...p.audit.missingData.map((m) => ({ type: 'missing_data', amount: 0, note: `${m} not on record` })),
      ]
    }
  }

  const selection: AgentSelection = {
    arv,
    conf,
    selectedCompIds: picks.map((p) => p.id),
    drivers: driverIds,
    ...(Object.keys(adjustments).length ? { adjustments } : {}),
    flags: [
      ...(medianFallback ? ['median_fallback'] : []),
      ...(thinPool ? ['thin_pocket'] : []),
      ...(staleDrivers ? ['stale_drivers'] : []),
      `price_groups:arv_$${Math.round(arvBand?.medianPpsf ?? 0)}/sf,median_$${Math.round(medianBand?.medianPpsf ?? 0)}/sf,asis_$${Math.round(asIsBand?.medianPpsf ?? 0)}/sf`,
      `pocket_base:$${Math.round(qualifiedMedianPpsf)}/sf(${medianScope},n=${medianBase.length})`,
    ],
    notes: `Deterministic selector (${medianFallback ? 'median-band fallback' : 'ARV band'}): ${picks.length} picks — ${bgPicks} block-group match(es), median $${Math.round(medianPpsf)}/sqft × ${subject.squareFeet}sqft subject. Groups: arv $${Math.round(arvBand?.medianPpsf ?? 0)}/sf · median $${Math.round(medianBand?.medianPpsf ?? 0)}/sf · as-is $${Math.round(asIsBand?.medianPpsf ?? 0)}/sf.`,
    dataQuality: {
      score: Math.min(10, Math.round((clean.length / Math.max(1, ranked.length)) * 10)),
      notes: `${clean.length}/${ranked.length} priced comps survived rule-out; ${arvBand?.n ?? 0} arv-band / ${medianBand?.n ?? 0} median-band / ${asIsBand?.n ?? 0} as-is-band; ${audits.filter((a) => a.verdict === 'excluded').length} excluded / ${audits.filter((a) => a.verdict === 'unpriceable').length} unpriceable / ${audits.filter((a) => a.missingData.length).length} with missing data.`,
    },
  }

  // Same coherence bounds + revision gate the model seat faced — enabled
  // comps only, priceable picks, d1–d8 checks. A reject gets deterministic
  // remedies: each gate complaint maps to a concrete re-derive (swap a
  // dead pick, re-anchor drivers in-pocket, re-clamp the ARV inside the
  // envelope) — instant, no model, ≤2 remedy cycles.
  // The gate's enabled set = preset-enabled ∪ R-eligible — a comp that
  // only failed preset tolerances (style/era/210d) is enabled evidence
  // here; its flags ride the pick as recoverable adjustments.
  const eligibleIds = new Set(
    ranked.filter((r) => r.audit.verdict !== 'excluded' && r.audit.verdict !== 'unpriceable').map((r) => String(r.id)))
  const gateComps = ctx.appraisalResult.comparables.map((c) =>
    c.id != null && !c.isEnabled && eligibleIds.has(String(c.id)) ? { ...c, isEnabled: true } : c)
  const enabledById = new Map(
    gateComps
      .filter((c) => c.isEnabled && c.id)
      .map((c) => [c.id!, c] as const))
  const inPocketIds = new Set(ranked.filter(inPocketPick).map((r) => r.id))
  let accepted = false
  let lastFails: string[] = []
  let verdict = selection
  // Grade against the R-eligible view: same evidence comps, but a comp
  // that only failed preset tolerances reads enabled here — otherwise
  // flaggedOutlier vetoes every expanded-pool pick on isEnabled alone.
  const gradeComps = evidence.comps.map((c) =>
    c.id != null && c.isEnabled === false && eligibleIds.has(String(c.id))
      ? { ...c, isEnabled: true }
      : c)
  const gradeEvidence = { ...evidence, comps: gradeComps }
  for (let cycle = 0; cycle <= 2; cycle++) {
    const fails = validateAgentSelection(verdict, gateComps)
    const grade = gradeVerdict(gradeEvidence, verdict)
    if (fails.length) {
      grade.failures.push('coherence_validation')
      grade.gateFails.push('validation')
      grade.gateFeedback.push(...fails)
    }
    const ok = fails.length === 0 && grade.gateFails.length === 0
    attempts.push({
      selection: verdict,
      grade,
      decision: ok ? 'accepted' : 'rejected',
      at: new Date().toISOString(),
    })
    if (ok) { accepted = true; break }
    lastFails = [...fails, ...grade.gateFeedback]
    if (cycle === 2) break
    const remedied = remedySelection(verdict, lastFails, {
      ordered, enabledById, inPocketIds, minDrivers: MIN_PICKS,
    })
    if (!remedied) break
    verdict = remedied
  }

  // The audit ledger rides debugNotes — every excluded comp names its
  // rule; the report trace shows the disprove-first path either way.
  const ledger = audits
    .filter((a) => a.verdict === 'excluded')
    .map((a) => `${a.id}: ${a.reasons.join('; ')}`)
  // Debug line: every comp the pocket test flags, its verdict, group and
  // flags — shows exactly why gate-pocket comps did or didn't pick.
  const pickIds = new Set(picks.map((p) => String(p.id)))
  const pocketLedger = ranked.filter(inPocket).map((r) =>
    `${r.id}:${r.audit.verdict}${r.group === 'bottom' ? ':bottom' : ''}${isAsIs(r) ? ':asis' : ''}${inBg(r) ? ':BG' : ':TRACT'}${pickIds.has(String(r.id)) ? ':PICKED' : ''}`)
  // Per-pick label dump — every pick shows its full label vector so the
  // audit explains exactly why one comp beat another.
  const pickLabels = picks.map((p) =>
    `${p.id}[${p.labels ? `${p.labels.geo}|sqft:${p.labels.sqft}|yr:${p.labels.year}|lot:${p.labels.lot}|price:${p.labels.pricePosition}→${p.labels.priceEvidence}|diffs:${p.labels.diffs}` : ''}]`)
  ledger.unshift(`labels: ${pickLabels.join(' ')}`)
  ledger.unshift(`pocket: ${pocketLedger.join(' ')}`)

  return {
    selection: accepted ? verdict : null,
    model: 'deterministic-selector',
    attempts,
    clarifications: [],
    debugNotes: lastFails.length ? [...lastFails, ...ledger] : accepted ? ledger : [...(attempts.at(-1)?.grade.gateFeedback ?? []), ...ledger],
    unavailable: false,
  }
}

/** Gate-feedback → deterministic fix. Every remedy is a pure re-derive on
 *  the ranked pool — replace a dead pick, re-anchor drivers in-pocket,
 *  re-clamp the ARV inside the pick envelope. Returns null when no
 *  feedback maps to a fixable cause (the honest reject stands). */
function remedySelection(
  sel: AgentSelection,
  feedback: string[],
  deps: {
    ordered: RankedComp[]
    enabledById: Map<string, AppraisedComparable>
    inPocketIds: Set<string>
    minDrivers: number
  },
): AgentSelection | null {
  const picks = [...sel.selectedCompIds]
  let drivers = [...(sel.drivers ?? [])]
  let arv = sel.arv
  let changed = false
  const removed = new Set<string>()
  const nextPick = () =>
    deps.ordered.find((r) => !picks.includes(r.id) && !removed.has(r.id) && deps.enabledById.has(r.id))?.id ?? null
  const pickPrices = () =>
    picks.map((id) => deps.enabledById.get(id)?.salePrice).filter((p): p is number => p != null && p > 0)
  for (const f of feedback) {
    // d1 — the gate names the pocket comps it wants picked; swap each
    // flagged driver for the first unpicked gate-pocket id.
    const d1 = /pricing comp (\S+).*?remain: ([0-9,\s…]+)/.exec(f)
    if (d1) {
      const off = d1[1]
      const pocketIds = d1[2].split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s))
      const swap = pocketIds.find((id) => !picks.includes(id) && deps.enabledById.has(id))
      if (swap) {
        const i = picks.indexOf(off)
        if (i >= 0) picks[i] = swap
        else if (!picks.includes(swap)) picks.push(swap)
        const di = drivers.indexOf(off)
        if (di >= 0) drivers[di] = swap
        else if (!drivers.includes(swap)) drivers.push(swap)
        removed.add(off)
        changed = true
      }
      continue
    }
    // d2 — vetoed pick: drop it and refill from the ranked pool.
    const d2 = /pick (\S+) \([^)]*\) is not market evidence/.exec(f)
    if (d2) {
      const i = picks.indexOf(d2[1])
      if (i >= 0) {
        removed.add(d2[1])
        const next = nextPick()
        if (next) picks[i] = next
        else picks.splice(i, 1)
        drivers = drivers.filter((d) => d !== d2[1])
        changed = true
      }
      continue
    }
    const notEnabled = /selected comp (\S+) is not an enabled pool member/.exec(f)
    if (notEnabled) {
      const next = deps.ordered.find((r) => !picks.includes(r.id) && deps.enabledById.has(r.id))
      const i = picks.indexOf(notEnabled[1])
      if (i >= 0) { if (next) picks[i] = next.id; else picks.splice(i, 1); changed = true }
      continue
    }
    if (/driver (\S+) is not in selectedCompIds/.test(f)) {
      drivers = drivers.filter((d) => picks.includes(d))
      changed = true
      continue
    }
    if (/outside the selected-evidence envelope/i.test(f)) {
      const prices = pickPrices()
      if (prices.length) {
        const clamped = Math.round(Math.min(Math.max(arv, Math.min(...prices) * 0.75), Math.max(...prices) * 1.25) / 500) * 500
        if (clamped !== arv) { arv = clamped; changed = true }
      }
      continue
    }
    // Pocket anchoring — drivers must be in-pocket picks
    if (/outside.*pocket|driver.*pocket|pocket.*driver|off.pocket.*driver/i.test(f)) {
      const inP = picks.filter((id) => deps.inPocketIds.has(id))
      const nd = inP.length ? inP.slice(0, deps.minDrivers) : picks.slice(0, deps.minDrivers)
      if (nd.join() !== drivers.join()) { drivers = nd; changed = true }
      continue
    }
    // ARV extrapolating past the pick envelope — clamp inside it
    if (/extrapolat|above the (envelope|top)|beyond the/i.test(f)) {
      const prices = pickPrices()
      if (prices.length) {
        const clamped = Math.round(Math.min(Math.max(arv, Math.min(...prices)), Math.max(...prices)) / 500) * 500
        if (clamped !== arv) { arv = clamped; changed = true }
      }
    }
  }
  // Drivers must live inside picks and stay minDrivers deep — pocket
  // members first, then the pick order.
  drivers = drivers.filter((d) => picks.includes(d))
  const inP = picks.filter((id) => deps.inPocketIds.has(id) && !drivers.includes(id))
  drivers = [...drivers, ...inP, ...picks.filter((p) => !drivers.includes(p) && !inP.includes(p))]
    .slice(0, deps.minDrivers)
  if (!drivers.length && picks.length) drivers = picks.slice(0, deps.minDrivers)
  if (!changed && drivers.join() !== (sel.drivers ?? []).join()) changed = true
  return changed ? { ...sel, selectedCompIds: picks, drivers, arv } : null
}
