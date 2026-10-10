'use client'

import { useEffect, useRef, useState } from 'react'
import { useEvaluation } from '@/hooks/use-evaluation'

/**
 * Counts seconds while the evaluation streams, then freezes on the final
 * total — the way ChatGPT's thinking clock does. Shows nothing until the
 * first run of the session starts; the frozen total stays until the next
 * run resets it.
 */
export function EvalTimer({ className }: { className?: string }) {
  const streaming = useEvaluation().isStreaming
  const [elapsed, setElapsed] = useState<number | null>(null)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (!streaming) return
    const start = Date.now()
    setElapsed(0)
    const id = setInterval(() => {
      if (mounted.current) setElapsed(Math.floor((Date.now() - start) / 1000))
    }, 250)
    return () => clearInterval(id)
  }, [streaming])

  if (elapsed == null) return null
  return (
    <span className={className ?? 'text-[10px] font-mono tabular-nums text-foreground-tertiary'}>
      {elapsed}s
    </span>
  )
}
