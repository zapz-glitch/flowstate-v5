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
export type LLMTask = 'default' | 'comp_selection' | 'market_search' | 'vision'

/** Default models per task — can be overridden via env vars */
const TASK_MODELS: Record<LLMTask, string> = {
  default: 'google/gemini-2.0-flash-001',
  comp_selection: 'x-ai/grok-4.1-fast',
  market_search: 'x-ai/grok-4.1-fast',
  vision: 'google/gemini-2.0-flash-001',
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
