/**
 * What counts as an intentional hover on a map marker. Dragging, zooming and sweeping the pointer
 * across the map must not open a comp card; resting on a marker must. Pure, so it is easy to test.
 */

/** The pointer has to rest on a marker this long before its card opens */
export const DWELL_MS = 250
/** Movement up to this many pixels still counts as resting; more restarts the wait */
export const DWELL_SLOP_PX = 4
/** After a drag, zoom or wheel turn, hover stays quiet this long */
export const SETTLE_MS = 350

export interface Point { x: number; y: number }

export interface IntentInput {
  now: number
  /** When the pointer started resting on the marker (restarts when it moves more than the slop) */
  restedSince: number
  /** The last drag end, zoom change or wheel turn on the map (0 if none) */
  lastInteractionAt: number
  /** A drag is in progress, or a mouse button is held down */
  gesturing: boolean
}

/** Has the pointer shown intent yet? If not, how long until it could. */
export function hoverIntent({ now, restedSince, lastInteractionAt, gesturing }: IntentInput): { ready: boolean; waitMs: number } {
  if (gesturing) return { ready: false, waitMs: DWELL_MS }
  const waitMs = Math.max(restedSince + DWELL_MS - now, lastInteractionAt + SETTLE_MS - now)
  return waitMs <= 0 ? { ready: true, waitMs: 0 } : { ready: false, waitMs }
}

/** Did the pointer move far enough from where it was resting to start the wait over? */
export function movedBeyondSlop(from: Point, to: Point): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) > DWELL_SLOP_PX
}
