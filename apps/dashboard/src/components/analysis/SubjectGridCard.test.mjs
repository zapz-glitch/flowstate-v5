import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { loadModule, realUtils } from '../../lib/test-load.mjs'

const h = React.createElement
const stub = (name) => (props) => h('div', { 'data-stub': name }, props?.children)
let helpers
try {
  // format-helpers pulls in the shared appraisal package and feature matching; the card only needs its formatters
  helpers = loadModule(new URL('./format-helpers.ts', import.meta.url), {
    '@/lib/utils': realUtils(),
    '@flowstate-api/shared': { subdivisionsMatch: () => true },
    './feature-match': { compFeatureMatches: () => [], featureState: () => 'unknown', MATCH_TEXT: '', MISMATCH_TEXT: '' },
  })
} catch (error) {
  throw new Error(`format-helpers must load for this test: ${error.message}`)
}
const { SubjectGridCard } = loadModule(new URL('./SubjectGridCard.tsx', import.meta.url), {
  '@/lib/utils': realUtils(),
  'lucide-react': { MapPin: stub('pin') },
  '@/components/ui/copy-button': { CopyButton: ({ text }) => h('button', { 'data-copy': text }, 'copy') },
  './StreetViewImage': { StreetViewImage: stub('photo') },
  './PropertyPermits': { PropertyPermits: stub('permits') },
  './PhotoGallery': { PhotoGallery: ({ photos, compact }) => h('div', { 'data-gallery': photos.length, 'data-compact': String(!!compact) }) },
  './PhysicalCharacteristicsLine': { PhysicalCharacteristicsLine: () => null },
  './format-helpers': helpers,
})

const base = {
  address: '951 Oriole Ln SE, Marietta, GA 30067',
  neighborhoodName: 'MEADOW BROOK',
  subdivision: 'MEADOW BROOK',
  bedrooms: 3, bathrooms: 1.5, squareFeet: 1618, yearBuilt: 1966, lotSizeAcres: 0.19,
  condition: 'Light Cosmetic',
  listPrice: 280000,
  lastSale: { price: 169900, pricePerSqft: 105, date: '2016-04-14' },
  photos: ['a.jpg', 'b.jpg'],
}
const render = (subject, props = {}) => renderToStaticMarkup(h(SubjectGridCard, { subject, ...props }))
const count = (text, needle) => text.split(needle).length - 1

test('the area name appears once, even when neighborhood and subdivision are the same', () => {
  const out = render(base)
  assert.equal(count(out, 'Meadow Brook'), 1)
  assert.doesNotMatch(out, /rounded-full[^>]*>[^<]*Meadow/i, 'no pill')
})

test('with no neighborhood, the subdivision fills the line instead', () => {
  const out = render({ ...base, neighborhoodName: null, subdivision: 'CAVALIER GARDENS' })
  assert.match(out, /Cavalier Gardens/)
})

test('with neither, no area line is drawn', () => {
  const out = render({ ...base, neighborhoodName: null, subdivision: null })
  assert.doesNotMatch(out, /Meadow|Group/)
})

test('the address reads street, city, state: the ZIP is left off the text and kept for copy and the tooltip', () => {
  const out = render(base)
  assert.match(out, />951 Oriole Ln SE, Marietta, GA</)
  assert.doesNotMatch(out, />[^<]*30067[^<]*</, 'no ZIP in visible text')
  assert.match(out, /data-copy="951 Oriole Ln SE, Marietta, GA 30067"/)
  assert.match(out, /title="951 Oriole Ln SE, Marietta, GA 30067"/)
})

test('a list price is the headline; the last sale gets its own line', () => {
  const out = render(base)
  assert.match(out, /\$280,000/)
  assert.match(out, />List price</)
  assert.match(out, /Last sold \$169,900/)
  assert.match(out, /\$105\/sf/)
  assert.match(out, /Apr 14, 2016/)
})

test('with no list price the last sale is the headline, dated in its label', () => {
  const out = render({ ...base, listPrice: null })
  assert.match(out, /\$169,900/)
  assert.match(out, /Last sale · Apr 14, 2016/)
  assert.doesNotMatch(out, /Last sold/)
})

test('Condition starts under Sq Ft and spans two columns so it is never cut short', () => {
  const out = render(base)
  assert.match(out, /col-span-2 col-start-2[^"]*"[^>]*>\s*<span[^>]*>Condition<\/span>/)
  assert.match(out, /Light Cosmetic/)
})

test('the actions render at the foot of the card, after the details', () => {
  const out = render(base, { actions: h('button', null, 'Prep offer') })
  assert.ok(out.indexOf('Prep offer') > out.indexOf('Light Cosmetic'))
  assert.ok(out.endsWith('</button></div>'), 'last thing inside the card')
})

test('no comp rules line on the card', () => {
  assert.doesNotMatch(render(base), /Comp rules/)
})

test('with no actions there is nothing at the foot', () => {
  assert.doesNotMatch(render(base), /Prep offer|Re-run|Evaluation Settings/)
})

test('the photo strip uses compact thumbnails', () => {
  assert.match(render(base), /data-gallery="2" data-compact="true"/)
})

test('no Street View button on the card', () => {
  assert.doesNotMatch(render(base), /Street View/i)
})
