// Stale Server Action recovery.
// Next.js hashes Server Action IDs with a per-build salt, so a tab opened
// before a deploy calls action IDs the new deployment doesn't contain —
// `Failed to find Server Action`. The only fix is loading the new bundle:
// detect that specific error and reload once (guarded against loops).
//
// Two consumers:
//  - StaleActionGuard (root layout): window 'unhandledrejection'/'error'
//    listeners catch action calls that propagate uncaught.
//  - try/catch call sites: a caught rejection never reaches the global
//    listeners, so catch blocks call reloadForStaleAction(err) directly.

const RELOAD_KEY = 'fs:stale-action-reload'
const RELOAD_WINDOW_MS = 30_000

let reloadFired = false

export function isStaleServerActionError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? `${err.message} ${(err as { digest?: string }).digest ?? ''}`
      : String(err ?? '')
  return /failed[- ]to[- ]find[- ]server[- ]action|server action\s+"?[0-9a-f]+"?\s+was not found/i.test(msg)
}

/**
 * Reloads the page once when `err` is a stale-action error. Returns true when
 * a reload was triggered (caller should bail — the page is going away) or
 * false when this isn't a stale-action error / a reload already happened
 * recently (fall through to normal error handling so a real outage still
 * surfaces instead of looping forever).
 */
export function reloadForStaleAction(err: unknown): boolean {
  if (!isStaleServerActionError(err) || typeof window === 'undefined' || reloadFired) return false
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
    if (Date.now() - last < RELOAD_WINDOW_MS) return false
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch { /* storage blocked — the in-memory flag still bounds this page */ }
  reloadFired = true
  window.location.reload()
  return true
}
