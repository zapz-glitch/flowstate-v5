'use client'

import { useEffect, useMemo, useRef } from 'react'
import { ExternalLink } from 'lucide-react'
import { useTheme } from '@/components/theme-provider'

// SEO Engine console — the flowstate-seo-engine admin UI served from
// insights.flowstate.homes, embedded inside the dashboard shell. The frame
// follows the dashboard theme via ?theme= + postMessage sync. The engine's
// own admin gate is disabled — the dashboard's auth is the boundary.
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
    <div className="flex flex-col h-[calc(100dvh-6rem)] space-y-4 animate-in fade-in duration-500">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2">
        <div className="space-y-1">
          <h1 className="text-heading-lg text-foreground tracking-tight">SEO Engine</h1>
          <p className="text-body text-foreground-tertiary">
            Autonomous SEO pipeline — opportunities, content, experiments, and agent runs.
          </p>
        </div>
        <a
          href={SEO_CONSOLE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-body-sm text-foreground-tertiary hover:text-foreground transition-colors"
        >
          Open full console <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      <div className="flex-1 min-h-0 rounded-xl border border-border overflow-hidden bg-card">
        <iframe
          ref={frameRef}
          src={src}
          title="SEO Engine"
          className="h-full w-full border-0"
        />
      </div>
    </div>
  )
}
