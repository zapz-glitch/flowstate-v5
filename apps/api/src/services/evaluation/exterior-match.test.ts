/**
 * Exterior match — subject cover photo vs comp cover photo.
 *
 * Ways this can fail, each covered below:
 *  - the images go out in the wrong order (subject must be first)
 *  - a missing photo still produces a match score
 *  - a dead first photo link leaves the subject with no cover
 *  - a failed or refused call invents a probability
 *  - the subject cover stays an aerial/hidden shot when a clear front photo exists
 *  - a failed front-photo pick leaves the subject with no cover at all
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../types'
import { decisionsExteriorMatch, fetchCoverImage, pickFrontCoverImage } from './exterior-match'

const ENV = { OPENAI_API_KEY: 'k' } as Env
const subjectCover = { base64: 'U1VCSkVDVA==', content_type: 'image/jpeg', url: 'https://img.example.com/s.jpg' }
const compCover = { base64: 'Q09NUA==', content_type: 'image/webp' }

const answers = (match: number, subjectFront = 0.97, compFront = 0.9) => ({
  answers: [
    { type: 'predicate', name: 'subject_cover_is_front', probability: subjectFront },
    { type: 'predicate', name: 'comp_cover_is_front', probability: compFront },
    { type: 'predicate', name: 'exterior_match', probability: match },
  ],
})

afterEach(() => vi.unstubAllGlobals())

describe('decisionsExteriorMatch', () => {
  it('sends the subject photo first, then the comp photo, and returns the three probabilities', async () => {
    const fetchMock = vi.fn(async () => Response.json(answers(0.83)))
    vi.stubGlobal('fetch', fetchMock)

    const r = await decisionsExteriorMatch(ENV, { subjectCover, compCover, subjectAddress: '1 A St', compAddress: '2 B St' })

    expect(r).toMatchObject({ matchP: 0.83, subjectCoverIsFrontP: 0.97, compCoverIsFrontP: 0.9, model: 'gpt-6-luna' })
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    const images = body.input[0].content.filter((c: { type: string }) => c.type === 'input_image')
    expect(images.map((i: { image_url: string }) => i.image_url)).toEqual([
      'data:image/jpeg;base64,U1VCSkVDVA==',
      'data:image/webp;base64,Q09NUA==',
    ])
    expect(body.questions.map((q: { name: string; type: string }) => `${q.type}:${q.name}`)).toEqual([
      'predicate:subject_cover_is_front',
      'predicate:comp_cover_is_front',
      'predicate:exterior_match',
    ])
  })

  it('makes no call and gives no score when either photo is missing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    expect(await decisionsExteriorMatch(ENV, { subjectCover: null, compCover })).toBeNull()
    expect(await decisionsExteriorMatch(ENV, { subjectCover, compCover: null })).toBeNull()
    expect(await decisionsExteriorMatch({} as Env, { subjectCover, compCover })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('gives no score when the call fails or the model declines to answer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 500 })))
    expect(await decisionsExteriorMatch(ENV, { subjectCover, compCover })).toBeNull()

    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ answers: [{ type: 'refusal', name: 'exterior_match' }] })))
    expect(await decisionsExteriorMatch(ENV, { subjectCover, compCover })).toBeNull()
  })
})

describe('fetchCoverImage', () => {
  it('skips dead photo links and returns the first photo that loads', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('dead')
        ? new Response('gone', { status: 404 })
        : new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { 'content-type': 'image/jpeg' } })))

    const cover = await fetchCoverImage(['https://img.example.com/dead1.jpg', 'https://img.example.com/dead2.jpg', 'https://img.example.com/front.jpg'])

    expect(cover?.url).toBe('https://img.example.com/front.jpg')
    expect(cover?.content_type).toBe('image/jpeg')
  })

  it('returns null when there are no photos', async () => {
    expect(await fetchCoverImage([])).toBeNull()
  })
})

describe('pickFrontCoverImage', () => {
  const urls = ['https://img.example.com/aerial.jpg', 'https://img.example.com/front.jpg', 'https://img.example.com/pool.jpg']
  const stub = (decisions: () => Response) => {
    const calls: Array<Record<string, any>> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('api.openai.com')) { calls.push(JSON.parse(String(init?.body))); return decisions() }
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { 'content-type': 'image/jpeg' } })
    }))
    return calls
  }

  it('uses the photo the model says best shows the front of the house', async () => {
    const calls = stub(() => Response.json({ answers: [{ type: 'choice', name: 'front_photo', choice: 'photo_2', probabilities: [] }] }))
    const cover = await pickFrontCoverImage(ENV, urls)

    expect(cover?.url).toBe('https://img.example.com/front.jpg')
    expect(calls[0].questions[0].choices.map((c: { value: string }) => c.value)).toEqual(['photo_1', 'photo_2', 'photo_3', 'none'])
    expect(calls[0].input[0].content.filter((c: { type: string }) => c.type === 'input_image')).toHaveLength(3)
  })

  it.each([
    ['the model says none shows the front', () => Response.json({ answers: [{ type: 'choice', name: 'front_photo', choice: 'none', probabilities: [] }] })],
    ['the call fails', () => new Response('down', { status: 500 })],
  ])('falls back to the first photo when %s', async (_label, decisions) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stub(decisions)
    expect((await pickFrontCoverImage(ENV, urls))?.url).toBe('https://img.example.com/aerial.jpg')
  })

  it('skips the model when there is only one photo or no decision model', async () => {
    const calls = stub(() => Response.json({ answers: [] }))
    expect((await pickFrontCoverImage(ENV, urls.slice(0, 1)))?.url).toBe(urls[0])
    expect((await pickFrontCoverImage({} as Env, urls))?.url).toBe(urls[0])
    expect(calls).toHaveLength(0)
  })
})
