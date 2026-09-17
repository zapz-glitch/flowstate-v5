'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useTheme } from '@/components/theme-provider'

// SEO Engine console — the flowstate-seo-engine admin UI served from
// insights.flowstate.homes, embedded inside the dashboard shell.
// Admin auth is the engine's own SEO_ADMIN_KEY cookie (SameSite=None;Secure),
// so the operator signs in once inside the frame. The frame follows the
// dashboard theme via ?theme= and postMessage sync.
const SEO_CONSOLE_URL =
  process.env.NEXT_PUBLIC_SEO_CONSOLE_URL ?? 'https://insights.flowstate.homes/admin/seo'

export default function SeoPage() {
  const { theme } = useTheme()
  const frameRef = useRef<HTMLIFrameElement>(null)
  const mode = theme === 'night' || theme === 'dawn' ? 'dark' : 'light'

  // src is fixed at mount; later theme changes go through postMessage so the
  // frame doesn't reload.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const src = useMemo(() => `${SEO_CONSOLE_URL}?theme=${mode}`, [])

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(
      { type: 'flowstate-theme', theme: mode },
      new URL(SEO_CONSOLE_URL).origin,
    )
  }, [mode])

  return (
    <div className="flex flex-col h-[calc(100dvh-4rem)] -m-4 sm:-m-6">
      <iframe
        ref={frameRef}
        src={src}
        title="SEO Engine"
        className="flex-1 w-full border-0 bg-background"
      />
    </div>
  )
}
