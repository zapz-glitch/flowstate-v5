'use client'

import { useEffect } from 'react'

/**
 * Proactive deploy-staleness recovery. StaleActionGuard reloads a tab only
 * after an error already fired — but a tab left open across a deploy keeps
 * running the old bundle indefinitely, so shipped fixes never reach the
 * user. Chunk filenames are content-hashed, so a new deploy changes the
 * page's <script src> set. Refetch the current page's HTML periodically
 * and on tab regain; if it references a chunk we don't have, reload once
 * onto the new bundle.
 *
 * Only <script src> tags are compared — <link rel="preload"> entries point
 * at lazy chunks that may never load, which would false-positive. Deferred
 * while an input is focused so a reload can't eat in-progress typing, and
 * sessionStorage-throttled so a flapping deploy can't loop.
 */
const RELOAD_KEY = 'fs:version-reload'
const POLL_MS = 120_000
const DEFER_MS = 30_000

export function VersionGuard() {
  useEffect(() => {
    let fired = false
    let deferred: ReturnType<typeof setTimeout> | undefined

    const check = async () => {
      if (fired) return
      try {
        const res = await fetch(window.location.pathname, { cache: 'no-store' })
        if (!res.ok) return
        const html = await res.text()
        const loaded = new Set(
          Array.from(document.scripts).map((s) => s.src).filter(Boolean),
        )
        const stale = Array.from(
          html.matchAll(/<script[^>]*\ssrc="(\/_next\/static\/[^"]+)"/g),
          (m) => new URL(m[1], location.origin).href,
        ).some((u) => !loaded.has(u))
        if (!stale) return
      } catch {
        return // network hiccup — try again next tick
      }
      // Never yank the page mid-typing — recheck shortly.
      const el = document.activeElement
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        deferred = setTimeout(check, DEFER_MS)
        return
      }
      try {
        const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
        if (Date.now() - last < 30_000) return
        sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
      } catch {
        /* storage blocked — the in-memory flag still bounds this page */
      }
      fired = true
      window.location.reload()
    }

    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void check()
    }, POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      clearTimeout(deferred)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  return null
}
