'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

/**
 * PROTOTYPE · a switchable "skin" for the page it is mounted on. The skin is a block of CSS
 * overrides under [data-skin="nds"] in globals.css (colors, type, buttons), applied to <html> only
 * while this page is open. Our real theme tokens are not edited; turning the skin off, or leaving
 * the page, restores the current look exactly. Start it with ?skin=nds or the switch below.
 *
 * The switch is drawn in a portal on <body>, so it never takes a place in the page's own layout,
 * and it sits above the phone bottom nav instead of on top of it.
 */
const KEY = 'flowstate:skin-preview'
type Skin = 'nds' | null

export function SkinPreview() {
  const [skin, setSkin] = useState<Skin>(null)
  const [ready, setReady] = useState(false)

  // Read the choice after mount (the page is server-rendered without it)
  useEffect(() => {
    let next: Skin = null
    try {
      const fromUrl = new URLSearchParams(window.location.search).get('skin')
      if (fromUrl === 'nds') next = 'nds'
      else if (fromUrl === 'off') next = null
      else next = localStorage.getItem(KEY) === 'nds' ? 'nds' : null
    } catch { /* private mode */ }
    setSkin(next)
    setReady(true)
  }, [])

  useEffect(() => {
    if (!ready) return
    const root = document.documentElement
    if (skin) root.dataset.skin = skin
    else delete root.dataset.skin
    try { if (skin) localStorage.setItem(KEY, skin); else localStorage.removeItem(KEY) } catch { /* private mode */ }
    return () => { delete root.dataset.skin }
  }, [skin, ready])

  // A choice made with the switch replaces one made in the address bar: drop ?skin= so a reload keeps the choice
  const choose = (value: Skin) => {
    setSkin(value)
    try {
      const url = new URL(window.location.href)
      if (url.searchParams.has('skin')) {
        url.searchParams.delete('skin')
        // null, not the current state: Next then copies its own state and syncs its router, so a later
        // router refresh cannot bring the old ?skin= back
        window.history.replaceState(null, '', url)
      }
    } catch { /* leave the address as it is */ }
  }

  if (!ready) return null
  const option = (value: Skin, label: string) => (
    <button
      type="button"
      aria-pressed={skin === value}
      onClick={() => choose(value)}
      className={cn(
        'h-7 rounded px-2.5 text-[11px] font-medium transition-colors',
        skin === value ? 'bg-foreground text-background' : 'text-foreground-secondary hover:bg-secondary hover:text-foreground',
      )}
    >
      {label}
    </button>
  )
  return createPortal(
    <div
      role="group"
      aria-label="Skin prototype"
      // Below lg the app has a bottom nav (3.5rem plus the phone's safe area); sit just above it
      className="no-print fixed bottom-[calc(3.5rem+var(--sab)+0.75rem)] right-3 z-40 flex items-center gap-1.5 rounded-md border border-border bg-background p-1 shadow-sm lg:bottom-3"
    >
      <span className="px-1.5 text-[10px] uppercase tracking-wider text-foreground-tertiary">Prototype</span>
      {option(null, 'Current')}
      {option('nds', 'Studio')}
    </div>,
    document.body,
  )
}
