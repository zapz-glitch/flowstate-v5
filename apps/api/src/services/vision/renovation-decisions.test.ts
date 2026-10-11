/**
 * Subject renovation read — decision model first, reasoning reader as backup.
 *
 * Ways this can fail, each covered below:
 *  - the tier question drops a tier definition or the listing description
 *  - a clear majority read is not used as the verdict, or is mislabeled
 *  - a split read (no majority) is used instead of going to the backup
 *  - a heavy tier is called from a single photo
 *  - the "cannot tell" answer or a failed call invents a tier
 *  - the backup failing throws away a usable decision-model read
 *  - the decision model runs when it is not configured
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { assessRenovationFromPhotos, RENOVATION_LEVEL_DEFINITIONS, renovationTierProbabilities } from './renovation'

const photos = (n: number) => Array.from({ length: n }, (_, i) => `https://img.example.com/p${i}.jpg`)
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9])

type Probabilities = Record<string, number>
const decisionsAnswers = (tiers: Probabilities | null) => ({
  answers: tiers
    ? [
        {
          type: 'choice',
          name: 'renovation_level',
          choice: Object.entries(tiers).sort((a, b) => b[1] - a[1])[0][0],
          confidence: 0.9,
          probabilities: Object.entries(tiers).map(([value, probability]) => ({ value, probability })),
        },
        { type: 'choice', name: 'kitchen_condition', choice: 'dated', probabilities: [{ value: 'dated', probability: 0.8 }] },
        { type: 'predicate', name: 'structural_concern', probability: 0.1 },
      ]
    : [{ type: 'refusal', name: 'renovation_level' }],
})

const haikuVerdict = (level: string) => ({
  content: [{
    type: 'text',
    text: JSON.stringify({
      renovation_level: level, confidence: 70, major_observations: ['worn finishes'],
      kitchen_condition: 'dated', bathroom_condition: 'dated', flooring_condition: 'poor',
      wall_ceiling_condition: 'dated', exterior_condition: 'good',
      visible_major_system_concerns: [], structural_concerns: [],
      rationale: 'Dated throughout.', evidence_for_classification: [], evidence_against_more_severe_level: [],
      evidence_against_less_severe_level: [], limitations: [],
      curb_appeal_condition: 'dated', curb_appeal_confidence: 60, curb_appeal_summary: 'Dated exterior.',
    }),
  }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 10 },
})

/** Route outbound calls: photos, the decision model, and the backup reader. */
function stubNetwork(opts: { decisions: Probabilities | null | 'fail'; haiku?: string | 'fail' }) {
  const calls = { decisions: [] as Array<Record<string, any>>, haiku: 0 }
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('img.example.com')) return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } })
    if (url.includes('api.openai.com/v1/decisions')) {
      calls.decisions.push(JSON.parse(String(init?.body)))
      if (opts.decisions === 'fail') return new Response('down', { status: 500 })
      return Response.json(decisionsAnswers(opts.decisions))
    }
    if (url.includes('api.anthropic.com')) {
      calls.haiku++
      if (opts.haiku === 'fail' || !opts.haiku) return new Response('down', { status: 500 })
      return Response.json(haikuVerdict(opts.haiku))
    }
    throw new Error(`unexpected fetch: ${url}`)
  }))
  return calls
}

const DECISIONS_ENV = { CONDITION_READER: 'decisions', OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' }

afterEach(() => vi.unstubAllGlobals())

describe('renovationTierProbabilities', () => {
  it('keeps only the five tiers, keyed by tier name', () => {
    expect(renovationTierProbabilities({ 'Full Cosmetic': 0.6, HEAVY_REHAB: 0.3, Unverified: 0.1 }))
      .toEqual({ 'Full Cosmetic': 0.6, 'Heavy Rehab': 0.3 })
    expect(renovationTierProbabilities({ Unverified: 1 })).toBeNull()
    expect(renovationTierProbabilities(undefined)).toBeNull()
  })
})

describe('subject renovation read — decision model first', () => {
  it('asks which tier the property is most like, with every tier definition and the description', async () => {
    const calls = stubNetwork({ decisions: { 'Full Cosmetic': 0.7, 'Heavy Rehab': 0.3 } })
    await assessRenovationFromPhotos(DECISIONS_ENV, photos(6), { address: '1 Test St', description: 'Needs new kitchen.' })

    expect(calls.decisions).toHaveLength(1)
    const body = calls.decisions[0]
    const tier = body.questions.find((q: any) => q.name === 'renovation_level')
    expect(tier.type).toBe('choice')
    expect(tier.instructions).toContain('most like')
    for (const d of RENOVATION_LEVEL_DEFINITIONS) {
      expect(tier.choices).toContainEqual({ value: d.name, description: d.criteria })
    }
    expect(tier.choices.map((c: any) => c.value)).toContain('Unverified')
    const content = body.input[0].content
    expect(content.filter((c: any) => c.type === 'input_image')).toHaveLength(6)
    expect(content[0].text).toContain('Needs new kitchen.')
  })

  it('uses a majority read as the verdict and records the probability per tier', async () => {
    const calls = stubNetwork({ decisions: { 'Full Cosmetic': 0.7, 'Heavy Rehab': 0.25, 'Light Cosmetic': 0.05 } })
    const r = await assessRenovationFromPhotos(DECISIONS_ENV, photos(6))

    expect(r.status).toBe('ok')
    expect(r.renovationLevel).toBe('Full Cosmetic')
    expect(r.confidence).toBe(70)
    expect(r.tierProbabilities).toEqual({ Lipstick: 0, 'Light Cosmetic': 0.05, 'Full Cosmetic': 0.7, 'Heavy Rehab': 0.25, 'Full Gut': 0 })
    expect(r.provider).toBe('openai')
    expect(r.model).toBe('gpt-6-luna')
    expect(r.rationale).toContain('Full Cosmetic 70%')
    expect(r.kitchenCondition).toBe('dated')
    expect(calls.haiku).toBe(0)
  })

  it('hands a split read to the backup reader and keeps the probabilities as evidence', async () => {
    const calls = stubNetwork({ decisions: { 'Full Cosmetic': 0.45, 'Heavy Rehab': 0.4, 'Light Cosmetic': 0.15 }, haiku: 'Heavy Rehab' })
    const r = await assessRenovationFromPhotos(DECISIONS_ENV, photos(6))

    expect(calls.haiku).toBe(1)
    expect(r.renovationLevel).toBe('Heavy Rehab')
    expect(r.provider).toBe('claude')
    expect(r.tierProbabilities).toMatchObject({ 'Full Cosmetic': 0.45, 'Heavy Rehab': 0.4 })
    expect(r.limitations.join(' ')).toContain('inconclusive')
  })

  it('does not accept a heavy tier from a single photo', async () => {
    const calls = stubNetwork({ decisions: { 'Heavy Rehab': 0.92, 'Full Cosmetic': 0.08 }, haiku: 'Light Cosmetic' })
    const r = await assessRenovationFromPhotos(DECISIONS_ENV, photos(1))

    expect(calls.haiku).toBe(1)
    expect(r.renovationLevel).toBe('Light Cosmetic')
  })

  it('caps single-photo confidence on a light tier', async () => {
    stubNetwork({ decisions: { Lipstick: 0.9, 'Light Cosmetic': 0.1 } })
    const r = await assessRenovationFromPhotos(DECISIONS_ENV, photos(1))

    expect(r.renovationLevel).toBe('Lipstick')
    expect(r.confidence).toBe(60)
  })

  it.each([
    ['a "cannot tell" answer', { Unverified: 0.8, 'Full Cosmetic': 0.2 } as Probabilities],
    ['a refusal', null],
    ['a failed call', 'fail' as const],
  ])('goes to the backup reader on %s', async (_label, decisions) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const calls = stubNetwork({ decisions, haiku: 'Full Cosmetic' })
    const r = await assessRenovationFromPhotos(DECISIONS_ENV, photos(6))

    expect(calls.haiku).toBe(1)
    expect(r.renovationLevel).toBe('Full Cosmetic')
    expect(r.provider).toBe('claude')
  })

  it('never invents a tier when both readers fail', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubNetwork({ decisions: 'fail', haiku: 'fail' })
    const r = await assessRenovationFromPhotos(DECISIONS_ENV, photos(6))

    expect(r.status).toBe('unavailable')
    expect(r.renovationLevelIndex).toBeNull()
  })

  it('keeps an inconclusive read when the backup reader fails', async () => {
    stubNetwork({ decisions: { 'Full Cosmetic': 0.45, 'Heavy Rehab': 0.4, 'Light Cosmetic': 0.15 }, haiku: 'fail' })
    const r = await assessRenovationFromPhotos(DECISIONS_ENV, photos(6))

    expect(r.renovationLevel).toBe('Full Cosmetic')
    expect(r.confidence).toBe(45)
    expect(r.limitations.join(' ')).toContain('Backup reader failed')
  })

  it('does not call the decision model unless it is configured', async () => {
    const calls = stubNetwork({ decisions: { 'Full Cosmetic': 0.9 }, haiku: 'Full Cosmetic' })
    const r = await assessRenovationFromPhotos({ OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'a' }, photos(6))

    expect(calls.decisions).toHaveLength(0)
    expect(r.provider).toBe('claude')
    expect(r.tierProbabilities).toBeUndefined()
  })
})
