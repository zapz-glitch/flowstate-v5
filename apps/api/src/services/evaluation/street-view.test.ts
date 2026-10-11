/**
 * Street View fetch.
 *
 * Ways this can fail, each covered below:
 *  - Google's grey "no imagery" placeholder is passed on as a real photo
 *  - a real panorama is dropped
 *  - a call is made with no key or no coordinates
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../types'
import { fetchStreetViewTile } from './observable'

const ENV = { GOOGLE_MAPS_KEY: 'g' } as Env
const here = { latitude: 27.85, longitude: -82.75 }

function stub(metadataStatus: string) {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    if (url.includes('/streetview/metadata')) return Response.json({ status: metadataStatus })
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { 'content-type': 'image/jpeg' } })
  }))
  return urls
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchStreetViewTile', () => {
  it('returns nothing where Google has no panorama, without fetching the placeholder', async () => {
    const urls = stub('ZERO_RESULTS')
    expect(await fetchStreetViewTile(ENV, here)).toBeNull()
    expect(urls).toHaveLength(1)
  })

  it('returns the image where a panorama exists', async () => {
    stub('OK')
    expect(await fetchStreetViewTile(ENV, here)).toMatchObject({ content_type: 'image/jpeg' })
  })

  it('makes no call without a key or coordinates', async () => {
    const urls = stub('OK')
    expect(await fetchStreetViewTile({} as Env, here)).toBeNull()
    expect(await fetchStreetViewTile(ENV, { latitude: null, longitude: null })).toBeNull()
    expect(urls).toHaveLength(0)
  })
})
