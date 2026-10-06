import { useState } from 'react'

interface HoldState<T> {
  busy: boolean
  /** What was on screen when the rerun started · null when nothing is being held */
  frozen: T | null
  /** Goes up by one each time a held rerun finishes · key the new results on it to animate them in */
  generation: number
}

/**
 * Pure step of the hold: what to keep, given the previous state and the new inputs.
 * - A rerun starts (busy goes up) with results on screen: freeze them.
 * - A rerun ends: release, and count it so the fresh results can animate in.
 * - Any other change leaves the state alone.
 */
export function nextHold<T>(prev: HoldState<T>, value: T, busy: boolean, hasPrior: boolean): HoldState<T> {
  if (busy === prev.busy) return prev
  if (busy) return { busy, frozen: hasPrior ? value : null, generation: prev.generation }
  return { busy, frozen: null, generation: prev.generation + (prev.frozen != null ? 1 : 0) }
}

/**
 * Keeps the results steady during a rerun. While a rerun is in flight the previous results are
 * returned unchanged, so the numbers, comp order and map dots do not shuffle as the new data streams
 * in; when it finishes the fresh results are released at once. A first run (nothing on screen when
 * it started) is never held, so results still appear step by step.
 *
 * Mounting while already busy does not freeze anything: that is a first run in progress.
 */
export function useHeldDuringRerun<T>(value: T, busy: boolean, hasPrior: boolean) {
  const [state, setState] = useState<HoldState<T>>(() => ({ busy, frozen: null, generation: 0 }))
  const current = nextHold(state, value, busy, hasPrior)
  if (current !== state) setState(current)
  const holding = busy && current.frozen != null
  return { value: holding ? (current.frozen as T) : value, holding, generation: current.generation }
}
