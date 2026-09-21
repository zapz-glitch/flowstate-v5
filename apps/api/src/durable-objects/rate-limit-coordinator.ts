/**
 * RateLimitCoordinator Durable Object
 *
 * Coordinates CoreLogic API rate limiting across all workers globally.
 * Tracks daily usage per key and manages cooldowns.
 */

import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../types'
import type {
  RateLimitState,
  KeyState,
  DailyUsage,
  AcquireKeyResult,
  ReleaseKeyResult,
} from './types'
import { computeThrottleSlot, computeThrottleStats, THROTTLE_BULK_MAX_REQUESTS, THROTTLE_MAX_REQUESTS } from './throttle'

// CoreLogic API limits
const MAX_DAILY_USAGE_PER_KEY = 100
const COOLDOWN_MS = 60 * 1000 // 1 minute cooldown on rate limit

/** Storage key for the global request-throttle sliding window */
const THROTTLE_STORAGE_KEY = 'throttleGrants'

export class RateLimitCoordinatorDO extends DurableObject<Env> {
  private state: RateLimitState | null = null
  private throttleGrants: number[] | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }

  /**
   * Load the throttle grant window (committed request slots)
   */
  private async loadThrottleGrants(): Promise<number[]> {
    if (this.throttleGrants) return this.throttleGrants
    this.throttleGrants =
      (await this.ctx.storage.get<number[]>(THROTTLE_STORAGE_KEY)) ?? []
    return this.throttleGrants
  }

  /**
   * Get the number of configured API keys from environment
   */
  private getKeyCount(): number {
    let count = 0
    for (let i = 0; i < 10; i++) {
      const envRecord = this.env as unknown as Record<string, string | undefined>
      const clientId = envRecord[`CORELOGIC_CLIENT_ID_${i}`]
      if (clientId) {
        count++
      } else {
        break
      }
    }
    return Math.max(count, 1)
  }

  /**
   * Get today's date string (UTC)
   */
  private getTodayString(): string {
    return new Date().toISOString().split('T')[0]
  }

  /**
   * Load state from storage
   */
  private async loadState(): Promise<RateLimitState> {
    if (this.state) return this.state

    const stored = await this.ctx.storage.get<RateLimitState>('state')
    const keyCount = this.getKeyCount()
    const today = this.getTodayString()

    if (stored) {
      // Reset daily usage if new day
      for (const keyIndex of Object.keys(stored.dailyUsage).map(Number)) {
        const usage = stored.dailyUsage[keyIndex]
        if (usage && usage.date !== today) {
          stored.dailyUsage[keyIndex] = { date: today, count: 0 }
        }
      }

      // Ensure we have state for all keys
      while (stored.keys.length < keyCount) {
        const index = stored.keys.length
        stored.keys.push({
          index,
          isAvailable: true,
          lastUsedAt: null,
          todayUsage: 0,
          cooldownUntil: null,
        })
        stored.dailyUsage[index] = { date: today, count: 0 }
      }

      this.state = stored
    } else {
      // Initialize fresh state
      const keys: KeyState[] = []
      const dailyUsage: Record<number, DailyUsage> = {}

      for (let i = 0; i < keyCount; i++) {
        keys.push({
          index: i,
          isAvailable: true,
          lastUsedAt: null,
          todayUsage: 0,
          cooldownUntil: null,
        })
        dailyUsage[i] = { date: today, count: 0 }
      }

      this.state = { keys, dailyUsage }
    }

    return this.state
  }

  /**
   * Save state to storage
   */
  private async saveState(): Promise<void> {
    if (this.state) {
      await this.ctx.storage.put('state', this.state)
    }
  }

  /**
   * Handle incoming HTTP requests
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    try {
      switch (url.pathname) {
        case '/acquire':
          return this.handleAcquireKey()
        case '/release':
          return this.handleReleaseKey(request)
        case '/rate-limit':
          return this.handleRateLimit(request)
        case '/status':
          return this.handleGetStatus()
        case '/reset':
          return this.handleResetDaily()
        case '/throttle/acquire':
          return this.handleThrottleAcquire(request)
        case '/throttle/stats':
          return this.handleThrottleStats()
        default:
          return new Response('Not Found', { status: 404 })
      }
    } catch (error) {
      console.error('[RateLimitCoordinatorDO] Error handling request:', error)
      return new Response(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'Internal error',
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      )
    }
  }

  /**
   * Acquire an available API key
   */
  private async handleAcquireKey(): Promise<Response> {
    const state = await this.loadState()
    const now = Date.now()
    const today = this.getTodayString()

    // Find an available key
    for (const key of state.keys) {
      // Check if in cooldown
      if (key.cooldownUntil) {
        const cooldownExpiry = new Date(key.cooldownUntil).getTime()
        if (now < cooldownExpiry) {
          continue // Still in cooldown
        }
        // Cooldown expired, clear it
        key.cooldownUntil = null
      }

      // Check daily usage
      const usage = state.dailyUsage[key.index]
      if (usage) {
        // Reset if new day
        if (usage.date !== today) {
          usage.date = today
          usage.count = 0
          key.todayUsage = 0
        }

        // Check if limit reached
        if (usage.count >= MAX_DAILY_USAGE_PER_KEY) {
          continue // Key exhausted for today
        }
      }

      // Key is available - mark as in use
      key.isAvailable = false
      key.lastUsedAt = new Date().toISOString()

      await this.saveState()

      const result: AcquireKeyResult = {
        success: true,
        keyIndex: key.index,
      }

      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // No keys available - calculate wait time
    let minWaitMs = Infinity

    for (const key of state.keys) {
      if (key.cooldownUntil) {
        const cooldownExpiry = new Date(key.cooldownUntil).getTime()
        const waitMs = cooldownExpiry - now
        if (waitMs > 0 && waitMs < minWaitMs) {
          minWaitMs = waitMs
        }
      }
    }

    const result: AcquireKeyResult = {
      success: false,
      keyIndex: null,
      error: 'All API keys are exhausted or in cooldown',
      waitMs: minWaitMs === Infinity ? undefined : minWaitMs,
    }

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * Release a key after use
   */
  private async handleReleaseKey(request: Request): Promise<Response> {
    const body = await request.json() as { keyIndex: number; success: boolean }
    const state = await this.loadState()
    const today = this.getTodayString()

    const key = state.keys[body.keyIndex]
    if (!key) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid key index' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Mark key as available
    key.isAvailable = true

    // Increment usage on success
    if (body.success) {
      const usage = state.dailyUsage[body.keyIndex]
      if (usage) {
        if (usage.date !== today) {
          usage.date = today
          usage.count = 1
        } else {
          usage.count++
        }
        key.todayUsage = usage.count
      }
    }

    await this.saveState()

    const result: ReleaseKeyResult = { success: true }
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * Report a rate limit (429) error for a key
   */
  private async handleRateLimit(request: Request): Promise<Response> {
    const body = await request.json() as { keyIndex: number }
    const state = await this.loadState()

    const key = state.keys[body.keyIndex]
    if (!key) {
      return new Response(JSON.stringify({ success: false, error: 'Invalid key index' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    // Put key in cooldown
    key.cooldownUntil = new Date(Date.now() + COOLDOWN_MS).toISOString()
    key.isAvailable = true // Release it so other workers don't wait for it

    await this.saveState()

    return new Response(JSON.stringify({ success: true, cooldownMs: COOLDOWN_MS }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * Get current status of all keys
   */
  private async handleGetStatus(): Promise<Response> {
    const state = await this.loadState()
    const now = Date.now()
    const today = this.getTodayString()

    const status = state.keys.map((key) => {
      // Check cooldown status
      let inCooldown = false
      let cooldownRemainingMs = 0
      if (key.cooldownUntil) {
        const cooldownExpiry = new Date(key.cooldownUntil).getTime()
        if (now < cooldownExpiry) {
          inCooldown = true
          cooldownRemainingMs = cooldownExpiry - now
        }
      }

      // Get today's usage
      const usage = state.dailyUsage[key.index]
      const todayCount = usage && usage.date === today ? usage.count : 0
      const remaining = MAX_DAILY_USAGE_PER_KEY - todayCount

      return {
        index: key.index,
        isAvailable: key.isAvailable && !inCooldown && remaining > 0,
        todayUsage: todayCount,
        remaining,
        inCooldown,
        cooldownRemainingMs,
        lastUsedAt: key.lastUsedAt,
      }
    })

    const summary = {
      total: status.length,
      available: status.filter((s) => s.isAvailable).length,
      inCooldown: status.filter((s) => s.inCooldown).length,
      exhausted: status.filter((s) => s.remaining === 0).length,
      totalRemainingToday: status.reduce((sum, s) => sum + s.remaining, 0),
    }

    return new Response(JSON.stringify({ status, summary }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * POST /throttle/acquire
   *
   * Global sliding-window throttle for Cotality API calls (50 req/min).
   * Always commits a slot: returns waitMs=0 when capacity is available now,
   * or a reserved future slot the caller waits for. granted=false only when
   * the queue backlog exceeds the cap.
   *
   * Body `{ priority: true }` marks interactive traffic (typeahead) which
   * may use the reserved headroom slots instead of queueing behind bulk
   * analysis backlog. Bulk callers are capped at MAX - RESERVE.
   *
   * Single-threaded DO = serialized acquires, no races across workers.
   */
  private async handleThrottleAcquire(request: Request): Promise<Response> {
    let priority = false
    try {
      const body = (await request.json()) as { priority?: boolean }
      priority = body.priority === true
    } catch { /* empty body — bulk acquire */ }

    const grants = await this.loadThrottleGrants()
    const { grants: updated, result } = computeThrottleSlot(
      grants,
      Date.now(),
      priority ? THROTTLE_MAX_REQUESTS : THROTTLE_BULK_MAX_REQUESTS,
    )

    this.throttleGrants = updated
    await this.ctx.storage.put(THROTTLE_STORAGE_KEY, updated)

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * GET /throttle/stats
   *
   * Current throttle window stats for monitoring: how many of the 50
   * requests/minute are committed, queue depth, and expected wait.
   */
  private async handleThrottleStats(): Promise<Response> {
    const grants = await this.loadThrottleGrants()
    const stats = computeThrottleStats(grants, Date.now())

    return new Response(JSON.stringify(stats), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  /**
   * Reset daily usage (for testing or scheduled reset)
   */
  private async handleResetDaily(): Promise<Response> {
    const state = await this.loadState()
    const today = this.getTodayString()

    for (const key of state.keys) {
      key.todayUsage = 0
      key.cooldownUntil = null
      state.dailyUsage[key.index] = { date: today, count: 0 }
    }

    await this.saveState()

    return new Response(JSON.stringify({ success: true, message: 'Daily usage reset' }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
