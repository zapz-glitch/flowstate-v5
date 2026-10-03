'use client'

import { useMemo, useCallback, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import type { SubjectData, CompItem } from './shared-types'
import { CompCard } from './CompCard'
import { SubjectGridCard } from './SubjectGridCard'
import { getCompKey } from './format-helpers'
import { isValidCoordinate } from '@/lib/property-map-geometry'

const MapInner = dynamic(() => import('./PropertyMapInner'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[400px] rounded-lg bg-secondary/30 flex items-center justify-center text-foreground-tertiary text-body-sm">
      Loading map…
    </div>
  ),
})

export interface MapMarker {
  lat: number
  lng: number
  type: 'subject' | 'comp-arv' | 'comp-market' | 'comp-floor' | 'comp-disabled'
  label: string
  /** Comp key for toggling ARV selection (comp markers only) */
  compKey?: string
}

interface PropertyMapProps {
  subject?: SubjectData | null
  comps?: { items?: CompItem[] } | null
  /** Manual comp selection keys — when provided, overrides comp.isEnabled */
  selectedCompKeys?: Set<string>
  /** Called when a marker is clicked — parent scrolls to the corresponding card */
  onMarkerSelect?: (type: 'subject' | 'comp', compKey?: string) => void
  /** Currently highlighted marker key ('subject' or a comp key) */
  activeMarkerKey?: string | null
}

export function PropertyMap({ subject, comps, selectedCompKeys, onMarkerSelect, activeMarkerKey }: PropertyMapProps) {
  const markers = useMemo(() => {
    const m: MapMarker[] = []

    // Subject property
    if (subject && isValidCoordinate({ lat: subject.latitude, lng: subject.longitude })) {
      m.push({
        lat: subject.latitude!,
        lng: subject.longitude!,
        type: 'subject',
        label: subject.address ?? 'Subject Property',
      })
    }

    // Comps
    if (comps?.items) {
      for (let i = 0; i < comps.items.length; i++) {
        const comp = comps.items[i]
        if (isValidCoordinate({ lat: comp.latitude, lng: comp.longitude })) {
          const compKey = getCompKey(comp, i)
          const enabled = selectedCompKeys ? selectedCompKeys.has(compKey) : comp.isEnabled !== false
          // Marker color = evidence class, not enabled state — green = ARV
          // evidence, orange = market/median, red = investor floor.
          const cls = comp.classification?.type
          m.push({
            lat: comp.latitude!,
            lng: comp.longitude!,
            type: !enabled ? 'comp-disabled'
              : cls === 'after_renovation' ? 'comp-arv'
              : cls === 'as_is' ? 'comp-floor'
              : 'comp-market',
            label: comp.address ?? 'Comparable',
            compKey,
          })
        }
      }
    }

    return m
  }, [subject, comps, selectedCompKeys])

  const handleMarkerClick = useCallback((markerType: 'subject' | 'comp', compKey?: string) => {
    onMarkerSelect?.(markerType, compKey)
  }, [onMarkerSelect])

  // Marker hover → the SAME card that opens on click, overlaid on the map
  // (subject card for the subject marker, CompCard for comps — the card
  // itself is untouched). 250ms grace to move onto the card; it leaves
  // shortly after the pointer does.
  const compByKey = useMemo(() => {
    const map = new Map<string, { comp: CompItem; index: number }>()
    comps?.items?.forEach((comp, i) => map.set(getCompKey(comp, i), { comp, index: i }))
    return map
  }, [comps])

  const [hoveredComp, setHoveredComp] = useState<{ comp: CompItem; index: number } | null>(null)
  const [hoveredSubject, setHoveredSubject] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelHide = useCallback(() => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null }
  }, [])
  const scheduleHide = useCallback((ms = 250) => {
    cancelHide()
    hideTimer.current = setTimeout(() => { setHoveredComp(null); setHoveredSubject(false) }, ms)
  }, [cancelHide])

  const handleMarkerHover = useCallback((marker: MapMarker | null) => {
    if (!marker) { scheduleHide(); return }
    cancelHide()
    if (marker.type === 'subject') { setHoveredSubject(true); setHoveredComp(null); return }
    const hit = marker.compKey ? compByKey.get(marker.compKey) : undefined
    setHoveredComp(hit ?? null)
    setHoveredSubject(false)
  }, [compByKey, cancelHide, scheduleHide])

  if (!markers.some(marker => marker.type === 'subject')) return null

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
    <MapInner
      key={`${subject?.address}|${subject?.latitude}|${subject?.longitude}`}
      markers={markers}
      onMarkerClick={handleMarkerClick}
      onMarkerHover={handleMarkerHover}
      activeMarkerKey={activeMarkerKey}
    />
      {(hoveredComp || hoveredSubject) && (
        <div
          className="absolute left-2 top-2 z-20 w-[22rem] max-h-[85%] overflow-y-auto rounded-lg border border-border bg-background/95 shadow-xl backdrop-blur-sm"
          onMouseEnter={cancelHide}
          onMouseLeave={() => scheduleHide(150)}
        >
          {hoveredSubject && subject && <SubjectGridCard subject={subject} />}
          {hoveredComp && <CompCard comp={hoveredComp.comp} index={hoveredComp.index} subject={subject ?? undefined} isExpanded />}
        </div>
      )}
    </div>
  )
}
