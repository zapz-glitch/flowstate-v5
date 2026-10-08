import assert from 'node:assert/strict'
import { detectEscalationTriggers, escalateBandReview } from '../src/services/evaluation/band-escalate'
import { isAsIsEvidence } from '../src/services/evaluation/band-adjudicate'
import { computeEvidenceBands } from '@flowstate-api/shared/appraisal'
import type { BComp } from '@flowstate-api/shared/appraisal'

// Escalation tier unit coverage — the trigger predicate, the coherence
// fence, and the doctrine guardrails the expert's overrides pass through.
// Success = every trigger fires on its signature input, nothing fires on a
// clean adjudication, and no path emits an invalid override.

type Row = BComp & { id: string; band?: 'as_is' | 'median' | 'arv' | null }

const comp = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  isEnabled: true,
  salePrice: 200_000,
  squareFeet: 1000,
  saleDate: '2026-06-01',
  classification: { type: 'after_renovation' },
  curbAppeal: { condition: 'renovated' },
  ...over,
})

const cleanAdjudication = { overrides: {}, adjustments: [], model: 'test', ambiguous: [], confidence: 0.9 }

const baseInput = (over: Partial<Parameters<typeof detectEscalationTriggers>[0]> = {}) => ({
  subject: { squareFeet: 1000 },
  comps: [comp('a'), comp('b')],
  adjudication: cleanAdjudication,
  draftArvMid: 200_000,
  adjudicatedArvMid: 200_000,
  arvMemberIds: ['a', 'b'],
  arvSpread: 0.05,
  ...over,
})

// ── Trigger matrix ───────────────────────────────────────────────────────────

assert.deepEqual(detectEscalationTriggers(baseInput()), [], 'clean adjudication never escalates')
assert.ok(detectEscalationTriggers(baseInput({ adjudication: { ...cleanAdjudication, confidence: 0.55 } })).includes('low_confidence'))
assert.ok(detectEscalationTriggers(baseInput({ adjudication: { ...cleanAdjudication, ambiguous: ['a'] } })).includes('ambiguous_members'))
assert.ok(detectEscalationTriggers(baseInput({ adjudicatedArvMid: 220_000 })).includes('material_arv_shift'), '>5% mid shift fires')
assert.deepEqual(
  detectEscalationTriggers(baseInput({ adjudicatedArvMid: 209_000 })).filter((t) => t === 'material_arv_shift'),
  [], 'a 4.5% shift does not fire',
)
assert.ok(detectEscalationTriggers(baseInput({ arvMemberIds: ['a'] })).includes('thin_arv_anchor'))
assert.ok(detectEscalationTriggers(baseInput({ arvSpread: 0.55 })).includes('wide_arv_spread'))
assert.ok(
  detectEscalationTriggers(
    baseInput({ comps: [comp('a'), comp('b', { curbAppeal: { condition: 'distressed' } })] }),
  ).includes('conflicting_condition_evidence'),
  'after_renovation listing + distressed vision = conflict',
)
assert.ok(
  detectEscalationTriggers(
    baseInput({
      comps: [
        comp('a'),
        comp('b', { classification: { type: 'as_is' }, curbAppeal: { condition: 'renovated' } }),
      ],
    }),
  ).includes('conflicting_condition_evidence'),
  'as_is listing + renovated vision = conflict',
)

// ── Doctrine guardrails ───────────────────────────────────────────────────────

assert.equal(
  isAsIsEvidence(comp('x', { classification: { type: 'as_is' }, curbAppeal: { condition: 'renovated' } })),
  true,
  'as_is listing class is as-is evidence even with a renovated vision read',
)
assert.equal(isAsIsEvidence(comp('x', { curbAppeal: { condition: 'distressed' } })), true)
assert.equal(isAsIsEvidence(comp('x', { evidenceVerification: { transactionCheck: 'nominal_sale' } })), true)
assert.equal(isAsIsEvidence(comp('x')), false)

// ── Coherence fence ───────────────────────────────────────────────────────────

{
  // Unit rates 200/210/220/230/258 — the 1.5×IQR fence keeps 258 but the
  // 1.0×IQR core fence excludes it from edges.
  const rows = [200, 210, 220, 230, 258].map((p, i) =>
    comp(`c${i}`, { salePrice: p * 1000, squareFeet: 1000 }),
  )
  const bands = computeEvidenceBands(rows, { squareFeet: 1000 })
  assert.equal(bands.arv.method, 'ok')
  assert.equal(bands.arv.n, 5, 'all members survive the 1.5x trim')
  assert.deepEqual(bands.arv.coherenceExcludedIds, ['c4'], 'incoherent member named')
  assert.ok(bands.arv.edgeExcludedIds.includes('c4'), 'coherence member folded into edge exclusions')
  assert.equal(bands.arv.high, 230_000, 'edges stop at the coherent core')
  assert.ok((bands.arv.spread ?? 0) > 0, 'spread emitted')
}
{
  // Small bands keep their evidence — no coherence culling under n=4.
  const rows = [200, 210, 258].map((p, i) => comp(`c${i}`, { salePrice: p * 1000, squareFeet: 1000 }))
  const bands = computeEvidenceBands(rows, { squareFeet: 1000 })
  assert.deepEqual(bands.arv.coherenceExcludedIds, [], 'n<4 bands exempt from the core fence')
}

// ── Escalation entry behavior ─────────────────────────────────────────────────

// No triggers → null before any provider work (never calls Opus on routine pools).
{
  const res = await escalateBandReview(
    { ANTHROPIC_API_KEY: 'sk-test' },
    baseInput({ comps: [comp('a'), comp('b')] }),
  )
  assert.equal(res, null, 'no triggers = no specialist call')
}
// Triggers fire but no Anthropic key → null, additive-only degradation.
{
  const res = await escalateBandReview(
    {},
    baseInput({ adjudication: { ...cleanAdjudication, confidence: 0.4 }, comps: [comp('a'), comp('b')] }),
  )
  assert.equal(res, null, 'no key = degraded, never blocking')
}

console.log('band-escalation: trigger matrix, coherence fence, doctrine guards, entry behavior — passed')
