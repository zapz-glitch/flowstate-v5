/**
 * Integration: comp read with street view switched off.
 *
 * Way this can fail: street view is off but the comp read still fetches a
 * street image or asks the street-comparison question — or turning it off
 * breaks the condition and satellite reads beside it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../types'
import { decisionsCompObservables } from './observable'

afterEach(() => vi.unstubAllGlobals())

describe('comp read with street view off', () => {
  it('skips the street lane and still runs the condition and satellite reads', async () => {
    const urls: string[] = []
    const asked: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      urls.push(url)
      if (url.includes('api.openai.com/v1/decisions')) {
        const body = JSON.parse(String(init?.body))
        asked.push(...body.questions.map((q: { name: string }) => q.name))
        return Response.json({
          answers: body.questions.map((q: { type: string; name: string; choices?: Array<{ value: string }> }) =>
            q.type === 'predicate'
              ? { type: 'predicate', name: q.name, probability: 0.6 }
              : { type: 'choice', name: q.name, choice: q.choices![0]!.value, probabilities: [{ value: q.choices![0]!.value, probability: 0.9 }] }),
        })
      }
      if (url.includes('/maps/api/staticmap')) return new Response(new Uint8Array(8), { headers: { 'content-type': 'image/png' } })
      return new Response('not stubbed', { status: 500 })
    }))

    const result = await decisionsCompObservables({ OPENAI_API_KEY: 'k', GOOGLE_MAPS_KEY: 'g', STREET_VIEW_ENABLED: 'false' } as Env, {
      comp: { propertyId: 'c1', address: '2 B St' },
      listingImages: [{ base64: 'TElTVA==', content_type: 'image/jpeg' }],
      latitude: 39.9, longitude: -82.98,
      subjectStreetViewImage: null,
      subjectSatelliteImage: { base64: 'U0FU', content_type: 'image/png' },
      benchmark: null,
    })

    expect(urls.some((u) => u.includes('streetview'))).toBe(false)
    expect(asked).not.toContain('c10_physical_match')
    expect(asked).toContain('c13_condition_tier')
    expect(asked).toContain('c9_site_exposure')
    expect(result).toMatchObject({ conditionTier: 'LIPSTICK', siteExposure: 'FRONTING', physicalMatchP: null })
  })
})
