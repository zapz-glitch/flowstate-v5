/**
 * Decision-level verdict grading — the deterministic gate.
 *
 * Pure recomputation over the frozen evidence bundle the appraiser saw.
 * No model in the loop: every check reads fields the pipeline already
 * computed (census stamps, condition classifications, verification
 * flags). There are no bands — condition classification + a
 * deterministic price-coherence trim are the referee. Fail-open by
 * contract: the grade records on the run; gateFails + gateFeedback are
 * what the revision loop feeds back to the appraiser.
 *
 * Checks:
 *   d1  pricing weight stays in the pocket (block group first)
 *   d2  no flagged/non-market picks
 *   d4  no as-is drivers; ARV evidence used when it exists
 *   d5  no coherence-outlier picks; strong anchors not skipped
 *   d6  missing-evidence surfaced in flags
 *   d7  ARV inside the renovated-comps price envelope (±10%)
 */

import type { HarnessEvidence, AgentSelection } from './index'

export type CheckResult = 'pass' | 'fail' | 'warn' | 'skipped'

export interface VerdictGrade {
  checks: Record<'d1' | 'd2' | 'd4' | 'd5' | 'd6' | 'd7' | 'd8', CheckResult>
  /** pass=1, warn=0.5 over non-skipped checks, minus flat soft penalties. */
  score: number
  /** Machine-readable failure classes — the 'improve' loop input. */
  failures: string[]
  /** Soft warnings — telemetry classes that cost only the flat penalty. */
  warnings: string[]
  /** Flat soft-penalty deducted from the composite (geo bleed = 0.1). */
  scorePenalty: number
  /** Check names whose fail contradicts verified evidence — what the
   *  revision gate rejects on. */
  gateFails: string[]
  /** Targeted correction feedback for the revision loop — populated for
   *  every gated fail, naming the comp/item and the evidence violated. */
  gateFeedback: string[]
  gradedAt: string
}

const asRec = (v: unknown): Record<string, unknown> | null =>
  v != null && typeof v === 'object' ? (v as Record<string, unknown>) : null

/** Read a Clef digest field defensively — digests are advisory unknowns. */
const digestField = (c: HarnessEvidence['comps'][number], stage: 'A' | 'B' | 'C', key: string): string | null => {
  const rec = asRec(asRec(c.clefDigest)?.[stage])
  const v = rec?.[key]
  return typeof v === 'string' ? v : null
}

type GradeComp = HarnessEvidence['comps'][number]

const priceable = (c: GradeComp) =>
  c.isEnabled !== false && c.salePrice != null && c.salePrice > 0 && c.squareFeet != null && c.squareFeet > 0

/** Block-group membership — the priority geography match. */
const inBg = (c: GradeComp): boolean =>
  c.sameBlockGroup === true ||
  ['block_group', 'same_pocket'].includes(digestField(c, 'B', 'geoFit') ?? '')

/** Loose pocket (BG or same tract) — only counts when the pool offers no
 *  BG candidates at all; block-group discipline is the priority. */
const inPocket = (c: GradeComp, subjectTract: string | null | undefined): boolean =>
  inBg(c) || (subjectTract != null && c.censusTract === subjectTract)

const flaggedOutlier = (c: GradeComp): boolean =>
  c.isEnabled === false ||
  c.evidenceVerification?.transactionCheck === 'nominal_sale' ||
  digestField(c, 'A', 'priceSanity') === 'data_error' ||
  digestField(c, 'B', 'priceSanity') === 'data_error' ||
  ((c.evidenceVerification?.flags?.length ?? 0) > 0 &&
    (c.evidenceVerification?.flags ?? []).some((f) => /nominal|typo|outlier|data_error/i.test(f)))

/** Renovated/updated sale — real ARV evidence. Reads the haiku condition
 *  classification (label / tier), the keyword classifier, and the verified-
 *  flip flag. curbAppeal is Clef shadow evidence — display only, never a
 *  gate input. */
const carriesArvEvidence = (c: GradeComp): boolean =>
  c.verifiedFlip === true ||
  c.classification?.type === 'after_renovation' ||
  c.conditionLabel === 'Renovated' ||
  c.conditionLabel === 'Updated' ||
  c.compTier === 'arv'

/** As-is/distressed sale — can never drive an ARV verdict. Anchored on
 *  the condition classification directly (no band labels, no Clef shadow
 *  stamps). */
const asIsClassified = (c: GradeComp): boolean =>
  c.classification?.type === 'as_is' ||
  c.conditionLabel === 'Poor' ||
  c.compTier === 'investor' ||
  (c.conditionAsIs === true)

/** Condition group for the coherence trim — arv evidence vs as-is stock
 *  vs everything else. Deterministic; not a band, just a trim bucket. */
const conditionGroup = (c: GradeComp): 'as_is' | 'arv' | 'median' =>
  asIsClassified(c) ? 'as_is' : carriesArvEvidence(c) ? 'arv' : 'median'

const quantile = (sorted: number[], q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]!

/**
 * Price-coherence outliers inside a condition group: 1.5×IQR on sale
 * price. This is what catches the 'outsized prices' datasets produce —
 * a $610k comp sitting in a pool of $250k renovated sales is priced
 * out before it can distort the envelope or be picked.
 */
function coherenceOutliers(group: GradeComp[]): Set<string> {
  const priced = group.filter((c) => c.salePrice != null && c.salePrice > 0)
  if (priced.length < 4) return new Set() // too thin to trim — trust the pool
  const prices = priced.map((c) => c.salePrice!).sort((a, b) => a - b)
  const q1 = quantile(prices, 0.25)
  const q3 = quantile(prices, 0.75)
  const iqr = q3 - q1
  const lo = q1 - 1.5 * iqr
  const hi = q3 + 1.5 * iqr
  return new Set(priced.filter((c) => c.salePrice! < lo || c.salePrice! > hi).map((c) => c.id))
}

export function gradeVerdict(evidence: HarnessEvidence, selection: AgentSelection): VerdictGrade {
  const failures: string[] = []
  const warnings: string[] = []
  const gateFeedback: string[] = []
  let scorePenalty = 0
  const checks: VerdictGrade['checks'] = {
    d1: 'pass', d2: 'pass', d4: 'pass', d5: 'pass', d6: 'pass', d7: 'pass', d8: 'pass',
  }

  const byId = new Map(evidence.comps.map((c) => [c.id, c] as const))
  const picks = selection.selectedCompIds.map((id) => byId.get(id)).filter((c): c is GradeComp => c != null)
  const driverIds = selection.drivers ?? selection.selectedCompIds
  const drivers = driverIds.map((id) => byId.get(id)).filter((c): c is GradeComp => c != null)
  const enabledUnpicked = evidence.comps.filter((c) => priceable(c) && !selection.selectedCompIds.includes(c.id))
  const subjectTract = evidence.subject.censusTract

  // Coherence trim — computed once for d5/d7, same math for every group.
  const groups: Record<'as_is' | 'arv' | 'median', GradeComp[]> = { as_is: [], arv: [], median: [] }
  for (const c of evidence.comps) if (priceable(c)) groups[conditionGroup(c)].push(c)
  const trimmed = new Set<string>([
    ...coherenceOutliers(groups.as_is),
    ...coherenceOutliers(groups.arv),
    ...coherenceOutliers(groups.median),
  ])
  // ARV-qualified comps: renovated-classified, priceable, not flagged,
  // not coherence-trimmed. The d4/d7 evidence pool.
  const arvQualified = groups.arv.filter((c) => !flaggedOutlier(c) && !trimmed.has(c.id))

  // ── d1: right neighborhood — pricing weight, block group first ───────────
  const bgPool = new Set(evidence.comps.filter((c) => priceable(c) && inBg(c)).map((c) => c.id))
  const tractPool = new Set(evidence.comps.filter((c) => priceable(c) && inPocket(c, subjectTract)).map((c) => c.id))
  const pocketIds = bgPool.size > 0 ? bgPool : tractPool
  const pocketLabel = bgPool.size > 0 ? 'block group' : 'tract'
  const weightedIds = new Set(drivers.map((c) => c.id))
  const offPocketDrivers = drivers.filter((c) => !pocketIds.has(c.id))
  const offPocketSupporting = picks.filter((c) => !weightedIds.has(c.id) && !pocketIds.has(c.id))
  const unpickedPocket = enabledUnpicked.filter((c) => pocketIds.has(c.id))
  // All-as_is pocket paradox: when every unpicked in-pocket comp is
  // as-is-classified, picking it can't satisfy d4 — warn instead of an
  // unsatisfiable d1+d4 contradiction.
  const pocketAllAsIs = unpickedPocket.length > 0 && unpickedPocket.every(asIsClassified)
  if (offPocketDrivers.length > 0 && unpickedPocket.length > 0 && !pocketAllAsIs) {
    checks.d1 = 'fail'
    failures.push(bgPool.size > 0 ? 'd1_neighborhood_miss' : 'd1_off_tract_pick')
    for (const c of offPocketDrivers) {
      gateFeedback.push(
        `d1: pricing comp ${c.id} (${c.address ?? 'unknown'}) is outside the subject ${pocketLabel} — ` +
        `replace with an unpicked in-pocket comp (${unpickedPocket.length} remain: ${unpickedPocket.slice(0, 5).map((u) => u.id).join(', ')}${unpickedPocket.length > 5 ? ', …' : ''})`,
      )
    }
  } else if (pocketAllAsIs && offPocketDrivers.length > 0) {
    checks.d1 = 'warn'
    failures.push('d1_all_asis_pocket')
    gateFeedback.push(
      `d1: every unpicked in-pocket comp is as-is-classified — it cannot carry ARV weight, so off-${pocketLabel} ` +
      `drivers are acceptable here; pick the in-pocket comps as supporting context if useful`,
    )
  } else if (offPocketDrivers.length > drivers.length / 3) {
    checks.d1 = 'warn'
    failures.push('d1_thin_pocket_anchor')
  }
  if (offPocketSupporting.length > 0) {
    warnings.push('SUPPORTING_COMP_GEO_BLEED')
    scorePenalty += 0.1
  }

  // ── d2: right pool ────────────────────────────────────────────────────────
  const flaggedPicks = picks.filter(flaggedOutlier)
  if (flaggedPicks.length > 0) {
    checks.d2 = 'fail'
    failures.push('d2_flagged_pick')
    for (const c of flaggedPicks) {
      const fl = (c.evidenceVerification?.flags ?? [])[0]
      gateFeedback.push(`d2: pick ${c.id} (${c.address ?? 'unknown'}) is not market evidence — ${fl ?? 'flagged outlier'}; remove it`)
    }
  }

  // ── d4: right ARV evidence ────────────────────────────────────────────────
  const asIsDrivers = drivers.filter(asIsClassified)
  // All-as-is pool paradox: when the pool offers zero non-as-is evidence,
  // any driver is as-is — the verdict is forced into a distressed read.
  const poolHasNonAsIs = evidence.comps.some((c) => priceable(c) && !asIsClassified(c))
  if (asIsDrivers.length > 0 && poolHasNonAsIs) {
    checks.d4 = 'fail'
    failures.push('d4_as_is_driver')
    for (const c of asIsDrivers) {
      gateFeedback.push(`d4: pricing comp ${c.id} (${c.address ?? 'unknown'}) is classified as-is — as-is stock cannot drive an ARV verdict`)
    }
  } else if (asIsDrivers.length > 0) {
    checks.d4 = 'warn'
    failures.push('d4_all_as_is_pool')
  } else {
    const qualifiedIds = new Set(arvQualified.map((c) => c.id))
    const driversWithEvidence = drivers.filter(carriesArvEvidence)
    const skippedQualified = drivers.filter((c) => !qualifiedIds.has(c.id) && !carriesArvEvidence(c))
    if (qualifiedIds.size > 0 && driversWithEvidence.length === 0) {
      checks.d4 = 'fail'
      failures.push('d4_arv_evidence_skipped')
      gateFeedback.push(`d4: no pricing comp carries renovated evidence while ${qualifiedIds.size} qualified renovated comp(s) went unused — anchor on them or say why none apply`)
    } else if (driversWithEvidence.length === 0 || skippedQualified.length > 0) {
      checks.d4 = 'warn'
      failures.push('d4_maintained_anchor')
    }
  }

  // ── d5: right rejections ─────────────────────────────────────────────────
  const trimmedPicks = picks.filter((c) => trimmed.has(c.id))
  if (trimmedPicks.length > 0) {
    checks.d5 = 'fail'
    failures.push('d5_coherence_outlier_picked')
    for (const c of trimmedPicks) {
      gateFeedback.push(`d5: pick ${c.id} (${c.address ?? 'unknown'}) is a price outlier inside its condition group ($${c.salePrice?.toLocaleString() ?? '?'}) — remove it`)
    }
  }
  const verifiedAnchors = enabledUnpicked.filter((c) =>
    carriesArvEvidence(c) && digestField(c, 'C', 'anchorQuality') === 'strong_anchor')
  if (verifiedAnchors.length > 0 && picks.some((c) => !carriesArvEvidence(c))) {
    checks.d5 = checks.d5 === 'fail' ? 'fail' : 'warn'
    failures.push('d5_anchor_skipped')
  }

  // ── d6: missing-evidence handling ────────────────────────────────────────
  const unpriceablePool = evidence.comps.filter((c) => !priceable(c))
  if (unpriceablePool.length >= 2 && !(selection.flags ?? []).some((f) => /missing|unprice|incomplete|sqft|evidence/i.test(f))) {
    checks.d6 = 'warn'
    failures.push('d6_gaps_unsurfaced')
  }

  // ── d7: final value inside the renovated-comps price envelope ────────────
  // The envelope is the actual sale-price range of ARV-qualified comps —
  // ±10%. With fewer than 2 qualified comps the envelope is soft (warn),
  // computed over all non-as-is priceable comps instead.
  const envelopePool = arvQualified.length >= 2 ? arvQualified
    : evidence.comps.filter((c) => priceable(c) && !asIsClassified(c) && !flaggedOutlier(c))
  if (envelopePool.length >= 2) {
    const prices = envelopePool.map((c) => c.salePrice!)
    const lo = Math.min(...prices) * 0.9
    const hi = Math.max(...prices) * 1.1
    const soft = arvQualified.length < 2
    if (selection.arv < lo || selection.arv > hi) {
      if (soft) {
        checks.d7 = 'warn'
        failures.push('d7_outside_implied_edge')
        gateFeedback.push(`d7: ARV $${selection.arv.toLocaleString()} is outside the non-as-is comps' price range $${Math.round(lo).toLocaleString()}–$${Math.round(hi).toLocaleString()} (±10%, weak renovated evidence — flag why or re-anchor)`)
      } else {
        checks.d7 = 'fail'
        failures.push('d7_outside_evidence_edge')
        gateFeedback.push(`d7: ARV $${selection.arv.toLocaleString()} is outside the renovated comps' price envelope $${Math.round(lo).toLocaleString()}–$${Math.round(hi).toLocaleString()} (±10%) — re-anchor inside the evidence`)
      }
    }
  } else {
    checks.d7 = 'skipped'
  }

  // ── d8: observable price-position discipline ──────────────────────────
  // The Decisions lane's code-verified tier (observables.codePosition):
  // ABOVE_MEDIAN = ARV-band evidence, MEDIAN = median-market, BELOW_MEDIAN
  // = investor/as-is band. A driver priced in the investor band contradicts
  // the ARV verdict — same rule as d4, anchored on price position instead
  // of condition labels. Unexplained premium flags on picks must surface.
  const belowDrivers = drivers.filter((c) => c.observables?.codePosition === 'BELOW_MEDIAN')
  if (belowDrivers.length > 0) {
    checks.d8 = 'fail'
    failures.push('d8_driver_in_investor_band')
    for (const c of belowDrivers) {
      gateFeedback.push(`d8: pricing comp ${c.id} (${c.address ?? 'unknown'}) is priced in the pocket's below-median band (code-verified) — investor-band stock cannot drive an ARV verdict`)
    }
  } else {
    const premiumPicks = picks.filter((c) => (c.observables?.unexplainedPremiumP ?? 0) >= 0.7)
    if (premiumPicks.length > 0) {
      checks.d8 = 'warn'
      failures.push('d8_unexplained_premium_picked')
      for (const c of premiumPicks) {
        gateFeedback.push(`d8: pick ${c.id} (${c.address ?? 'unknown'}) is flagged as an extreme-variance outlier sale — justify it or drop it`)
      }
    } else if (evidence.comps.some((c) => c.observables != null)) {
      checks.d8 = 'pass'
    } else {
      checks.d8 = 'skipped'
    }
  }

  // Composite — pass=1, warn=0.5, skipped out of the denominator, minus
  // flat soft penalties (geo bleed).
  const results = Object.values(checks)
  const active = results.filter((r) => r !== 'skipped')
  const earned = active.reduce((a, r) => a + (r === 'pass' ? 1 : r === 'warn' ? 0.5 : 0), 0)
  const gateFails = Object.entries(checks).filter(([, r]) => r === 'fail').map(([k]) => k)

  return {
    checks,
    gateFails,
    score: active.length > 0 ? Math.max(0, earned / active.length - scorePenalty) : 1,
    failures: [...new Set(failures)],
    warnings: [...new Set(warnings)],
    scorePenalty,
    gateFeedback,
    gradedAt: new Date().toISOString(),
  }
}
