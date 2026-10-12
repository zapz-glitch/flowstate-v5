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
import { decisionsRun, isDecisionsAvailable } from '../decisions'
import type { Env } from '../../types'
import type { Phase1Context, HarnessEvidence } from './index'
import type { AppraiserResult } from './appraiser'
import { runDeterministicSelector, type PocketValues, type RankedComp } from './selector'
import {
  decisionsCompObservables, fetchSatelliteTile,
  type CompObservables,
} from './observable'
import { pickFrontCoverImage } from './exterior-match'

/** Merge a later partial observable read into the stamped one — defined
 *  fields win, arrays concat; a null field never erases prior evidence. */
function mergeObservables(prev: CompObservables | null | undefined, next: CompObservables | null): CompObservables | null {
  if (!next) return prev ?? null
  if (!prev) return next
  const out = { ...prev } as Record<string, unknown>
  for (const [k, v] of Object.entries(next)) {
    if (v == null) continue
    if (k === 'imagesRead' && Array.isArray(v)) {
      out[k] = [...(prev.imagesRead ?? []), ...(v as string[])]
      continue
    }
    out[k] = v
  }
  return out as unknown as CompObservables
}

/** Imaging depth for the site pass — the top of the sorted candidate set. */
const SITE_CAP = 15
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
  env: Env,
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
  // The COMPLETE labeled candidate set — every ranked comp, best-evidence
  // first, each carrying its audit verdict and exclusion reason. Code stages
  // the evidence; the model decides. An excluded comp can still pick when
  // its row's evidence beats the exclusion (below_market stays hard-vetoed —
  // price labels are facts).
  const candidates = ranked.slice().sort((a, b) =>
    evidenceRank(a) - evidenceRank(b)
    || (a.labels?.diffs ?? 9) - (b.labels?.diffs ?? 9)
    || (GEO_RANK[a.profile.geoTier] ?? 9) - (GEO_RANK[b.profile.geoTier] ?? 9)
    || String(b.comp.saleDate ?? '').localeCompare(String(a.comp.saleDate ?? '')))
  if (candidates.length === 0) {
    base.debugNotes.push('decisions-seat: 0 comps in pool — deterministic seat')
    return base
  }
  base.debugNotes.push(`decisions-seat: seat call → ${candidates.length} candidates (ranked=${ranked.length}, complete set)`)

  // Spec order step 5 — the imaging reads run only now, AFTER the TypeScript
  // labels (step 4) exist: satellite lot-premium/exposure reads, street-view
  // physical match, cover-vs-cover exterior match. They stamp onto the same
  // observable record so the seat row carries the totality when judged.
  {
    const subjLat = ctx.bundle?.property?.latitude ?? null
    const subjLng = ctx.bundle?.property?.longitude ?? null
    const subjectPhotos = ctx.photoBundle?.subject?.photos ?? []
    // Street view stays out — cover-vs-cover exterior match is the
    // physical-similarity read (owner directive).
    const [subjectCoverImage, subjectSatelliteImage] = await Promise.all([
      pickFrontCoverImage(env, subjectPhotos).catch(() => null),
      fetchSatelliteTile(env, { latitude: subjLat ?? undefined, longitude: subjLng ?? undefined }).catch(() => null),
    ])
    let siteRead = 0
    // Imaging depth: the top of the sorted set — where picks actually come
    // from. The seat still SEES every candidate; the far tail doesn't burn
    // tile fetches it will never need.
    await Promise.all(candidates.slice(0, SITE_CAP).map(async (r) => {
      const ac = ctx.appraisalResult?.comparables?.find((c) => c.id === r.id) as
        { latitude?: number | null; longitude?: number | null; coverPhotoUrl?: string | null } | undefined
      const site = await decisionsCompObservables(env, {
        comp: {
          propertyId: r.id, address: r.comp.address, salePrice: r.comp.salePrice,
          squareFeet: r.comp.squareFeet, yearBuilt: r.comp.yearBuilt, saleDate: r.comp.saleDate,
          neighborhoodName: r.comp.neighborhoodName, censusTract: r.comp.censusTract,
          sameBlockGroup: r.comp.sameBlockGroup, lotSizeAcres: r.comp.lotSizeAcres ?? null,
          pool: r.comp.poolType ?? null,
        },
        salePrice: r.comp.salePrice ?? null,
        ppsf: r.ppsf,
        coverPhotoUrl: r.comp.coverPhotoUrl ?? ac?.coverPhotoUrl ?? null,
        latitude: ac?.latitude ?? null,
        longitude: ac?.longitude ?? null,
        subjectCoverImage, subjectSatelliteImage,
        subjectAddress: evidence.subject.address ?? null,
        subjectRef: evidence.subject,
        benchmark: evidence.marketBenchmark ?? null,
      }, { condition: false, street: false }).catch(() => null)
      if (site) {
        r.comp.observables = mergeObservables(r.comp.observables, site)
        if (ctx.compObservables && r.comp.observables) ctx.compObservables[r.id] = r.comp.observables
        siteRead++
      }
    }))
    base.debugNotes.push(`decisions-seat: site pass → ${siteRead}/${Math.min(candidates.length, SITE_CAP)} candidates imaged (labels first)`)
  }

  // Every fact the model needs already lives in the row: the TS labels,
  // the observables prior (proto's Decisions reads — condition, price
  // position, premium/exposure), and the pocket proof. The seat reads the
  // totality of each comp's dataset, not a hand-picked field.
  const subjectObs = evidence.subjectObservables ?? null
  const rows = candidates.map((r) => {
    const l = r.labels
    const ob = r.comp.observables ?? null
    const pp = pricePoint(r)
    return {
      id: r.id,
      verdict: r.audit.verdict,
      why: r.audit.reasons[0] ?? null,
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
        physicalMatchP: ob.physicalMatchP, exteriorMatchP: ob.exteriorMatchP, arvFitnessP: ob.arvFitnessP,
        unexplainedPremiumP: ob.unexplainedPremiumP,
        tier: ob.finalTier,
      } : null,
    }
  })

  const state = {
    task:
      'Each question names a comparable sale. A QUALIFIED comp for this ' +
      'subject is: (1) in the subject pocket or a pocket with proven similar ' +
      'value, (2) physically similar on the big items — size, era, style, ' +
      'lot, pool/construction/foundation/garage matches, (3) a plausible ' +
      'non-distressed sale — not investor-grade, not a flip acquisition, ' +
      '(4) priced at or above the pocket median — above-market (renovated ' +
      'evidence) or at-market. Every row is labeled: price labels are facts ' +
      '(pricePoint below_market can NEVER price ARV), condition fields are ' +
      'evidence you weigh. Rows marked verdict=excluded carry the code\'s ' +
      'exclusion reason in `why` — override it only when the row\'s own ' +
      'evidence proves the comp qualified anyway. Answer the probability ' +
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

  // Owner doctrine: the seat answers the questions a human appraiser asks.
  // Facts-in-a-cell = predicates (yes/no: block group, neighborhood).
  // Degrees-of-fit = probabilities (sqft band, year band, apples-to-apples,
  // the final call — a scale, not a binary). The price band is the single
  // classification question — the model says which market band the comp
  // resembles matching our rules; code price labels stay facts.
  const siteRows = new Set(Object.keys(ctx.compObservables ?? {}))
  const asked = rows.filter((r) => siteRows.has(r.id))
  const questionRows = asked.length ? asked : rows
  type Q = { type: 'noul'; instructions: string } | { type: 'choice'; criteria: Record<string, string>; instructions: string }
  const questions: Record<string, Q> = {}
  for (const row of questionRows) {
    const id = row.id
    questions[`q_sqft_${id}`] = {
      type: 'noul',
      instructions: `Comp ${id}: probability this property is within the subject's square footage band — a scale, not a binary. Use the sqft label on its row (exact ≈ 1.0, far ≈ 0).`,
    }
    questions[`q_year_${id}`] = {
      type: 'noul',
      instructions: `Comp ${id}: probability this property is within the subject's year-built band — a scale. Use the year label on its row.`,
    }
    questions[`q_block_${id}`] = {
      type: 'noul',
      instructions: `Comp ${id}: YES or NO — is this property in the subject's block group? Use its geo tier label (BLOCK_GROUP = yes).`,
    }
    questions[`q_hood_${id}`] = {
      type: 'noul',
      instructions: `Comp ${id}: YES or NO — is this property in the subject's neighborhood? Use its geo tier label and neighborhood field.`,
    }
    questions[`q_apples_${id}`] = {
      type: 'noul',
      instructions: `Comp ${id}: probability this property is an apples-to-apples physical comparison to the subject — a scale. Weigh sqft/year/lot/style/feature labels, physicalMatchP, exteriorMatchP, development vintage, and the site predicates.`,
    }
    questions[`q_final_${id}`] = {
      type: 'noul',
      instructions:
        `Comp ${id}: YES or NO — does this property show what the subject will look like and sell for after renovation, at or above market? ` +
        `This is THE appraisal call: it must be physically similar, in or near the pocket, a non-distressed sale, and represent the subject at above-market or at-market price. ` +
        `pricePoint=${row.pricePoint} — below_market means NO.`,
    }
    questions[`band_${id}`] = {
      type: 'choice',
      criteria: {
        ABOVE_MARKET: 'resembles an above-market comp matching our rules',
        AT_MARKET: 'resembles an at-market comp matching our rules',
        BELOW_MARKET: 'resembles a below-market comp matching our rules',
      },
      instructions:
        `Comp ${id}: which market band does this property resemble as a comparable matching our appraisal rules? ` +
        `Read the whole row — price labels (facts), condition evidence, geo tier, site predicates. ` +
        `Code price label pricePoint=${row.pricePoint}; classify the comp, do not just echo the label.`,
    }
  }
  // The head-to-head choice: Luna compares the whole asked set and
  // returns a preference distribution — which comp is the STRONGEST ARV
  // evidence — rather than TypeScript inventing a blend formula.
  questions['best_comp'] = {
    type: 'choice',
    criteria: Object.fromEntries([
      ...questionRows.map((r) => {
        const rc = candidates.find((x) => x.id === r.id)
        return [r.id, rc?.comp.address ?? r.id]
      }),
      ['NONE_QUALIFIED', 'no candidate is strong enough ARV evidence to select'],
    ]),
    instructions:
      'Considering the whole candidate set: which comparable provides the ' +
      'STRONGEST ARV evidence for the subject — weighing market ' +
      'compatibility (pocket/geo), physical similarity, condition ' +
      'suitability for ARV comparison, sale recency, and required ' +
      'adjustments? Pick the single best comp; NONE_QUALIFIED only when no ' +
      'candidate can honestly price the subject post-renovation.',
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
    const choice = (name: string): string | null => {
      const a = answers[name] as { choice?: string | boolean } | undefined
      return typeof a?.choice === 'string' ? a.choice : null
    }
    const choiceProbs = (name: string): Record<string, number> => {
      const a = answers[name] as { probabilities?: Record<string, number> } | undefined
      return a?.probabilities ?? {}
    }
    const pref = choiceProbs('best_comp')
    const modelBest = choice('best_comp')
    const askedIds = new Set(questionRows.map((r) => r.id))
    const scored: { r: RankedComp; p: number; band: string | null; pref: number }[] = candidates
      .filter((r) => askedIds.has(r.id))
      .map((r) => ({ r, p: prob(`q_final_${r.id}`) ?? -1, band: choice(`band_${r.id}`), pref: pref[r.id] ?? 0 }))
      .filter((x) => x.p >= 0 || x.pref > 0)
    if (!scored.length) {
      // Malformed/absent answers — still pick the best-ranked candidate;
      // a seat answer must exist, honestly labeled.
      const r = candidates[0]!
      scored.push({ r, p: 0, band: null, pref: 0 })
      base.debugNotes.push(`decisions-seat: no answers returned — forced pick ${r.id}`)
    }
    if (modelBest === 'NONE_QUALIFIED') base.debugNotes.push('decisions-seat: model judged no candidate qualified — forcing least-bad pick')
    else base.debugNotes.push(`decisions-seat: model preference → ${modelBest ?? '?'} (pref dist: ${Object.entries(pref).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, p]) => `${id}:${p.toFixed(2)}`).join(' ')})`)
    // Selection = Luna's relative preference over the qualified set, not a
    // TS blend: order by best_comp preference, keep comps the final call
    // passed (q_final >= 0.5) or that the model itself ranked first, and
    // never let a BELOW_MARKET band pick drive ARV unless nothing else
    // exists (forced floor, flagged).
    const rankedByPref = [...scored].sort((a, b) => (b.pref - a.pref) || (b.p - a.p))
    const qualified = rankedByPref.filter((x) => x.band !== 'BELOW_MARKET' && (x.p >= 0.5 || x.r.id === modelBest))
    let forcedBelowMarket = false
    let picks = qualified.length ? qualified.slice(0, 3) : rankedByPref.filter((x) => x.band !== 'BELOW_MARKET').slice(0, 1)
    if (!picks.length && scored.length) {
      // Every candidate reads below-market — the seat still must answer.
      // Least-bad is the highest-preference distressed comp; it prices the
      // floor, flagged so the card and the gate see what it is.
      forcedBelowMarket = true
      const top = rankedByPref[0]!
      picks = [top]
      base.debugNotes.push(`decisions-seat: all candidates below-market — forced floor pick ${top.r.id} (pref=${top.pref.toFixed(2)})`)
    }
    if (!picks.length) {
      base.debugNotes.push('decisions-seat: no candidates at all — deterministic seat')
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
      .map((id) => candidates.find((x) => x.id === id)!.comp.salePrice)
      .filter((p): p is number => p != null && p > 0)
    if (arv > 0 && salePrices.length) {
      const lo = Math.round(Math.min(...salePrices) * 0.75)
      const hi = Math.round(Math.max(...salePrices) * 1.25)
      if (arv > hi) arv = hi
      else if (arv < lo) arv = lo
    }
    if (arv <= 0) {
      // No priceable implied value (missing sqft/salePrice) — the pick
      // still stands; price falls back to the deterministic engine's ARV.
      const baseArv = base.selection?.arv ?? base.selection?.arvEvidence ?? 0
      if (baseArv <= 0) {
        base.debugNotes.push('decisions-seat: no priceable value anywhere — deterministic seat')
        return base
      }
      arv = baseArv
      base.debugNotes.push(`decisions-seat: pick unpriced by implied value — ARV falls back to deterministic $${arv}`)
    }
    const poolP = prob('pool_quality') ?? 0
    const topP = picks[0]!.p
    const conf: 'high' | 'medium' | 'low' =
      topP >= 0.7 && poolP >= 0.5 ? 'high' : topP >= 0.45 ? 'medium' : 'low'
    const note = picks
      .map((x) => `${x.r.id} final=${x.p.toFixed(2)} pref=${x.pref.toFixed(2)} band=${x.band ?? '?'} ${pricePoint(x.r)}`)
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
        flags: [...(base.selection?.flags ?? []), 'decisions_seat', ...(forcedBelowMarket ? ['below_market_pick'] : [])],
      },
    }
  } catch (e) {
    base.debugNotes.push(`decisions-seat: ${e instanceof Error ? e.message : 'call failed'} — deterministic seat`)
    return base
  }
}
