/**
 * Anthropic Provider (Messages API)
 *
 * Direct api.anthropic.com access — used for the eval/reno reasoning lane
 * (claude-haiku-5-5) that replaced gpt-6-luna via OpenRouter. Supports the
 * same LLMRequest contract: images (base64 or URL — URLs are fetched and
 * inlined since the Messages API takes no remote refs), system prompts,
 * adaptive thinking, and strict JSON schema output via the
 * structured-outputs beta (`output_format`).
 */

import type {
  LLMRequest,
  LLMResponse,
  ProviderResult,
} from './types'
import { success, failure, createError } from './types'
import { BaseLLMProvider, type BaseLLMProviderConfig } from './base-provider'
import { fetchImageAsBase64 } from './image-utils'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const STRUCTURED_OUTPUTS_BETA = 'structured-outputs-2025-11-13'

type AnthropicContent =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'thinking'; thinking: string }

interface AnthropicResponse {
  content: AnthropicContent[]
  stop_reason?: string
  usage?: { input_tokens?: number; output_tokens?: number }
}

export class AnthropicProvider extends BaseLLMProvider {
  readonly name = 'claude' as const

  constructor(config: BaseLLMProviderConfig) {
    super({ ...config, baseUrl: ANTHROPIC_API_URL })
  }

  protected async doExecute(request: LLMRequest): Promise<ProviderResult<LLMResponse>> {
    const content: AnthropicContent[] = []

    for (const image of request.images ?? []) {
      if (image.base64) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: image.mimeType || 'image/jpeg', data: image.base64 },
        })
      } else if (image.url) {
        // Messages API accepts inline base64 only — fetch remote refs.
        const fetched = await fetchImageAsBase64(image.url).catch(() => null)
        if (fetched && fetched.size > 0) {
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: fetched.mimeType || 'image/jpeg', data: fetched.base64 },
          })
        }
      }
    }
    content.push({ type: 'text', text: request.prompt })

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxTokens ?? this.maxTokens,
      messages: [{ role: 'user', content }],
    }
    if (request.systemPrompt) body.system = request.systemPrompt
    if (request.tools?.length) body.tools = request.tools
    if (request.temperature != null) body.temperature = request.temperature
    if (request.reasoning?.enabled) body.thinking = { type: 'adaptive' }
    if (request.jsonSchema) {
      body.output_format = { type: 'json_schema', schema: sanitizeSchema(request.jsonSchema.schema) }
    } else if (request.responseFormat === 'json') {
      body.output_format = { type: 'json_schema', schema: { type: 'object' } }
    }

    const headers: Record<string, string> = {
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    }
    if (body.output_format) headers['anthropic-beta'] = STRUCTURED_OUTPUTS_BETA

    const resp = await fetch(ANTHROPIC_API_URL, this.createFetchOptions('POST', headers, body))
    const text = await resp.text()
    if (!resp.ok) {
      return failure(this.parseHttpError(resp.status, text))
    }

    let parsed: AnthropicResponse
    try {
      parsed = JSON.parse(text)
    } catch {
      return failure(createError(this.name, 'PARSE_ERROR', 'Non-JSON response from Anthropic', { retryable: false }))
    }

    const textBlocks = parsed.content?.filter((c) => c.type === 'text') ?? []
    const thinking = parsed.content?.find((c) => c.type === 'thinking')

    return success(
      {
        content: textBlocks.map((c) => (c.type === 'text' ? c.text : '')).join(''),
        finishReason: parsed.stop_reason,
        reasoning: thinking?.type === 'thinking' ? thinking.thinking : undefined,
      },
      {
        usage: {
          promptTokens: parsed.usage?.input_tokens,
          completionTokens: parsed.usage?.output_tokens,
          totalTokens: (parsed.usage?.input_tokens ?? 0) + (parsed.usage?.output_tokens ?? 0),
        },
      },
    )
  }
}

export function createAnthropicProvider(config: BaseLLMProviderConfig): AnthropicProvider {
  return new AnthropicProvider(config)
}

/** The structured-outputs beta rejects numeric bound keywords
 *  ("For 'integer' type, properties maximum, minimum are not supported").
 *  Strip them recursively — they're validation hints, not semantics, and a
 *  400 here silently killed every subject reno read behind 'unavailable'. */
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties',
])

function sanitizeSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchema)
  if (node == null || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(k)) continue
    out[k] = sanitizeSchema(v)
  }
  return out
}
