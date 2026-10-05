'use client'

import { useEffect, type RefObject } from 'react'

/**
 * Paces mouse-wheel scrolling inside the results pane.
 *
 * Reading order first: the first wheel notch lands on the valuation box, the
 * next on the comparables bar. From there each notch is a small, animated
 * step, so dense comp cards glide past instead of jumping. Scrolling back up
 * through those stops reverses the same way. Trackpads and touch are left
 * alone (their deltas are already small and continuous).
 */
export function usePacedWheel(ref: RefObject<HTMLElement | null>, stepPx = 56) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let target: number | null = null
    let frame = 0

    // Landing points, in content order · each is where its element pins.
    // The landing elements are sticky, so their own boxes move once pinned.
    // Their resting positions come from static neighbours: the element above
    // the pinned card, and the comparables section that holds the bar.
    const stops = (): number[] => {
      const pinned = el.querySelector<HTMLElement>('[data-pane-sticky]')
      const bar = el.querySelector<HTMLElement>('[data-comps-anchor]')
      const paneTop = el.getBoundingClientRect().top
      const staticTop = (node: HTMLElement) => node.getBoundingClientRect().top - paneTop + el.scrollTop
      const stickyTop = (node: HTMLElement) => parseFloat(getComputedStyle(node).top) || 0
      let pinnedStop: number | null = null
      const before = pinned?.previousElementSibling as HTMLElement | null
      if (pinned && before) {
        const gap = parseFloat(getComputedStyle(pinned.parentElement!).rowGap) || 0
        pinnedStop = staticTop(before) + before.offsetHeight + gap - stickyTop(pinned)
      }
      const section = bar?.parentElement
      const barStop = bar && section ? staticTop(section) - stickyTop(bar) : null
      return [pinnedStop, barStop].filter((v): v is number => v != null && v > 0).sort((a, b) => a - b)
    }

    // The position we last wrote · if the pane is somewhere else on the next
    // frame, something other than us scrolled it (a marker click, the keys,
    // the scrollbar) and our glide gives way.
    let wrote: number | null = null
    const tick = () => {
      if (target == null) return
      if (wrote != null && Math.abs(el.scrollTop - wrote) > 1.5) { target = null; wrote = null; return }
      const diff = target - el.scrollTop
      if (Math.abs(diff) < 1) { el.scrollTop = target; target = null; wrote = null; return }
      el.scrollTop += diff * 0.2
      wrote = el.scrollTop
      frame = requestAnimationFrame(tick)
    }
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return
      // Trackpads send many small deltas · let them through untouched
      if (Math.abs(event.deltaY) < 40) return
      event.preventDefault()
      const max = el.scrollHeight - el.clientHeight
      const from = target ?? el.scrollTop
      const down = event.deltaY > 0
      const points = stops()
      const last = points[points.length - 1] ?? 0
      let next: number
      if (down) {
        const stop = points.find((s) => s > from + 4)
        next = stop ?? from + stepPx
      } else if (from <= last + 4) {
        // Still inside the reading-order zone · step back to the previous stop
        const stop = [...points].reverse().find((s) => s < from - 4)
        next = stop ?? 0
      } else {
        next = from - stepPx
      }
      target = Math.max(0, Math.min(max, next))
      wrote = null
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(tick)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { el.removeEventListener('wheel', onWheel); cancelAnimationFrame(frame) }
  }, [ref, stepPx])
}
