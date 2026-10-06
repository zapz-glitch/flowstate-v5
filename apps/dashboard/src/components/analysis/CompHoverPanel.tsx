'use client'

import { useEffect, useRef, useState } from 'react'
import { useEvaluation } from '@/hooks/use-evaluation'
import { CompGridCard } from './CompGridCard'
import { StreetViewImage } from './StreetViewImage'
import { Fact, Pair, STAMP } from './property-card-parts'
import { CopyButton } from '@/components/ui/copy-button'
import { cn } from '@/lib/utils'
import type { SubjectData } from './shared-types'
import { formatAddressCasing, formatAreaLine, formatCensusTract, formatLotSize, formatShortDate, getCompKey, subjectStreetViewHref, titleCaseWords } from './format-helpers'
import { onMarkerHover, type MarkerHover } from './map-hover'

const WIDTH = 660
const LEAVE_MS = 320
const FADE_MS = 150
/** A pinned card closes this long after the pointer leaves it */
const PINNED_LEAVE_MS = 160
/** A pinned card also closes when the mouse wanders this far (px) from it without ever entering it */
const PINNED_WANDER_PX = 140
/** A click that opened a pinned card must not count as the tap-away that closes it */
const PINNED_CLICK_GUARD_MS = 150

/** Distance from a point to a rectangle (0 when inside) */
function distanceToRect(x: number, y: number, r: DOMRect): number {
  const dx = Math.max(r.left - x, 0, x - r.right)
  const dy = Math.max(r.top - y, 0, y - r.bottom)
  return Math.hypot(dx, dy)
}

/**
 * Resting on a map marker (the map decides what counts as resting) shows that comp (left)
 * beside the subject (right). The pair stays up while the pointer is on the marker or on either
 * card, so you can move from the marker onto the comp, then across to the subject. It closes only
 * once the pointer is outside both, and fades out as it goes.
 *
 * A click or tap on a marker pins the pair: it stays after the pointer leaves the marker, and goes
 * when the pointer leaves the card, when the person taps anywhere else, or on Escape.
 */
export function CompHoverPanel() {
  const { subject, displayComps: comps, compOverride, onToggleComp, onCompClick } = useEvaluation()
  const [hover, setHover] = useState<MarkerHover | null>(null)
  const [closing, setClosing] = useState(false)
  const hoverRef = useRef<MarkerHover | null>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const overPanel = useRef(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(false)
  const pinnedAt = useRef(0)
  const enteredPinned = useRef(false)
  hoverRef.current = hover

  useEffect(() => {
    const clear = (timer: typeof openTimer) => { if (timer.current) { clearTimeout(timer.current); timer.current = null } }
    const cancelAll = () => {
      clear(openTimer); clear(closeTimer)
      // Back on a marker while the panel is fading out · bring it back
      if (fadeTimer.current) { clearTimeout(fadeTimer.current); fadeTimer.current = null; setClosing(false) }
    }
    const beginClose = () => {
      if (fadeTimer.current) return
      setClosing(true)
      fadeTimer.current = setTimeout(() => {
        fadeTimer.current = null
        pinned.current = false; enteredPinned.current = false
        setHover(null); setClosing(false)
      }, FADE_MS)
    }
    const off = onMarkerHover((next) => {
      // A pinned card ignores hovering: a stray pass over another marker must not swap it
      if (pinned.current && !next?.pinned) return
      cancelAll()
      if (next?.pinned) {
        pinned.current = true; pinnedAt.current = Date.now(); enteredPinned.current = false
        setHover(next)
        return
      }
      if (next) {
        // The map already waited for the pointer to rest on the marker · open now
        setHover(next)
        return
      }
      // Left the marker · give the pointer a moment to reach the cards
      closeTimer.current = setTimeout(() => { closeTimer.current = null; if (hoverRef.current && !overPanel.current) beginClose() }, LEAVE_MS)
    })
    const onPanelEnter = () => { overPanel.current = true; if (pinned.current) enteredPinned.current = true; cancelAll() }
    const onPanelLeave = () => {
      overPanel.current = false
      // A pinned card waits until the pointer has been on it at least once
      if (pinned.current && !enteredPinned.current) return
      closeTimer.current = setTimeout(() => { closeTimer.current = null; if (hoverRef.current) beginClose() }, pinned.current ? PINNED_LEAVE_MS : 160)
    }
    panelHandlers.current = { onPanelEnter, onPanelLeave }

    // Ways out of a pinned card: tap or click anywhere else (a drag is not a tap), Escape, or the
    // mouse wandering well away from it
    const onDocClick = (event: MouseEvent) => {
      if (!pinned.current || !hoverRef.current) return
      if (Date.now() - pinnedAt.current < PINNED_CLICK_GUARD_MS) return
      if (panelRef.current?.contains(event.target as Node)) return
      beginClose()
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && pinned.current && hoverRef.current) beginClose() }
    const onPointerMove = (event: PointerEvent) => {
      if (!pinned.current || !hoverRef.current || event.pointerType !== 'mouse' || enteredPinned.current || closing) return
      const box = panelRef.current?.getBoundingClientRect()
      if (box && distanceToRect(event.clientX, event.clientY, box) > PINNED_WANDER_PX) beginClose()
    }
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointermove', onPointerMove)
    return () => {
      off(); clear(openTimer); clear(closeTimer); clear(fadeTimer)
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointermove', onPointerMove)
    }
  }, [])
  const panelHandlers = useRef<{ onPanelEnter: () => void; onPanelLeave: () => void }>({ onPanelEnter: () => {}, onPanelLeave: () => {} })

  if (!hover || !subject) return null
  const items = comps?.items ?? []
  const index = items.findIndex((comp, i) => getCompKey(comp, i) === hover.compKey)
  if (index < 0) return null
  const comp = items[index]
  const selected = compOverride?.selectedCompKeys
  const isSelected = selected ? selected.has(hover.compKey) : comp.isEnabled === true

  const width = Math.min(WIDTH, window.innerWidth - 24)
  const left = Math.max(12, Math.min(hover.x + 16, window.innerWidth - width - 12))
  const maxHeight = Math.min(560, window.innerHeight - 24)
  const top = Math.max(12, Math.min(hover.y - 80, window.innerHeight - maxHeight - 12))

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Comp beside the subject property"
      className={cn(
        'fixed z-50 grid grid-cols-2 items-stretch gap-2 p-2 rounded-sm border border-border bg-background shadow-2xl overflow-y-auto no-print',
        closing ? 'animate-out fade-out fill-mode-forwards pointer-events-none' : 'animate-in fade-in',
      )}
      style={{ left, top, width, maxHeight, animationDuration: `${FADE_MS}ms` }}
      onMouseEnter={() => panelHandlers.current.onPanelEnter()}
      onMouseLeave={() => panelHandlers.current.onPanelLeave()}
    >
      <CompGridCard
        comp={comp}
        index={index}
        subject={subject}
        isSelectedForArv={isSelected}
        onToggleArv={onToggleComp}
        onCompClick={(c) => { pinned.current = false; enteredPinned.current = false; setHover(null); setClosing(false); onCompClick?.(c) }}
      />
      <SubjectCompareCard subject={subject} />
    </div>
  )
}

/**
 * The subject drawn as a comp card · same component pieces, same rows in the
 * same order, same type — so the two read side by side, line for line. The
 * rows the subject has no value for stay as empty slots so the lines align.
 * Permits and the photo strip stay on the main subject card.
 */
function SubjectCompareCard({ subject }: { subject: SubjectData }) {
  const tract = formatCensusTract(subject.censusTract)
  const area = subject.neighborhoodName || subject.subdivision
  const price = subject.listPrice ?? subject.lastSale?.price ?? null
  // Written like the comp's address: street, city, state · no ZIP
  const street = subject.address ? formatAddressCasing(subject.address.replace(/\s+\d{5}(-\d{4})?$/, '')) : null
  const zillowUrl = subject.address
    ? subject.listingUrl ?? `https://www.zillow.com/homes/${encodeURIComponent(subject.address)}_rb/`
    : null
  const perSqft = price != null && subject.squareFeet ? `$${Math.round(price / subject.squareFeet)}/sf` : null
  // Same empty line the comp card fills with "136 sf smaller" and the like
  const NO_DELTA = '\u00a0'
  const streetViewUrl = subjectStreetViewHref(subject)
  const photo = (
    <StreetViewImage
      photos={subject.photos}
      address={subject.address}
      latitude={subject.latitude}
      longitude={subject.longitude}
      width={640}
      height={427}
      className="w-full h-full object-cover"
    />
  )
  return (
    <div className="relative isolate flex h-full flex-col border border-border rounded-sm overflow-hidden">
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] z-10 pointer-events-none bg-blue-500" />
      <div className="relative aspect-[2/1] flex-shrink-0 bg-muted/30 overflow-hidden">
        {/* Clicking the photo opens Street View in a new tab, like the comp card beside it */}
        {streetViewUrl ? (
          <a href={streetViewUrl} target="_blank" rel="noopener noreferrer" className="block h-full w-full" title="Open Street View">
            {photo}
          </a>
        ) : photo}
        <div className="absolute top-2 left-2.5 flex flex-wrap items-center gap-1 pointer-events-none">
          <div data-stamp="subject" className={cn(STAMP, 'bg-blue-600 text-white')}>SUBJECT</div>
        </div>
      </div>
      <div className="flex flex-1 flex-col pl-3.5 pr-3 py-2.5 text-[11px]">
        {/* Address (Zillow link + copy) left, price right */}
        <div className="flex items-baseline justify-between gap-2">
          <div className="min-w-0 flex items-center gap-1">
            {street && zillowUrl ? (
              <a
                href={zillowUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-body-sm font-semibold text-foreground truncate rounded px-0.5 -mx-0.5 transition-colors hover:text-foreground hover:bg-secondary active:scale-[0.98]"
                title={`${subject.address} · open on Zillow`}
              >
                {street}
              </a>
            ) : (
              <span className="text-body-sm font-semibold text-foreground truncate">{street ?? 'Unknown'}</span>
            )}
            {subject.address && <CopyButton text={subject.address} title="Copy address" className="flex-shrink-0" />}
          </div>
          <span className="text-sm font-bold text-foreground tabular-nums flex-shrink-0">
            {price != null ? `$${price.toLocaleString()}` : '-'}
          </span>
        </div>

        {/* Area name left, what the price is right */}
        <div className="flex items-center justify-between gap-2 mt-0.5">
          <span className="text-foreground-tertiary truncate">{formatAreaLine(subject.censusBlockGroup, area) ?? (tract ? `Tract ${tract}` : '')}</span>
          <span className="font-medium flex-shrink-0 text-foreground-secondary">{subject.listPrice != null ? 'List price' : price != null ? 'Last sale' : ''}</span>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1.5">
          <Pair label="Condition" value={subject.condition || 'NA'} title={subject.conditionSummary ?? undefined} />
        </div>

        {perSqft && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
            <span className="text-foreground-tertiary tabular-nums">{perSqft}</span>
          </div>
        )}

        {/* Property facts · the same six rows as the comp card, pinned to the bottom */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-auto pt-2 border-t border-border/60">
          <Fact label="Bed/Bath" value={`${subject.bedrooms ?? '-'}/${subject.bathrooms ?? '-'}`} />
          <Fact label="Sq Ft" value={subject.squareFeet?.toLocaleString() || '-'} delta={NO_DELTA} />
          <Fact label="Year" value={subject.yearBuilt ?? '-'} delta={NO_DELTA} />
          <Fact label="Lot" value={formatLotSize(subject.lotSizeAcres)} delta={NO_DELTA} />
          <Fact label="Style" value={(subject as { buildingStyle?: string | null }).buildingStyle || '-'} valueClass="capitalize" />
          <Fact label="Sold" value={subject.lastSale?.date ? formatShortDate(subject.lastSale.date) : '-'} />
        </div>
      </div>
    </div>
  )
}
