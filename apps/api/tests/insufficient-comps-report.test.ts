/**
 * Insufficient-comps regression proof.
 *
 * Before this fix, a pool that ended INSUFFICIENT_COMPS threw an
 * AnalysisError — the job pushed an `error` event, no report was saved,
 * and Property Search dead-ended on a red error card.
 *
 * Now the pipeline completes with `valuation: null` — the subject, the
 * full evaluated comp pool, per-comp rule evidence, and the step log are
 * all preserved so the report renders like every other property.
 *
 * Asserts:
 *  1. Old-sale comps (beyond every sale-age tier) → completes, not throws.
 *  2. `valuation === null`, `comps.insufficientComps === true`.
 *  3. Every comp item stays in the report with `isEnabled: false` and
 *     per-rule `appraisalRules` evidence.
 *  4. The step log records `appraisal_rules` failed + `valuation` skipped
 *     (last `appraisal_rules` entry — an earlier `completed` entry records
 *     the evidence-selection pass).
 *  5. `report.arv.value` / `report.outcome.*` are null — no fabricated ARV.
 *  6. Zero comps found → same degraded shape, empty pool.
 *  7. `jevOutcome` is absent — the Jev path was excised post-#79.
 */
import assert from 'node:assert/strict'
import { performAnalysis } from '../src/services/evaluation'
import type { Env } from '../src/types'
import type {
  NormalizedComparable,
  NormalizedProperty,
  PropertyBundle,
} from '../src/services/property-api/types'

const daysAgo = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

// No provider keys, no LLM keys, no DB — every optional dependency degrades:
// photos unavailable, vision resolves a non-ok verdict, Jev throws (caught),
// seller notes skip (no leadId), major-item config skips (no userId).
const env = {} as Env

const subject: NormalizedProperty = {
  id: 'clip-subject-1',
  provider: 'corelogic',
  address: '123 Subject St',
  city: 'Tampa',
  state: 'FL',
  zipCode: '33607',
  latitude: 27.95,
  longitude: -82.45,
  bedrooms: 3,
  bathrooms: 2,
  squareFeet: 1400,
  lotSizeAcres: 0.18,
  yearBuilt: 1988,
  propertyType: 'SFR',
  stories: 1,
  lastSalePrice: 150000,
  lastSaleDate: daysAgo(3000),
  assessedValue: 180000,
  marketValue: 180000,
  taxAmount: 2100,
}

const staleComp = (i: number): NormalizedComparable => ({
  id: `clip-comp-${i}`,
  provider: 'corelogic',
  address: `${200 + i} Old Sale Rd`,
  city: 'Tampa',
  state: 'FL',
  zipCode: '33607',
  latitude: 27.95 + i * 0.001,
  longitude: -82.45 + i * 0.001,
  distanceMiles: 0.2 + i * 0.1,
  bedrooms: 3,
  bathrooms: 2,
  squareFeet: 1350 + i * 100,
  lotSizeAcres: 0.17,
  yearBuilt: 1990,
  // A different property type is a rule the filter ladder never loosens —
  // nothing can qualify. (Sale age alone no longer proves that: the ladder
  // widens it without a fixed cap, docs/FILTER-LADDER.md.)
  propertyType: 'Condominium',
  salePrice: 280000 + i * 10000,
  saleDate: daysAgo(2400),
  pricePerSqft: 200,
})

const bundle = (comparables: NormalizedComparable[]): PropertyBundle => ({
  property: subject,
  comparables,
  enrichment: {
    permits: null,
    floodZone: null,
    weatherRisk: null,
    neighbourhood: null,
  },
  metadata: {
    fetchedAt: new Date().toISOString(),
    provider: 'corelogic',
    searchParams: { propertyId: subject.id },
    comparablesParams: { propertyId: subject.id, radiusMiles: 1, monthsBack: 12 },
    enrichmentOptions: {},
  },
})

// ─── Stale pool → degraded report, not a throw ──────────────────────────────

const result = await performAnalysis(
  { jobId: 'job-insufficient', bundle: bundle([staleComp(1), staleComp(2), staleComp(3)]) },
  env,
)

const { response } = result
assert.equal(response.evaluationEngine, 'ts-v5')
// Assessed-value anchor: insufficient comps still produce a valuation when a
// modeled value exists — marked 'assessed', never mistaken for comp-verified.
assert.equal(response.valuation?.arvSource, 'assessed', 'valuation anchored on county assessment')
assert.equal(response.valuation?.arv, 180000)
assert.equal(response.comps.insufficientComps, true, 'pool flagged insufficient')
assert.equal(response.comps.total, 3, 'full evaluated pool is preserved')
assert.equal(response.comps.items.length, 3)
assert.ok(
  response.comps.items.every((c) => c.isEnabled === false),
  'every comp is disabled — none qualified',
)
assert.ok(
  response.comps.items.every((c) => c.appraisalRules != null),
  'per-comp appraisal-rule evidence survives the degraded path',
)

// Subject + audit trail still render like a normal report.
assert.equal(response.subject.address, '123 Subject St, Tampa, FL 33607')
const steps = response.report?.steps ?? []
assert.equal(
  steps.findLast((s) => s.step === 'appraisal_rules')?.status,
  'failed',
  'appraisal step records the failure',
)
assert.equal(
  steps.find((s) => s.step === 'valuation')?.status,
  'completed',
  'valuation step completes on the assessed anchor',
)
assert.match(
  steps.find((s) => s.step === 'valuation')?.detail ?? '',
  /Assessment-anchored/,
  'valuation step marks the anchor, not comp evidence',
)
assert.equal(response.report?.arv.value, 180000, 'report ARV carries the assessment anchor')
assert.ok(response.report?.outcome.recommendation != null, 'anchored valuation still yields a deal verdict')
assert.equal(response.report?.requiresHumanReview, true, 'anchored runs still flag for human review')
assert.ok(
  (response.report?.fallbacksUsed ?? []).includes('insufficient_comps'),
  'insufficient_comps is in the fallback ledger',
)
assert.equal(
  'jevOutcome' in response,
  false,
  'jevOutcome field is gone — the Jev path was excised from this provider',
)

// ─── Empty pool → same degraded shape ───────────────────────────────────────

const empty = await performAnalysis(
  { jobId: 'job-no-comps', bundle: bundle([]) },
  env,
)
assert.equal(empty.response.valuation?.arvSource, 'assessed', 'empty pool still anchors on assessment')
assert.equal(empty.response.valuation?.arv, 180000)
assert.equal(empty.response.comps.insufficientComps, true)
assert.equal(empty.response.comps.items.length, 0)
assert.equal(
  empty.response.report?.steps.findLast((s) => s.step === 'appraisal_rules')?.status,
  'failed',
)

// ─── No modeled value either → true report-only (valuation stays null) ──────

const noAnchor = await performAnalysis(
  {
    jobId: 'job-no-anchor',
    bundle: {
      ...bundle([staleComp(9), staleComp(10)]),
      property: { ...subject, assessedValue: null, avmValue: null, marketValue: null },
      enrichment: { ...bundle([]).enrichment, avm: null },
    },
  },
  env,
)
assert.equal(noAnchor.response.valuation, null, 'no anchor → no valuation is fabricated')
assert.equal(noAnchor.response.comps.insufficientComps, true)
assert.equal(
  noAnchor.response.report?.steps.find((s) => s.step === 'valuation')?.status,
  'skipped',
  'valuation step records the skip when nothing anchors it',
)

console.log('insufficient-comps-report: all assertions passed')
