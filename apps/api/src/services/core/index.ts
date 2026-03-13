/**
 * Core Services
 *
 * Provides foundational infrastructure for the modular architecture:
 * - Universal provider interfaces
 * - Observability (logging, metrics, token tracking)
 */

// Types and utilities
export type {
  // Provider interfaces
  Provider,
  ProviderResult,
  ProviderError,
  UsageMetrics,
  TimingMetrics,
  RequestContext,
  // LLM types
  LLMProvider,
  LLMProviderType,
  LLMProviderConfig,
  LLMRequest,
  LLMResponse,
  ImageInput,
  // Property data types
  PropertyDataProviderType,
  PropertyIdentifier,
  // Photo source types
  PhotoSourceType,
  FetchedPhotosResult,
  ZillowPropertyData,
  PriceHistoryEntry,
} from './types'

export {
  // Result helpers
  success,
  failure,
  createError,
  withTiming,
  // Cost calculation
  calculateEstimatedCost,
  LLM_PRICING,
} from './types'

// Observability
export type {
  ObservabilityService,
  LogLevel,
  LogEntry,
  TokenUsageEntry,
  UsageSummary,
  LatencyEntry,
  ErrorEntry,
  TokenUsageRecord,
} from './observability'

export {
  createObservabilityService,
  generateRequestId,
  toTokenUsageRecords,
} from './observability'

