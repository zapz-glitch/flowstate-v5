/**
 * Evidence-stage env.
 *
 * Way this can fail: with REASONING_STAGE_ONLY on, the evidence stage can
 * still reach a reasoning model (haiku or a specialist) before the appraiser.
 */

import { describe, expect, it } from 'vitest'
import { createReasoningProvider, createSpecialistProvider } from './index'
import { evidenceStageEnv } from './stage-env'

const ENV = { REASONING_STAGE_ONLY: 'true', ANTHROPIC_API_KEY: 'a', OPENROUTER_API_KEY: 'o', OPENAI_API_KEY: 'd' }

describe('evidenceStageEnv', () => {
  it('removes every reasoning model from the evidence stage and keeps the rest', () => {
    const stage = evidenceStageEnv(ENV)
    expect(createReasoningProvider(stage, 'openai/gpt-6-luna')).toBeNull()
    expect(createSpecialistProvider(stage, 'routine')).toBeNull()
    expect(stage.OPENAI_API_KEY).toBe('d')
    expect(stage.OPENROUTER_API_KEY).toBe('o')
    expect(ENV.ANTHROPIC_API_KEY).toBe('a')
    expect(evidenceStageEnv({ ...ENV, REASONING_STAGE_ONLY: undefined }).ANTHROPIC_API_KEY).toBe('a')
  })
})
