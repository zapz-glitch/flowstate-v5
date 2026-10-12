/**
 * Reasoning lane switched off.
 *
 * Way this can fail: the lane is "off" for the evidence stage but a call
 * site still gets a model — haiku through the Anthropic key, or the call
 * site's own OpenRouter default.
 */

import { describe, expect, it } from 'vitest'
import { createReasoningProvider, isReasoningProviderAvailable } from './index'

describe('REASONING_PROVIDER=off', () => {
  it('gives no reasoning model even when both keys are present', () => {
    const env = { REASONING_PROVIDER: 'off', ANTHROPIC_API_KEY: 'a', OPENROUTER_API_KEY: 'o' }
    expect(createReasoningProvider(env, 'openai/gpt-6-luna')).toBeNull()
    expect(isReasoningProviderAvailable(env)).toBe(false)
  })
})
