/**
 * Decision-level verdict grading — docs/BANDING-VERIFICATION-SPEC.md §1, §4.
 *
 * Pure recomputation over the frozen evidence bundle the agent saw: the
 * seven decision checks plus the band-geometry check (ε ≤ 0.10 per edge,
 * IoU ≥ 0.70, skip-not-pass disregard scoring). Fail-open by contract —
 * the grade records on the run, never blocks or retries the verdict.
 *
 * No model in the loop: every check reads fields the pipeline already
 * computed (census stamps, Clef digests, verification flags, the
 * deterministic band module).
 */

import { computeEvidenceBands, bandEdgeCheck, type BandName, type EvidenceBands } from '@flowstate-api/shared/appraisal'
import type { HarnessEvidence, AgentSelection } from './index'

export type CheckResult = 'pass' | 'fail' | 'warn' | 'skipped'

export interface StatedBand {
  low: number
  high: number
  mid: number
  compIds: string[]
}

export interface BandEdgeGrade {
  stated: StatedBand | null
  evidence: { low: number; high: number; mid: number } | null
  epsLow: number | null
  epsHigh: number | null
  iou: number | null
  result: CheckResult
  /** Evidence-band method (ok | insufficient_data | extreme_variance | stale | bimodal | missing). */
  method: string
}

export interface VerdictGrade {
  checks: Record<'d1' | 'd2' | 'd3' | 'd4' | 'd5' | 'd6' | 'd7' | 'd8', CheckResult>
  bandGrades: Record<BandName, BandEdgeGrade>
  /** pass=1, warn=0.5 over non-skipped checks — thin markets can't inflate. */
  score: number
  /** Machine-readable failure classes — the 'improve' loop input. */
  failures: string[]
  gradedAt: string
}

const BAND_NAMES: BandName[] = ['as_is', 'median', 'arv']

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

const carriesArvEvidence = (c: GradeComp): boolean =>
  c.verifiedFlip === true ||
  c.classification?.type === 'after_renovation' ||
  c.curbAppeal?.condition === 'renovated'

const asIsClassified = (c: GradeComp): boolean =>
  c.classification?.type === 'as_is' || c.curbAppeal?.condition === 'distressed'

/** Grade one band's stated edges against the evidence band (spec §4, §6.3). */
function gradeBand(
  name: BandName,
  stated: StatedBand | null,
  evidenceBand: EvidenceBands[BandName],
): BandEdgeGrade {
  const method = evidenceBand.method
  if (method !== 'ok') {
    // Valid disregard — skipped, omitted from the denominator.
    return {
      stated, evidence: null, epsLow: null, epsHigh: null, iou: null,
      result: stated ? 'warn' : 'skipped', // agent claimed a band evidence can't support → warn
      method,
    }
  }
  if (!stated) {
    // Invalid disregard — band exists in evidence, agent didn't state it.
    return { stated: null, evidence: null, epsLow: null, epsHigh: null, iou: null, result: 'fail', method }
  }
  const check = bandEdgeCheck(stated.low, stated.high, evidenceBand.low!, evidenceBand.high!)
  const pass = check.epsLow <= 0.1 && check.epsHigh <= 0.1 && check.iou >= 0.7
  return {
    stated,
    evidence: { low: evidenceBand.low!, high: evidenceBand.high!, mid: evidenceBand.mid! },
    epsLow: check.epsLow,
    epsHigh: check.epsHigh,
    iou: check.iou,
    result: pass ? 'pass' : 'fail',
    method,
  }
}

export function gradeVerdict(evidence: HarnessEvidence, selection: AgentSelection): VerdictGrade {
  const failures: string[] = []
  const checks: VerdictGrade['checks'] = {
    d1: 'pass', d2: 'pass', d3: 'pass', d4: 'pass', d5: 'pass', d6: 'pass', d7: 'pass', d8: 'pass',
  }

  const byId = new Map(evidence.comps.map((c) => [c.id, c] as const))
  const picks = selection.selectedCompIds.map((id) => byId.get(id)).filter((c): c is GradeComp => c != null)
  const driverIds = selection.drivers ?? selection.selectedCompIds
  const drivers = driverIds.map((id) => byId.get(id)).filter((c): c is GradeComp => c != null)
  const enabledUnpicked = evidence.comps.filter((c) => priceable(c) && !selection.selectedCompIds.includes(c.id))
  const subjectTract = evidence.subject.censusTract

  const bands = computeEvidenceBands(evidence.comps, evidence.subject)

  // ── d1: right neighborhood — block group first ───────────────────────────
  // The operative pocket is the block group whenever the pool offers BG
  // candidates; tract-only matches only count on a BG-empty pool.
  const bgPool = new Set(evidence.comps.filter((c) => priceable(c) && inBg(c)).map((c) => c.id))
  const tractPool = new Set(evidence.comps.filter((c) => priceable(c) && inPocket(c, subjectTract)).map((c) => c.id))
  const pocketIds = bgPool.size > 0 ? bgPool : tractPool
  const offPocketPicks = picks.filter((c) => !pocketIds.has(c.id))
  if (offPocketPicks.length > 0 && enabledUnpicked.some((c) => pocketIds.has(c.id))) {
    checks.d1 = 'fail'
    failures.push(bgPool.size > 0 ? 'd1_neighborhood_miss' : 'd1_off_tract_pick')
  } else if (offPocketPicks.length > picks.length / 3) {
    checks.d1 = 'warn'
    failures.push('d1_thin_pocket_anchor')
  }

  // ── d2: right pool ────────────────────────────────────────────────────────
  if (picks.some(flaggedOutlier)) {
    checks.d2 = 'fail'
    failures.push('d2_flagged_pick')
  }

  // ── d3: correct band membership (geometry is d8) ──────────────────────────
  const statedEdges = selection.bandEdges ?? {}
  const statedMembers = new Map<string, BandName>()
  for (const bn of BAND_NAMES) {
    for (const id of statedEdges[bn]?.compIds ?? []) {
      if (!byId.has(id)) { checks.d3 = 'fail'; failures.push(`d3_${bn}_unknown_member`); continue }
      if (statedMembers.has(id)) { checks.d3 = 'fail'; failures.push(`d3_${id}_dual_membership`); continue }
      statedMembers.set(id, bn)
      const c = byId.get(id)!
      if (bn === 'arv' && asIsClassified(c)) { checks.d3 = 'fail'; failures.push('d3_as_is_in_arv_band') }
    }
  }

  // ── d4: right ARV evidence ────────────────────────────────────────────────
  if (drivers.some(asIsClassified)) {
    checks.d4 = 'fail'
    failures.push('d4_as_is_driver')
  } else {
    const arvBandMembers = bands.arv.method === 'ok' ? new Set(bands.arv.memberIds) : new Set<string>()
    const driversWithEvidence = drivers.filter(carriesArvEvidence)
    const skippedArvMembers = drivers.filter((c) => arvBandMembers.has(c.id) === false && !carriesArvEvidence(c))
    if (arvBandMembers.size > 0 && driversWithEvidence.length === 0) {
      checks.d4 = 'fail'
      failures.push('d4_arv_evidence_skipped')
    } else if (driversWithEvidence.length === 0 || skippedArvMembers.length > 0) {
      checks.d4 = 'warn'
      failures.push('d4_maintained_anchor')
    }
  }

  // ── d5: right rejections ─────────────────────────────────────────────────
  const trimmed = new Set(BAND_NAMES.flatMap((bn) => bands[bn].trimmedIds))
  if (picks.some((c) => trimmed.has(c.id))) {
    checks.d5 = 'fail'
    failures.push('d5_iqr_outlier_picked')
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

  // ── d7: final value inside the ARV evidence edge ─────────────────────────
  const arvBand = bands.arv
  if (arvBand.method === 'ok') {
    const lo = arvBand.low! * 0.9
    const hi = arvBand.high! * 1.1
    if (selection.arv < lo || selection.arv > hi) {
      checks.d7 = 'fail'
      failures.push('d7_outside_evidence_edge')
    }
  } else {
    checks.d7 = 'skipped'
  }

  // ── d8: band geometry ─────────────────────────────────────────────────────
  const bandGrades = {
    as_is: gradeBand('as_is', statedEdges.as_is ?? null, bands.as_is),
    median: gradeBand('median', statedEdges.median ?? null, bands.median),
    arv: gradeBand('arv', statedEdges.arv ?? null, bands.arv),
  }
  const bandResults = BAND_NAMES.map((bn) => bandGrades[bn].result)
  if (bandResults.includes('fail')) {
    checks.d8 = 'fail'
    for (const bn of BAND_NAMES) if (bandGrades[bn].result === 'fail') failures.push(`d8_${bn}_edge_miss`)
  } else if (bandResults.every((r) => r === 'skipped')) {
    checks.d8 = 'skipped'
  } else if (bandResults.includes('warn')) {
    checks.d8 = 'warn'
  }

  // Composite — pass=1, warn=0.5, skipped out of the denominator.
  const results = Object.values(checks)
  const active = results.filter((r) => r !== 'skipped')
  const earned = active.reduce((a, r) => a + (r === 'pass' ? 1 : r === 'warn' ? 0.5 : 0), 0)

  return {
    checks,
    bandGrades,
    score: active.length > 0 ? earned / active.length : 1,
    failures: [...new Set(failures)],
    gradedAt: new Date().toISOString(),
  }
}
