import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { loadModule } from '../../lib/test-load.mjs'

const { MAP_COLORS, markerNumberColor } = loadModule(new URL('./map-colors.ts', import.meta.url))
const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8')

test('Included is the comp checkbox green and Excluded is a light silver', () => {
  assert.equal(MAP_COLORS.included, '#059669') // emerald-600, the ARV checkbox
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(MAP_COLORS.excluded.slice(i, i + 2), 16))
  assert.ok(r > 190 && g > 190 && b > 190, 'light')
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 24, 'silver, not tinted')
})

test('the number on a silver dot is dark, on every other dot white', () => {
  assert.equal(markerNumberColor('comp-disabled'), '#171717')
  for (const type of ['subject', 'comp-arv', 'comp-market', 'comp-floor']) assert.equal(markerNumberColor(type), '#ffffff')
})

test('the legend and both maps take their colors from the one shared definition', () => {
  for (const file of ['./MapOverlay.tsx', './PropertyMapInner.tsx', './SubjectAerialMap.tsx']) {
    const src = read(file)
    assert.match(src, /map-colors/, `${file} imports the shared colors`)
    assert.doesNotMatch(src, /#404040|#a3a3a3/, `${file} has no old marker colors`)
  }
})
