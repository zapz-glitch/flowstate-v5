import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { loadModule } from '../lib/test-load.mjs'

const { useStayMounted } = loadModule(new URL('./use-stay-mounted.ts', import.meta.url))
const Probe = ({ open }) => React.createElement('span', null, String(useStayMounted(open)))
const render = (open) => renderToStaticMarkup(React.createElement(Probe, { open }))

test('an overlay that starts closed is not built yet', () => {
  assert.match(render(false), />false</)
})

test('an overlay that starts open is built', () => {
  assert.match(render(true), />true</)
})
