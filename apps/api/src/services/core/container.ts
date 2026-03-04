/**
 * Service Container (Dependency Injection)
 *
 * Provides centralized service creation and management.
 * Ensures services are created once per request and share dependencies.
 */

import type { Env } from '../../types'
import type { PropertyApiService } from '../property-api'
import type { VisionService } from '../vision'
import type { ValuationService } from '../valuation'
import type { ObservabilityService } from './observability'
import type { RequestContext } from './types'
import { createObservabilityService, generateRequestId } from './observability'

// ─── Container Configuration ─────────────────────────────────────────────────

export interface ContainerConfig {
  /** Log level for observability */
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
  /** Request context for correlation */
  requestContext?: {
    requestId?: string
    userId?: string
    apiKeyId?: string
    endpoint?: string
  }
}

// ─── Service Container Interface ─────────────────────────────────────────────

export interface ServiceContainer {
  /** Environment bindings */
  readonly env: Env

  /** Observability service - always available */
  readonly observability: ObservabilityService

  /** Request context */
  readonly requestContext: RequestContext

  /** Property API service - lazily created */
  readonly propertyApi: PropertyApiService

  /** Valuation service - lazily created */
  readonly valuation: ValuationService

  /** Database - direct access to D1 */
  readonly db: D1Database
}

// ─── Lazy Service Container ──────────────────────────────────────────────────

class LazyServiceContainer implements ServiceContainer {
  readonly env: Env
  readonly observability: ObservabilityService
  readonly requestContext: RequestContext
  readonly db: D1Database

  // Cached service instances
  private _propertyApi: PropertyApiService | null = null
  private _vision: VisionService | null = null
  private _valuation: ValuationService | null = null

  constructor(env: Env, config?: ContainerConfig) {
    this.env = env
    this.db = env.DB

    // Create observability service
    const baseObservability = createObservabilityService({
      logLevel: config?.logLevel ?? 'info',
    })

    // Set up request context
    const requestId = config?.requestContext?.requestId ?? generateRequestId()
    this.requestContext = {
      requestId,
      userId: config?.requestContext?.userId,
      apiKeyId: config?.requestContext?.apiKeyId,
      endpoint: config?.requestContext?.endpoint,
      startTime: Date.now(),
    }

    // Create observability with request context
    this.observability = baseObservability.withRequestContext(
      requestId,
      config?.requestContext?.userId,
      config?.requestContext?.apiKeyId
    )

    this.observability.info('Service container created', {
      endpoint: this.requestContext.endpoint,
    })
  }

  get propertyApi(): PropertyApiService {
    if (!this._propertyApi) {
      // Dynamic import to avoid circular dependencies
      const { createPropertyApi } = require('../property-api') as typeof import('../property-api')
      this._propertyApi = createPropertyApi(this.env)
      this.observability.debug('PropertyAPI service created')
    }
    return this._propertyApi
  }

  get vision(): VisionService {
    if (!this._vision) {
      const { createVisionService } = require('../vision') as typeof import('../vision')
      this._vision = createVisionService(this.env)
      this.observability.debug('Vision service created', {
        provider: this._vision.getProviderName(),
        model: this._vision.getModel(),
      })
    }
    return this._vision
  }

  get valuation(): ValuationService {
    if (!this._valuation) {
      const { createValuationService } = require('../valuation') as typeof import('../valuation')
      this._valuation = createValuationService()
      this.observability.debug('Valuation service created')
    }
    return this._valuation
  }
}

// ─── Factory Function ────────────────────────────────────────────────────────

/**
 * Create a new service container for a request
 *
 * @param env - Cloudflare Workers environment bindings
 * @param config - Optional container configuration
 * @returns ServiceContainer with lazily-created services
 *
 * @example
 * ```typescript
 * const container = createServiceContainer(c.env, {
 *   requestContext: {
 *     requestId: c.get('requestId'),
 *     userId: auth?.userId,
 *     apiKeyId: auth?.apiKeyId,
 *     endpoint: '/v1/analyze'
 *   }
 * })
 *
 * // Services are created on first access
 * const property = await container.propertyApi.searchProperty({ address })
 * ```
 */
export function createServiceContainer(env: Env, config?: ContainerConfig): ServiceContainer {
  return new LazyServiceContainer(env, config)
}

// ─── Hono Context Integration ────────────────────────────────────────────────

/**
 * Create container from Hono context
 * Extracts auth context and request info automatically
 */
export function createContainerFromContext(
  c: {
    env: Env
    get: (key: string) => unknown
    req: { path: string }
  }
): ServiceContainer {
  const auth = c.get('auth') as { userId?: string; apiKeyId?: string } | undefined

  return createServiceContainer(c.env, {
    requestContext: {
      requestId: (c.get('requestId') as string) ?? generateRequestId(),
      userId: auth?.userId,
      apiKeyId: auth?.apiKeyId,
      endpoint: c.req.path,
    },
  })
}

// ─── Re-exports ──────────────────────────────────────────────────────────────

export type { ObservabilityService } from './observability'
export type { RequestContext, UsageMetrics, TimingMetrics, ProviderError } from './types'
export { generateRequestId } from './observability'
