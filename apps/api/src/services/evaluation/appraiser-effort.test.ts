/**
 * Appraiser reasoning effort.
 *
 * Way this can fail: the seat is told to run at max effort and still runs
 * at the default.
 */

import { describe, expect, it } from 'vitest'
import { appraiserEffort } from './appraiser'

describe('appraiserEffort', () => {
  it('runs every pass at max when APPRAISER_EFFORT is max', () => {
    expect(appraiserEffort({ APPRAISER_EFFORT: 'max' }, false)).toBe('max')
    expect(appraiserEffort({ APPRAISER_EFFORT: 'max' }, true)).toBe('max')
  })
})
