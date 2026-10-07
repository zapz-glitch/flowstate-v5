import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { loadModule } from '../../lib/test-load.mjs'

const stub = (name) => () => React.createElement('i', { 'data-icon': name })
const { RealtorNotesCard } = loadModule(new URL('./RealtorNotesCard.tsx', import.meta.url), {
  'lucide-react': { AlertTriangle: stub('alert'), ChevronDown: stub('chevron'), PlusCircle: stub('plus') },
})
const render = (props) => renderToStaticMarkup(React.createElement(RealtorNotesCard, props))
const note = { id: 'n1', createdAt: '', text: '2026-10-06 underwriting eval FAILED: eval error — no ARV/MAO produced; handoff YES' }

test('realtor notes are quiet: no box, no bold title, a left rule, readable words', () => {
  const out = render({ notes: [note] })
  assert.match(out, /<section aria-label="Realtor notes" class="border-l-2 border-border /)
  assert.doesNotMatch(out, /class="border border-border/, 'not a boxed card')
  assert.match(out, /<h3 class="text-\[11px\] font-medium text-foreground-tertiary">Realtor notes<\/h3>/)
  assert.doesNotMatch(out, /font-semibold|font-bold/)
  // The date is split from the words, and the words are in the readable secondary text
  assert.match(out, /text-foreground-tertiary[^"]*">2026-10-06<\/span><span class="text-foreground-secondary">underwriting eval FAILED/)
})

test('nothing to show draws nothing', () => {
  assert.equal(render({ notes: [] }), '')
})

test('more than five notes offers the rest, and rehab intel keeps its meaning colors', () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ id: `n${i}`, createdAt: '', text: `2026-10-0${i + 1} note ${i}` }))
  const out = render({ notes: many, additions: [{ itemId: null, item: 'Roof', estimatedCost: 9000, evidence: 'agent said it leaks' }], advisories: [{ itemId: null, item: 'HVAC', suggestion: 'consider_removing', note: 'replaced 2024', evidence: 'permit' }] })
  assert.match(out, /All 7 notes/)
  assert.equal((out.match(/<li /g) ?? []).length, 5)
  assert.match(out, /text-emerald-600[^"]*"[^>]*>.*Added Roof \+\$9,000/s)
  assert.match(out, /text-amber-600[^"]*"[^>]*>.*Consider removing HVAC/s)
})
