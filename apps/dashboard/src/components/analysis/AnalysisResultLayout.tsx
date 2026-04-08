'use client'

import { useState } from 'react'
import { Loader2, ChevronDown, ChevronRight, TrendingUp, BrainCircuit } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { useEvaluation } from '@/hooks/use-evaluation'
import { ComparablesSection } from './ComparablesSection'
import { DealSummaryHero } from './DealSummaryHero'
import { MarketContextCard } from './MarketContextCard'
import { SubjectGridCard } from './SubjectGridCard'
import { PhotoGallery } from './PhotoGallery'

// ─── Analysis Result Layout ──────────────────────────────────────────────────

export interface AnalysisResultLayoutProps {
  /** Map-list hover sync (local to map view, not in atoms) */
  onCompHover?: (key: string | null) => void
  /** Valuation card ref for sticky/intersection observer */
  valuationCardRef?: React.RefObject<HTMLDivElement | null>
  /** Optional footer (e.g. Raw JSON toggle) */
  footer?: React.ReactNode
}

export function AnalysisResultLayout({
  onCompHover,
  valuationCardRef,
  footer,
}: AnalysisResultLayoutProps) {
  const {
    subject,
    displayValuation: valuation,
    displayComps: comps,
    isRecalculated,
    compOverride,
    marketContext,
    aiReport,
    aiAnalyzing,
    isStreaming,
    onToggleComp,
    onResetComps,
    onOpenSettings,
    onCompClick,
    onRunAiAnalysis,
  } = useEvaluation()

  const selectedCompKeys = compOverride?.selectedCompKeys
  const isManual = compOverride?.isManual ?? false
  const [marketOpen, setMarketOpen] = useState(false)

  return (
    <>
      {/* Subject property */}
      {subject && <SubjectGridCard subject={subject} />}

      {/* Valuation panel — sticky so it's always visible while scrolling comps */}
      {valuation ? (
        <div ref={valuationCardRef as React.RefObject<HTMLDivElement>} className="sticky top-0 z-10">
          <DealSummaryHero
            valuation={valuation}
            isRecalculated={isRecalculated}
            onOpenSettings={onOpenSettings}
          />
        </div>
      ) : subject && isStreaming ? (
        /* Valuation loading skeleton — only while streaming */
        <div className="border border-border rounded-sm">
          <div className="px-3 py-1.5 border-b border-border/30 flex items-center gap-2">
            <Loader2 className="w-3 h-3 text-primary animate-spin" />
            <span className="text-[10px] text-foreground-tertiary">Evaluating comparables...</span>
          </div>
          <div className="grid grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="px-3 py-2.5 border-r border-border/20 last:border-r-0">
                <Skeleton className="h-2.5 w-10 mb-1.5" />
                <Skeleton className="h-5 w-16" />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Market Research — collapsed by default */}
      {marketContext && (
        <div className="border border-border rounded-sm overflow-hidden">
          <button
            type="button"
            onClick={() => setMarketOpen(!marketOpen)}
            className="w-full px-4 py-2.5 flex items-center gap-2 hover:bg-secondary/30 transition-colors"
          >
            <TrendingUp className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
            <span className="text-[10px] font-semibold text-foreground-tertiary uppercase tracking-wider flex-1 text-left">Market Research</span>
            {marketOpen
              ? <ChevronDown className="w-3.5 h-3.5 text-foreground-tertiary" />
              : <ChevronRight className="w-3.5 h-3.5 text-foreground-tertiary" />
            }
          </button>
          {marketOpen && (
            <div className="border-t border-border/30">
              <MarketContextCard data={marketContext} />
            </div>
          )}
        </div>
      )}

      {/* AI analysis banner */}
      {aiAnalyzing && (
        <div className="border border-primary/20 bg-primary/5 px-4 py-3 flex items-center gap-3">
          <Loader2 className="w-4 h-4 text-primary animate-spin flex-shrink-0" />
          <span className="text-body-sm text-foreground-secondary">AI analysis in progress — comp selection may update</span>
        </div>
      )}

      {/* AI analysis report — shows after AI completes */}
      {aiReport && !aiAnalyzing && (
        <div className="border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 rounded-sm">
          <div className="flex items-center gap-2 mb-1">
            <BrainCircuit className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0" />
            <span className="text-[10px] font-semibold text-emerald-600 uppercase tracking-wider">AI Comp Selection</span>
            <span className="text-[9px] text-foreground-tertiary ml-auto">{aiReport.model}</span>
          </div>
          <p className="text-body-sm text-foreground-secondary">{aiReport.summary}</p>
          <div className="text-[10px] text-foreground-tertiary mt-1">
            {aiReport.selected} of {aiReport.total} comps selected for ARV
          </div>
        </div>
      )}

      {/* Properties grid (subject + comps) */}
      {comps ? (
        <ComparablesSection
          comps={comps}
          subject={subject}
          subjectSubdivision={subject?.subdivision}
          selectedCompKeys={selectedCompKeys}
          isManual={isManual}
          recalculatedArv={isRecalculated ? valuation?.arv : undefined}
          onToggleComp={onToggleComp}
          onReset={onResetComps}
          highlightedCompKey={null}
          isAnalyzing={aiAnalyzing}
          onRunAiAnalysis={onRunAiAnalysis}
          onCompClick={onCompClick}
          onCompHover={onCompHover}
        />
      ) : subject && isStreaming ? (
        /* Comps loading skeleton — only while streaming */
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Loader2 className="w-3 h-3 text-primary animate-spin" />
            <span className="text-caption text-foreground-tertiary">Loading comparables...</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="border border-border rounded-sm overflow-hidden">
                <Skeleton className="h-28 w-full rounded-none" />
                <div className="px-3 py-2.5 space-y-2">
                  <Skeleton className="h-3 w-3/4" />
                  <div className="grid grid-cols-2 gap-1">
                    {Array.from({ length: 4 }).map((_, j) => (
                      <div key={j} className="flex justify-between">
                        <Skeleton className="h-2.5 w-10" />
                        <Skeleton className="h-2.5 w-8" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Photos */}
      {subject?.photos && subject.photos.length > 0 && (
        <div className="border border-border px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-caption font-medium text-foreground-secondary">Property Photos</span>
          </div>
          <PhotoGallery photos={subject.photos} />
        </div>
      )}

      {footer}
    </>
  )
}
