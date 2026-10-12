/**
 * Integration: evidence-stage env + the subject condition reader.
 *
 * Way this can fail: haiku is meant to be held back until the appraiser
 * stage, but an inconclusive decision-model read still falls through to it
 * (or to a specialist model) during the condition read.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { evidenceStageEnv } from '../llm/stage-env'
import { assessRenovationFromPhotos } from './renovation'

afterEach(() => vi.unstubAllGlobals())

describe('subject condition read with the reasoning model held back', () => {
  it('keeps the decision-model read and calls no reasoning model, even when no tier has a majority', async () => {
    const hosts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      hosts.push(url.hostname)
      if (url.hostname === 'img.example.com') {
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { 'content-type': 'image/jpeg' } })
      }
      if (url.hostname === 'api.openai.com') {
        return Response.json({
          answers: [{
            type: 'choice', name: 'renovation_level', choice: 'Full Cosmetic', confidence: 0.5,
            probabilities: [
              { value: 'Full Cosmetic', probability: 0.45 },
              { value: 'Heavy Rehab', probability: 0.4 },
              { value: 'Light Cosmetic', probability: 0.15 },
            ],
          }],
        })
      }
      throw new Error(`unexpected call to ${url.hostname}`)
    }))

    const env = evidenceStageEnv({
      REASONING_STAGE_ONLY: 'true', CONDITION_READER: 'decisions',
      OPENAI_API_KEY: 'd', ANTHROPIC_API_KEY: 'a', OPENROUTER_API_KEY: 'o',
    })
    const result = await assessRenovationFromPhotos(env, [1, 2, 3, 4].map((n) => `https://img.example.com/p${n}.jpg`))

    expect(hosts.filter((h) => h === 'api.anthropic.com' || h === 'openrouter.ai')).toEqual([])
    expect(result).toMatchObject({ renovationLevel: 'Full Cosmetic', confidence: 45, provider: 'openai', model: 'gpt-6-luna' })
    expect(result.tierProbabilities).toMatchObject({ 'Full Cosmetic': 0.45, 'Heavy Rehab': 0.4 })
  })
})
