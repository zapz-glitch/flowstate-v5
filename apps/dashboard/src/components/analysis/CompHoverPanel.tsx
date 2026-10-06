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
/** Rest on a marker this long before the panel opens · sweeping across markers must not open it */
const OPEN_MS = 140
/** Once the panel is up, moving to another marker swaps after this short pause */
const SWAP_MS = 60
const FADE_MS = 150

/**
 * Resting on a map marker shows that comp (left) beside the subject (right).
 * The pair stays up while the pointer is on the marker or on either card, so
 * you can move from the marker onto the comp, then across to the subject. It
 * closes only once the pointer is outside both, and fades out as it goes.
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
  hoverRef.current = hover

  useEffect(() => {
    const clear = (timer: typeof openTimer) => { if (timer.current) { clearTimeout(timer.current); timer.current = null } }
    const cancelAll = () => {
      clear(openTimer); clear(closeTimer)
      // Back on a marker while the panel is fading out · bring it back
      if (fadeTimer.current) { clearTimeout(fadeTimer.current); fadeTimer.current = null; setClosing(false) }
    }
    const beginClose = () => {
      setClosing(true)
      fadeTimer.current = setTimeout(() => { fadeTimer.current = null; setHover(null); setClosing(false) }, FADE_MS)
    }
    const off = onMarkerHover((next) => {
      cancelAll()
      if (next) {
        openTimer.current = setTimeout(() => { openTimer.current = null; setHover(next) }, hoverRef.current ? SWAP_MS : OPEN_MS)
        return
      }
      // Left the marker · give the pointer a moment to reach the cards
      closeTimer.current = setTimeout(() => { closeTimer.current = null; if (hoverRef.current && !overPanel.current) beginClose() }, LEAVE_MS)
    })
    const onPanelEnter = () => { overPanel.current = true; cancelAll() }
    const onPanelLeave = () => {
      overPanel.current = false
      closeTimer.current = setTimeout(() => { closeTimer.current = null; if (hoverRef.current) beginClose() }, 160)
    }
    panelHandlers.current = { onPanelEnter, onPanelLeave }
    return () => { off(); clear(openTimer); clear(closeTimer); clear(fadeTimer) }
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
        onCompClick={(c) => { setHover(null); setClosing(false); onCompClick?.(c) }}
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
          <div className={cn(STAMP, 'bg-blue-600 text-white')}>SUBJECT</div>
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
