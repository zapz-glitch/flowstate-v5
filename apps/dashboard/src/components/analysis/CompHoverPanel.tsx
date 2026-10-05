'use client'

import { useEffect, useRef, useState } from 'react'
import { useEvaluation } from '@/hooks/use-evaluation'
import { CompGridCard } from './CompGridCard'
import { StreetViewImage } from './StreetViewImage'
import type { SubjectData } from './shared-types'
import { formatAddressCasing, formatCensusTract, formatLotSize, getCompKey, titleCaseWords } from './format-helpers'
import { onMarkerHover, type MarkerHover } from './map-hover'

const WIDTH = 660
const LEAVE_MS = 320

/**
 * Resting on a map marker shows that comp (left) beside the subject (right).
 * The pair stays up while the pointer is on the marker or on either card, so
 * you can move from the marker onto the comp, then across to the subject. It
 * closes only once the pointer is outside both.
 */
export function CompHoverPanel() {
  const { subject, displayComps: comps, compOverride, onToggleComp, onCompClick } = useEvaluation()
  const [hover, setHover] = useState<MarkerHover | null>(null)
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null)
  const overPanel = useRef(false)

  useEffect(() => {
    const cancel = () => { if (closing.current) { clearTimeout(closing.current); closing.current = null } }
    const off = onMarkerHover((next) => {
      cancel()
      if (next) { setHover(next); return }
      // Left the marker · give the pointer a moment to reach the cards
      closing.current = setTimeout(() => { if (!overPanel.current) setHover(null) }, LEAVE_MS)
    })
    return () => { off(); cancel() }
  }, [])

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
      className="fixed z-50 grid grid-cols-2 items-start gap-2 p-2 rounded-sm border border-border bg-background shadow-2xl overflow-y-auto animate-in fade-in duration-150 no-print"
      style={{ left, top, width, maxHeight }}
      onMouseEnter={() => { overPanel.current = true; if (closing.current) { clearTimeout(closing.current); closing.current = null } }}
      onMouseLeave={() => { overPanel.current = false; closing.current = setTimeout(() => setHover(null), 160) }}
    >
      <CompGridCard
        comp={comp}
        index={index}
        subject={subject}
        isSelectedForArv={isSelected}
        onToggleArv={onToggleComp}
        onCompClick={(c) => { setHover(null); onCompClick?.(c) }}
      />
      <SubjectCompareCard subject={subject} />
    </div>
  )
}

/** One fact row · the same markup the comp card uses */
function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0 flex items-baseline justify-between gap-2">
      <span className="text-foreground-tertiary flex-shrink-0">{label}</span>
      <span className="font-medium tabular-nums truncate capitalize">{value}</span>
    </div>
  )
}

/**
 * The subject drawn as a comp card — same photo, same rows, same type — so
 * the two read side by side, line for line. Permits and the photo strip
 * stay on the main subject card.
 */
function SubjectCompareCard({ subject }: { subject: SubjectData }) {
  const tract = formatCensusTract(subject.censusTract)
  const area = subject.neighborhoodName || subject.subdivision
  const price = subject.listPrice ?? subject.lastSale?.price ?? null
  return (
    <div className="relative isolate border border-border rounded-sm overflow-hidden">
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] z-10 pointer-events-none bg-blue-500" />
      <div className="relative aspect-[2/1] bg-muted/30 overflow-hidden">
        <StreetViewImage
          photos={subject.photos}
          address={subject.address}
          latitude={subject.latitude}
          longitude={subject.longitude}
          width={640}
          height={427}
          className="w-full h-full object-cover"
        />
        <div className="absolute top-2 left-2.5 pointer-events-none">
          <div className="h-[22px] px-1.5 rounded-sm flex items-center text-[11px] font-bold tracking-wide shadow-sm bg-blue-600 text-white">SUBJECT</div>
        </div>
      </div>
      <div className="pl-3.5 pr-3 py-2.5 text-[11px]">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-body-sm font-semibold text-foreground truncate" title={subject.address || undefined}>
            {subject.address ? formatAddressCasing(subject.address) : 'Unknown'}
          </span>
          <span className="text-sm font-bold text-foreground tabular-nums flex-shrink-0">
            {price != null ? `$${price.toLocaleString()}` : '-'}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2 mt-0.5">
          <span className="text-foreground-tertiary truncate">{area ? titleCaseWords(area) : tract ? `Tract ${tract}` : ''}</span>
          <span className="font-medium flex-shrink-0 text-foreground-secondary">{subject.listPrice != null ? 'List price' : price != null ? 'Last sale' : ''}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1.5">
          <span className="whitespace-nowrap">
            <span className="text-foreground-tertiary">Condition</span>{' '}
            <span className="font-medium text-foreground">{subject.condition || 'NA'}</span>
          </span>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2 pt-2 border-t border-border/60">
          <Fact label="Bed/Bath" value={`${subject.bedrooms ?? '-'}/${subject.bathrooms ?? '-'}`} />
          <Fact label="Sq Ft" value={subject.squareFeet?.toLocaleString() || '-'} />
          <Fact label="Year" value={subject.yearBuilt ?? '-'} />
          <Fact label="Lot" value={formatLotSize(subject.lotSizeAcres)} />
          <Fact label="Style" value={(subject as { buildingStyle?: string | null }).buildingStyle || '-'} />
          <Fact label="Tract" value={tract ?? '-'} />
        </div>
      </div>
    </div>
  )
}
