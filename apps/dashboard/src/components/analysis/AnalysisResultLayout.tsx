'use client'

import type { OfferWorkflow } from '@/lib/client-api'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { useEvaluation } from '@/hooks/use-evaluation'
import { ComparablesSection, type CompSelectionStats } from './ComparablesSection'
import { DecisionTrail } from './DecisionTrail'
import { DealSummaryHero } from './DealSummaryHero'
import { DealActions } from './DealActions'
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
  /** 'left' = the page draws the valuation box elsewhere (under the map);
   *  this column is then the subject card and the comparables only. */
  valuationPlacement?: 'inline' | 'left'
  /** Extra lines for the subject card (flood and location risks) */
  subjectExtras?: React.ReactNode
  /** What to draw instead of the live evaluation · the page holds the previous results steady during a rerun */
  evaluation?: ReturnType<typeof useEvaluation>
  /** A rerun is streaming in: the held results are dimmed and not clickable */
  refreshing?: boolean
  /** Goes up each time a held rerun finishes · the fresh results animate in on it */
  enterKey?: number
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
  valuationPlacement = 'inline',
  subjectExtras,
  evaluation,
  refreshing = false,
  enterKey = 0,
}: AnalysisResultLayoutProps) {
  const live = useEvaluation()
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
    onPinTier,
    onOpenSettings,
    onCompClick,
    onFeedbackSubmitted,
  } = evaluation ?? live

  const selectedCompKeys = compOverride?.selectedCompKeys
  const isManual = compOverride?.isManual ?? false

  // The comp selection stats ("5 selected · 25 excluded · $241/sf avg · $320k to $410k") are
  // calculated by the comps section for the tier on screen and drawn at the foot of the subject card.
  const [compStats, setCompStats] = useState<CompSelectionStats | null>(null)
  const priceRange = compStats && compStats.priceMin != null && compStats.priceMax != null && compStats.priceMin !== compStats.priceMax
    ? `$${(compStats.priceMin / 1000).toFixed(0)}k to $${(compStats.priceMax / 1000).toFixed(0)}k`
    : null
  const statsNode = compStats ? (
    <div className="whitespace-nowrap text-[11px] tabular-nums text-foreground-tertiary">
      {compStats.selected} selected
      {compStats.excluded > 0 && ` · ${compStats.excluded} excluded`}
      {compStats.avgPsf != null && ` · $${compStats.avgPsf}/sf avg`}
      {priceRange && ` · ${priceRange}`}
    </div>
  ) : null

  return (
    <>
      {/* Subject property */}
      {subject && (
        <SubjectGridCard
          subject={subject}
          isLoading={isStreaming}
          footer={subjectExtras}
          stats={statsNode}
          actions={valuation ? (
            <DealActions
              bare
              offerPrice={valuation.wholesalePrice ?? valuation.buyPrice}
              onOfferWorkflow={onOfferWorkflow}
              onRerun={onRerun}
              rerunning={rerunning}
              onOpenSettings={onOpenSettings}
            />
          ) : null}
        />
      )}

      {/* Valuation panel — sticky so it's always visible while scrolling comps */}
      {valuationPlacement === 'left' ? null : valuation ? (
        <div
          key={enterKey}
          ref={valuationCardRef as React.RefObject<HTMLDivElement>}
          data-pane-sticky
          aria-busy={refreshing}
          className={cn(
            'sticky z-10 top-[calc(3.5rem+var(--sat))] lg:top-0 transition-opacity duration-300',
            refreshing && 'opacity-60 pointer-events-none select-none',
            enterKey > 0 && !refreshing && 'animate-in fade-in duration-300',
          )}
        >
          <DealSummaryHero
            valuation={valuation}
            isRecalculated={isRecalculated}
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
      ) : null}

      {/* Widened-rules warning · shown only when the search had to stretch its rules to look for ARV
          evidence and still found none. Neutral on purpose: it is a note, not an alarm. The plain "no ARV evidence
          in the verified pool" note, with no widening, was removed: it warned about nothing. */}
      {subject && !isStreaming && comps?.insufficientComps === true && (comps?.retrieval?.paramFlex?.extensions ?? 0) > 0 ? (() => {
        return (
          <div data-notice className="border border-border rounded-sm px-4 py-3 bg-secondary/40 text-foreground">
            <div className="text-sm font-semibold">No ARV evidence — rules had to be widened</div>
            <p className="text-xs text-foreground-secondary mt-0.5">
              {comps?.retrieval?.paramFlex?.concessions?.length
                ? `To reach comps we extended ${comps.retrieval.paramFlex.concessions.join(', ')}. `
                : ''}
              Every census-verified comp was evaluated and none carried ARV evidence
              (flip resale, premium over scope median, or above AVM).
              {(valuation?.arvSource === 'avm' || valuation?.arvSource === 'assessed') && valuation?.arv != null && (
                <span className="block mt-1 font-medium text-foreground">
                  ARV is set from the {valuation.arvSource === 'avm' ? 'subject AVM estimate' : 'county value'}, ${valuation.arv.toLocaleString()}.
                  {' '}A conservative estimate until comp evidence exists.
                </span>
              )}
              {comps?.asIsMarketIntel?.asIsMarketPrice != null && (
                <span className="block mt-1 font-medium text-foreground">
                  Investor floor: ${comps.asIsMarketIntel.asIsMarketPrice.toLocaleString()}
                  {' '}({comps.asIsMarketIntel.compCount} distressed + {comps.asIsMarketIntel.flipSaleCount} flip buy(s))
                </span>
              )}
            </p>
          </div>
        )
      })() : null}

      {notesSlot}

      <InvestorAnalysisSummary analysis={valuation?.investorAnalysis} />

      {/* Streaming status — lives near the comps section, not the search bar */}
      {statusLabel && !refreshing && (isStreaming || live.isStreaming) && (
        <div className="flex items-center gap-2 px-1">
          <Loader2 className="w-3 h-3 text-primary animate-spin" />
          <span className="text-caption text-foreground-tertiary">{statusLabel}</span>
        </div>
      )}

      {/* Properties grid (subject + comps) */}
      {comps ? (
        <div className="relative">
        {/* During a rerun the step label floats over the held comps instead of pushing them down */}
        {refreshing && statusLabel && (
          <div role="status" className="absolute left-1/2 top-12 z-10 flex -translate-x-1/2 items-center gap-2 rounded-sm border border-border bg-background px-3 py-1.5 shadow-sm animate-in fade-in duration-300">
            <Loader2 className="w-3 h-3 text-primary animate-spin" />
            <span className="text-caption text-foreground-secondary whitespace-nowrap">{statusLabel}</span>
          </div>
        )}
        <div
          aria-busy={refreshing}
          className={cn('transition-opacity duration-300', refreshing && 'opacity-60 pointer-events-none select-none')}
        >
        <ComparablesSection
          enterKey={enterKey}
          onSelectionStats={setCompStats}
          comps={comps}
          subject={subject}
          subjectSubdivision={subject?.subdivision}
          selectedCompKeys={selectedCompKeys}
          isManual={isManual}
          recalculatedArv={isRecalculated ? valuation?.arv : undefined}
          onToggleComp={onToggleComp}
          onPinTier={onPinTier}
          onReset={onResetComps}
          highlightedCompKey={null}
          onCompClick={onCompClick}
          onCompHover={onCompHover}
          feedbackContext={feedbackContext}
          onFeedbackSubmitted={onFeedbackSubmitted}
        />
        </div>
        </div>
      ) : null}

      {/* Appraisal decision trail — per-comp rule audit */}
      {valuation?.bMechanics?.decisions?.length ? (
        <DecisionTrail decisions={valuation.bMechanics.decisions} />
      ) : null}

      {subject && isStreaming ? (
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
