/**
 * Assist sub-agent.
 *
 * Ways this can fail, each covered below:
 *  - arm A and arm B reach the same model, so the A/B compares nothing
 *  - a single-comp question is answered with the whole pool (or the reverse)
 *  - a failed call or junk output is passed to the appraiser as an answer
 *  - a model's out-of-range confidence is passed through unclamped
 *  - gate feedback is not shown when the appraiser asks after a rejection
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { withAssistArm } from '../llm/assist-arms'
import { assistReason } from './assist'
import type { HarnessEvidence } from './index'

const ENV = { ANTHROPIC_API_KEY: 'a', OPENROUTER_API_KEY: 'o' }
const evidence = { subject: { address: '1 A St' }, comps: [] } as unknown as HarnessEvidence
const comps = [
  { compId: 'c1', address: '2 B St', observables: { conditionTier: 'LIPSTICK' } },
  { compId: 'c2', address: '3 C St', observables: { conditionTier: 'HEAVY_REHAB' } },
]
const answer = (body: object | string) => (typeof body === 'string' ? body : JSON.stringify(body))

function stubModels(reply: object | string | 'fail') {
  const calls: Array<{ host: string; model: string; prompt: string }> = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = JSON.parse(String(init?.body))
    const prompt = JSON.stringify(body.messages)
    calls.push({ host: url.hostname, model: body.model, prompt })
    if (reply === 'fail') return new Response('down', { status: 500 })
    const text = answer(reply)
    return url.hostname === 'api.anthropic.com'
      ? Response.json({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
      : Response.json({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
  }))
  return calls
}

const GOOD = { answer: 'The listing describes a full remodel.', confidence: 0.8, evidence: ['description'] }

afterEach(() => vi.unstubAllGlobals())

describe('assistReason', () => {
  it('arm A asks haiku on Anthropic', async () => {
    const calls = stubModels(GOOD)
    const finding = await assistReason(withAssistArm(ENV, 'A'), { evidence, comps, request: { compId: 'c1', question: 'Is c1 renovated?' } })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ host: 'api.anthropic.com', model: 'claude-haiku-5-5' })
    expect(finding).toMatchObject({ compId: 'c1', answer: GOOD.answer, confidence: 0.8, source: 'assist', model: 'claude-haiku-5-5' })
  })

  it('arm B asks DeepSeek on OpenRouter', async () => {
    const calls = stubModels(GOOD)
    const finding = await assistReason(withAssistArm(ENV, 'B'), { evidence, comps, request: { compId: 'c1', question: 'Is c1 renovated?' } })

    expect(calls[0]).toMatchObject({ host: 'openrouter.ai', model: 'deepseek/deepseek-v4.1-flash' })
    expect(finding?.model).toBe('deepseek/deepseek-v4.1-flash')
  })

  it('sends one comp for a comp question and the whole pool for a general one', async () => {
    const calls = stubModels(GOOD)
    await assistReason(withAssistArm(ENV, 'A'), { evidence, comps, request: { compId: 'c1', question: 'q' } })
    await assistReason(withAssistArm(ENV, 'A'), { evidence, comps, request: { compId: null, question: 'q' } })

    expect(calls[0]!.prompt).toContain('2 B St')
    expect(calls[0]!.prompt).not.toContain('3 C St')
    expect(calls[1]!.prompt).toContain('2 B St')
    expect(calls[1]!.prompt).toContain('3 C St')
  })

  it('shows the gate feedback when the appraiser asks after a rejection', async () => {
    const calls = stubModels(GOOD)
    await assistReason(withAssistArm(ENV, 'A'), {
      evidence, comps, request: { compId: null, question: 'Why was this rejected?' },
      gateFeedback: { failures: ['d2_pocket_discipline'], feedback: ['pick c2 is outside the pocket'] },
    })
    expect(calls[0]!.prompt).toContain('pick c2 is outside the pocket')
  })

  it.each([
    ['the call fails', 'fail' as const],
    ['the output is not JSON', 'I think so'],
    ['the answer is empty', { answer: '  ', confidence: 0.9, evidence: [] }],
  ])('returns nothing when %s', async (_label, reply) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubModels(reply)
    expect(await assistReason(withAssistArm(ENV, 'A'), { evidence, comps, request: { compId: 'c1', question: 'q' } })).toBeNull()
  })

  it('clamps confidence into 0-1', async () => {
    stubModels({ answer: 'Yes.', confidence: 7, evidence: [] })
    expect((await assistReason(withAssistArm(ENV, 'A'), { evidence, comps, request: { compId: null, question: 'q' } }))?.confidence).toBe(1)
  })

  it('returns nothing when no reasoning model is configured', async () => {
    const calls = stubModels(GOOD)
    expect(await assistReason({}, { evidence, comps, request: { compId: null, question: 'q' } })).toBeNull()
    expect(calls).toHaveLength(0)
  })
})
