/**
 * Decisions seat — the finale lane's pick step. TypeScript labels every
 * data set (runDeterministicSelector's audits, geo/physical/price/pocket
 * labels, feature matches); proto's observables lane already stamped each
 * comp's Decisions prior (condition, price position, premium, exposure)
 * into evidence. This seat asks the Decisions API one predicate per
 * candidate — "an apples-to-apples comp for the subject at above-market
 * or at-market price" — and picks the highest-probability comps. ARV is
 * deterministic implied-value math on the picks; the model selects, code
 * prices. A missing/malformed answer keeps the deterministic selection —
 * honest degrade, never invented data.
 */
import { decisionsRun, isDecisionsAvailable, type DecisionsEnv } from '../decisions'
import type { Phase1Context, HarnessEvidence } from './index'
import type { AppraiserResult } from './appraiser'
import { runDeterministicSelector, type PocketValues, type RankedComp } from './selector'

const SEAT_CAP = 10
/** A pick needs real support — below the floor the deterministic seat keeps the pick. */
const PROB_FLOOR = 0.4
const GEO_RANK: Record<string, number> = { BLOCK_GROUP: 0, NEIGHBORHOOD: 1, SUBDIVISION: 2, TRACT: 3, OFF_POCKET: 4 }

/** Price point in the spec's vocabulary — price labels are facts:
 *  ARV-priced evidence = above market, median-priced = at market,
 *  as-is/distressed = below market. Below market can never price ARV. */
function pricePoint(r: RankedComp): 'above_market' | 'at_market' | 'below_market' {
  const pe = r.labels?.priceEvidence
  if (pe === 'arv') return 'above_market'
  if (pe === 'as_is' || pe === 'none') return 'below_market'
  return 'at_market'
}

/** Marginal-sqft contributory value — same appraiser taper as the type
 *  lane: excess/missing size contributes 50%/40%/30% of $/sf by gap size. */
function impliedValue(r: RankedComp, subjectSqft: number | null): number | null {
  if (!subjectSqft || !r.comp.squareFeet || !r.comp.salePrice || r.ppsf <= 0) return null
  const gap = subjectSqft - r.comp.squareFeet
  const gapPct = Math.abs(gap) / r.comp.squareFeet
  const rate = gapPct <= 0.10 ? 0.5 : gapPct <= 0.25 ? 0.4 : 0.3
  return Math.round(r.comp.salePrice + gap * r.ppsf * rate)
}

export async function runDecisionsSeat(
  env: DecisionsEnv,
  ctx: Phase1Context,
  evidence: HarnessEvidence,
): Promise<AppraiserResult> {
  let ranked: RankedComp[] = []
  let pocket: PocketValues | null = null
  const base = runDeterministicSelector(ctx, evidence, {
    // Pocket-relative band — both tails are outliers: too high can never
    // be evidence for this pocket, too low is as-is/distress priced.
    priceBand: { upper: 2.0, lower: 0.5 },
    pocketValueGate: true,
    onRanked: (r, p) => { ranked = r; pocket = p },
  })
  const pv = pocket as PocketValues | null
  if (pv) {
    const fmt = (g: PocketValues['blocks']) => g.slice(0, 6).map((x) => `${x.subject ? '*' : ''}${x.key}:$${x.medianPpsf}/sf n${x.n} ${x.ratio}x`).join(', ')
    base.debugNotes.push(`pocket-value: $${pv.pocketPpsf}/sf (${pv.scope}, n=${pv.pocketN}) · blocks [${fmt(pv.blocks)}] · hoods [${fmt(pv.neighborhoods)}]`)
  }
  // Band/gate exclusions must survive a seat fallback: disable excluded
  // comps so an outlier can never drive the Set-B fallback ARV.
  for (const r of ranked) {
    if (r.audit.verdict === 'excluded' && r.comp.isEnabled !== false) r.comp.isEnabled = false
  }

  if (!isDecisionsAvailable(env)) {
    base.debugNotes.push('decisions-seat: no OPENAI_API_KEY — deterministic seat')
    return base
  }

  const subject = evidence.subject
  const subjSqft = subject.squareFeet ?? null
  const subjectYear = subject.yearBuilt ?? null
  const evidenceRank = (r: RankedComp) =>
    r.labels?.priceEvidence === 'arv' ? 0 : r.labels?.priceEvidence === 'median' ? 1 : 2
  const eligible = ranked
    .filter((r) => r.audit.verdict === 'eligible' || r.audit.verdict === 'picked')
    .sort((a, b) =>
      evidenceRank(a) - evidenceRank(b)
      || (a.labels?.diffs ?? 9) - (b.labels?.diffs ?? 9)
      || (GEO_RANK[a.profile.geoTier] ?? 9) - (GEO_RANK[b.profile.geoTier] ?? 9)
      || String(b.comp.saleDate ?? '').localeCompare(String(a.comp.saleDate ?? '')))
    .slice(0, SEAT_CAP)
  if (eligible.length === 0) {
    base.debugNotes.push('decisions-seat: 0 eligible comps — deterministic seat')
    return base
  }
  base.debugNotes.push(`decisions-seat: seat call → ${eligible.length} candidates (ranked=${ranked.length})`)

  // Every fact the model needs already lives in the row: the TS labels,
  // the observables prior (proto's Decisions reads — condition, price
  // position, premium/exposure), and the pocket proof. The seat reads the
  // totality of each comp's dataset, not a hand-picked field.
  const subjectObs = evidence.subjectObservables ?? null
  const rows = eligible.map((r) => {
    const l = r.labels
    const ob = r.comp.observables ?? null
    const pp = pricePoint(r)
    return {
      id: r.id,
      pricePoint: pp,
      salePrice: r.comp.salePrice,
      implied: impliedValue(r, subjSqft),
      ppsf: Math.round(r.ppsf),
      sqft: r.comp.squareFeet,
      beds: r.comp.bedrooms,
      baths: r.comp.bathrooms,
      yearBuilt: r.comp.yearBuilt,
      lotSqft: r.comp.lotSizeSquareFeet,
      saleDate: r.comp.saleDate,
      distMi: r.comp.distanceMiles != null ? Math.round(r.comp.distanceMiles * 10) / 10 : null,
      geo: l?.geo ?? r.profile.geoTier,
      block: (r.comp as { censusBlockGroup?: string | null }).censusBlockGroup ?? null,
      hood: r.comp.neighborhoodName ?? r.comp.subdivision ?? null,
      lbl: l ? `sqft:${l.sqft}|yr:${l.year}|lot:${l.lot}|style:${l.style}|feat:${l.feat}|sale:${l.saleAge}|${l.pricePosition}→${l.priceEvidence}|${l.sanity}|diffs:${l.diffs}` : '',
      // Decisions prior — stamped by the observables lane. Every probability
      // the earlier passes produced lands on the row: condition reads, the
      // premium/exposure reads, physical-match and ARV-fitness scores, and
      // the per-attribute lot-premium odds (waterfront / corner-cul-de-sac
      // / large lot / view / pool).
      prior: ob ? {
        pricePosition: ob.pricePosition, priceSupport: ob.priceSupport,
        descCondition: ob.descCondition, coverEvidence: ob.coverPhotoEvidence,
        conditionTier: ob.conditionTier, renoClaimP: ob.renoClaimP,
        premium: ob.premiumAttributes, premiumP: ob.premiumProbabilities ?? null,
        exposure: ob.siteExposure, vintage: ob.developmentVintage,
        physicalMatchP: ob.physicalMatchP, arvFitnessP: ob.arvFitnessP,
        unexplainedPremiumP: ob.unexplainedPremiumP,
        tier: ob.finalTier,
      } : null,
    }
  })

  const state = {
    task:
      'Each question names a comparable sale and asks whether it is an ' +
      'apples-to-apples ARV comparable for the subject at above-market or ' +
      'at-market pricing. The labeled facts are the dataset — price labels ' +
      'are facts (pricePoint below_market can NEVER price ARV), condition ' +
      'fields are evidence you weigh. An apples-to-apples comp is: in the ' +
      'subject pocket (or a pocket whose value proved similar — the row ' +
      'passed R9), physically close on the big items (size, era, style, ' +
      'pool/construction/garage matches), a plausible non-distressed sale, ' +
      'and priced at or above the pocket median. Answer the probability ' +
      'the comp qualifies as ARV evidence for THIS subject.',
    // The entire subject profile the candidates are judged against — the
    // model answers 'how well does this comp represent THIS property'.
    subject: {
      address: subject.address, sqft: subject.squareFeet, beds: subject.bedrooms,
      baths: subject.bathrooms, yearBuilt: subject.yearBuilt, lotSqft: subject.lotSizeSquareFeet,
      stories: subject.stories ?? null, propertyType: (subject as { propertyType?: string | null }).propertyType ?? null,
      construction: subject.constructionType ?? null, foundation: (subject as { foundationType?: string | null }).foundationType ?? null,
      pool: (subject as { poolType?: string | null }).poolType ?? null,
      garage: (subject as { garageType?: string | null }).garageType ?? null,
      condition: subject.condition ?? null,
      renoTier: subjectObs?.renovationTier ?? null,
      renoEvidenceP: subjectObs?.renoEvidenceP ?? null,
      lotPremium: subjectObs?.lotPremium ?? null,
      lotPremiumP: subjectObs?.lotPremiumProbabilities ?? null,
      siteExposure: subjectObs?.siteExposure ?? null,
      edgeNorthP: subjectObs?.siteEdges?.north ?? 0,
      edgeEastP:  subjectObs?.siteEdges?.east  ?? 0,
      edgeSouthP: subjectObs?.siteEdges?.south ?? 0,
      edgeWestP:  subjectObs?.siteEdges?.west  ?? 0,
      streetEdge: subjectObs?.siteEdges?.streetEdge ?? null,
    },
    pocket: pv ? { scope: pv.scope, medianPpsf: pv.pocketPpsf, n: pv.pocketN } : null,
    candidates: rows,
  }

  const questions: Record<string, { type: 'noul'; instructions: string }> = {}
  for (const row of rows) {
    // rep — does this comp REPRESENT the subject? Physical characteristics,
    // location, classification — price blind.
    questions[`rep_${row.id}`] = {
      type: 'noul',
      instructions:
        `Comp ${row.id}: probability this property is a good representation ` +
        `of the subject — same kind of house in a similar-value location. ` +
        `Weigh sqft/year/lot/style/feature labels, stories/construction/` +
        `foundation/pool/garage matches, physicalMatchP, development ` +
        `vintage and geo tier. Ignore sale price entirely.`,
    }
    // fit — can this comp's PRICE evidence drive the subject's ARV? Above
    // market or at market only; below-market labels are disqualifying.
    questions[`fit_${row.id}`] = {
      type: 'noul',
      instructions:
        `Comp ${row.id}: probability this is an apples-to-apples ARV ` +
        `comparable for the subject at above-market or at-market price. ` +
        `pricePoint=${row.pricePoint} — if below_market the answer is ~0. ` +
        `Weigh its price evidence, sale age, price sanity, condition ` +
        `evidence and ARV fitness prior.`,
    }
  }
  // The seat also answers one summary question — its probability the pick
  // set is complete doubles as run confidence.
  questions['pool_quality'] = {
    type: 'noul',
    instructions:
      'Overall: how confident are you that this candidate set contains ' +
      'enough true apples-to-apples comps to price the subject\'s ARV? ' +
      'High when multiple in-pocket matches exist; low when the pool is ' +
      'thin or foreign-pocket.',
  }

  try {
    const res = await decisionsRun(env, { state, questions })
    const answers = res.answers ?? {}
    const prob = (name: string): number | null => {
      const a = answers[name] as { probability?: number } | undefined
      return typeof a?.probability === 'number' ? a.probability : null
    }
    const scored = eligible
      .map((r) => ({ r, fit: prob(`fit_${r.id}`), rep: prob(`rep_${r.id}`) }))
      .filter((x): x is { r: RankedComp; fit: number; rep: number } => x.fit != null && x.rep != null)
    if (!scored.length) {
      base.debugNotes.push('decisions-seat: no probabilities returned — deterministic seat')
      return base
    }
    // Below-market labels are facts — a distressed/as-is sale can support
    // the floor but can never be an ARV pick regardless of probability.
    // Rank on min(rep, fit): a pick must BOTH represent the subject AND
    // price it — the weaker leg bounds the comp.
    const pickable = scored
      .filter((x) => pricePoint(x.r) !== 'below_market')
      .map((x) => ({ ...x, p: Math.min(x.fit, x.rep) }))
      .sort((a, b) => b.p - a.p)
    const over = pickable.filter((x) => x.p >= PROB_FLOOR).slice(0, 3)
    const picks = over.length ? over : pickable.slice(0, 1)
    if (!picks.length) {
      base.debugNotes.push('decisions-seat: every candidate below-market — deterministic seat')
      return base
    }
    const ids = picks.map((x) => x.r.id)
    // A seat pick IS the ARV evidence — re-enable it on the saved pool
    // (an upstream audit may have disabled it) so the card, enabledCount
    // and the enabled-comp Set-B path all see the selection.
    for (const x of picks) {
      x.r.comp.isEnabled = true
      delete (x.r.comp as { disableReasons?: string[] }).disableReasons
      // The saved pool reads appraisalResult.comparables — a different
      // object set than evidence.comps. Flip the same comp there too.
      const appraised = ctx.appraisalResult?.comparables?.find((c) => c.id === x.r.id)
      if (appraised) {
        appraised.isEnabled = true
        ;(appraised as { seatPick?: boolean }).seatPick = true
        if (appraised.evaluation) appraised.evaluation.disableReasons = []
      }
    }
    // A landed pick IS ARV evidence — the pre-seat insufficient verdict no
    // longer describes this run.
    if (ctx.appraisalResult) ctx.appraisalResult.insufficientComps = false
    // ARV is code: median implied value of the picks (marginal-sqft taper),
    // clamped inside the picks' own sale-price envelope for the gate.
    const implieds = picks
      .map((x) => impliedValue(x.r, subjSqft) ?? (x.r.ppsf * (subjSqft ?? x.r.comp.squareFeet ?? 0)))
      .filter((v) => v > 0).sort((a, b) => a - b)
    let arv = implieds.length ? Math.round(implieds[Math.floor((implieds.length - 1) / 2)]) : 0
    const salePrices = ids
      .map((id) => eligible.find((x) => x.id === id)!.comp.salePrice)
      .filter((p): p is number => p != null && p > 0)
    if (arv > 0 && salePrices.length) {
      const lo = Math.round(Math.min(...salePrices) * 0.75)
      const hi = Math.round(Math.max(...salePrices) * 1.25)
      if (arv > hi) arv = hi
      else if (arv < lo) arv = lo
    }
    if (arv <= 0) {
      base.debugNotes.push('decisions-seat: no priceable implied value — deterministic seat')
      return base
    }
    const poolP = prob('pool_quality') ?? 0
    const topP = picks[0]!.p
    const conf: 'high' | 'medium' | 'low' =
      topP >= 0.7 && poolP >= 0.5 ? 'high' : topP >= 0.45 ? 'medium' : 'low'
    const note = picks
      .map((x) => `${x.r.id} rep=${x.rep.toFixed(2)} fit=${x.fit.toFixed(2)} ${pricePoint(x.r)}`)
      .join(' · ')
    base.debugNotes.push(`decisions-seat: picks ${note} → ARV $${arv} (conf ${conf}, pool p=${poolP.toFixed(2)})`)
    return {
      ...base,
      model: 'decisions',
      selection: {
        ...(base.selection ?? {}),
        selectedCompIds: ids,
        drivers: ids,
        arv,
        arvEvidence: arv,
        conf,
        notes: `Decisions seat: ${note} — ARV $${arv.toLocaleString()}`,
        flags: [...(base.selection?.flags ?? []), 'decisions_seat'],
      },
    }
  } catch (e) {
    base.debugNotes.push(`decisions-seat: ${e instanceof Error ? e.message : 'call failed'} — deterministic seat`)
    return base
  }
}
