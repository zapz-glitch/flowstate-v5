/**
 * Assist-model A/B arms.
 *
 * The "assist model" is the reasoning lane's model: the backup reader when
 * the decision model cannot call a condition, and the sub-agent the
 * appraiser may ask to reason over the evidence. An arm swaps that one
 * model and nothing else — the decision model, the appraiser, the gate and
 * every rule stay the same, so a difference between arms is the assist model.
 *
 *   A — claude-haiku-5-5 (Anthropic direct)
 *   B — deepseek/deepseek-v4.1-flash (OpenRouter)
 */

export type AssistArm = 'A' | 'B'

export const ASSIST_ARMS: Record<AssistArm, { provider: 'anthropic' | 'openrouter'; model: string }> = {
  A: { provider: 'anthropic', model: 'claude-haiku-5-5' },
  B: { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' },
}

export function parseAssistArm(value: unknown): AssistArm | undefined {
  return value === 'A' || value === 'B' ? value : undefined
}

interface AssistArmEnv {
  REASONING_PROVIDER?: string
  REASONING_MODEL?: string
  REASONING_OPENROUTER_MODEL?: string
}

/**
 * The env a run of this arm sees: the same bindings and keys, with the
 * reasoning lane pinned to the arm's model. No arm → the env unchanged.
 */
export function withAssistArm<E extends AssistArmEnv>(env: E, arm: AssistArm | undefined): E {
  if (!arm) return env
  const { provider, model } = ASSIST_ARMS[arm]
  return provider === 'anthropic'
    ? { ...env, REASONING_PROVIDER: 'anthropic', REASONING_MODEL: model }
    : { ...env, REASONING_PROVIDER: 'openrouter', REASONING_OPENROUTER_MODEL: model }
}
