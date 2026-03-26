"use client"

import { useState, useCallback, useRef, useEffect, type ReactNode } from "react"
import { GripVertical } from "lucide-react"
import { cn } from "@/lib/utils"

const STORAGE_KEY = "flowstate-panel-width"
const DEFAULT_PCT = 42
const MIN_PCT = 25
const MAX_PCT = 55

interface ResizableLayoutProps {
  left: ReactNode
  right: ReactNode
  className?: string
}

export function ResizableLayout({ left, right, className }: ResizableLayoutProps) {
  const [leftPct, setLeftPct] = useState(DEFAULT_PCT)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  // Load persisted width
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const v = parseFloat(saved)
        if (v >= MIN_PCT && v <= MAX_PCT) setLeftPct(v)
      }
    } catch { /* ignore */ }
  }, [])

  // Save on change
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, String(Math.round(leftPct))) } catch { /* ignore */ }
  }, [leftPct])

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
  }, [])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const pct = ((e.clientX - rect.left) / rect.width) * 100
      setLeftPct(Math.min(MAX_PCT, Math.max(MIN_PCT, pct)))
    }
    const onMouseUp = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
    }
    const onTouchMove = (e: TouchEvent) => {
      if (!dragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const pct = ((e.touches[0].clientX - rect.left) / rect.width) * 100
      setLeftPct(Math.min(MAX_PCT, Math.max(MIN_PCT, pct)))
    }

    window.addEventListener("mousemove", onMouseMove)
    window.addEventListener("mouseup", onMouseUp)
    window.addEventListener("touchmove", onTouchMove)
    window.addEventListener("touchend", onMouseUp)
    return () => {
      window.removeEventListener("mousemove", onMouseMove)
      window.removeEventListener("mouseup", onMouseUp)
      window.removeEventListener("touchmove", onTouchMove)
      window.removeEventListener("touchend", onMouseUp)
    }
  }, [])

  return (
    <div ref={containerRef} className={cn("flex flex-1 min-h-0", className)}>
      {/* Left panel */}
      <div className="flex-shrink-0 no-print" style={{ width: `${leftPct}%` }}>
        {left}
      </div>

      {/* Drag handle */}
      <div
        className="flex-shrink-0 w-2 cursor-col-resize bg-border/40 hover:bg-primary/20 active:bg-primary/40 transition-colors flex items-center justify-center group"
        onMouseDown={onMouseDown}
        onTouchStart={() => { dragging.current = true }}
      >
        <div className="h-8 w-3.5 rounded-sm border bg-muted shadow-sm flex items-center justify-center opacity-60 group-hover:opacity-100 transition-opacity">
          <GripVertical className="h-3 w-3 text-foreground-tertiary" />
        </div>
      </div>

      {/* Right panel */}
      <div className="flex-1 min-w-0 overflow-auto">
        {right}
      </div>
    </div>
  )
}

// Keep these exports for backward compat but they're unused now
export const ResizablePanelGroup = () => null
export const ResizablePanel = () => null
export const ResizableHandle = () => null
