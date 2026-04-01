'use client'

import { Loader2 } from 'lucide-react'
import type { SubjectData, ValuationData, CompsData, CompItem } from './shared-types'
import { ComparablesSection } from './ComparablesSection'
import { DealSummaryHero } from './DealSummaryHero'
import { SubjectGridCard } from './SubjectGridCard'
import { PhotoGallery } from './PhotoGallery'
import { VisionAnalysisButton } from './VisionAnalysisButton'

// ─── Analysis Result Layout ──────────────────────────────────────────────────

export interface AnalysisResultLayoutProps {
  subject: SubjectData | null | undefined
  comps: CompsData | null | undefined
  valuation: ValuationData | undefined
  isRecalculated: boolean

  // Comp selection
  selectedCompKeys?: Set<string>
  isManual?: boolean
  onToggleComp: (key: string) => void
  onResetComps: () => void

  // Settings
  onOpenSettings: () => void

  // AI
  aiAnalyzing?: boolean

  // Map interaction
  highlightedCompKey?: string | null

  // Comparison dialog
  onCompClick?: (comp: CompItem) => void

  // Map-list hover sync
  onCompHover?: (key: string | null) => void

  // Vision analysis
  visionAnalysis?: unknown

  // Valuation card ref for sticky/intersection observer
  valuationCardRef?: React.RefObject<HTMLDivElement | null>

  // Optional footer (e.g. Raw JSON toggle)
  footer?: React.ReactNode
}

export function AnalysisResultLayout({
  subject,
  comps,
  valuation,
  isRecalculated,
  selectedCompKeys,
  isManual = false,
  onToggleComp,
  onResetComps,
  onOpenSettings,
  aiAnalyzing = false,
  highlightedCompKey,
  onCompClick,
  onCompHover,
  visionAnalysis,
  valuationCardRef,
  footer,
}: AnalysisResultLayoutProps) {
  return (
    <>
      {/* Subject property */}
      {subject && <SubjectGridCard subject={subject} />}

      {/* Valuation panel — sticky so it's always visible while scrolling comps */}
      {valuation && (
        <div ref={valuationCardRef as React.RefObject<HTMLDivElement>} className="sticky top-0 z-10">
          <DealSummaryHero
            valuation={valuation}
            isRecalculated={isRecalculated}
            onOpenSettings={onOpenSettings}
          />
        </div>
      )}

      {/* AI analysis banner */}
      {aiAnalyzing && (
        <div className="border border-primary/20 bg-primary/5 px-4 py-3 flex items-center gap-3">
          <Loader2 className="w-4 h-4 text-primary animate-spin flex-shrink-0" />
          <span className="text-body-sm text-foreground-secondary">AI analysis in progress — comp selection may update</span>
        </div>
      )}

      {/* Properties grid (subject + comps) */}
      {comps && (
        <ComparablesSection
          comps={comps}
          subject={subject}
          subjectSubdivision={subject?.subdivision}
          selectedCompKeys={selectedCompKeys}
          isManual={isManual}
          arv={valuation?.arv}
          arvThresholdPercent={valuation?.asIsMarketIntel?.thresholdPercent}
          recalculatedArv={isRecalculated ? valuation?.arv : undefined}
          onToggleComp={onToggleComp}
          onReset={onResetComps}
          highlightedCompKey={highlightedCompKey}
          isAnalyzing={aiAnalyzing}
          onCompClick={onCompClick}
          onCompHover={onCompHover}
        />
      )}

      {/* Photos */}
      {subject?.photos && subject.photos.length > 0 && (
        <div className="border border-border px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-caption font-medium text-foreground-secondary">Property Photos</span>
            <VisionAnalysisButton
              photoUrls={subject.photos}
              propertyContext={{
                address: subject.address,
                squareFeet: subject.squareFeet ?? undefined,
                yearBuilt: subject.yearBuilt ?? undefined,
              }}
              existingAnalysis={visionAnalysis as import('./shared-types').VisionAnalysis | null | undefined}
            />
          </div>
          <PhotoGallery photos={subject.photos} />
        </div>
      )}

      {footer}
    </>
  )
}
