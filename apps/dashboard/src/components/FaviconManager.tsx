'use client'

import { useEffect } from 'react'
import { getUiPrefs, type UiPrefs } from '@/lib/client-api'

function applyFavicon(url: string | null) {
  const href = url || '/favicon-32x32.png'
  const links = document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="shortcut icon"]')
  if (links.length === 0) {
    const link = document.createElement('link')
    link.rel = 'icon'
    link.href = href
    document.head.appendChild(link)
    return
  }
  links.forEach((link) => { link.href = href })
}

/** Swaps the browser favicon to the user's custom icon (ui-prefs). */
export function FaviconManager() {
  useEffect(() => {
    getUiPrefs().then((p) => applyFavicon(p.faviconUrl)).catch(() => {})
    const onUpdate = (e: Event) => applyFavicon((e as CustomEvent<UiPrefs>).detail.faviconUrl)
    window.addEventListener('ui-prefs-updated', onUpdate)
    return () => window.removeEventListener('ui-prefs-updated', onUpdate)
  }, [])
  return null
}
