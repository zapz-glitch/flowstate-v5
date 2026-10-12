/**
 * Appraiser single pass.
 *
 * Way this can fail: single pass is on and the appraiser still gets extra
 * rounds (questions, revisions, an empty-answer retry) — each one is another
 * 15-20s model call.
 */

import { describe, expect, it } from 'vitest'
import { appraiserLimits } from './appraiser'

describe('appraiserLimits', () => {
  it('allows exactly one model call when APPRAISER_SINGLE_PASS is on', () => {
    expect(appraiserLimits({ APPRAISER_SINGLE_PASS: 'true' })).toEqual({ clarifications: 0, reasoning: 0, revisions: 0, emptyRetry: false })
    expect(appraiserLimits({})).toEqual({ clarifications: 5, reasoning: 5, revisions: 2, emptyRetry: true })
  })
})
