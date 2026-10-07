import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { loadModule, realUtils } from '../../lib/test-load.mjs'

const { PageHeader } = loadModule(new URL('./page-header.tsx', import.meta.url), { '@/lib/utils': realUtils() })
const html = (props) => renderToStaticMarkup(React.createElement(PageHeader, props))

test('a page header is the title and nothing else', () => {
  const out = html({ title: 'Property Reports' })
  assert.match(out, /<h1[^>]*>Property Reports<\/h1>/)
  assert.doesNotMatch(out, /<p[ >]/, 'no subtitle paragraph')
  assert.doesNotMatch(out, /<svg/, 'no icon')
})

test('buttons go in an actions group at the right', () => {
  const out = html({ title: 'Analytics', actions: React.createElement('button', null, 'Today') })
  assert.match(out, /<button>Today<\/button>/)
  assert.ok(out.indexOf('Analytics') < out.indexOf('Today'), 'title first, actions after')
})

test('with no actions there is no empty actions wrapper', () => {
  assert.doesNotMatch(html({ title: 'Tasks' }), /justify-end/)
})

test('the header keeps a fixed minimum height so titles line up across pages', () => {
  assert.match(html({ title: 'Tasks' }), /min-h-9/)
})
