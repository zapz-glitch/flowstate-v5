'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

/**
 * PROTOTYPE · switchable "skins" for the dashboard. A skin is a block of CSS overrides in globals.css
 * under html[data-skin="…"]. Our real theme tokens are not edited; choosing Current restores today's
 * look exactly.
 *
 * - "america": the whole dashboard, every menu page, in the manner of america.gov.
 * - "nds" (Studio): Property Search only; on any other page it is not applied and not offered.
 *
 * Start one with ?skin=america or ?skin=nds, or use the switch. The switch is drawn in a portal on
 * <body>, so it takes no place in the page's layout, and it sits above the phone bottom nav.
 */
const KEY = 'flowstate:skin-preview'
type Skin = 'nds' | 'america' | null
const isSkin = (value: string | null): value is 'nds' | 'america' => value === 'nds' || value === 'america'

export function SkinPreview() {
  const pathname = usePathname()
  const [skin, setSkin] = useState<Skin>(null)
  const [ready, setReady] = useState(false)
  const onSearch = pathname?.startsWith('/dashboard/analyze') ?? false
  // Studio exists for Property Search only
  const applied: Skin = skin === 'nds' && !onSearch ? null : skin

  // Read the choice after mount (the page is server-rendered without it)
  useEffect(() => {
    let next: Skin = null
    try {
      const fromUrl = new URLSearchParams(window.location.search).get('skin')
      const kept = localStorage.getItem(KEY)
      if (isSkin(fromUrl)) next = fromUrl
      else if (fromUrl === 'off') next = null
      else next = isSkin(kept) ? kept : null
    } catch { /* private mode */ }
    setSkin(next)
    setReady(true)
  }, [])

  useEffect(() => {
    if (!ready) return
    try { if (skin) localStorage.setItem(KEY, skin); else localStorage.removeItem(KEY) } catch { /* private mode */ }
  }, [skin, ready])

  useEffect(() => {
    if (!ready) return
    const root = document.documentElement
    if (applied) root.dataset.skin = applied
    else delete root.dataset.skin
    return () => { delete root.dataset.skin }
  }, [applied, ready])

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
      aria-pressed={applied === value}
      onClick={() => choose(value)}
      className={cn(
        'h-7 rounded px-2.5 text-[11px] font-medium transition-colors',
        applied === value ? 'bg-foreground text-background' : 'text-foreground-secondary hover:bg-secondary hover:text-foreground',
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
      {onSearch && option('nds', 'Studio')}
      {option('america', 'America')}
    </div>,
    document.body,
  )
}
