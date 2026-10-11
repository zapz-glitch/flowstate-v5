/**
 * Assist-model A/B arms.
 *
 * Ways this can fail, each covered below:
 *  - an arm changes anything other than the reasoning lane's model
 *  - arm B still resolves to haiku because the Anthropic key is present
 *  - arm B uses the call site's default OpenRouter model instead of DeepSeek
 *  - an unknown arm value is accepted
 *  - the overlay mutates the shared env, leaking one run's arm into the next
 */

import { describe, expect, it } from 'vitest'
import { createReasoningProvider } from './index'
import { parseAssistArm, withAssistArm } from './assist-arms'

const ENV = { ANTHROPIC_API_KEY: 'a', OPENROUTER_API_KEY: 'o', OPENAI_API_KEY: 'd', CONDITION_READER: 'decisions' }

describe('withAssistArm', () => {
  it('arm A pins the reasoning lane to haiku on Anthropic', () => {
    const provider = createReasoningProvider(withAssistArm(ENV, 'A'), 'openai/gpt-6-luna')
    expect(provider?.name).toBe('claude')
    expect(provider?.model).toBe('claude-haiku-5-5')
  })

  it('arm B pins the reasoning lane to DeepSeek on OpenRouter even with an Anthropic key', () => {
    const provider = createReasoningProvider(withAssistArm(ENV, 'B'), 'openai/gpt-6-luna')
    expect(provider?.name).toBe('openrouter')
    expect(provider?.model).toBe('deepseek/deepseek-v4.1-flash')
  })

  it('changes nothing else and does not mutate the shared env', () => {
    const before = { ...ENV }
    const armed = withAssistArm(ENV, 'B')
    expect(ENV).toEqual(before)
    expect(armed).toMatchObject(before)
    expect(withAssistArm(ENV, undefined)).toBe(ENV)
  })

  it('leaves call sites on their own model when no arm is set', () => {
    expect(createReasoningProvider({ OPENROUTER_API_KEY: 'o' }, 'openai/gpt-6-luna')?.model).toBe('openai/gpt-6-luna')
  })
})

describe('parseAssistArm', () => {
  it('accepts only A or B', () => {
    expect(parseAssistArm('A')).toBe('A')
    expect(parseAssistArm('B')).toBe('B')
    for (const bad of ['a', 'C', '', null, undefined, 1]) expect(parseAssistArm(bad)).toBeUndefined()
  })
})
