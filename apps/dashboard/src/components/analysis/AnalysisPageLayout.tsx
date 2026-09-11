'use client'

import { useState, useCallback, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useEvaluation } from '@/hooks/use-evaluation'
import { ResizableLayout } from '@/components/ui/resizable'
import { MapLegend, MapOverlay } from './MapOverlay'
import { PropertyMap } from './PropertyMap'
import { AnalysisResultLayout } from './AnalysisResultLayout'
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
  statusLabel?: string | null

  // Optional footer (e.g. Raw JSON)
  footer?: ReactNode
}

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
}: AnalysisPageLayoutProps) {
  const { subject, displayComps: comps, compOverride } = useEvaluation()
  const selectedCompKeys = compOverride?.selectedCompKeys
  const hasMapData = !!(subject?.latitude && subject?.longitude)

  // ─── Hover state for map↔list sync ──────────────────────────────────
  const [hoveredCompKey, setHoveredCompKey] = useState<string | null>(null)
  const handleCompHover = useCallback((key: string | null) => {
    setHoveredCompKey(key)
  }, [])
  const mapActiveKey = hoveredCompKey ?? activeMarkerKey ?? null

  const resultProps = {
    onCompHover: handleCompHover,
    valuationCardRef,
    statusLabel,
    footer,
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
        <div className="h-full relative">
          <PropertyMap
            subject={subject!}
            comps={mapComps ?? comps}
            selectedCompKeys={selectedCompKeys}
            onMarkerSelect={onMarkerSelect}
            activeMarkerKey={mapActiveKey}
          />
          <MapLegend />
          <MapOverlay riskFlags={riskFlags} floodZone={floodZone} />
        </div>
      }
      right={
        <div className="min-w-0 props-pane">
          <div className={cn('flex flex-col gap-4 lg:pl-4 pt-2 pb-4')}>
            {loading ? loadingSkeleton : (
              <AnalysisResultLayout {...resultProps} />
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
