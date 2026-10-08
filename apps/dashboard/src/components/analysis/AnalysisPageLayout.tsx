'use client'

import type { OfferWorkflow } from '@/lib/client-api'
import { isValidCoordinate } from '@/lib/property-map-geometry'

import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useEvaluation } from '@/hooks/use-evaluation'
import { useHeldDuringRerun } from '@/hooks/use-held-during-rerun'
import { ResizableLayout } from '@/components/ui/resizable'
import { RiskLine } from './MapOverlay'
import { CompHoverPanel } from './CompHoverPanel'
import { PropertyMap } from './PropertyMap'
import { AnalysisResultLayout } from './AnalysisResultLayout'
import type { RerunStatus } from './DealActions'
import { DealSummaryHero } from './DealSummaryHero'
import {
  SubjectPropertySkeleton,
  ComparablesSkeleton,
} from './AnalysisSkeletons'
import type { CompsData } from './shared-types'

export interface AnalysisPageLayoutProps {
  // Map-specific (not in atoms — only used when map is visible)
  mapComps?: CompsData | null | undefined
  onMarkerSelect: (type: 'subject' | 'comp', compKey?: string) => void
  activeMarkerKey?: string | null

  // Risk (map overlay only)
  riskFlags?: string[] | null
  floodZone?: { zone?: string | null; inFloodZone?: boolean | null } | null

  // Pass-through to AnalysisResultLayout
  valuationCardRef?: React.RefObject<HTMLDivElement | null>

  // Loading state
  loading?: boolean

  /** Current streaming step label — shown near the comparables section */
  statusLabel?: ReactNode

  // Optional footer (e.g. Raw JSON)
  footer?: ReactNode

  /** Realtor-notes card — rendered between the deal hero and analysis readouts */
  notesSlot?: ReactNode

  /** Re-run the analysis for the current property */
  onRerun?: () => void
  /** True while a rerun is in flight */
  rerunning?: boolean
  /** Live stage line for the rerun control */
  rerunStatus?: RerunStatus | null
  /**
   * True from the click of a run until its last result has landed · the page's own run state, which
   * moves in the same step as the results. The steady hold keys on this: the evaluation atom's
   * streaming flag lags a render behind, and that one-render gap used to release the hold and
   * re-freeze half-loaded data.
   */
  busy?: boolean
  /** Fire an offer workflow — returns the outcome the hero flashes */
  onOfferWorkflow?: (workflow: OfferWorkflow, offerPrice?: number) => Promise<{ ok: boolean }>
  /** Prior session disposition — hero renders a dated warning chip */
  disposition?: { workflow: OfferWorkflow; at: number } | null
}

const VALUATION_HEIGHT_KEY = 'flowstate-valuation-height'
const VALUATION_MIN = 96
const MAP_MIN = 220

export function AnalysisPageLayout({
  mapComps,
  onMarkerSelect,
  activeMarkerKey,
  riskFlags,
  floodZone,
  valuationCardRef,
  loading = false,
  statusLabel,
  footer,
  notesSlot,
  onRerun,
  rerunning,
  rerunStatus,
  busy,
  onOfferWorkflow,
  disposition,
}: AnalysisPageLayoutProps) {
  // While a rerun streams in, keep what is on screen steady (dimmed, not clickable) and bring the
  // fresh results in together at the end · a first run, with nothing on screen yet, still builds up live.
  const live = useEvaluation()
  const held = useHeldDuringRerun(live, busy ?? (!!rerunning || live.isStreaming), !!live.displayValuation)
  const refreshing = held.holding
  const { subject, displayComps: comps, compOverride, displayValuation: valuation, isRecalculated } = held.value
  const selectedCompKeys = compOverride?.selectedCompKeys
  const hasMapData = isValidCoordinate({ lat: subject?.latitude, lng: subject?.longitude })

  // ─── Hover state for map↔list sync ──────────────────────────────────
  const [hoveredCompKey, setHoveredCompKey] = useState<string | null>(null)
  const handleCompHover = useCallback((key: string | null) => {
    setHoveredCompKey(key)
  }, [])
  const mapActiveKey = hoveredCompKey ?? activeMarkerKey ?? null

  // ─── Valuation box height · drag the bar above it to give the map more room ──
  const leftColumn = useRef<HTMLDivElement>(null)
  const [valuationHeight, setValuationHeight] = useState<number | null>(null)
  useEffect(() => {
    const saved = Number(localStorage.getItem(VALUATION_HEIGHT_KEY))
    if (saved > 0) setValuationHeight(saved)
  }, [])
  const startValuationDrag = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    const column = leftColumn.current
    if (!column) return
    const move = (e: MouseEvent) => {
      const rect = column.getBoundingClientRect()
      // Keep every valuation row readable, and leave the map a usable height
      const next = Math.round(Math.max(VALUATION_MIN, Math.min(rect.bottom - e.clientY, rect.height - MAP_MIN)))
      setValuationHeight(next)
      try { localStorage.setItem(VALUATION_HEIGHT_KEY, String(next)) } catch { /* private mode */ }
    }
    const stop = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', stop); document.body.style.cursor = '' }
    document.body.style.cursor = 'row-resize'
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', stop)
  }, [])

  const resultProps = {
    subjectExtras: <RiskLine riskFlags={riskFlags} floodZone={floodZone} />,
    onCompHover: handleCompHover,
    valuationCardRef,
    statusLabel,
    footer,
    notesSlot,
    onRerun,
    rerunning,
    rerunStatus,
    onOfferWorkflow,
    disposition,
    evaluation: held.value,
    refreshing,
    enterKey: held.generation,
  }

  const loadingSkeleton = (
    <>
      <SubjectPropertySkeleton />
      <ComparablesSkeleton />
    </>
  )

  return hasMapData ? (
    <ResizableLayout
      className="flex-1 min-h-0 mx-4 sm:mx-6 mt-3"
      left={
        <div ref={leftColumn} className="h-full relative flex flex-col">
          {/* Map on top, reaching right down to the valuation box · both stay
              put while the comps scroll on the right */}
          <div className="relative flex-1 min-h-0 flex flex-col">
            <PropertyMap
              subject={subject!}
              comps={refreshing ? comps : (mapComps ?? comps)}
              selectedCompKeys={selectedCompKeys}
              onMarkerSelect={onMarkerSelect}
              activeMarkerKey={mapActiveKey}
            />
          </div>
          {!loading && valuation && (
            <>
              {/* Drag bar · pull down to shrink the valuation box, up to grow it */}
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize the valuation box"
                title="Drag to resize the valuation box"
                onMouseDown={startValuationDrag}
                onDoubleClick={() => { setValuationHeight(null); try { localStorage.removeItem(VALUATION_HEIGHT_KEY) } catch { /* private mode */ } }}
                className="hidden lg:flex flex-shrink-0 h-2 cursor-row-resize items-center justify-center group no-print"
              >
                <span className="h-0.5 w-10 rounded-full bg-border group-hover:bg-foreground/30 transition-colors" />
              </div>
              <div
                key={held.generation}
                ref={valuationCardRef as React.RefObject<HTMLDivElement>}
                aria-busy={refreshing}
                className={cn(
                  'flex-shrink-0 overflow-y-auto max-h-[60%] transition-opacity duration-300',
                  refreshing && 'opacity-60 pointer-events-none select-none',
                  held.generation > 0 && !refreshing && 'animate-in fade-in duration-300',
                )}
                style={{ containerType: 'inline-size', height: valuationHeight ?? undefined }}
              >
                <DealSummaryHero
                  valuation={valuation}
                  isRecalculated={isRecalculated}
                  disposition={disposition}
                />
              </div>
            </>
          )}
          <CompHoverPanel />
        </div>
      }
      right={
        <div className="min-w-0 props-pane">
          <div className={cn('flex flex-col gap-4 lg:pl-4 pt-2 pb-4')}>
            {loading ? loadingSkeleton : (
              <AnalysisResultLayout {...resultProps} valuationPlacement="left" />
            )}
          </div>
        </div>
      }
    />
  ) : (
    <div className="flex-1 min-w-0 p-4 sm:p-6">
      <div className="flex flex-col gap-4 max-w-5xl mx-auto props-pane">
        {loading ? loadingSkeleton : <AnalysisResultLayout {...resultProps} />}
      </div>
    </div>
  )
}
