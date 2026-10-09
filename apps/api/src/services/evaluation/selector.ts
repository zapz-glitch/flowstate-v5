/**
 * The deterministic selector — the comp-selection seat of the corelogic
 * harness. No model in the final decision: code already carries every
 * signal the pick needs (geo match tiers from census geocoding +
 * CoreLogic subdivision, the block ladder's arv/median/as-is price
 * groups, Decisions' arvFitnessP/physicalMatchP/anomaly probabilities),
 * so it disproves and ranks without an appraiser call. The same d1–d8
 * gate that grades a model verdict verifies the pick; a gate reject
 * completes on the deterministic engine — Sonnet never engages.
 *
 * Flow: price-group every comp (top=ARV band, middle=median, bottom=as-is)
 * → rule out anomalies (divergent AVM, unexplained premium, investor-band
 * pricing, off-pocket geo) → pick ARV comps that match the rules → if
 * none qualify, the median group answers instead.
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

const MAX_PICKS = 6
const MIN_PICKS = 3
/** Extreme-variance anomaly threshold — a comp this likely to carry an
 *  unexplained premium never makes the ARV pool. */
const ANOMALY_P = 0.7

interface RankedComp {
  id: string
  comp: HarnessEvidence['comps'][number]
  profile: CompMatchProfile
  group: PriceGroup
  ppsf: number
  anomalies: string[]
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

/** Anomaly rule-out — runs BEFORE ranking, independent of the shared
 *  exclusion reasons: the outsized-premium sales and AVM contradictions
 *  that make a comp unpriceable evidence even inside the pocket. */
function anomaliesOf(comp: HarnessEvidence['comps'][number]): string[] {
  const anomalies: string[] = []
  const v = comp.evidenceVerification as Record<string, unknown> | null | undefined
  if (v?.priceCheck === 'divergent') anomalies.push('price contradicts its own AVM')
  const up = comp.observables?.unexplainedPremiumP
  if (typeof up === 'number' && up >= ANOMALY_P) {
    anomalies.push(`unexplained premium (p=${up.toFixed(2)}) — extreme variance vs the pocket`)
  }
  return anomalies
}

/** Post the code-computed selection as an AppraiserResult so the gate
 *  ladder, trace shape, and trust floor stay identical to a model run. */
export function runDeterministicSelector(
  ctx: Phase1Context,
  evidence: HarnessEvidence,
): AppraiserResult {
  const pool = evidence.comps.filter((c) => c.isEnabled && c.id)
  const ranked: RankedComp[] = []
  for (const comp of pool) {
    const ppsf = comp.salePrice != null && comp.squareFeet != null && comp.squareFeet > 0
      ? comp.salePrice / comp.squareFeet : 0
    if (!(ppsf > 0)) continue
    const profile = compMatchProfile(evidence.subject, comp)
    const anomalies = anomaliesOf(comp)
    // 'caution:' and 'weak geo' reasons are advisory — a tract-level
    // match is the pocket's floor when the ladder itself is tract-scoped;
    // it ranks last via geoTier, not out of the pool entirely.
    const reasons = exclusionReasons(comp, evidence)
      .filter((r) => !r.startsWith('caution') && !r.startsWith('weak geo'))
    anomalies.push(...reasons)
    ranked.push({ id: comp.id!, comp, profile, group: priceGroupOf(comp), ppsf, anomalies })
  }

  const clean = ranked.filter((r) => r.anomalies.length === 0)
  // The three price groups the run reports — ARV band / median / as-is —
  // over anomaly-clean comps only (outliers never set the bands).
  const groupStats = (g: PriceGroup) => {
    const xs = clean.filter((r) => r.group === g).map((r) => r.ppsf).sort((a, b) => a - b)
    return xs.length ? { n: xs.length, medianPpsf: xs[Math.floor((xs.length - 1) / 2)] } : null
  }
  const arvBand = groupStats('top')
  const medianBand = groupStats('middle')
  const asIsBand = groupStats('bottom')

  // Disprove-first ordering inside a group: geo tier outranks everything,
  // then ARV-fitness, physical similarity, and price position.
  const rank = (a: RankedComp, b: RankedComp) =>
    GEO_TIER_RANK[a.profile.geoTier] - GEO_TIER_RANK[b.profile.geoTier]
    || (b.comp.observables?.arvFitnessP ?? 0.5) - (a.comp.observables?.arvFitnessP ?? 0.5)
    || (b.comp.observables?.physicalMatchP ?? 0.5) - (a.comp.observables?.physicalMatchP ?? 0.5)
    || b.ppsf - a.ppsf

  // Condition band decides the pick pool, not just price band — an
  // as-is/distressed sale at median price is still as-is evidence and
  // cannot drive an ARV verdict (d4). ARV picks come from renovated
  // stock; the median fallback draws on ordinary-market (transitional)
  // sales; as-is comps are reported as the as-is band, never picked.
  const condClass = (r: RankedComp): string | null =>
    (r.comp.classification as { type?: string } | null | undefined)?.type ?? null
  const isAsIs = (r: RankedComp) => condClass(r) === 'as_is'
  const isRenovated = (r: RankedComp) =>
    condClass(r) === 'after_renovation' || (!condClass(r) && r.group === 'top')
  const arvPool = clean.filter((r) => !isAsIs(r) && isRenovated(r)).sort(rank)
  const medianPool = clean.filter((r) => !isAsIs(r) && !isRenovated(r)).sort(rank)
  const medianFallback = arvPool.length < MIN_PICKS
  const picks = (medianFallback ? medianPool : arvPool).slice(0, MAX_PICKS)

  const attempts: SelectionAttempt[] = []
  if (picks.length < MIN_PICKS || !evidence.subject.squareFeet) {
    return {
      selection: null,
      model: 'deterministic-selector',
      attempts,
      clarifications: [],
      debugNotes: [
        `selector: ${picks.length} qualified comps in ${medianFallback ? 'median' : 'arv'} band — needs ${MIN_PICKS}+`,
        `groups: arv=${arvBand?.n ?? 0} median=${medianBand?.n ?? 0} as-is=${asIsBand?.n ?? 0} of ${ranked.length} priced`,
        ...ranked.filter((r) => r.anomalies.length > 0).slice(0, 8).map((r) => `${r.id}: ${r.anomalies.join('; ')}`),
      ],
      unavailable: false,
    }
  }

  const ppsfs = picks.map((p) => p.ppsf).sort((a, b) => a - b)
  const medianPpsf = ppsfs.length % 2 ? ppsfs[(ppsfs.length - 1) / 2] : (ppsfs[ppsfs.length / 2 - 1] + ppsfs[ppsfs.length / 2]) / 2
  // d7: the ARV must anchor inside the picks' price envelope ±10% —
  // a large subject on small comps would otherwise extrapolate past
  // the top sale. $/sqft suggests; the envelope binds.
  const rawArv = medianPpsf * (evidence.subject.squareFeet ?? 0)
  const prices = picks.map((p) => p.comp.salePrice!).sort((a, b) => a - b)
  const arv = Math.round(Math.min(Math.max(rawArv, prices[0] * 0.9), prices[prices.length - 1] * 1.1) / 500) * 500

  const bgPicks = picks.filter((p) => p.profile.geoTier === 'BLOCK_GROUP').length
  const medianFitness = picks.map((p) => p.comp.observables?.arvFitnessP ?? 0.5).sort((a, b) => a - b)[Math.floor((picks.length - 1) / 2)]
  const conf: AgentSelection['conf'] =
    medianFallback ? 'low'
    : picks.length >= 4 && bgPicks >= 2 && medianFitness >= 0.6 ? 'high'
    : picks.length >= 3 ? 'medium'
    : 'low'

  const selection: AgentSelection = {
    arv,
    conf,
    selectedCompIds: picks.map((p) => p.id),
    drivers: picks.slice(0, MIN_PICKS).map((p) => p.id),
    flags: [
      ...(medianFallback ? ['median_fallback'] : []),
      `price_groups:arv_$${Math.round(arvBand?.medianPpsf ?? 0)}/sf,median_$${Math.round(medianBand?.medianPpsf ?? 0)}/sf,asis_$${Math.round(asIsBand?.medianPpsf ?? 0)}/sf`,
    ],
    notes: `Deterministic selector (${medianFallback ? 'median-band fallback' : 'ARV band'}): ${picks.length} picks — ${bgPicks} block-group match(es), median $${Math.round(medianPpsf)}/sqft × ${evidence.subject.squareFeet}sqft subject. Groups: arv $${Math.round(arvBand?.medianPpsf ?? 0)}/sf · median $${Math.round(medianBand?.medianPpsf ?? 0)}/sf · as-is $${Math.round(asIsBand?.medianPpsf ?? 0)}/sf.`,
    dataQuality: {
      score: Math.min(10, Math.round((clean.length / Math.max(1, ranked.length)) * 10)),
      notes: `${clean.length}/${ranked.length} priced comps survived anomaly rule-out; ${arvBand?.n ?? 0} arv-band / ${medianBand?.n ?? 0} median-band / ${asIsBand?.n ?? 0} as-is-band.`,
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

  return {
    selection: accepted ? selection : null,
    model: 'deterministic-selector',
    attempts,
    clarifications: [],
    debugNotes: fails.length ? fails : grade.gateFeedback,
    unavailable: false,
  }
}
