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
  const [isDragging, setIsDragging] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

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

  const startDrag = useCallback((e?: React.MouseEvent) => {
    e?.preventDefault()
    draggingRef.current = true
    setIsDragging(true)
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
  }, [])

  const stopDrag = useCallback(() => {
    if (!draggingRef.current) return
    draggingRef.current = false
    setIsDragging(false)
    document.body.style.cursor = ""
    document.body.style.userSelect = ""
  }, [])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const pct = ((e.clientX - rect.left) / rect.width) * 100
      setLeftPct(Math.min(MAX_PCT, Math.max(MIN_PCT, pct)))
    }
    const onTouchMove = (e: TouchEvent) => {
      if (!draggingRef.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const pct = ((e.touches[0].clientX - rect.left) / rect.width) * 100
      setLeftPct(Math.min(MAX_PCT, Math.max(MIN_PCT, pct)))
    }

    window.addEventListener("mousemove", onMouseMove)
    window.addEventListener("mouseup", stopDrag)
    window.addEventListener("touchmove", onTouchMove)
    window.addEventListener("touchend", stopDrag)
    return () => {
      window.removeEventListener("mousemove", onMouseMove)
      window.removeEventListener("mouseup", stopDrag)
      window.removeEventListener("touchmove", onTouchMove)
      window.removeEventListener("touchend", stopDrag)
    }
  }, [stopDrag])

  return (
    <div ref={containerRef} className={cn("flex flex-1 min-h-0 relative", className)}>
      {/* Invisible overlay during drag — prevents map canvas from stealing mouse events */}
      {isDragging && (
        <div className="fixed inset-0 z-50" style={{ cursor: "col-resize" }} />
      )}

      {/* Left panel */}
      <div
        className="flex-shrink-0 no-print"
        style={{
          width: `${leftPct}%`,
          pointerEvents: isDragging ? "none" : undefined,
        }}
      >
        {left}
      </div>

      {/* Drag handle */}
      <div
        className="flex-shrink-0 w-2 cursor-col-resize bg-border/40 hover:bg-primary/20 active:bg-primary/40 transition-colors group sticky top-10 self-start h-[calc(100vh-2.5rem)] flex items-center justify-center z-10"
        onMouseDown={startDrag}
        onTouchStart={() => startDrag()}
      >
        <div className="h-10 w-3.5 rounded-sm border bg-muted shadow-sm flex items-center justify-center opacity-50 group-hover:opacity-100 transition-opacity">
          <GripVertical className="h-4 w-4 text-foreground-tertiary" />
        </div>
      </div>

      {/* Right panel */}
      <div
        className="flex-1 min-w-0"
        style={{ pointerEvents: isDragging ? "none" : undefined }}
      >
        {right}
      </div>
    </div>
  )
}
