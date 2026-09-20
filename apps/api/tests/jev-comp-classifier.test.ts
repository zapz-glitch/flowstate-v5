import assert from 'node:assert/strict'
import {
  classifyCompPriceWithJev,
  compClassifierEligible,
  compClassifierMode,
  COMP_PRICE_CLASSES,
  COMP_PRICE_QUESTION_VERSION,
  routeCompPriceClass,
  routeCompPriceClasses,
} from '../src/services/jev'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const fakeSubject = {
  id: 's1', address: '1 Main St', city: 'Atlanta', state: 'GA', zipCode: '30301',
  bedrooms: 3, bathrooms: 2, squareFeet: 1400, yearBuilt: 1985, subdivision: 'Test Sub',
} as never

const fakeComp = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, address: `${id} Oak Ln`, city: 'Atlanta', state: 'GA', salePrice: 240000,
  saleDate: '2026-06-01', squareFeet: 1420, pricePerSqft: 169, distanceMiles: 0.4,
  bedrooms: 3, bathrooms: 2, yearBuilt: 1987, adjustedSalePrice: 245000,
  evaluation: {
    comparableId: id, shouldDisable: false, disableReasons: [],
    filterResults: [{ type: 'distance', passed: true }],
    totalAdjustment: 5000, adjustmentResults: [], originalPrice: 240000, adjustedPrice: 245000,
  },
  ...overrides,
}) as never

const disabledComp = (id: string) => fakeComp(id, {
  evaluation: {
    comparableId: id, shouldDisable: true, disableReasons: ['construction_material_match'],
    filterResults: [{ type: 'construction_material_match', passed: false }],
    totalAdjustment: 0, adjustmentResults: [], originalPrice: 240000, adjustedPrice: 240000,
  },
})

const env = { TYPESAFE_API_KEY: 'k', TYPESAFE_MODEL: 'jev-test-1' }
const originalFetch = globalThis.fetch

/** Mock Jev: echoes one choice answer per question, choice value from `pick`. */
function mockJev(pick: (questionId: string) => unknown, capture?: { body?: Record<string, unknown> }) {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    if (capture) capture.body = body
    const questions = (body.questions ?? {}) as Record<string, { type: string; criteria?: Record<string, string> }>
    const answers = Object.fromEntries(Object.keys(questions).map((id) => [id, pick(id)]))
    return Response.json({ model: 'jev-test-1', answers, usage: { input_tokens: 500 } })
  }
}

// ─── 1. Feature-flag isolation ────────────────────────────────────────────────

assert.equal(compClassifierMode({}), 'shadow')                       // default: shadow on
assert.equal(compClassifierMode({ JEV_COMP_CLASSIFIER_V2_SHADOW: 'false' }), 'off')
assert.equal(compClassifierMode({ JEV_COMP_CLASSIFIER_V2_ENABLED: 'true' }), 'enabled')
assert.equal(compClassifierMode({ JEV_COMP_CLASSIFIER_V2_ENABLED: 'true', JEV_COMP_CLASSIFIER_V2_SHADOW: 'false' }), 'enabled')
assert.equal(compClassifierMode({ JEV_COMP_CLASSIFIER_V2_ENABLED: 'false' }), 'shadow')
// Baseline A is production whenever mode is not 'enabled'
assert.notEqual(compClassifierMode({}), 'enabled')
assert.notEqual(compClassifierMode({ JEV_COMP_CLASSIFIER_V2_SHADOW: 'false' }), 'enabled')

// ─── 2. Eligibility gate ──────────────────────────────────────────────────────

assert.equal(compClassifierEligible(fakeComp('ok')), true)
assert.equal(compClassifierEligible(disabledComp('bad')), false)                      // hard-gate failure
assert.equal(compClassifierEligible(fakeComp('far', { distanceMiles: 0.9 })), false)  // outside radius
assert.equal(compClassifierEligible(fakeComp('nodist', { distanceMiles: null })), false)
assert.equal(compClassifierEligible(fakeComp('noeval', { evaluation: undefined })), true) // no evaluation ≠ disabled
// soft failures (shouldDisable false despite failed filters) still eligible
assert.equal(compClassifierEligible(fakeComp('soft', {
  evaluation: {
    comparableId: 'soft', shouldDisable: false, disableReasons: [],
    filterResults: [{ type: 'subdivision_match', passed: false }],
    totalAdjustment: 0, adjustmentResults: [], originalPrice: 240000, adjustedPrice: 240000,
  },
})), true)

// ─── 3. Gate-before-JEV: only eligible comps reach the classifier ─────────────

{
  const capture: { body?: Record<string, unknown> } = {}
  mockJev(() => ({ type: 'choice', choice: 'ARV', confidence: 0.9, probabilities: { ARV: 0.9, AS_IS: 0.05, UNIDENTIFIED: 0.05 } }), capture)
  const mixed = [fakeComp('e1'), disabledComp('d1'), fakeComp('e2'), fakeComp('far', { distanceMiles: 2.1 })]
  const eligible = mixed.filter(compClassifierEligible)
  assert.deepEqual(eligible.map((c) => (c as { id: string }).id).sort(), ['e1', 'e2'])
  const result = await classifyCompPriceWithJev(fakeSubject, eligible, {}, env)
  const state = capture.body!.state as { comparables: Array<{ id: string }>; eligibleMarket: { eligibleCount: number } }
  // Jev never saw the gate failures
  assert.deepEqual(state.comparables.map((c) => c.id).sort(), ['e1', 'e2'])
  assert.equal(state.eligibleMarket.eligibleCount, 2)
  assert.deepEqual(Object.keys(result.classifications).sort(), ['e1', 'e2'])
  assert.equal(result.classifications.e1!.class, 'ARV')
}

// ─── 4. One choice question per comp, mutually exclusive classes ──────────────

{
  const capture: { body?: Record<string, unknown> } = {}
  mockJev(() => ({ type: 'choice', choice: 'AS_IS', confidence: 0.8, probabilities: { ARV: 0.1, AS_IS: 0.8, UNIDENTIFIED: 0.1 } }), capture)
  await classifyCompPriceWithJev(fakeSubject, [fakeComp('c1'), fakeComp('c2'), fakeComp('c3')], {}, env)
  const questions = capture.body!.questions as Record<string, { type: string; criteria: Record<string, string> }>
  const qlist = Object.values(questions)
  assert.equal(qlist.length, 3)                                    // ONE question per comp (not two nouls)
  assert.ok(qlist.every((q) => q.type === 'choice'))               // never a score/noul
  for (const q of qlist) assert.deepEqual(Object.keys(q.criteria).sort(), [...COMP_PRICE_CLASSES].sort())
  assert.deepEqual(Object.keys(questions).sort(), ['comp_0_price_classification', 'comp_1_price_classification', 'comp_2_price_classification'])
  // No circular leakage: no truth scores / valuations in comp evidence
  const state = capture.body!.state as { comparables: Array<Record<string, unknown>> }
  for (const comp of state.comparables) {
    assert.equal(comp.jevArvTruth, undefined)
    assert.equal(comp.jevInvestmentTruth, undefined)
    assert.equal(comp.arv, undefined)
    assert.equal(comp.asIsValue, undefined)
    assert.ok(Object.hasOwn(comp, 'ruleEvidence'))
    assert.ok(Object.hasOwn(comp, 'pricePercentileAmongEligible'))
  }
}

// ─── 5. Deterministic routing invariants ──────────────────────────────────────

assert.deepEqual(routeCompPriceClass('ARV'), { arvPool: true, asIsPool: false })
assert.deepEqual(routeCompPriceClass('AS_IS'), { arvPool: false, asIsPool: true })
assert.deepEqual(routeCompPriceClass('UNIDENTIFIED'), { arvPool: false, asIsPool: false })
assert.deepEqual(routeCompPriceClass(null), { arvPool: false, asIsPool: false })   // missing → closed
assert.deepEqual(routeCompPriceClass(undefined), { arvPool: false, asIsPool: false })

{
  const { arvIds, asIsIds } = routeCompPriceClasses({
    a: { class: 'ARV', probabilities: null, confidence: 0.9 },
    b: { class: 'AS_IS', probabilities: null, confidence: 0.8 },
    c: { class: 'UNIDENTIFIED', probabilities: null, confidence: 0.4 },
    d: null,           // missing result → neither pool
    e: undefined,      // missing result → neither pool
  })
  assert.deepEqual([...arvIds], ['a'])
  assert.deepEqual([...asIsIds], ['b'])
  // Disjoint by construction — a comp can never be in both pools
  for (const id of arvIds) assert.ok(!asIsIds.has(id))
  for (const id of asIsIds) assert.ok(!arvIds.has(id))
  // UNIDENTIFIED and missing enter neither
  assert.ok(!arvIds.has('c') && !asIsIds.has('c'))
  assert.ok(!arvIds.has('d') && !asIsIds.has('d'))
  assert.ok(!arvIds.has('e') && !asIsIds.has('e'))
}

// Empty result → empty pools (never silently forces a class)
{
  const { arvIds, asIsIds } = routeCompPriceClasses({})
  assert.equal(arvIds.size, 0)
  assert.equal(asIsIds.size, 0)
}

// ─── 6. Fail-closed parsing ───────────────────────────────────────────────────

// 6a. Malformed answer (wrong primitive) → UNIDENTIFIED, not an error
{
  mockJev(() => ({ type: 'score', score: 1.5, confidence: 0.9 }))
  const result = await classifyCompPriceWithJev(fakeSubject, [fakeComp('c1')], {}, env)
  assert.equal(result.classifications.c1!.class, 'UNIDENTIFIED')
  const { arvIds, asIsIds } = routeCompPriceClasses(result.classifications)
  assert.equal(arvIds.size, 0)
  assert.equal(asIsIds.size, 0)
}

// 6b. Unknown choice string → UNIDENTIFIED, raw value preserved for debugging
{
  mockJev(() => ({ type: 'choice', choice: 'RENOVATED_MAYBE', confidence: 0.9 }))
  const result = await classifyCompPriceWithJev(fakeSubject, [fakeComp('c1')], {}, env)
  assert.equal(result.classifications.c1!.class, 'UNIDENTIFIED')
  assert.equal(result.classifications.c1!.rawChoice, 'RENOVATED_MAYBE')
}

// 6c. Missing answer for one comp → that comp UNIDENTIFIED, others still classify
{
  mockJev((id) => id === 'comp_1_price_classification'
    ? { type: 'choice', choice: 'AS_IS', confidence: 0.8, probabilities: { AS_IS: 0.8 } }
    : id === 'comp_2_price_classification'
      ? undefined  // missing entirely
      : { type: 'choice', choice: 'ARV', confidence: 0.9, probabilities: { ARV: 0.9 } })
  const result = await classifyCompPriceWithJev(fakeSubject, [fakeComp('c1'), fakeComp('c2'), fakeComp('c3')], {}, env)
  assert.equal(result.classifications.c1!.class, 'ARV')
  assert.equal(result.classifications.c2!.class, 'AS_IS')
  assert.equal(result.classifications.c3!.class, 'UNIDENTIFIED')
  const { arvIds, asIsIds } = routeCompPriceClasses(result.classifications)
  assert.deepEqual([...arvIds], ['c1'])
  assert.deepEqual([...asIsIds], ['c2'])
}

// 6d. Missing answer key in the response object → UNIDENTIFIED
{
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }
    const keys = Object.keys(body.questions)
    const echoed = Object.fromEntries(keys.slice(0, -1).map((id) => [id, { type: 'choice', choice: 'ARV', confidence: 0.9 }]))
    return Response.json({ model: 'jev-test-1', answers: echoed, usage: { input_tokens: 1 } })
  }
  const result = await classifyCompPriceWithJev(fakeSubject, [fakeComp('c1'), fakeComp('c2')], {}, env)
  assert.equal(result.classifications.c1!.class, 'ARV')
  assert.equal(result.classifications.c2!.class, 'UNIDENTIFIED')
}

// 6e. Malformed envelope (bad model shape) → whole batch rejected, throws
{
  globalThis.fetch = async () => Response.json({ model: 'not-a-jev-model!', answers: {}, usage: { input_tokens: 1 } })
  await assert.rejects(() => classifyCompPriceWithJev(fakeSubject, [fakeComp('c1')], {}, env))
}

// 6f. Request failure/timeout → throws; caller falls back, never forces a class
{
  globalThis.fetch = async () => { throw new Error('timeout') }
  await assert.rejects(() => classifyCompPriceWithJev(fakeSubject, [fakeComp('c1')], {}, env))
  globalThis.fetch = async () => Response.json({ error: 'x' }, { status: 429 })
  await assert.rejects(() => classifyCompPriceWithJev(fakeSubject, [fakeComp('c1')], {}, env))
}

// 6g. No API key → throws before any request
{
  globalThis.fetch = async () => { throw new Error('fetch should not be called') }
  await assert.rejects(() => classifyCompPriceWithJev(fakeSubject, [fakeComp('c1')], {}, {}))
}

// ─── 7. Duplicate / retried responses cannot duplicate comps ──────────────────

{
  // classifications keyed by comp id — a retried batch answer just overwrites
  const map = {
    c1: { class: 'ARV' as const, probabilities: null, confidence: 0.9 },
  }
  const once = routeCompPriceClasses(map)
  const twice = routeCompPriceClasses({ ...map })  // retry produces same map
  assert.equal(once.arvIds.size, 1)
  assert.equal(twice.arvIds.size, 1)
  // Duplicate comp ids are rejected before any request
  globalThis.fetch = async () => { throw new Error('fetch should not be called') }
  await assert.rejects(() => classifyCompPriceWithJev(fakeSubject, [fakeComp('c1'), fakeComp('c1')], {}, env))
}

// ─── 8. Probabilities kept for observability, never routing ───────────────────

{
  mockJev(() => ({ type: 'choice', choice: 'UNIDENTIFIED', confidence: 0.55, probabilities: { ARV: 0.34, AS_IS: 0.33, UNIDENTIFIED: 0.33 } }))
  const result = await classifyCompPriceWithJev(fakeSubject, [fakeComp('c1')], {}, env)
  const cls = result.classifications.c1!
  assert.equal(cls.class, 'UNIDENTIFIED')
  assert.equal(cls.confidence, 0.55)
  assert.equal(cls.probabilities!.ARV, 0.34)
  // High P(ARV) inside an UNIDENTIFIED verdict still routes nowhere —
  // the selected class is the only routing input.
  const { arvIds, asIsIds } = routeCompPriceClasses(result.classifications)
  assert.equal(arvIds.size, 0)
  assert.equal(asIsIds.size, 0)
}

// ─── 8b. top1/top2/margin persisted for abstention analysis ──────────────────

{
  mockJev(() => ({ type: 'choice', choice: 'ARV', confidence: 0.7, probabilities: { ARV: 0.7, AS_IS: 0.2, UNIDENTIFIED: 0.1 } }))
  const result = await classifyCompPriceWithJev(fakeSubject, [fakeComp('c1')], {}, env)
  const cls = result.classifications.c1!
  assert.equal(cls.top1, 0.7)
  assert.equal(cls.top2, 0.2)
  assert.equal(cls.margin, 0.5)
}

{
  // Missing probabilities → nulls, still classified
  mockJev(() => ({ type: 'choice', choice: 'AS_IS', confidence: 0.6 }))
  const result = await classifyCompPriceWithJev(fakeSubject, [fakeComp('c1')], {}, env)
  const cls = result.classifications.c1!
  assert.equal(cls.class, 'AS_IS')
  assert.equal(cls.top1, null)
  assert.equal(cls.top2, null)
  assert.equal(cls.margin, null)
}

{
  // Single-probability payload → top1 set, top2/margin null
  mockJev(() => ({ type: 'choice', choice: 'ARV', probabilities: { ARV: 0.99 } }))
  const result = await classifyCompPriceWithJev(fakeSubject, [fakeComp('c1')], {}, env)
  const cls = result.classifications.c1!
  assert.equal(cls.top1, 0.99)
  assert.equal(cls.top2, null)
  assert.equal(cls.margin, null)
}

// ─── 9. Run metadata ──────────────────────────────────────────────────────────

{
  mockJev(() => ({ type: 'choice', choice: 'ARV', confidence: 0.9, probabilities: { ARV: 0.9 } }))
  const result = await classifyCompPriceWithJev(fakeSubject, [fakeComp('c1'), fakeComp('c2')], {}, env)
  assert.equal(result.model, 'jev-test-1')
  assert.equal(result.inputTokens, 500)
  assert.ok(result.latencyMs >= 0)
  assert.equal(result.stateHashes.length, 1)          // one batch → one state fingerprint
  assert.ok(/^[0-9a-f]+$/.test(result.stateHashes[0]!))
  assert.equal(COMP_PRICE_QUESTION_VERSION, 'comp_price_classification_v1')
}

globalThis.fetch = originalFetch
console.log('jev-comp-classifier: all invariants pass')
