/**
 * OpenAI-Compatible LLM Provider
 *
 * Base class for OpenRouter which uses OpenAI-compatible API format.
 */

import type {
  LLMProviderType,
  LLMRequest,
  LLMResponse,
  ProviderResult,
  UsageMetrics,
  OpenAIContent,
  OpenAIMessage,
  OpenAIResponse,
} from './types'
import { success, failure } from './types'
import { BaseLLMProvider, type BaseLLMProviderConfig } from './base-provider'
import { toDataUrl } from './image-utils'

// ─── OpenAI-Compatible Config ────────────────────────────────────────────────

export interface OpenAICompatibleConfig extends BaseLLMProviderConfig {
  /** Override for providers using different endpoints */
  baseUrl: string
}

// ─── OpenAI-Compatible Provider ──────────────────────────────────────────────

export abstract class OpenAICompatibleProvider extends BaseLLMProvider {
  abstract readonly name: LLMProviderType

  constructor(config: OpenAICompatibleConfig) {
    super(config)
  }

  /**
   * Build content array from images and prompt
   */
  protected buildContent(request: LLMRequest): OpenAIContent[] {
    const content: OpenAIContent[] = []

    // Add images
    if (request.images) {
      for (const image of request.images) {
        let imageUrl: string

        if (image.base64) {
          // Convert to data URL
          imageUrl = toDataUrl(image.base64, image.mimeType || 'image/jpeg')
        } else if (image.url) {
          imageUrl = image.url
        } else {
          continue
        }

        content.push({
          type: 'image_url',
          image_url: {
            url: imageUrl,
            detail: 'high',
          },
        })
      }
    }

    // Add text prompt
    content.push({ type: 'text', text: request.prompt })

    return content
  }

  /**
   * Build messages array for API request
   */
  protected buildMessages(request: LLMRequest): OpenAIMessage[] {
    const messages: OpenAIMessage[] = []

    // Add system message if provided
    if (request.systemPrompt) {
      messages.push({
        role: 'system',
        content: request.systemPrompt,
      })
    }

    // Add user message with content
    messages.push({
      role: 'user',
      content: this.buildContent(request),
    })

    return messages
  }

  /**
   * Execute the API request
   */
  protected async doExecute(request: LLMRequest): Promise<ProviderResult<LLMResponse>> {
    const messages = this.buildMessages(request)

    // Build request body
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: request.maxTokens ?? this.maxTokens,
      temperature: request.temperature,
    }

    // Add web search tool if configured
    if (request.webSearch) {
      const params: Record<string, unknown> = {}
      if (request.webSearch.engine) params.engine = request.webSearch.engine
      if (request.webSearch.maxResults) params.max_results = request.webSearch.maxResults
      if (request.webSearch.searchContextSize) params.search_context_size = request.webSearch.searchContextSize
      if (request.webSearch.allowedDomains) params.allowed_domains = request.webSearch.allowedDomains
      if (request.webSearch.excludedDomains) params.excluded_domains = request.webSearch.excludedDomains
      if (request.webSearch.userLocation) params.user_location = request.webSearch.userLocation
      body.tools = [{ type: 'openrouter:web_search', ...(Object.keys(params).length > 0 ? { parameters: params } : {}) }]
    }

    // Add reasoning if configured
    if (request.reasoning?.enabled) {
      body.reasoning = {
        effort: request.reasoning.effort ?? 'medium',
      }
    }

    const fetchOptions = this.createFetchOptions(
      'POST',
      {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body
    )

    const response = await fetch(this.baseUrl, fetchOptions)

    if (!response.ok) {
      const errorText = await response.text()
      return failure(this.parseHttpError(response.status, errorText))
    }

    const data = (await response.json()) as OpenAIResponse

    // Extract text content
    const text = data.choices?.[0]?.message?.content
    if (!text) {
      return failure(this.normalizeError(new Error('No text response from model')))
    }

    // Extract usage
    const usage: UsageMetrics = {
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
      totalTokens: data.usage?.total_tokens,
    }

    return success<LLMResponse>(
      {
        content: text,
        finishReason: data.choices?.[0]?.finish_reason,
        reasoning: data.choices?.[0]?.message?.reasoning || undefined,
      },
      { usage }
    )
  }
}

// ─── OpenRouter Provider ──────────────────────────────────────────────────────

export class OpenRouterProvider extends OpenAICompatibleProvider {
  readonly name = 'openrouter' as const

  constructor(config: { apiKey: string; model?: string; maxTokens?: number }) {
    super({
      apiKey: config.apiKey,
      model: config.model ?? 'google/gemini-2.0-flash-001',
      maxTokens: config.maxTokens,
      baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
    })
  }
}

// ─── Factory Function ─────────────────────────────────────────────────────────

export function createOpenRouterProvider(config: {
  apiKey: string
  model?: string
  maxTokens?: number
}): OpenRouterProvider {
  return new OpenRouterProvider(config)
}
