/**
 * Comp Hybrid — the evaluation, entirely Jev-driven.
 *
 * Order of operations (product spec — swe-2-eval funnel):
 *   1. Facts only: a comp needs a usable sale price and a usable sale date.
 *      Everything after this line is Jev's judgment.
 *   2. Test 1 (services/jev, comp_tests_v1): raw-field nouls — squareFeet,
 *      lotSize, yearBuilt, salePrice, saleDate — "does this comp match the
 *      subject on this field, per the appraisal rules?" Passing every
 *      verifiable field puts the comp in the "passed test 1" bucket. Every
 *      passer also carries a composite score: proximity to the subject
 *      dominates, blended with mean field-match strength. A field that
 *      cannot be verified (missing on the comp or the subject) is noted,
 *      never failed.
 *   3. Enrich the TOP-10 test-1 passers by score (property detail:
 *      subdivision, neighborhood, style, construction materials,
 *      foundation, features, transaction) via the caller's provider seam —
 *      test 2 needs fields the raw pool lacks.
 *   4. Test 2 (services/jev, comp_tests_v1): enriched nouls — a subdivision
 *      match passes; if subdivision fails, a neighborhood match still
 *      passes. Both no → test 2 fail. Physical character, material, and
 *      foundation nouls are preferred-not-required — they lift the score:
 *      a bare pass starts at 90 and each matched physical characteristic
 *      pushes toward 100. The Score primitive also rates every enriched
 *      comp on a distance-dominant spectrum (closest → highest) with Jev's
 *      confidence — for fail ordering and display.
 *   5. Classification: passing test 2 does NOT make a comp an ARV comp —
 *      it only means the comp matched the rules. The test-2 passers are
 *      split by price: the top 15% become the ARV set (variable count —
 *      not capped at 3), the remainder become the as-is market reference.
 *   6. No fill. Fewer than three passers yields whatever passed; zero
 *      passers → humanHandoff — the run flags for manual review instead
 *      of standing in unexamined comps.
 *   7. Adjustments are still deterministic math from appraisal settings;
 *      ARV = average of the ARV-set comps' adjusted prices.
 *
 * Every comp carries an audit record: why it never ran, its test-1 field
 * answers and composite score, its test-2 noul answers and score, its
 * price-tier classification, and its rank among the evaluated set.
 */

import type { NormalizedProperty, NormalizedComparable } from '../property-api/types'
import type { AppraisedComparable, AppraisalAdjustment, AppraisalFilter } from '../appraisal/types'
import { evaluateComparable } from '../appraisal'
import {
  buildTest1Defs,
  COMP_EVAL_VERSION,
  COMP_NOUL_GATE,
  COMP_TEST1_FIELDS,
  COMP_TEST2_NOUL_LABELS,
  COMP_TEST2_SCORE_LEVELS,
  runCompTest1WithJev,
  runCompTest2WithJev,
} from '../jev'
import type {
  CompTest1Field,
  CompTest1FieldDef,
  JevCompTest1Result,
  JevCompTest2Result,
  JevEnv,
} from '../jev'

/** Pipeline identifier — bump when the stage contract changes. */
export const COMP_HYBRID_VERSION = COMP_EVAL_VERSION

/** ARV tier: the top fraction of test-2 passers by adjusted price. */
export const COMP_ARV_TOP_PERCENT = 15

/** Test-1 composite score: proximity weight (field-match strength takes the rest). */
export const COMP_TEST1_PROXIMITY_WEIGHT = 0.6

/** Test-2 passers start at this score; matched physical characteristics push toward 100. */
export const COMP_TEST2_PASS_BASELINE = 90

/**
 * Card-score bands per test outcome — the tier dominates, proximity sets
 * the position inside the band (nearest = band top). Bands never overlap:
 * every test-2 passer outscores every test-2 fail, and every test-1 passer
 * outscores every test-1 fail.
 */
export const COMP_TIER_BANDS: Record<HybridCompScore['stage'], readonly [number, number]> = {
  test2_pass: [75, 100],
  test2_fail: [35, 74],
  test1_pass: [35, 74],
  test1_fail: [0, 34],
  ineligible: [0, 34],
}

/** Max test-1 passers that get a provider detail call — enrichment budget. */
export const COMP_ENRICH_MAX = 10

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HybridCompTest1 {
  /** field → 0–1 probability the comp matches the subject on it (null = not asked) */
  nouls: Record<CompTest1Field, number | null>
  /** Verifiable fields below the gate */
  failedFields: CompTest1Field[]
  /** Fields the comp (or subject) data could not verify — noted, not failed */
  unverifiableFields: CompTest1Field[]
  /** Every verifiable field at/above the gate — the "passed test 1" bucket */
  passed: boolean
  /** Composite /100 — proximity to the subject dominates, blended with mean field-match strength. Orders passers for the enrichment budget. */
  score: number | null
}

export interface HybridCompTest2 {
  nouls: {
    subdivision: number
    neighborhood: number
    /** Advisory — preferred, never gating; feeds the 90→100 match boost */
    physicalCharacter: number
    /** Advisory — preferred, never gating; feeds the 90→100 match boost */
    material: number
    /** Advisory — preferred, never gating; feeds the 90→100 match boost */
    foundation: number
  }
  /** Subdivision yes, or neighborhood yes — eligible for classification */
  passed: boolean
  /** Passers: 90 baseline + up to 10 for matched physical characteristics. Fails: distance spectrum scaled below 90. */
  score: number
  confidence: number | null
  /** Score level index → probability */
  levelProbabilities: Record<string, number>
}

export interface HybridCompScore {
  compId: string
  /**
   * 'ineligible'  = no usable price/date, never tested
   * 'test1_fail'  = failed a verifiable test-1 field
   * 'test1_pass'  = passed test 1 but beyond the enrich cap — never test-2'd
   * 'test2_fail'  = passed test 1, failed test 2 — ineligible but scored
   * 'test2_pass'  = passed both tests — eligible for the core set
   */
  stage: 'ineligible' | 'test1_fail' | 'test1_pass' | 'test2_fail' | 'test2_pass'
  /** Why the comp never ran test 1 */
  rejectReasons: string[]
  saleAgeDays: number | null
  /** Property-detail data was merged before test 2 */
  enriched: boolean
  test1: HybridCompTest1 | null
  test2: HybridCompTest2 | null
  /**
   * Score /100 for the card — tiered composite: the test outcome sets the
   * band (both tests → top, test-1-pass/test-2-fail → middle, test-1 fail /
   * ineligible → bottom) and proximity to the subject sets the position
   * inside the band — nearest scores highest. Every comp carries one.
   * Jev's distance-spectrum answer lives on test2.score.
   */
  score: number | null
  scoreConfidence: number | null
  /** 1-based rank across the whole pool by the composite score — #1 is the closest comp that passed both tests */
  poolRank: number | null
  /**
   * Price tier among test-2 passers — 'arv' = top-15% by adjusted price
   * (the ARV set), 'as_is' = the remainder (as-is market reference).
   * Null for any comp that didn't pass both tests.
   */
  priceTier: 'arv' | 'as_is' | null
  /** 'core' = ARV-tier test-2 passer — the only comps that feed ARV */
  selected: 'core' | null
  /** Deterministic adjustment — applied to this comp's sale price */
  adjustedPrice: number | null
}

export interface HybridTest1Result {
  entries: HybridCompScore[]
  /** The ARV set — test-2 passers in the top price tier */
  arvCompIds: string[]
  /** Every test-2 passer */
  coreCompIds: string[]
  /** Test-2 passers below the ARV tier — the as-is market reference */
  asIsCompIds: string[]
  /** True when zero comps passed test 2 — the run flags for manual review instead of standing in unexamined comps */
  humanHandoff: boolean
  noulGate: number
  /** The questions this run asked — generated from the appraisal preset */
  questionSet: {
    test1: { key: string; label: string }[]
    test2: { key: string; label: string; advisory: boolean }[]
    scoreLevels: readonly string[]
  }
  counts: {
    pool: number
    ineligible: number
    test1Passed: number
    test1Failed: number
    enriched: number
    test2Passed: number
    test2Failed: number
    arv: number
    asIs: number
    selected: number
  }
  /** Jev run metadata per stage — absent when the stage never ran */
  test1: { model: string; latencyMs: number; inputTokens: number; stateHashes: string[] } | null
  test2: { model: string; latencyMs: number; inputTokens: number; stateHashes: string[] } | null
  /** Property-detail data fetched for the test-1 passers — caller merges it into the pool */
  enrichedComps: Map<string, NormalizedComparable>
}

// ─── Run metadata (persisted on the analysis response) ──────────────────────

export interface HybridRun {
  status: 'completed' | 'skipped' | 'unavailable'
  reason?: string
  mode: 'enabled' | 'shadow'
  questionVersion: typeof COMP_HYBRID_VERSION
  /** Jev run metadata — test 1 + test 2 stages */
  model?: string
  latencyMs?: number
  inputTokens?: number
  stateHashes?: string[]
  test1?: { model: string; latencyMs: number; inputTokens: number; stateHashes: string[] } | null
  test2?: { model: string; latencyMs: number; inputTokens: number; stateHashes: string[] } | null
  counts?: HybridTest1Result['counts']
  selection?: {
    noulGate: number
    arvTopPercent?: number
    /** True when zero comps passed test 2 — flagged for manual review */
    humanHandoff?: boolean
  }
  /** The questions this run asked — generated from the appraisal preset */
  questionSet?: HybridTest1Result['questionSet']
  screenedAt?: string
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function saleAgeDays(comp: NormalizedComparable, now: Date): number | null {
  if (!comp.saleDate) return null
  const t = Date.parse(comp.saleDate)
  if (Number.isNaN(t)) return null
  return Math.floor((now.getTime() - t) / 86_400_000)
}

// ─── Engine ─────────────────────────────────────────────────────────────────

type Test1Fn = (
  subject: NormalizedProperty,
  comps: AppraisedComparable[],
  filters: AppraisalFilter[],
  rules: unknown,
  env: JevEnv,
) => Promise<JevCompTest1Result>

type Test2Fn = (
  subject: NormalizedProperty,
  comps: AppraisedComparable[],
  rules: unknown,
  env: JevEnv,
) => Promise<JevCompTest2Result>

type EnrichFn = (comps: NormalizedComparable[]) => Promise<NormalizedComparable[]>

/**
 * Test 1 on the raw pool → enrich the top-10 passers by composite score →
 * test 2 on the enriched set → split passers by price into the ARV tier
 * (top 15%) and the as-is reference. No fill: zero passers flags the run
 * for human handoff. `test1`, `test2`, and `enrich` are injectable so the
 * engine is testable without a live TypeSafe call.
 */
export async function runJevEvaluation(
  subject: NormalizedProperty,
  comps: AppraisedComparable[],
  filters: AppraisalFilter[],
  adjustments: AppraisalAdjustment[],
  env: JevEnv,
  opts?: {
    noulGate?: number
    now?: Date
    rules?: unknown
    test1?: Test1Fn
    test2?: Test2Fn
    enrich?: EnrichFn
    /** Stage progress for live UI updates — fires at each funnel boundary. */
    onProgress?: (message: string, data?: Record<string, unknown>) => void
  },
): Promise<HybridTest1Result> {
  const now = opts?.now ?? new Date()
  const noulGate = opts?.noulGate ?? COMP_NOUL_GATE
  const test1Fn: Test1Fn = opts?.test1 ?? runCompTest1WithJev
  const test2Fn: Test2Fn = opts?.test2 ?? runCompTest2WithJev
  const enrich: EnrichFn | undefined = opts?.enrich
  const rules = opts?.rules ?? filters
  const progress = opts?.onProgress

  // Stage 0 — facts only: usable sale price + usable sale date. Everything
  // else is Jev's judgment.
  const entries: HybridCompScore[] = comps.map((comp) => {
    const days = saleAgeDays(comp, now)
    const rejectReasons: string[] = []
    if (comp.salePrice == null || comp.salePrice <= 0) rejectReasons.push('No usable sale price')
    if (days == null) rejectReasons.push('No usable sale date')
    const evaluation = evaluateComparable(subject, comp, filters, adjustments)
    return {
      compId: comp.id,
      stage: rejectReasons.length > 0 ? 'ineligible' as const : 'test1_fail' as const,
      rejectReasons,
      saleAgeDays: days,
      enriched: comp.isEnriched === true,
      test1: null,
      test2: null,
      score: null,
      scoreConfidence: null,
      poolRank: null,
      priceTier: null,
      selected: null,
      adjustedPrice: evaluation.adjustedPrice,
    }
  })
  const byId = new Map(comps.map((c) => [c.id, c]))
  const candidates = entries.filter((e) => e.stage !== 'ineligible')
  const candidateComps = comps.filter((c) => candidates.some((e) => e.compId === c.id))

  // Stage 1 — test 1: the raw-field nouls. A comp passes when every field
  // the data can verify is at/above the gate; a field that cannot be
  // verified (missing on the comp or the subject) is noted, not failed.
  const defs = buildTest1Defs(filters, subject)
  let test1Meta: HybridTest1Result['test1'] = null
  if (candidateComps.length > 0) {
    progress?.(`Jev test 1 — screening ${candidateComps.length} comps on raw fields (baths, sqft, lot, year built, price, sale date)`, { stage: 'test1', candidates: candidateComps.length })
    const result = await test1Fn(subject, candidateComps, filters, rules, env)
    test1Meta = { model: result.model, latencyMs: result.latencyMs, inputTokens: result.inputTokens, stateHashes: result.stateHashes }
    for (const entry of candidates) {
      const comp = byId.get(entry.compId)!
      const nouls = result.results[entry.compId]
      if (!nouls) throw new Error(`Jev test 1 returned no result for comparable ${entry.compId}; no partial coverage accepted.`)
      const failedFields: CompTest1Field[] = []
      const unverifiableFields: CompTest1Field[] = []
      const noulRecord = {} as Record<CompTest1Field, number | null>
      for (const def of defs) {
        const verifiable = def.verifiable(subject, comp)
        if (!verifiable) {
          unverifiableFields.push(def.key)
          noulRecord[def.key] = nouls[def.key] ?? null
          continue
        }
        noulRecord[def.key] = nouls[def.key] ?? null
        if ((nouls[def.key] ?? 0) < noulGate) failedFields.push(def.key)
      }
      entry.test1 = {
        nouls: noulRecord,
        failedFields,
        unverifiableFields,
        // A field the data cannot verify is noted, not failed — providers do
        // not always return bedrooms/lot/type on the raw comps feed, and an
        // appraiser does not disqualify a sale over missing data.
        passed: failedFields.length === 0,
        // Composite /100 — filled in below for passers (needs every noul
        // recorded first); fails keep null.
        score: null,
      }
    }
  }
  const test1Passers = candidates.filter((e) => e.test1?.passed === true)
  for (const e of test1Passers) e.stage = 'test1_pass'
  const test1PassComps = test1Passers
    .map((e) => byId.get(e.compId))
    .filter((c): c is AppraisedComparable => c != null)
  if (candidateComps.length > 0) {
    progress?.(`Test 1 done — ${test1Passers.length} passed, ${candidates.length - test1Passers.length} failed`, { stage: 'test1_done', passed: test1Passers.length, failed: candidates.length - test1Passers.length })
  }

  // Test-1 composite score for every passer /100 — proximity to the
  // subject dominates (closer = higher, scaled against the configured
  // distance radius), blended with mean field-match strength across the
  // test-1 fields. Unverifiable fields count 0, so coverage is rewarded
  // along with pass quality.
  const distanceRule = filters.find((f) => f.type === 'distance' && f.enabled !== false)
  const radiusMiles = typeof distanceRule?.value === 'number' && distanceRule.value > 0 ? distanceRule.value : 1
  const strengthOf = (e: HybridCompScore): number => {
    if (!e.test1 || defs.length === 0) return 0
    let sum = 0
    for (const def of defs) sum += e.test1.nouls[def.key] ?? 0
    return sum / defs.length
  }
  for (const e of test1Passers) {
    const d = byId.get(e.compId)?.distanceMiles
    const proximity = d == null || !Number.isFinite(d) ? 0 : Math.max(0, 1 - d / radiusMiles)
    e.test1!.score = Math.round(
      100 * (COMP_TEST1_PROXIMITY_WEIGHT * proximity + (1 - COMP_TEST1_PROXIMITY_WEIGHT) * strengthOf(e)),
    )
  }

  // Enrichment budget — provider detail calls go only to the ten
  // highest-scoring test-1 passers. Score desc, nearest as the tiebreak.
  // Passers beyond the cap keep stage 'test1_pass' and never see test 2.
  const enrichPoolComps = [...test1PassComps]
    .sort((a, b) => {
      const sa = entries.find((e) => e.compId === a.id)!.test1?.score ?? -1
      const sb = entries.find((e) => e.compId === b.id)!.test1?.score ?? -1
      if (sb !== sa) return sb - sa
      return (a.distanceMiles ?? Infinity) - (b.distanceMiles ?? Infinity)
    })
    .slice(0, COMP_ENRICH_MAX)

  // Stage 2 — enrich the capped passer set with property detail
  // (subdivision, neighborhood, construction, features, transaction)
  // for test 2.
  const enrichedComps = new Map<string, NormalizedComparable>()
  let examComps: AppraisedComparable[] = enrichPoolComps
  if (enrich && enrichPoolComps.length > 0) {
    const needEnrichment = enrichPoolComps.filter((c) => c.isEnriched !== true)
    if (needEnrichment.length > 0) {
      progress?.(`Enriching ${needEnrichment.length} of ${test1PassComps.length} test-1 passers (property detail)`, { stage: 'enrich', count: needEnrichment.length, passers: test1PassComps.length })
      const enriched = await enrich(needEnrichment)
      for (const c of enriched) enrichedComps.set(c.id, c)
      const enrichedById = new Map(enriched.map((c) => [c.id, c]))
      examComps = enrichPoolComps.map((comp) => {
        const e = enrichedById.get(comp.id)
        if (!e) return comp
        const merged: AppraisedComparable = { ...comp, ...e }
        const evaluation = evaluateComparable(subject, merged, filters, adjustments)
        const entry = entries.find((en) => en.compId === comp.id)!
        entry.enriched = true
        entry.adjustedPrice = evaluation.adjustedPrice
        return merged
      })
    } else {
      for (const e of test1Passers) e.enriched = true
    }
  }

  // Stage 3 — test 2 on the enriched set: subdivision yes OR neighborhood
  // yes passes; physical character and material are advisory. The Score
  // question rates each comp on the distance-dominant spectrum.
  const maxLevel = COMP_TEST2_SCORE_LEVELS.length - 1
  let test2Meta: HybridTest1Result['test2'] = null
  if (examComps.length > 0) {
    progress?.(`Jev test 2 — ${examComps.length} enriched comps (subdivision/neighborhood + proximity score)`, { stage: 'test2', candidates: examComps.length })
    const result = await test2Fn(subject, examComps, rules, env)
    test2Meta = { model: result.model, latencyMs: result.latencyMs, inputTokens: result.inputTokens, stateHashes: result.stateHashes }
    const examIds = new Set(examComps.map((c) => c.id))
    for (const entry of test1Passers) {
      if (!examIds.has(entry.compId)) continue // beyond the enrich cap — stays 'test1_pass'
      const t2 = result.results[entry.compId]
      if (!t2) throw new Error(`Jev test 2 returned no result for comparable ${entry.compId}; no partial coverage accepted.`)
      const passed = t2.nouls.subdivision >= noulGate || t2.nouls.neighborhood >= noulGate
      // Passers: 90 baseline + up to 10 as physical matches land (character,
      // material, foundation). Fails keep the distance spectrum scaled
      // below the pass floor so a fail never outranks a pass.
      const matchMean = (t2.nouls.physicalCharacter + t2.nouls.material + t2.nouls.foundation) / 3
      entry.test2 = {
        nouls: t2.nouls,
        passed,
        score: passed
          ? Math.min(100, COMP_TEST2_PASS_BASELINE + Math.round((100 - COMP_TEST2_PASS_BASELINE) * matchMean))
          : Math.min(COMP_TEST2_PASS_BASELINE - 1, Math.round((t2.rawScore / maxLevel) * (COMP_TEST2_PASS_BASELINE - 1))),
        confidence: t2.confidence,
        levelProbabilities: t2.levelProbabilities,
      }
      entry.stage = passed ? 'test2_pass' : 'test2_fail'
      entry.score = entry.test2.score
      entry.scoreConfidence = t2.confidence
    }
    const passed2 = test1Passers.filter((e) => e.test2?.passed === true).length
    progress?.(`Test 2 done — ${passed2} passed, ${examComps.length - passed2} failed`, { stage: 'test2_done', passed: passed2, failed: examComps.length - passed2 })
  }

  // Stage 4 — rank the test-2-evaluated set by Jev's distance Score (ties →
  // confidence → distance → recency). This orders the fill bucket.
  const evaluated = entries.filter((e) => e.test2 !== null).sort((a, b) => {
    const sa = a.test2!.score
    const sb = b.test2!.score
    if (sb !== sa) return sb - sa
    const ca = a.test2!.confidence ?? 0
    const cb = b.test2!.confidence ?? 0
    if (cb !== ca) return cb - ca
    const da = byId.get(a.compId)?.distanceMiles ?? Infinity
    const db = byId.get(b.compId)?.distanceMiles ?? Infinity
    if (da !== db) return da - db
    const ta = byId.get(a.compId)?.saleDate ? Date.parse(byId.get(a.compId)!.saleDate!) : 0
    const tb = byId.get(b.compId)?.saleDate ? Date.parse(byId.get(b.compId)!.saleDate!) : 0
    return tb - ta
  })

  // Stage 5 — the card score for every comp: the test outcome sets the band
  // and proximity to the subject sets the position inside it, so the score
  // sort reads best→worst with the nearest comps always on top. Test-2
  // passers carry their match score (90 baseline → 100 on physical
  // matches); the test-1-pass/test-2-fail bucket sits in the middle, and
  // test-1 fails (or unusable comps) sit at the bottom.
  for (const stage of ['test2_pass', 'test2_fail', 'test1_pass', 'test1_fail', 'ineligible'] as const) {
    const tierEntries = entries.filter((e) => e.stage === stage)
    if (tierEntries.length === 0) continue
    if (stage === 'test2_pass') {
      for (const e of tierEntries) e.score = e.test2!.score
      continue
    }
    const [lo, hi] = COMP_TIER_BANDS[stage]
    const distances = tierEntries
      .map((e) => byId.get(e.compId)?.distanceMiles)
      .filter((d): d is number => d != null && Number.isFinite(d))
    const dMin = distances.length ? Math.min(...distances) : 0
    const dMax = distances.length ? Math.max(...distances) : 0
    for (const e of tierEntries) {
      const d = byId.get(e.compId)?.distanceMiles
      const frac = d == null || !Number.isFinite(d) ? 1 : dMax > dMin ? (d - dMin) / (dMax - dMin) : 0
      e.score = Math.round(hi - frac * (hi - lo))
    }
  }

  // Stage 6 — classification: passing test 2 means the comp matched the
  // rules, not that it's an ARV comp. Split the passers by adjusted price —
  // the top 15% become the ARV set (variable count, not capped at 3), the
  // rest become the as-is market reference. No fill: a short passer set
  // stays short, and zero passers flags the run for human handoff.
  const core = evaluated.filter((e) => e.stage === 'test2_pass')
  const arvCount = core.length > 0
    ? Math.max(1, Math.ceil(core.length * (COMP_ARV_TOP_PERCENT / 100)))
    : 0
  const byPrice = [...core].sort((a, b) => {
    const pa = a.adjustedPrice ?? -Infinity
    const pb = b.adjustedPrice ?? -Infinity
    if (pb !== pa) return pb - pa
    return (b.test2?.score ?? 0) - (a.test2?.score ?? 0)
  })
  const arvSet = new Set(byPrice.slice(0, arvCount).map((e) => e.compId))
  for (const e of core) {
    e.priceTier = arvSet.has(e.compId) ? 'arv' : 'as_is'
    e.selected = arvSet.has(e.compId) ? 'core' : null
  }
  const arvCompIds = [...arvSet]
  const asIsCompIds = core.filter((e) => e.priceTier === 'as_is').map((e) => e.compId)
  const humanHandoff = core.length === 0
  if (humanHandoff) {
    progress?.('Human handoff — zero comps passed test 2', { stage: 'human_handoff' })
  }
  progress?.(
    `Selection — ${arvCompIds.length} ARV / ${asIsCompIds.length} as-is of ${core.length} test-2 passers${humanHandoff ? ' — human handoff' : ''}`,
    { stage: 'selected', arv: arvCompIds.length, asIs: asIsCompIds.length, passers: core.length, humanHandoff }
  )

  // Rank the whole pool by the composite (score desc → nearest → newest) so
  // poolRank matches the order the dashboard's score sort shows.
  const ranked = [...entries].sort((a, b) => {
    const ds = (b.score ?? -1) - (a.score ?? -1)
    if (ds !== 0) return ds
    const da = byId.get(a.compId)?.distanceMiles ?? Infinity
    const db = byId.get(b.compId)?.distanceMiles ?? Infinity
    if (da !== db) return da - db
    const ta = byId.get(a.compId)?.saleDate ? Date.parse(byId.get(a.compId)!.saleDate!) : 0
    const tb = byId.get(b.compId)?.saleDate ? Date.parse(byId.get(b.compId)!.saleDate!) : 0
    return tb - ta || a.compId.localeCompare(b.compId)
  })
  ranked.forEach((e, i) => { e.poolRank = i + 1 })

  const counts = {
    pool: comps.length,
    ineligible: entries.length - candidates.length,
    test1Passed: test1Passers.length,
    test1Failed: candidates.length - test1Passers.length,
    enriched: entries.filter((e) => e.enriched).length,
    test2Passed: core.length,
    test2Failed: evaluated.length - core.length,
    arv: arvCompIds.length,
    asIs: asIsCompIds.length,
    selected: arvCompIds.length,
  }

  return {
    entries,
    arvCompIds,
    coreCompIds: core.map((e) => e.compId),
    asIsCompIds,
    humanHandoff,
    noulGate,
    questionSet: {
      test1: defs.map(({ key, label }) => ({ key, label })),
      test2: [
        { key: 'subdivision', label: COMP_TEST2_NOUL_LABELS.subdivision, advisory: false },
        { key: 'neighborhood', label: COMP_TEST2_NOUL_LABELS.neighborhood, advisory: false },
        { key: 'physicalCharacter', label: COMP_TEST2_NOUL_LABELS.physicalCharacter, advisory: true },
        { key: 'material', label: COMP_TEST2_NOUL_LABELS.material, advisory: true },
        { key: 'foundation', label: COMP_TEST2_NOUL_LABELS.foundation, advisory: true },
      ],
      scoreLevels: COMP_TEST2_SCORE_LEVELS,
    },
    counts,
    test1: test1Meta,
    test2: test2Meta,
    enrichedComps,
  }
}
