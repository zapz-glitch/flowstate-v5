/**
 * Stage envs — which models each stage of a run may reach.
 *
 * With REASONING_STAGE_ONLY=true the reasoning model (haiku, or an A/B
 * arm's model) is held back until the reasoning stage: the appraiser's comp
 * selection and the sub-agent it may call. Everything before that — photo
 * and description condition reads, satellite reads, listing evidence — runs
 * on the decision model alone, with no reasoning-model backup.
 */

interface StageEnv {
  REASONING_STAGE_ONLY?: string
  REASONING_PROVIDER?: string
  ANTHROPIC_API_KEY?: string
}

/**
 * The env the evidence stage runs with. When the reasoning model is held
 * back, the reasoning lane is switched off and the Anthropic key withheld,
 * so no call site can reach haiku or a specialist model. Otherwise unchanged.
 */
export function evidenceStageEnv<E extends StageEnv>(env: E): E {
  if (env.REASONING_STAGE_ONLY !== 'true') return env
  return { ...env, REASONING_PROVIDER: 'off', ANTHROPIC_API_KEY: undefined }
}
