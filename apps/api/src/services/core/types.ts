/**
 * Core Types
 *
 * Universal provider interfaces and types for modular architecture.
 * These types enable swappable providers for data, LLM, and photo services.
 */

// ─── Provider Result Types ───────────────────────────────────────────────────

/**
 * Usage metrics for LLM providers - tracked for billing and limits
 */
export interface UsageMetrics {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  /** Estimated cost in USD based on provider pricing */
  estimatedCostUsd?: number
}

/**
 * Timing metrics for observability
 */
export interface TimingMetrics {
  startTime: number
  endTime: number
  durationMs: number
}

/**
 * Standardized provider error
 */
export interface ProviderError {
  /** Error code for programmatic handling */
  code: string
  /** Human-readable error message */
  message: string
  /** Whether this error can be retried */
  retryable: boolean
  /** Provider name that generated the error */
  provider: string
  /** HTTP status code if applicable */
  statusCode?: number
  /** Original error details for debugging */
  details?: unknown
}

/**
 * Universal result type for all provider operations
 */
export interface ProviderResult<T> {
  success: boolean
  data?: T
  error?: ProviderError
  /** Token usage - only for LLM providers */
  usage?: UsageMetrics
  /** Timing information */
  timing?: TimingMetrics
}

// ─── Provider Interface ──────────────────────────────────────────────────────

/**
 * Base provider interface - all providers implement this
 */
export interface Provider<TRequest, TResponse> {
  /** Provider name (e.g., 'gemini', 'corelogic', 'zillow') */
  readonly name: string
  /** Execute the provider operation */
  execute(request: TRequest): Promise<ProviderResult<TResponse>>
  /** Check if provider is properly configured */
  isConfigured(): boolean
}

// ─── LLM Provider Types ──────────────────────────────────────────────────────

/**
 * LLM provider types supported
 */
export type LLMProviderType = 'gemini' | 'claude' | 'openai' | 'grok' | 'openrouter'

/**
 * Image input for vision analysis
 */
export interface ImageInput {
  /** URL of the image */
  url?: string
  /** Base64-encoded image data */
  base64?: string
  /** MIME type (e.g., 'image/jpeg') */
  mimeType?: string
}

/**
 * LLM request for vision or text completion
 */
/** OpenRouter web search tool configuration */
export interface WebSearchConfig {
  /** Search engine: auto | exa | native | parallel */
  engine?: 'auto' | 'exa' | 'native' | 'parallel'
  /** Max results per search (1-25, default 5) */
  maxResults?: number
  /** Content extraction depth: low | medium | high */
  searchContextSize?: 'low' | 'medium' | 'high'
  /** Restrict to specific domains */
  allowedDomains?: string[]
  /** Exclude specific domains */
  excludedDomains?: string[]
  /** Geo-bias for search results */
  userLocation?: {
    type: 'approximate'
    city?: string
    region?: string
    country?: string
  }
}

export interface LLMRequest {
  /** Main prompt/instruction */
  prompt: string
  /** System prompt for context setting */
  systemPrompt?: string
  /** Images for vision analysis */
  images?: ImageInput[]
  /** Expected response format */
  responseFormat?: 'text' | 'json'
  /** Maximum tokens to generate */
  maxTokens?: number
  /** Temperature for response randomness (0-1) */
  temperature?: number
  /** Enable OpenRouter web search tool */
  webSearch?: WebSearchConfig
  /** Enable reasoning/thinking mode */
  reasoning?: {
    enabled: boolean
    /** Reasoning effort: xhigh, high, medium, low, minimal */
    effort?: 'xhigh' | 'high' | 'medium' | 'low' | 'minimal'
  }
}

/**
 * LLM response
 */
export interface LLMResponse {
  /** Generated text content */
  content: string
  /** Finish reason if provided by model */
  finishReason?: string
  /** Reasoning/thinking content (when reasoning mode is enabled) */
  reasoning?: string
}

/**
 * LLM provider configuration
 */
export interface LLMProviderConfig {
  provider: LLMProviderType
  apiKey: string
  model?: string
  maxTokens?: number
  /** Base URL override (for custom endpoints) */
  baseUrl?: string
}

/**
 * LLM provider interface
 */
export interface LLMProvider extends Provider<LLMRequest, LLMResponse> {
  readonly name: LLMProviderType
  readonly model: string
}

// ─── Data Provider Types ─────────────────────────────────────────────────────

/**
 * Property data provider types
 */
export type PropertyDataProviderType = 'corelogic' | 'attom' | 'mls'

/**
 * Normalized property identifier
 */
export interface PropertyIdentifier {
  /** Provider-specific property ID */
  propertyId: string
  /** Street address */
  address: string
  city: string
  state: string
  zipCode: string
  /** Coordinates if available */
  latitude?: number | null
  longitude?: number | null
}

// ─── Photo Provider Types ────────────────────────────────────────────────────

/**
 * Photo source provider types
 */
export type PhotoSourceType = 'zillow' | 'streetview' | 'mls' | 'direct'

/**
 * Fetched photos result
 */
export interface FetchedPhotosResult {
  /** Array of photo URLs */
  photos: string[]
  /** Source of the photos */
  source: PhotoSourceType
  /** Street view URL if available */
  streetViewUrl?: string
  /** Satellite view URL if available */
  satelliteUrl?: string
  /** Zillow listing URL */
  listingUrl?: string
  /** Additional property data extracted from source */
  propertyData?: ZillowPropertyData
}

/**
 * Zillow property data extracted from listing
 */
export interface ZillowPropertyData {
  /** Zillow property ID */
  zpid?: string
  /** Property description */
  description?: string
  /** Listed price */
  price?: number
  /** Price history */
  priceHistory?: PriceHistoryEntry[]
  /** Property features */
  features?: string[]
  /** Number of photos available */
  photoCount?: number
  /** Days on market */
  daysOnMarket?: number
  /** Property status */
  status?: string
  /** Year built */
  yearBuilt?: number
  /** Square footage */
  squareFeet?: number
  /** Lot size */
  lotSize?: string
  /** Bedrooms */
  bedrooms?: number
  /** Bathrooms */
  bathrooms?: number
}

/**
 * Price history entry
 */
export interface PriceHistoryEntry {
  date: string
  price: number
  event: string
  source?: string
}

// ─── Request Context ─────────────────────────────────────────────────────────

/**
 * Request context for observability and correlation
 */
export interface RequestContext {
  /** Unique request ID for correlation */
  requestId: string
  /** User ID if authenticated */
  userId?: string
  /** API key ID if using API authentication */
  apiKeyId?: string
  /** Request start timestamp */
  startTime: number
  /** Endpoint being called */
  endpoint?: string
}

// ─── Cost Calculation ────────────────────────────────────────────────────────

/**
 * LLM pricing per 1M tokens (USD)
 */
export const LLM_PRICING: Record<string, { input: number; output: number }> = {
  // Gemini
  'gemini-2.0-flash': { input: 0.10, output: 0.40 },
  'gemini-1.5-flash': { input: 0.075, output: 0.30 },
  'gemini-1.5-pro': { input: 1.25, output: 5.00 },
  // Claude
  'claude-3-5-sonnet-20241022': { input: 3.00, output: 15.00 },
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
  // OpenAI
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4-turbo': { input: 10.00, output: 30.00 },
  // Grok
  'grok-2-vision-1212': { input: 2.00, output: 10.00 },
  'grok-2-1212': { input: 2.00, output: 10.00 },
}

/**
 * Calculate estimated cost for LLM usage
 */
export function calculateEstimatedCost(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const pricing = LLM_PRICING[model]
  if (!pricing) {
    // Default to medium pricing if model not found
    return ((promptTokens * 1.0) + (completionTokens * 5.0)) / 1_000_000
  }
  return ((promptTokens * pricing.input) + (completionTokens * pricing.output)) / 1_000_000
}

// ─── Utility Types ───────────────────────────────────────────────────────────

/**
 * Create a successful result
 */
export function success<T>(
  data: T,
  options?: { usage?: UsageMetrics; timing?: TimingMetrics }
): ProviderResult<T> {
  return {
    success: true,
    data,
    usage: options?.usage,
    timing: options?.timing,
  }
}

/**
 * Create a failed result
 */
export function failure<T>(error: ProviderError, timing?: TimingMetrics): ProviderResult<T> {
  return {
    success: false,
    error,
    timing,
  }
}

/**
 * Create a provider error
 */
export function createError(
  provider: string,
  code: string,
  message: string,
  options?: { retryable?: boolean; statusCode?: number; details?: unknown }
): ProviderError {
  return {
    provider,
    code,
    message,
    retryable: options?.retryable ?? false,
    statusCode: options?.statusCode,
    details: options?.details,
  }
}

/**
 * Measure timing for an async operation
 */
export async function withTiming<T>(
  operation: () => Promise<T>
): Promise<{ result: T; timing: TimingMetrics }> {
  const startTime = Date.now()
  const result = await operation()
  const endTime = Date.now()
  return {
    result,
    timing: {
      startTime,
      endTime,
      durationMs: endTime - startTime,
    },
  }
}
