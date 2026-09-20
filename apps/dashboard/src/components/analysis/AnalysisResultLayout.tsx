'use client'

import { Loader2 } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { useEvaluation } from '@/hooks/use-evaluation'
import { ComparablesSection } from './ComparablesSection'
import { DealSummaryHero } from './DealSummaryHero'
import { SubjectGridCard } from './SubjectGridCard'
import { InvestorAnalysisSummary } from './InvestorAnalysisSummary'
import { JevOutcomeCard } from './JevOutcomeCard'
import { JevShadowValuationCard } from './JevShadowValuationCard'

// ─── Analysis Result Layout ──────────────────────────────────────────────────

export interface AnalysisResultLayoutProps {
  /** Map-list hover sync (local to map view, not in atoms) */
  onCompHover?: (key: string | null) => void
  /** Valuation card ref for sticky/intersection observer */
  valuationCardRef?: React.RefObject<HTMLDivElement | null>
  /** Streaming step label — rendered near the comparables section */
  statusLabel?: string | null
  /** Optional footer (e.g. Raw JSON toggle) */
  footer?: React.ReactNode
}

export function AnalysisResultLayout({
  onCompHover,
  valuationCardRef,
  statusLabel,
  footer,
}: AnalysisResultLayoutProps) {
  const {
    subject,
    displayValuation: valuation,
    displayComps: comps,
    isRecalculated,
    compOverride,
    feedbackContext,
    isStreaming,
    onToggleComp,
    onResetComps,
    onOpenSettings,
    onCompClick,
    onFeedbackSubmitted,
    jevOutcome,
    jevCompClassification,
  } = useEvaluation()

  const selectedCompKeys = compOverride?.selectedCompKeys
  const isManual = compOverride?.isManual ?? false

  return (
    <>
      {/* Subject property */}
      {subject && <SubjectGridCard subject={subject} isLoading={isStreaming} />}

      {/* Valuation panel — sticky so it's always visible while scrolling comps */}
      {valuation ? (
        <div ref={valuationCardRef as React.RefObject<HTMLDivElement>} className="sticky z-10 top-[calc(3.5rem+var(--sat))] lg:top-0">
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

      <InvestorAnalysisSummary analysis={valuation?.investorAnalysis} />

      <JevOutcomeCard outcome={jevOutcome} />

      <JevShadowValuationCard run={jevCompClassification} />

      {/* Streaming status — lives near the comps section, not the search bar */}
      {statusLabel && isStreaming && (
        <div className="flex items-center gap-2 px-1">
          <Loader2 className="w-3 h-3 text-primary animate-spin" />
          <span className="text-caption text-foreground-tertiary">{statusLabel}</span>
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
          onCompClick={onCompClick}
          onCompHover={onCompHover}
          feedbackContext={feedbackContext}
          onFeedbackSubmitted={onFeedbackSubmitted}
        />
      ) : subject && isStreaming ? (
        /* Comps loading skeleton — only while streaming */
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Loader2 className="w-3 h-3 text-primary animate-spin" />
            <span className="text-caption text-foreground-tertiary">{statusLabel ?? 'Loading comparables...'}</span>
          </div>
          <div className="comps-grid">
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

      {footer}
    </>
  )
}
