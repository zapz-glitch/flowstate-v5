'use client'

import { useEffect, type RefObject } from 'react'

/** One scroll stop per row of comp cards: the position that puts the row flush
 *  under the pinned bar. `cardTops` are the cards' top edges in content
 *  coordinates; cards in the same grid row share a top. */
export function rowStopsFor(cardTops: number[], lane: number): number[] {
  const stops: number[] = []
  let previous = -Infinity
  for (const top of [...cardTops].sort((a, b) => a - b)) {
    if (top - previous > 4) stops.push(top - lane)
    previous = top
  }
  return stops
}

/** Sort the stops, drop empty and non-positive ones, and drop any within
 *  `minGap` px of the one before, so a notch never moves a sliver. */
export function mergeStops(raw: Array<number | null | undefined>, minGap = 40): number[] {
  const merged: number[] = []
  for (const stop of raw.filter((v): v is number => v != null && v > 0).sort((a, b) => a - b)) {
    if (merged.length === 0 || stop - merged[merged.length - 1] > minGap) merged.push(stop)
  }
  return merged
}

/** Where one wheel notch lands: the next stop, or a small step past the last. */
export function nextWheelTarget({ points, from, down, stepPx, max }: {
  points: number[]; from: number; down: boolean; stepPx: number; max: number
}): number {
  const last = points[points.length - 1] ?? 0
  let next: number
  if (down) {
    next = points.find((s) => s > from + 4) ?? from + stepPx
  } else if (from <= last + 4) {
    // Still inside the stops (valuation, bar, comp rows) · back to the previous stop
    next = [...points].reverse().find((s) => s < from - 4) ?? 0
  } else {
    next = from - stepPx
  }
  return Math.max(0, Math.min(max, next))
}

/**
 * Paces mouse-wheel scrolling inside the results pane.
 *
 * Reading order first: the first wheel notch lands on the valuation box, the
 * next on the comparables bar. From there every notch jumps to the next row
 * of comp cards, flush under the comparables bar, and every notch up jumps
 * back one row. Past the last row (decision trail and the like) each notch is
 * a small, animated step. Trackpads and touch are left alone (their deltas
 * are already small and continuous).
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

      // One stop per row of comp cards, flush under the pinned bar
      let rowStops: number[] = []
      if (bar && section) {
        const lane = stickyTop(bar) + bar.offsetHeight + (parseFloat(getComputedStyle(bar).marginBottom) || 0)
        const tops = [...section.querySelectorAll<HTMLElement>('[data-card-key]')]
          .filter((card) => card.offsetParent !== null)
          .map(staticTop)
        rowStops = rowStopsFor(tops, lane)
      }

      // The bar stop already shows the first row (under the rules line and the
      // bar), so the first row needs no stop of its own.
      if (barStop != null) rowStops.shift()

      return mergeStops([pinnedStop, barStop, ...rowStops])
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
      // Ease out, but never less than a whole pixel per frame · the browser
      // rounds scroll positions, so a smaller step is dropped and the glide
      // would stall a pixel or two short of its target.
      const step = diff * 0.2
      el.scrollTop += Math.abs(step) < 1 ? Math.sign(diff) : step
      wrote = el.scrollTop
      frame = requestAnimationFrame(tick)
    }
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return
      // Trackpads send many small deltas · let them through untouched
      if (Math.abs(event.deltaY) < 40) return
      event.preventDefault()
      const max = el.scrollHeight - el.clientHeight
      target = nextWheelTarget({
        points: stops(),
        from: target ?? el.scrollTop,
        down: event.deltaY > 0,
        stepPx,
        max,
      })
      wrote = null
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(tick)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { el.removeEventListener('wheel', onWheel); cancelAnimationFrame(frame) }
  }, [ref, stepPx])
}
