import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadModule, realUtils } from '../../lib/test-load.mjs'

const { formatAreaLine, formatShortDate, streetViewHref, subjectStreetViewHref } = loadModule(new URL('./format-helpers.ts', import.meta.url), {
  '@/lib/utils': realUtils(),
  '@flowstate-api/shared': { subdivisionsMatch: () => true },
  './feature-match': { compFeatureMatches: () => [], featureState: () => 'unknown', MATCH_TEXT: '', MISMATCH_TEXT: '' },
})

test('a missing date shows a dash', () => {
  assert.equal(formatShortDate(null), '-')
  assert.equal(formatShortDate(undefined), '-')
  assert.equal(formatShortDate(''), '-')
})

test('a calendar date shows that same day, in any viewer time zone', () => {
  // The bug this guards: "2016-04-14" read as UTC midnight showed "Apr 13" in New York and Los Angeles.
  const original = process.env.TZ
  try {
    for (const tz of ['UTC', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Pacific/Honolulu', 'Asia/Tokyo']) {
      process.env.TZ = tz
      assert.equal(formatShortDate('2016-04-14'), 'Apr 14, 2016', `in ${tz}`)
      assert.equal(formatShortDate('2026-01-01'), 'Jan 1, 2026', `New Year in ${tz}`)
    }
  } finally {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  }
})

test('a full timestamp is still shown in the viewer’s own zone', () => {
  const original = process.env.TZ
  try {
    process.env.TZ = 'America/New_York'
    // 02:00 UTC on Apr 15 is still the evening of Apr 14 in New York
    assert.equal(formatShortDate('2016-04-15T02:00:00Z'), 'Apr 14, 2016')
  } finally {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  }
})

test('a property with coordinates links to Street View at that spot', () => {
  const href = streetViewHref({ latitude: 33.9, longitude: -84.5, address: '1 Main St' })
  assert.equal(href, 'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=33.9,-84.5')
})

test('without coordinates it falls back to a map search on the address', () => {
  const href = streetViewHref({ address: '1 Main St', city: 'Marietta', state: 'GA' })
  assert.match(href, /maps\/search\/\?api=1&query=1%20Main%20St%2C%20Marietta%2C%20GA/)
})

test('with no location at all there is no link', () => {
  assert.equal(streetViewHref({}), null)
})

test('the subject uses the same Street View rule as a comp', () => {
  const where = { latitude: 33.9, longitude: -84.5, address: '951 Oriole Ln SE, Marietta, GA 30067' }
  assert.equal(subjectStreetViewHref(where), streetViewHref(where))
  assert.equal(subjectStreetViewHref({ latitude: null, longitude: null, address: null }), null)
  assert.match(subjectStreetViewHref({ address: '951 Oriole Ln SE, Marietta, GA 30067' }), /maps\/search/)
})

test('the area line puts the block group first, then " - ", then the neighborhood', () => {
  // 12-digit census id · the block group is its last digit
  assert.equal(formatAreaLine('130670312034', 'MEADOW BROOK'), 'Group 4 - Meadow Brook')
})

test('the area line shows whichever half it has, and nothing when it has neither', () => {
  assert.equal(formatAreaLine('130670312034', null), 'Group 4')
  assert.equal(formatAreaLine(null, 'CAVALIER GARDENS'), 'Cavalier Gardens')
  assert.equal(formatAreaLine(undefined, ''), null)
  assert.equal(formatAreaLine('', null), null)
})
