/**
 * Integration: Geocodio lookup → tract and block group.
 *
 * Way this can fail: Geocodio answers but the comp still gets no block
 * group (wrong field read), or the lookup goes somewhere other than Geocodio.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchCensusGeography } from './census-geocoder'

afterEach(() => vi.unstubAllGlobals())

describe('fetchCensusGeography via Geocodio', () => {
  it('turns a Geocodio census answer into a tract and block group', async () => {
    const hosts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      hosts.push(new URL(String(input)).hostname)
      return Response.json({ results: [{ fields: { census: { '2020': { full_fips: '390490088112005' } } } }] })
    }))

    const geo = await fetchCensusGeography(39.9, -82.98, null, null, 'geocodio-key')

    expect(hosts).toEqual(['api.geocod.io'])
    expect(geo?.blockGroup).toBe('390490088112')
    expect(geo?.tract).toBe('39049008811')
  })
})
