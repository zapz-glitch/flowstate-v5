/**
 * Global Request Throttle — Sliding Window with Slot Reservation
 *
 * Enforces the Cotality (CoreLogic) API limit of 50 requests/minute
 * across ALL workers and workflow instances globally.
 *
 * How it works:
 * - `grants` is a sorted array of committed slot timestamps (past or future)
 * - An acquire is ALWAYS given a committed slot immediately — if the window
 *   is full, the slot is reserved at the earliest future time with capacity.
 *   The caller simply sleeps `waitMs` and then fires its request; no
 *   second round-trip or retry race is possible.
 * - If the backlog exceeds QUEUE_CAP_MS, acquire returns granted=false so
 *   the caller can surface a retryable error instead of queueing forever.
 *
 * Pure functions — no workerd imports — so they can be unit tested in Node.
 */

export const THROTTLE_WINDOW_MS = 60_000
export const THROTTLE_MAX_REQUESTS = 50
/** Reject acquires when the reserved backlog is deeper than this */
export const THROTTLE_QUEUE_CAP_MS = 300_000 // 5 minutes

export interface ThrottleAcquireResult {
  /** Whether a slot was committed (always true unless queue is saturated) */
  granted: boolean
  /** How long the caller must wait before firing its request */
  waitMs: number
  /** Absolute timestamp of the committed slot */
  scheduledFor: number
  /** Committed slots inside the current window after this acquire */
  windowCount: number
  /** Slots scheduled in the future (queue depth) */
  queueDepth: number
  error?: string
}

export interface ThrottleStats {
  limit: number
  windowMs: number
  /** Committed slots in the current window */
  windowCount: number
  /** Available capacity right now */
  availableNow: number
  /** Slots committed in the future (queued work) */
  queueDepth: number
  /** Wait for a new request submitted right now */
  nextSlotWaitMs: number
}

/**
 * Compute the committed slot for a new request.
 *
 * Returns the updated grants array (with the new slot appended when
 * granted) and the acquire result. Caller persists the array.
 */
export function computeThrottleSlot(
  grants: number[],
  now: number
): { grants: number[]; result: ThrottleAcquireResult } {
  const windowStart = now - THROTTLE_WINDOW_MS
  const active = grants.filter((g) => g > windowStart)
  const queueDepth = active.filter((g) => g > now).length

  if (active.length < THROTTLE_MAX_REQUESTS) {
    // Capacity in the current window — grant immediately
    active.push(now)
    return {
      grants: active,
      result: {
        granted: true,
        waitMs: 0,
        scheduledFor: now,
        windowCount: active.length,
        queueDepth,
      },
    }
  }

  // Window is full — the new slot frees when the 50th-newest committed
  // grant rolls off the window's left edge.
  const scheduledFor = active[active.length - THROTTLE_MAX_REQUESTS] + THROTTLE_WINDOW_MS
  const waitMs = Math.max(0, scheduledFor - now)

  if (waitMs > THROTTLE_QUEUE_CAP_MS) {
    return {
      grants: active,
      result: {
        granted: false,
        waitMs,
        scheduledFor,
        windowCount: active.length,
        queueDepth,
        error: `Rate-limit queue saturated: next available slot in ${Math.round(waitMs / 1000)}s`,
      },
    }
  }

  active.push(scheduledFor)
  return {
    grants: active,
    result: {
      granted: true,
      waitMs,
      scheduledFor,
      windowCount: active.length,
      queueDepth: queueDepth + 1,
    },
  }
}

/**
 * Compute current window stats without mutating state.
 */
export function computeThrottleStats(grants: number[], now: number): ThrottleStats {
  const windowStart = now - THROTTLE_WINDOW_MS
  const active = grants.filter((g) => g > windowStart)
  const queueDepth = active.filter((g) => g > now).length
  const availableNow = Math.max(0, THROTTLE_MAX_REQUESTS - active.length)

  const nextSlotWaitMs =
    availableNow > 0
      ? 0
      : Math.max(0, active[active.length - THROTTLE_MAX_REQUESTS] + THROTTLE_WINDOW_MS - now)

  return {
    limit: THROTTLE_MAX_REQUESTS,
    windowMs: THROTTLE_WINDOW_MS,
    windowCount: active.length,
    availableNow,
    queueDepth,
    nextSlotWaitMs,
  }
}
