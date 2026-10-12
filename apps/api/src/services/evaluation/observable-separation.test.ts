/**
 * Condition read and satellite read are two separate functions.
 *
 * Ways this can fail, each covered below:
 *  - a listing photo and a satellite image travel in the same model call
 *    (the condition answer gets coloured by the aerial, or the reverse)
 *  - a condition question is asked in the satellite call, or a satellite
 *    question in the condition call
 *  - a question is asked more than once for the same property
 *  - the subject tier is asked again here (the renovation assessment owns it)
 *  - the street-view comparison shares a call with either of the others
 *  - the Google close-up is the same frame as the wide aerial
 *  - splitting the calls loses an answer the appraiser reads
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../types'
import { applySubjectTierVerdict, decisionsCompObservables, decisionsSubjectObservables, type SubjectObservables } from './observable'

const ENV = { OPENAI_API_KEY: 'k', GOOGLE_MAPS_KEY: 'g' } as Env
const bytes = (label: string) => new TextEncoder().encode(label)
const b64 = (label: string) => btoa(label)
const kindOf = (dataUrl: string) => atob(dataUrl.split(',')[1]!).split(':')[0]!

interface Call { images: string[]; questions: string[]; text: string }

/** Route outbound calls and record every decision-model request. */
function stubNetwork() {
  const calls: Call[] = []
  const mapUrls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('api.openai.com/v1/decisions')) {
      const body = JSON.parse(String(init?.body))
      const content = body.input[0].content as Array<{ type: string; text?: string; image_url?: string }>
      calls.push({
        images: content.filter((c) => c.type === 'input_image').map((c) => kindOf(c.image_url!)),
        questions: body.questions.map((q: { name: string }) => q.name),
        text: content.filter((c) => c.type === 'input_text').map((c) => c.text).join('\n'),
      })
      return Response.json({
        answers: body.questions.map((q: { type: string; name: string; choices?: Array<{ value: string }> }) =>
          q.type === 'predicate'
            ? { type: 'predicate', name: q.name, probability: 0.7 }
            : { type: 'choice', name: q.name, choice: q.choices![0]!.value, confidence: 0.8, probabilities: [{ value: q.choices![0]!.value, probability: 0.8 }] }),
      })
    }
    if (url.includes('/maps/api/staticmap')) { mapUrls.push(url); return new Response(bytes('SATELLITE:' + url), { headers: { 'content-type': 'image/png' } }) }
    if (url.includes('/streetview/metadata')) return Response.json({ status: 'OK' })
    if (url.includes('/maps/api/streetview')) return new Response(bytes('STREET:comp'), { headers: { 'content-type': 'image/jpeg' } })
    if (url.includes('img.example.com')) return new Response(bytes('LISTING:' + url), { headers: { 'content-type': 'image/jpeg' } })
    return new Response('not stubbed', { status: 500 })
  }))
  return { calls, mapUrls }
}

const only = (calls: Call[], kind: string) => calls.filter((c) => c.images.length > 0 && c.images.every((k) => k === kind))
const asked = (calls: Call[]) => calls.flatMap((c) => c.questions)

afterEach(() => vi.unstubAllGlobals())

describe('comp observables — separate calls per kind of evidence', () => {
  const run = async () => {
    const net = stubNetwork()
    const result = await decisionsCompObservables(ENV, {
      comp: { propertyId: 'c1', address: '2 B St' },
      salePrice: 300000, ppsf: 200,
      description: 'Fully renovated kitchen and baths.',
      listingImages: [1, 2, 3].map((n) => ({ base64: b64(`LISTING:${n}`), content_type: 'image/jpeg' })),
      latitude: 27.85, longitude: -82.75,
      subjectStreetViewImage: { base64: b64('STREET:subject'), content_type: 'image/jpeg' },
      subjectSatelliteImage: { base64: b64('SATELLITE:subject'), content_type: 'image/png' },
      subjectCoverImage: { base64: b64('LISTING:subject-cover'), content_type: 'image/jpeg' },
      subjectAddress: '1 A St',
      benchmark: null,
    })
    return { ...net, result }
  }

  it('never puts a listing photo, a satellite image, and a street view in the same call', async () => {
    const { calls } = await run()
    expect(calls.length).toBeGreaterThanOrEqual(3)
    for (const call of calls) expect(new Set(call.images).size).toBe(1)
  })

  it('asks the renovation tier once, from the listing photos and description only', async () => {
    const { calls } = await run()
    const tierCalls = calls.filter((c) => c.questions.includes('c13_condition_tier'))
    expect(tierCalls).toHaveLength(1)
    expect(tierCalls[0]!.images).toEqual(['LISTING', 'LISTING', 'LISTING'])
    expect(tierCalls[0]!.text).toContain('Fully renovated kitchen and baths.')
    expect(tierCalls[0]!.text).not.toContain('satellite')
  })

  it('asks the satellite questions once, from the aerials only, without the listing description', async () => {
    const { calls } = await run()
    const satellite = only(calls, 'SATELLITE')
    expect(satellite).toHaveLength(1)
    expect(satellite[0]!.questions.sort()).toEqual(['c12_development_vintage', 'c8_premium_attributes', 'c9_site_exposure'])
    expect(satellite[0]!.text).not.toContain('Fully renovated kitchen and baths.')
  })

  it('compares street views in their own call', async () => {
    const { calls } = await run()
    const street = only(calls, 'STREET')
    expect(street).toHaveLength(1)
    expect(street[0]!.questions).toEqual(['c10_physical_match'])
    expect(street[0]!.images).toHaveLength(2)
  })

  it('asks every question exactly once', async () => {
    const { calls } = await run()
    const names = asked(calls)
    expect(new Set(names).size).toBe(names.length)
  })

  it('still returns every answer the appraiser reads', async () => {
    const { result } = await run()
    expect(result).toMatchObject({
      conditionTier: 'LIPSTICK',
      conditionTierProbabilities: { Lipstick: 0.8 },
      premiumAttributes: 'WATERFRONT',
      siteExposure: 'FRONTING',
      developmentVintage: 'NEWER',
      physicalMatchP: 0.7,
      arvFitnessP: 0.7,
      exteriorMatchP: 0.7,
    })
  })

  it('requests a tighter Google frame for the close-up than for the wide aerial', async () => {
    const { mapUrls } = await run()
    const zooms = mapUrls.map((u) => Number(new URL(u).searchParams.get('zoom'))).sort()
    expect(zooms).toEqual([17, 19])
  })
})

describe('subject observables — separate calls per kind of evidence', () => {
  const run = async () => {
    const net = stubNetwork()
    const result = await decisionsSubjectObservables(ENV, {
      subject: { address: '1 A St, Tampa, FL', latitude: 27.85, longitude: -82.75 },
      photoUrls: [1, 2, 3, 4].map((n) => `https://img.example.com/p${n}.jpg`),
      description: 'Needs TLC.',
      benchmark: null,
    })
    return { ...net, result }
  }

  it('keeps listing photos and satellite images in different calls', async () => {
    const { calls } = await run()
    for (const call of calls) expect(new Set(call.images).size).toBe(1)
    expect(only(calls, 'LISTING')).toHaveLength(1)
    expect(only(calls, 'SATELLITE')).toHaveLength(1)
  })

  it('asks lot premium and site exposure from the aerials only', async () => {
    const { calls } = await run()
    const satellite = only(calls, 'SATELLITE')[0]!
    expect(satellite.questions.sort()).toEqual(['s8_lot_premium', 's9_site_exposure', 's9e_east', 's9e_north', 's9e_south', 's9e_west'])
    expect(satellite.text).not.toContain('Needs TLC.')
    const condition = only(calls, 'LISTING')[0]!
    expect(condition.questions.some((q) => q.startsWith('s8') || q.startsWith('s9'))).toBe(false)
    expect(condition.text).toContain('Needs TLC.')
  })

  it('does not ask the subject tier again — the renovation assessment owns it', async () => {
    const { calls, result } = await run()
    expect(asked(calls).some((q) => q.includes('renovation_tier'))).toBe(false)
    expect(result?.renovationTier).toBeNull()
    expect(result?.photosRead).toBe(4)
  })
})

describe('applySubjectTierVerdict', () => {
  const observables = () => ({ renovationTier: null, renovationTierProbabilities: null }) as SubjectObservables

  it('reports the tier that prices the rehab (3757 Oakman Pl: owner-graded light-to-full cosmetic)', () => {
    const ob = observables()
    applySubjectTierVerdict(ob, {
      renovationLevelIndex: 2,
      tierProbabilities: { 'Light Cosmetic': 0.35, 'Full Cosmetic': 0.54, 'Heavy Rehab': 0.1 },
    })
    expect(ob.renovationTier).toBe('FULL_COSMETIC')
    expect(ob.renovationTierProbabilities).toEqual({ 'Light Cosmetic': 0.35, 'Full Cosmetic': 0.54, 'Heavy Rehab': 0.1 })
  })

  it('reports no tier when the assessment resolved none', () => {
    const ob = observables()
    applySubjectTierVerdict(ob, { renovationLevelIndex: null })
    expect(ob.renovationTier).toBeNull()
    expect(ob.renovationTierProbabilities).toBeNull()
  })
})
