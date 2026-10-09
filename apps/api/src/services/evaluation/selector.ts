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
 *   R3 sale recency — inside 2× preferred window or it drops;
 *      stale-but-usable is a recoverable caution.
 *   R4 anomaly — divergent AVM, unexplained premium, investor-band
 *      pricing, hard shared exclusions.
 *   R5 condition band — ARV picks come from after_renovation stock,
 *      transitional = median fallback, as_is never picks.
 *   R6 price envelope — the posted ARV anchors inside the picks'
 *      sale-price envelope ±10% (d7).
 *
 * The same d1–d8 gate that grades a model verdict verifies the pick;
 * a reject completes on the deterministic engine — Sonnet never engages.
 */

import { gradeVerdict } from './verdict-grade'
import { compMatchProfile } from './observable'
import { exclusionReasons } from './appraiser'
import { validateAgentSelection } from './index'
import type { AgentSelection, HarnessEvidence, Phase1Context, SelectionAttempt } from './index'
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

const MAX_PICKS = 6
const MIN_PICKS = 3
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

interface RankedComp {
  id: string
  comp: HarnessEvidence['comps'][number]
  profile: CompMatchProfile
  group: PriceGroup
  ppsf: number
  audit: CompAudit
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
 *  comp with stucco-over-frame is a price-tweak, not a lost comp. */
function physicalEligibility(p: CompMatchProfile): { excludes: string[]; recoverable: string[] } {
  const excludes: string[] = []
  const recoverable: string[] = []
  const band = (v: number | null, name: string, b: { recoverable: number; disqualifying: number }, unit: string) => {
    if (v == null) return
    const a = Math.abs(v)
    if (a > b.disqualifying) excludes.push(`R2 ${name} ${v > 0 ? '+' : ''}${Math.round(v)}${unit} beyond ±${b.disqualifying}${unit}`)
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
  const pool = evidence.comps.filter((c) => c.isEnabled && c.id)
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
    const phys = physicalEligibility(profile)
    if (phys.excludes.length) {
      audit.verdict = 'excluded'
      audit.rules.push('R2')
      audit.reasons.push(...phys.excludes)
      ranked.push({ id: comp.id!, comp, profile, group, ppsf, audit })
      continue
    }
    audit.recoverable.push(...phys.recoverable)

    // R3 sale recency — beyond 2× the preferred window drops outright;
    // inside it the staleness is a recoverable caution.
    const ageDays = comp.saleDate ? Math.floor((Date.now() - new Date(comp.saleDate).getTime()) / 864e5) : null
    const window = evidence.rules.preferredSaleAgeDays
    if (ageDays != null && ageDays > window * 2) {
      audit.verdict = 'excluded'
      audit.rules.push('R3')
      audit.reasons.push(`R3 stale sale ${ageDays}d — beyond 2×${window}d`)
      ranked.push({ id: comp.id!, comp, profile, group, ppsf, audit })
      continue
    }
    if (ageDays != null && ageDays > window) audit.recoverable.push(`stale ${ageDays}d vs ${window}d`)

    // R4 anomalies + the shared hard exclusions (investor-band, divergent
    // price, non-market sale). 'caution:'/'weak geo' stay advisory.
    const anomalies = anomaliesOf(comp)
    const shared = exclusionReasons(comp, evidence)
      .filter((r) => !r.startsWith('caution') && !r.startsWith('weak geo'))
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
    ranked.push({ id: comp.id!, comp, profile, group, ppsf, audit })
  }

  const clean = ranked.filter((r) => r.audit.verdict === 'eligible')
  // The three price groups the run reports — ARV band / median / as-is —
  // over clean comps only (outliers never set the bands).
  const groupStats = (g: PriceGroup) => {
    const xs = clean.filter((r) => r.group === g).map((r) => r.ppsf).sort((a, b) => a - b)
    return xs.length ? { n: xs.length, medianPpsf: xs[Math.floor((xs.length - 1) / 2)] } : null
  }
  const arvBand = groupStats('top')
  const medianBand = groupStats('middle')
  const asIsBand = groupStats('bottom')

  // Disprove-first ordering inside a band: geo tier outranks everything,
  // then ARV-fitness, physical similarity, and price position.
  const rank = (a: RankedComp, b: RankedComp) =>
    GEO_TIER_RANK[a.profile.geoTier] - GEO_TIER_RANK[b.profile.geoTier]
    || (b.comp.observables?.arvFitnessP ?? 0.5) - (a.comp.observables?.arvFitnessP ?? 0.5)
    || (b.comp.observables?.physicalMatchP ?? 0.5) - (a.comp.observables?.physicalMatchP ?? 0.5)
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
    (!condClass(r) && r.group === 'top')
  for (const r of clean) if (isAsIs(r)) r.audit.rules.push('R5:as-is-band')
  const arvPool = clean.filter((r) => !isAsIs(r) && isRenovated(r)).sort(rank)
  const medianPool = clean.filter((r) => !isAsIs(r) && !isRenovated(r)).sort(rank)
  const medianFallback = arvPool.length < MIN_PICKS

  // d1 pocket anchoring — pricing weight stays in the block group (or the
  // tract when the pool has no BG comps at all). Mirrors verdict-grade:
  // a driver outside the pocket fails while any in-pocket comp remains
  // unpicked, so in-pocket comps fill picks FIRST — across both bands —
  // and drivers are only ever in-pocket picks. Off-pocket picks stay
  // supporting evidence (a warn at most).
  const subjectTract = (subject.censusTract as string | null | undefined) ?? null
  const inBg = (r: RankedComp) =>
    r.comp.sameBlockGroup === true || r.profile.geoTier === 'BLOCK_GROUP'
  const inPocket = (r: RankedComp) =>
    inBg(r) || r.profile.geoTier === 'TRACT' ||
    (subjectTract != null && r.comp.censusTract === subjectTract)
  const bgExists = ranked.some(inBg)
  const inPocketPick = (r: RankedComp) => (bgExists ? inBg(r) : inPocket(r))

  // Picks: ARV-qualified comps always join the set first (even below
  // MIN_PICKS — d4 wants every qualified comp used), then in-pocket
  // comps from either band, then the remaining median fill.
  const pocketPicks = clean.filter(inPocketPick).sort(rank)
  const ordered = [
    ...arvPool.filter(inPocketPick),
    ...arvPool.filter((r) => !inPocketPick(r)),
    ...pocketPicks.filter((r) => !arvPool.includes(r)),
    ...medianPool.filter((r) => !inPocketPick(r)),
  ]
  const picks = ordered.slice(0, MAX_PICKS)
  // Drivers carry the pricing weight — in-pocket only. When the pool has
  // zero clean in-pocket comps we fall back to the raw ranking and let
  // the gate grade the pocket risk honestly.
  const driverIds = picks.filter(inPocketPick).slice(0, MIN_PICKS).map((p) => p.id)
  if (driverIds.length === 0) driverIds.push(...picks.slice(0, MIN_PICKS).map((p) => p.id))
  for (const p of picks) p.audit.verdict = 'picked'

  const attempts: SelectionAttempt[] = []
  if (picks.length < MIN_PICKS || !subject.squareFeet) {
    return {
      selection: null,
      model: 'deterministic-selector',
      attempts,
      clarifications: [],
      debugNotes: [
        `selector: ${picks.length} qualified comps in ${medianFallback ? 'median' : 'arv'} band — needs ${MIN_PICKS}+`,
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
  const rawArv = medianPpsf * (subject.squareFeet ?? 0)
  const qualifiedPrices = arvPool.map((r) => r.comp.salePrice!).filter((p) => p != null && p > 0)
  const envSource = qualifiedPrices.length >= 2 ? qualifiedPrices : picks.map((p) => p.comp.salePrice!)
  const prices = envSource.slice().sort((a, b) => a - b)
  const arv = Math.round(Math.min(Math.max(rawArv, prices[0] * 0.9), prices[prices.length - 1] * 1.1) / 500) * 500

  const bgPicks = picks.filter((p) => p.profile.geoTier === 'BLOCK_GROUP').length
  const medianFitness = picks.map((p) => p.comp.observables?.arvFitnessP ?? 0.5).sort((a, b) => a - b)[Math.floor((picks.length - 1) / 2)]
  const missingInPicks = picks.reduce((n, p) => n + p.audit.missingData.length, 0)
  const conf: AgentSelection['conf'] =
    medianFallback || missingInPicks > 0 ? 'low'
    : picks.length >= 4 && bgPicks >= 2 && medianFitness >= 0.6 ? 'high'
    : picks.length >= 3 ? 'medium'
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
      `price_groups:arv_$${Math.round(arvBand?.medianPpsf ?? 0)}/sf,median_$${Math.round(medianBand?.medianPpsf ?? 0)}/sf,asis_$${Math.round(asIsBand?.medianPpsf ?? 0)}/sf`,
    ],
    notes: `Deterministic selector (${medianFallback ? 'median-band fallback' : 'ARV band'}): ${picks.length} picks — ${bgPicks} block-group match(es), median $${Math.round(medianPpsf)}/sqft × ${subject.squareFeet}sqft subject. Groups: arv $${Math.round(arvBand?.medianPpsf ?? 0)}/sf · median $${Math.round(medianBand?.medianPpsf ?? 0)}/sf · as-is $${Math.round(asIsBand?.medianPpsf ?? 0)}/sf.`,
    dataQuality: {
      score: Math.min(10, Math.round((clean.length / Math.max(1, ranked.length)) * 10)),
      notes: `${clean.length}/${ranked.length} priced comps survived rule-out; ${arvBand?.n ?? 0} arv-band / ${medianBand?.n ?? 0} median-band / ${asIsBand?.n ?? 0} as-is-band; ${audits.filter((a) => a.verdict === 'excluded').length} excluded / ${audits.filter((a) => a.verdict === 'unpriceable').length} unpriceable / ${audits.filter((a) => a.missingData.length).length} with missing data.`,
    },
  }

  // Same coherence bounds + revision gate the model seat faced — enabled
  // comps only, priceable picks, d1–d8 checks.
  const fails = validateAgentSelection(selection, ctx.appraisalResult.comparables)
  const grade = gradeVerdict(evidence, selection)
  if (fails.length) {
    grade.failures.push('coherence_validation')
    grade.gateFails.push('validation')
    grade.gateFeedback.push(...fails)
  }
  const accepted = fails.length === 0 && grade.gateFails.length === 0
  attempts.push({
    selection,
    grade,
    decision: accepted ? 'accepted' : 'rejected',
    at: new Date().toISOString(),
  })

  // The audit ledger rides debugNotes — every excluded comp names its
  // rule; the report trace shows the disprove-first path either way.
  const ledger = audits
    .filter((a) => a.verdict === 'excluded')
    .map((a) => `${a.id}: ${a.reasons.join('; ')}`)

  return {
    selection: accepted ? selection : null,
    model: 'deterministic-selector',
    attempts,
    clarifications: [],
    debugNotes: fails.length ? fails : accepted ? ledger : [...grade.gateFeedback, ...ledger],
    unavailable: false,
  }
}
