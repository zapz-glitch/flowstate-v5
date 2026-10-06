import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { loadModule, realUtils } from '../../lib/test-load.mjs'

const parts = loadModule(new URL('./property-card-parts.tsx', import.meta.url), { '@/lib/utils': realUtils() })
const h = React.createElement
const render = (node) => renderToStaticMarkup(node)

test('Fact shows label and value, and no difference line when there is none', () => {
  const out = render(h(parts.Fact, { label: 'Sq Ft', value: '1,618' }))
  assert.match(out, /Sq Ft/)
  assert.match(out, /1,618/)
  assert.doesNotMatch(out, /leading-tight/)
})

test('Fact keeps a difference line when given one, even a blank spacer', () => {
  const real = render(h(parts.Fact, { label: 'Sq Ft', value: '1,482', delta: '136 sf smaller', deltaClass: 'text-red-600' }))
  assert.match(real, /136 sf smaller/)
  assert.match(real, /text-red-600/)
  // The subject card passes a non-breaking space so its rows line up with the comp's
  const spacer = render(h(parts.Fact, { label: 'Sq Ft', value: '1,618', delta: ' ' }))
  assert.match(spacer, /leading-tight/)
})

test('Pair is label then value on one line', () => {
  const out = render(h(parts.Pair, { label: 'Condition', value: 'Light Cosmetic' }))
  assert.ok(out.indexOf('Condition') < out.indexOf('Light Cosmetic'))
  assert.match(out, /whitespace-nowrap/)
})

test('the photo stamp has one fixed height shared by every card', () => {
  assert.match(parts.STAMP, /h-\[22px\]/)
})
