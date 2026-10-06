import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { loadModule, realUtils } from '../../lib/test-load.mjs'

const utils = realUtils()
const { DealActions } = loadModule(new URL('./DealActions.tsx', import.meta.url), {
  '@/lib/utils': utils,
  './valuation-number': loadModule(new URL('./valuation-number.ts', import.meta.url)),
})
const render = (props) => renderToStaticMarkup(React.createElement(DealActions, props))
const noop = async () => ({ ok: true })
const all = { offerPrice: 243000, onOfferWorkflow: noop, onRerun() {}, onOpenSettings() {} }

test('all five actions are present, decisions before tools', () => {
  const out = render(all)
  const labels = ['Prep offer', 'No margin', 'No offer', 'Re-run', 'Evaluation Settings']
  let at = -1
  for (const label of labels) {
    const i = out.indexOf(`>${label}<`)
    assert.ok(i > at, `${label} appears, in order`)
    at = i
  }
})

const dividers = (out) => (out.match(/w-px h-3 bg-border/g) ?? []).length

test('the strip has its own top border and a divider between decisions and tools, and between the tools', () => {
  const out = render(all)
  assert.match(out, /border-t/)
  assert.equal(dividers(out), 2)
})

test('the five actions sit in one horizontal row at the right', () => {
  const out = render(all)
  assert.match(out, /flex flex-wrap items-center justify-end/)
  assert.doesNotMatch(out, /flex-col/)
})

test('Prep offer is disabled when there is no offer price, enabled and priced otherwise', () => {
  const none = render({ ...all, offerPrice: null })
  assert.match(none, /<button[^>]*disabled=""[^>]*>Prep offer<\/button>/)
  assert.match(none, /Valuation incomplete/)
  const priced = render(all)
  assert.doesNotMatch(priced, /<button[^>]*disabled=""[^>]*>Prep offer<\/button>/)
  assert.match(priced, /Prep offer at \$243/)
})

test('without an offer handler there are no decision buttons and only the tools divider', () => {
  const out = render({ onRerun() {}, onOpenSettings() {} })
  assert.doesNotMatch(out, /Prep offer|No margin|No offer/)
  assert.match(out, /Re-run/)
  assert.equal(dividers(out), 1)
})

test('a rerun in flight disables Re-run and says so', () => {
  const out = render({ ...all, rerunning: true })
  assert.match(out, /<button[^>]*disabled=""[^>]*>Running…<\/button>/)
})

test('with nothing to do it renders nothing', () => {
  assert.equal(render({}), '')
})

test('bare drops the strip border and padding so it can sit beside other content', () => {
  const plain = render(all)
  const bare = render({ ...all, bare: true })
  assert.match(plain, /border-t border-border\/60 px-3 py-1/)
  assert.doesNotMatch(bare, /border-t|px-3 py-1/)
  assert.equal(dividers(bare), dividers(plain), 'the buttons themselves are unchanged')
})
