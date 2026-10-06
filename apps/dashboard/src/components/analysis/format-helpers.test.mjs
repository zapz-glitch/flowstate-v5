import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadModule, realUtils } from '../../lib/test-load.mjs'

const { formatShortDate } = loadModule(new URL('./format-helpers.ts', import.meta.url), {
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
