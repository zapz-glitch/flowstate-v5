import { useEffect, useRef, useState } from 'react'

/**
 * For overlays that are loaded on demand. True from the first time `open` is
 * true, and it stays true. Build the overlay when it first opens, then keep it
 * mounted so its own exit animation plays when it closes. (Drawing it only
 * while `open` is true cuts it out instantly on close.)
 */
export function useStayMounted(open: boolean): boolean {
  const [seen, setSeen] = useState(open)
  if (open && !seen) setSeen(true)
  return open || seen
}

/** Starts loading a lazily imported component when the browser is idle, so its
 *  first open does not wait for the code to download. */
export function usePreloadOnIdle(loader: () => Promise<unknown>): void {
  const loaderRef = useRef(loader)
  useEffect(() => {
    const run = () => { void loaderRef.current().catch(() => {}) }
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(run, { timeout: 3000 })
      return () => window.cancelIdleCallback(id)
    }
    const timer = setTimeout(run, 1500)
    return () => clearTimeout(timer)
  }, [])
}
