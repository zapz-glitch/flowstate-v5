'use client'

import { useAnalysisBridge } from '@/hooks/use-analysis-bridge'

/**
 * Invisible component that bridges SSE/polling hooks into Jotai atoms.
 * Must be rendered exactly once in the layout tree.
 */
export function AnalysisBridge() {
  useAnalysisBridge()
  return null
}
