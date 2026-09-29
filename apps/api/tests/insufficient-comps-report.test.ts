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
 *  4. The step log records `appraisal_rules` failed + `valuation` skipped.
 *  5. `report.arv.value` / `report.outcome.*` are null — no fabricated ARV.
 *  6. Zero comps found → same degraded shape, empty pool.
 *  7. `jevOutcome` marks 'unavailable/insufficient_comps' — no LLM spend.
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
  propertyType: 'SFR',
  salePrice: 280000 + i * 10000,
  // Older than every configured sale-age tier — nothing can qualify.
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
assert.equal(response.valuation, null, 'no valuation is fabricated')
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
  steps.find((s) => s.step === 'appraisal_rules')?.status,
  'failed',
  'appraisal step records the failure',
)
assert.equal(
  steps.find((s) => s.step === 'valuation')?.status,
  'skipped',
  'valuation step records the skip',
)
assert.equal(response.report?.arv.value, null, 'report ARV is null, not invented')
assert.equal(response.report?.outcome.recommendation, null)
assert.ok(
  (response.report?.fallbacksUsed ?? []).includes('insufficient_comps'),
  'insufficient_comps is in the fallback ledger',
)
assert.deepEqual(response.jevOutcome, { status: 'unavailable', reason: 'insufficient_comps' })

// ─── Empty pool → same degraded shape ───────────────────────────────────────

const empty = await performAnalysis(
  { jobId: 'job-no-comps', bundle: bundle([]) },
  env,
)
assert.equal(empty.response.valuation, null)
assert.equal(empty.response.comps.insufficientComps, true)
assert.equal(empty.response.comps.items.length, 0)
assert.equal(
  empty.response.report?.steps.find((s) => s.step === 'appraisal_rules')?.status,
  'failed',
)

console.log('insufficient-comps-report: all assertions passed')
