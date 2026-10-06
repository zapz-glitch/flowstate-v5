'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * PROTOTYPE · a switchable "skin" for the page it is mounted on. The skin is a handful of CSS
 * overrides under [data-skin="nds"] in globals.css (colors, type, buttons), applied to <html> only
 * while this page is open. Our real theme tokens are not edited; turning the skin off, or leaving
 * the page, restores the current look exactly. Start it with ?skin=nds or the switch below.
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

  if (!ready) return null
  const option = (value: Skin, label: string) => (
    <button
      type="button"
      aria-pressed={skin === value}
      onClick={() => setSkin(value)}
      className={cn(
        'h-7 rounded px-2.5 text-[11px] font-medium transition-colors',
        skin === value ? 'bg-foreground text-background' : 'text-foreground-secondary hover:bg-secondary hover:text-foreground',
      )}
    >
      {label}
    </button>
  )
  return (
    <div
      role="group"
      aria-label="Skin prototype"
      className="no-print fixed bottom-3 right-3 z-40 flex items-center gap-1 rounded-md border border-border bg-background p-1 shadow-sm"
    >
      <span className="px-1.5 text-[10px] uppercase tracking-wider text-foreground-tertiary">Prototype</span>
      {option(null, 'Current')}
      {option('nds', 'Studio')}
    </div>
  )
}
