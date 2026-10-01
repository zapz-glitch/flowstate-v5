'use client'

import type { OfferWorkflow } from '@/lib/client-api'
import { Loader2 } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { useEvaluation } from '@/hooks/use-evaluation'
import { ComparablesSection } from './ComparablesSection'
import { DealSummaryHero } from './DealSummaryHero'
import { SubjectGridCard } from './SubjectGridCard'
import { InvestorAnalysisSummary } from './InvestorAnalysisSummary'

// ─── Analysis Result Layout ──────────────────────────────────────────────────

export interface AnalysisResultLayoutProps {
  /** Map-list hover sync (local to map view, not in atoms) */
  onCompHover?: (key: string | null) => void
  /** Valuation card ref for sticky/intersection observer */
  valuationCardRef?: React.RefObject<HTMLDivElement | null>
  /** Streaming step label — rendered near the comparables section */
  statusLabel?: React.ReactNode
  /** Optional footer (e.g. Raw JSON toggle) */
  footer?: React.ReactNode
  /** Realtor-notes card — rendered between the deal hero and analysis readouts */
  notesSlot?: React.ReactNode
  /** Re-run the analysis for the current property */
  onRerun?: () => void
  /** True while a rerun is in flight */
  rerunning?: boolean
  /** Fire an offer workflow — returns the outcome the hero flashes */
  onOfferWorkflow?: (workflow: OfferWorkflow, offerPrice?: number) => Promise<{ ok: boolean }>
  /** Prior session disposition — hero renders a dated warning chip */
  disposition?: { workflow: OfferWorkflow; at: number } | null
}

export function AnalysisResultLayout({
  onCompHover,
  valuationCardRef,
  statusLabel,
  footer,
  notesSlot,
  onRerun,
  rerunning,
  onOfferWorkflow,
  disposition,
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
            onRerun={onRerun}
            rerunning={rerunning}
            onOfferWorkflow={onOfferWorkflow}
            disposition={disposition}
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
      ) : subject && !isStreaming && comps?.insufficientComps === true ? (
        /* Insufficient comps — the run completed with no valuation. The comp
           pool and its geo stamps still render below. */
        <div className="border border-amber-500/30 bg-amber-500/5 rounded-sm px-4 py-3">
          <div className="text-sm font-semibold text-amber-500">Insufficient comps</div>
          <p className="text-xs text-foreground-secondary mt-0.5">
            No comparables qualified under the appraisal rules, so no ARV or offer math was produced.
            The evaluated pool and per-comp test results are below — widen the rules or pick a nearby market and rerun.
          </p>
        </div>
      ) : null}

      {notesSlot}

      <InvestorAnalysisSummary analysis={valuation?.investorAnalysis} />

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
