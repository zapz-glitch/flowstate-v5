/**
 * Appraiser output budget.
 *
 * Way this can fail: at max effort the model's thinking uses the whole
 * output budget and no selection is written (seen live: two passes ended
 * at max_tokens with empty content on a 16,384 budget).
 */

import { describe, expect, it } from 'vitest'
import { appraiserMaxTokens } from './appraiser'

describe('appraiserMaxTokens', () => {
  it('gives max effort far more room than the default budget', () => {
    expect(appraiserMaxTokens('high')).toBe(16384)
    expect(appraiserMaxTokens('max')).toBeGreaterThanOrEqual(48000)
  })
})
