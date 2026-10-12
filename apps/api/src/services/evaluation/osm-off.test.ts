/**
 * OpenStreetMap switched off.
 *
 * Way this can fail: OSM is off and the street-orientation lookup still
 * calls Nominatim.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchStreetOrientation } from './observable'

afterEach(() => vi.unstubAllGlobals())

describe('fetchStreetOrientation', () => {
  it('makes no call when OSM is switched off', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const subject = { address: '3080 Parsons Ave, Columbus, OH', latitude: 39.9, longitude: -82.98 }
    expect(await fetchStreetOrientation(subject, { OSM_ENABLED: 'false' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
