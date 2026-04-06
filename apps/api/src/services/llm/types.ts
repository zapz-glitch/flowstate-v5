/**
 * LLM Provider Types
 *
 * Shared types for OpenRouter LLM provider.
 */

// Re-export core types for convenience
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
} from '../core/types'

export { success, failure, createError, withTiming, calculateEstimatedCost } from '../core/types'

// ─── OpenAI-Compatible Types (used by OpenRouter) ────────────────────────────

/**
 * OpenAI-compatible message content types
 */
export interface OpenAIImageContent {
  type: 'image_url'
  image_url: {
    url: string
    detail?: 'low' | 'high' | 'auto'
  }
}

export interface OpenAITextContent {
  type: 'text'
  text: string
}

export type OpenAIContent = OpenAIImageContent | OpenAITextContent

/**
 * OpenAI-compatible message format
 */
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | OpenAIContent[]
}

/**
 * OpenAI-compatible API response
 */
export interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string
      role: string
      /** Reasoning content (OpenRouter reasoning mode) */
      reasoning?: string
    }
    finish_reason?: string
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}
