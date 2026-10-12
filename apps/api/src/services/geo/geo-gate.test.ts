/**
 * Geography gate switch.
 *
 * Way this can fail: a run where a model selects the comps (agent harness)
 * on CoreLogic data skips the Geocodio lookups, so the subject and every
 * comp reach the appraiser with no block group or tract.
 */

import { describe, expect, it } from 'vitest'
import { isGeoGateActive } from './geo-gate'

describe('isGeoGateActive', () => {
  it('is on for the agent harness whatever the data provider', () => {
    expect(isGeoGateActive({ isAttomMcp: false, harness: 'agent' })).toBe(true)
    expect(isGeoGateActive({ isAttomMcp: false, harness: 'corelogic' })).toBe(true)
    expect(isGeoGateActive({ isAttomMcp: true, harness: undefined })).toBe(true)
    expect(isGeoGateActive({ isAttomMcp: false, harness: undefined })).toBe(false)
  })
})
