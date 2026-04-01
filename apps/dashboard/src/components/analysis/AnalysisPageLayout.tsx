'use client'

import { useState, useCallback, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { ResizableLayout } from '@/components/ui/resizable'
import { MapLegend, MapOverlay } from './MapOverlay'
import { PropertyMap } from './PropertyMap'
import { AnalysisResultLayout } from './AnalysisResultLayout'
import {
  SubjectPropertySkeleton,
  ComparablesSkeleton,
} from './AnalysisSkeletons'
import type { SubjectData, ValuationData, CompsData, CompItem } from './shared-types'
import type { UseReportSettingsReturn } from '@/hooks/use-report-settings'
import type { RecalcResult } from '@/lib/recalc'

export interface AnalysisPageLayoutProps {
  // Data
  subject: SubjectData | null | undefined
  comps: CompsData | null | undefined
  valuation: ValuationData | undefined
  isRecalculated: boolean

  // Map
  mapComps?: CompsData | null | undefined
  selectedCompKeys?: Set<string>
  onToggleComp: (key: string) => void
  onResetComps: () => void
  onMarkerSelect: (type: 'subject' | 'comp', compKey?: string) => void
  activeMarkerKey?: string | null
  isManual?: boolean

  // Settings
  settingsHook: UseReportSettingsReturn
  recalcData: RecalcResult | null
  onOpenSettings: () => void

  // AI
  aiAnalyzing?: boolean
  onRunAiAnalysis?: () => void

  // Risk
  riskFlags?: string[] | null
  floodZone?: { zone?: string | null; inFloodZone?: boolean | null } | null
  visionAnalysis?: unknown

  // Report
  jobId?: string | null
  valuationCardRef?: React.RefObject<HTMLDivElement | null>

  // Comparison dialog
  onCompClick?: (comp: CompItem) => void

  // Loading state
  loading?: boolean

  // Optional footer (e.g. Raw JSON)
  footer?: ReactNode
}

export function AnalysisPageLayout({
  subject,
  comps,
  valuation,
  isRecalculated,
  mapComps,
  selectedCompKeys,
  onToggleComp,
  onResetComps,
  onMarkerSelect,
  activeMarkerKey,
  isManual = false,
  settingsHook,
  recalcData,
  onOpenSettings,
  aiAnalyzing = false,
  onRunAiAnalysis,
  riskFlags,
  floodZone,
  visionAnalysis,
  jobId,
  valuationCardRef,
  onCompClick,
  loading = false,
  footer,
}: AnalysisPageLayoutProps) {
  const hasMapData = !!(subject?.latitude && subject?.longitude)

  // ─── Hover state for map↔list sync ──────────────────────────────────
  const [hoveredCompKey, setHoveredCompKey] = useState<string | null>(null)
  const handleCompHover = useCallback((key: string | null) => {
    setHoveredCompKey(key)
  }, [])
  // Merge: hover takes priority (transient), then click (persistent)
  const mapActiveKey = hoveredCompKey ?? activeMarkerKey ?? null

  // Shared props for AnalysisResultLayout (used in both map and no-map branches)
  const resultProps = {
    subject,
    comps,
    valuation,
    isRecalculated,
    selectedCompKeys,
    isManual,
    onToggleComp,
    onResetComps,
    onOpenSettings,
    aiAnalyzing,
    onRunAiAnalysis,
    onCompClick,
    onCompHover: handleCompHover,
    visionAnalysis,
    valuationCardRef,
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
          <MapOverlay riskFlags={riskFlags} floodZone={floodZone} recalcData={recalcData} settingsHook={settingsHook} />
        </div>
      }
      right={
        <div className="min-w-0">
          <div className={cn('flex flex-col gap-4 lg:pl-4 pt-2 pb-4')}>
            {loading ? loadingSkeleton : (
              <AnalysisResultLayout {...resultProps} highlightedCompKey={activeMarkerKey} />
            )}
          </div>
        </div>
      }
    />
  ) : (
    <div className="flex-1 min-w-0 p-4 sm:p-6">
      <div className="flex flex-col gap-4 max-w-5xl mx-auto">
        {loading ? loadingSkeleton : <AnalysisResultLayout {...resultProps} />}
      </div>
    </div>
  )
}
