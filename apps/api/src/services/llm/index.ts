/**
 * LLM Services
 *
 * Unified LLM provider system using OpenRouter.
 * OpenRouter provides access to multiple models via single API:
 * - google/gemini-2.0-flash-001 (default, fast and cheap)
 * - anthropic/claude-3.5-sonnet (high quality)
 * - openai/gpt-4o (alternative)
 *
 * Usage:
 *   import { createLLMProvider } from '../services/llm'
 *
 *   const provider = createLLMProvider({
 *     provider: 'openrouter',
 *     apiKey: 'your-api-key',
 *     model: 'google/gemini-2.0-flash-001'  // optional
 *   })
 *
 *   const result = await provider.execute({
 *     prompt: 'Analyze this property...',
 *     images: [{ url: 'https://...' }]
 *   })
 */

// ─── Type Exports ────────────────────────────────────────────────────────────

export type {
  LLMProvider,
  LLMProviderType,
  LLMProviderConfig,
  LLMRequest,
  LLMResponse,
  ImageInput,
  UsageMetrics,
  TimingMetrics,
  ProviderResult,
  ProviderError,
} from './types'

// ─── Provider Exports ────────────────────────────────────────────────────────

export { BaseLLMProvider, type BaseLLMProviderConfig } from './base-provider'
export { OpenAICompatibleProvider, OpenRouterProvider, createOpenRouterProvider } from './openai-compatible'
export { AnthropicProvider, createAnthropicProvider } from './anthropic'

// ─── Image Utilities ─────────────────────────────────────────────────────────

export {
  fetchImageAsBase64,
  fetchImagesAsBase64,
  prepareImagesForProvider,
  arrayBufferToBase64,
  detectMimeType,
  toDataUrl,
  isDataUrl,
  parseDataUrl,
  getRandomUserAgent,
  type FetchedImage,
  type ImageFetchOptions,
} from './image-utils'

// ─── Provider Creation ───────────────────────────────────────────────────────

import type { LLMProvider, LLMProviderConfig } from './types'
import { createOpenRouterProvider } from './openai-compatible'
import { createAnthropicProvider } from './anthropic'

/**
 * Create an LLM provider based on configuration
 * Only OpenRouter is supported - use OpenRouter model format for other providers:
 * - google/gemini-2.0-flash-001 (Gemini)
 * - anthropic/claude-3.5-sonnet (Claude)
 * - openai/gpt-4o (OpenAI)
 */
export function createLLMProvider(config: LLMProviderConfig): LLMProvider {
  if (config.provider !== 'openrouter') {
    console.warn(`Provider ${config.provider} requested - using OpenRouter instead. Set model to use specific provider via OpenRouter.`)
  }

  return createOpenRouterProvider({
    apiKey: config.apiKey,
    model: config.model || 'google/gemini-2.0-flash-001',
    maxTokens: config.maxTokens,
  })
}

/**
 * Environment interface for LLM provider
 */
interface LLMEnv {
  OPENROUTER_API_KEY?: string
  OPENROUTER_MODEL?: string
  COMP_SELECTION_MODEL?: string
  MARKET_SEARCH_MODEL?: string
}

/** Task-specific model presets */
export type LLMTask = 'default' | 'comp_selection' | 'market_search'

/** Default models per task — can be overridden via env vars */
const TASK_MODELS: Record<LLMTask, string> = {
  default: 'google/gemini-2.5-flash',
  comp_selection: 'google/gemini-2.5-flash',
  market_search: 'google/gemini-2.5-flash',
}

/**
 * Create an LLM provider from environment variables.
 * Optionally specify a task to use the appropriate model.
 */
export function createLLMProviderFromEnv(env: LLMEnv, task?: LLMTask): LLMProvider | null {
  if (!env.OPENROUTER_API_KEY) {
    return null
  }

  let model: string
  switch (task) {
    case 'comp_selection':
      model = env.COMP_SELECTION_MODEL || env.OPENROUTER_MODEL || TASK_MODELS.comp_selection
      break
    case 'market_search':
      model = env.MARKET_SEARCH_MODEL || env.OPENROUTER_MODEL || TASK_MODELS.market_search
      break
    default:
      model = env.OPENROUTER_MODEL || TASK_MODELS.default
  }

  return createOpenRouterProvider({
    apiKey: env.OPENROUTER_API_KEY,
    model,
  })
}

/**
 * Check if LLM provider is available
 */
export function isLLMProviderAvailable(env: LLMEnv): boolean {
  return !!env.OPENROUTER_API_KEY
}

// ─── Reasoning lane ──────────────────────────────────────────────────────────

/**
 * Env for the eval/reno reasoning lane — the calls that used to all ride
 * gpt-6-luna over OpenRouter (subject tier verdicts, comp condition
 * fallback, listing-details + seller-notes extraction).
 */
interface ReasoningEnv {
  ANTHROPIC_API_KEY?: string
  /** 'anthropic' | 'openrouter' | unset → anthropic when ANTHROPIC_API_KEY is set */
  REASONING_PROVIDER?: string
  /** Anthropic model — default claude-haiku-5-5 */
  REASONING_MODEL?: string
  OPENROUTER_API_KEY?: string
}

const DEFAULT_REASONING_MODEL = 'claude-haiku-5-5'

/**
 * Reasoning provider for eval/reno calls. Anthropic Haiku when configured
 * (REASONING_PROVIDER=anthropic, or ANTHROPIC_API_KEY present in auto mode);
 * otherwise the OpenRouter model the caller would have used — `fallbackModel`
 * is exactly what the call site passed before, so nothing changes for
 * workers without the Anthropic key.
 */
export function createReasoningProvider(env: ReasoningEnv, fallbackModel: string): LLMProvider | null {
  const mode = env.REASONING_PROVIDER ?? 'auto'
  const useAnthropic = mode === 'anthropic' || (mode === 'auto' && !!env.ANTHROPIC_API_KEY)
  if (useAnthropic && env.ANTHROPIC_API_KEY) {
    return createAnthropicProvider({
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.REASONING_MODEL || DEFAULT_REASONING_MODEL,
    })
  }
  if (env.OPENROUTER_API_KEY) {
    return createOpenRouterProvider({ apiKey: env.OPENROUTER_API_KEY, model: fallbackModel })
  }
  return null
}

export function isReasoningProviderAvailable(env: ReasoningEnv): boolean {
  return !!(env.ANTHROPIC_API_KEY || env.OPENROUTER_API_KEY)
}

// ─── Specialist lane ─────────────────────────────────────────────────────────

/**
 * On-demand specialist models — same Anthropic key, heavier brains for the
 * hardest slice of cases. Independent of REASONING_PROVIDER: arm A (luna)
 * and arm B (haiku) both escalate through this lane.
 *
 *   routine → claude-sonnet-5-5  (cohort classification, image understanding)
 *   expert  → claude-opus-5-5    (material ARV disputes, conflicting condition
 *                                 evidence, final band include/exclude, agent
 *                                 consult on revision turns)
 */
export type SpecialistTier = 'routine' | 'expert'

interface SpecialistEnv {
  ANTHROPIC_API_KEY?: string
  SPECIALIST_ROUTINE_MODEL?: string
  SPECIALIST_EXPERT_MODEL?: string
}

const SPECIALIST_MODELS: Record<SpecialistTier, string> = {
  routine: 'claude-sonnet-5-5',
  expert: 'claude-opus-5-5',
}

export function createSpecialistProvider(env: SpecialistEnv, tier: SpecialistTier): LLMProvider | null {
  if (!env.ANTHROPIC_API_KEY) return null
  const model = tier === 'expert'
    ? (env.SPECIALIST_EXPERT_MODEL ?? SPECIALIST_MODELS.expert)
    : (env.SPECIALIST_ROUTINE_MODEL ?? SPECIALIST_MODELS.routine)
  return createAnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model })
}

export function isSpecialistAvailable(env: SpecialistEnv): boolean {
  return !!env.ANTHROPIC_API_KEY
}
