'use client'

import { useState, useCallback, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Navigation, Droplets, AlertTriangle, ShieldCheck } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { ResizableLayout } from '@/components/ui/resizable'
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

  return hasMapData ? (
    <ResizableLayout
      className="flex-1 min-h-0 mx-4 sm:mx-6 mt-3"
      left={
        <div className="h-full relative">
          <PropertyMap
            subject={subject!}
            comps={mapComps ?? comps}
            subjectSubdivision={subject?.subdivision}
            selectedCompKeys={selectedCompKeys}
            onToggleComp={onToggleComp}
            onMarkerSelect={onMarkerSelect}
            activeMarkerKey={mapActiveKey}
          />
          {/* Legend — top right */}
          <div className="absolute top-2 right-12 z-10 flex flex-col gap-1 bg-black/50 backdrop-blur-sm rounded px-2.5 py-1.5">
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-[#3b82f6] border-[1.5px] border-white flex-shrink-0" />
              <span className="text-[10px] text-white/80">Subject</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-[#10b981] border-[1.5px] border-white flex-shrink-0" />
              <span className="text-[10px] text-white/80">Included</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-[#6b7280] border-[1.5px] border-white flex-shrink-0" />
              <span className="text-[10px] text-white/80">Excluded</span>
            </div>
          </div>

          {/* Map overlay: risk flags + proximity */}
          {(riskFlags?.length || floodZone || recalcData) && (
            <div className="absolute bottom-0 left-0 right-0 z-10 bg-black/60 backdrop-blur-sm no-print">
              {/* Risk flags row */}
              {(riskFlags?.length || floodZone) ? (
                <div className="px-4 py-2 flex items-center gap-3 overflow-x-auto scrollbar-none whitespace-nowrap border-b border-white/10">
                  {floodZone && (
                    floodZone.inFloodZone ? (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-400">
                        <Droplets className="w-3.5 h-3.5 flex-shrink-0" />
                        Flood Zone{floodZone.zone ? ` ${floodZone.zone}` : ''}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                        <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0" />
                        No Flood Zone
                      </span>
                    )
                  )}
                  {riskFlags?.map((flag, i) => (
                    <span key={i} className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400">
                      <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                      {flag}
                    </span>
                  ))}
                </div>
              ) : null}
              {/* Proximity row */}
              <div className="px-4 py-2 flex items-center justify-between gap-3">
                <div className="flex items-center gap-1.5">
                  <Navigation className="w-3.5 h-3.5 text-white/60" />
                  <span className="text-xs font-medium text-white/70">Traffic / Commercial Adjustments</span>
                  {recalcData && recalcData.valuation.proximityDeduction > 0 && (
                    <span className="text-xs font-medium text-red-400 tabular-nums">
                      −${recalcData.valuation.proximityDeduction.toLocaleString()}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {(['siding', 'backing', 'fronting'] as const).map((pos) => {
                    const label = pos === 'siding' ? 'Side' : pos === 'backing' ? 'Back' : 'Front'
                    const isOn = settingsHook.settings.proximityAdjustments?.[pos] ?? false
                    return (
                      <label key={pos} className="flex items-center gap-1.5 cursor-pointer">
                        <Switch
                          checked={isOn}
                          onCheckedChange={(checked) => {
                            const current = settingsHook.settings.proximityAdjustments ?? { siding: false, backing: false, fronting: false }
                            settingsHook.updateProximityAdjustments({ ...current, [pos]: checked })
                          }}
                          className="scale-90"
                        />
                        <span className={cn('text-xs', isOn ? 'text-white font-medium' : 'text-white/50')}>{label}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      }
      right={
        <div className="min-w-0">
          <div className={cn('flex flex-col gap-4 lg:pl-4 pt-2 pb-4')}>
            {loading ? (
              <>
                <SubjectPropertySkeleton />
                <ComparablesSkeleton />
              </>
            ) : (
              <AnalysisResultLayout
                subject={subject}
                comps={comps}
                valuation={valuation}
                isRecalculated={isRecalculated}
                hideValuation
                selectedCompKeys={selectedCompKeys}
                isManual={isManual}
                onToggleComp={onToggleComp}
                onResetComps={onResetComps}
                settingsHook={settingsHook}
                recalcData={recalcData}
                onOpenSettings={onOpenSettings}
                aiAnalyzing={aiAnalyzing}
                onRunAiAnalysis={onRunAiAnalysis}
                onCompClick={onCompClick}
                onCompHover={handleCompHover}
                highlightedCompKey={activeMarkerKey}
                riskFlags={riskFlags}
                floodZone={floodZone}
                visionAnalysis={visionAnalysis}
                jobId={jobId}
                valuationCardRef={valuationCardRef}
                footer={footer}
              />
            )}
          </div>
        </div>
      }
    />
  ) : (
    <div className="flex-1 min-w-0 p-4 sm:p-6">
      <div className="flex flex-col gap-4 max-w-5xl mx-auto">
        {loading ? (
          <>
            <SubjectPropertySkeleton />
            <ComparablesSkeleton />
          </>
        ) : (
          <AnalysisResultLayout
            subject={subject}
            comps={comps}
            valuation={valuation}
            isRecalculated={isRecalculated}
            selectedCompKeys={selectedCompKeys}
            isManual={isManual}
            onToggleComp={onToggleComp}
            onResetComps={onResetComps}
            settingsHook={settingsHook}
            recalcData={recalcData}
            onOpenSettings={onOpenSettings}
            aiAnalyzing={aiAnalyzing}
            onRunAiAnalysis={onRunAiAnalysis}
            onCompClick={onCompClick}
            onCompHover={handleCompHover}
            riskFlags={riskFlags}
            floodZone={floodZone}
            visionAnalysis={visionAnalysis}
            jobId={jobId}
            valuationCardRef={valuationCardRef}
            footer={footer}
          />
        )}
      </div>
    </div>
  )
}
