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
      ) : null}

      {/* Insufficient-comps disclosure — renders whether or not a valuation
          exists (AVM-anchored runs show the hero AND this note). */}
      {subject && !isStreaming && comps?.insufficientComps === true ? (() => {
        /* Thin-pocket disclosure — the param-flex ladder stretched numeric
           tolerances (geo stayed required) hunting ARV evidence. Green =
           strict pass, yellow = extended once or twice, red = deeper. */
        const extensions = comps?.retrieval?.paramFlex?.extensions ?? 0
        const factor = comps?.retrieval?.paramFlex?.factor ?? 1
        const tone = extensions === 0 ? 'text-emerald-500 border-emerald-500/30 bg-emerald-500/5'
          : extensions <= 2 ? 'text-amber-500 border-amber-500/30 bg-amber-500/5'
          : 'text-red-400 border-red-400/30 bg-red-400/5'
        return (
          <div className={`border rounded-sm px-4 py-3 ${tone}`}>
            <div className="text-sm font-semibold">
              {extensions === 0
                ? 'No ARV evidence in the verified pool'
                : 'No ARV evidence — rules had to be widened'}
            </div>
            <p className="text-xs text-foreground-secondary mt-0.5">
              {comps?.retrieval?.paramFlex?.concessions?.length
                ? `To reach comps we extended ${comps.retrieval.paramFlex.concessions.join(', ')}. `
                : ''}
              Every census-verified comp was evaluated and none carried ARV evidence
              (flip resale, premium over scope median, or above AVM).
              {(valuation?.arvSource === 'avm' || valuation?.arvSource === 'assessed') && valuation?.arv != null && (
                <span className="block mt-1 font-medium text-foreground">
                  Valuation is anchored on the {valuation.arvSource === 'avm' ? 'subject AVM' : 'county assessment'} — ${valuation.arv.toLocaleString()}
                  {' '}— a conservative estimate until comp evidence exists.
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

      {/* Param-flex disclosure on successful runs — how far the rules
          stretched to admit ARV evidence (geo stayed required). */}
      {subject && !isStreaming && comps?.insufficientComps !== true && comps?.retrieval?.paramFlex != null && (() => {
        const { extensions, factor } = comps.retrieval.paramFlex
        const tone = extensions === 0 ? 'text-emerald-500 border-emerald-500/30'
          : extensions <= 2 ? 'text-amber-500 border-amber-500/30'
          : 'text-red-400 border-red-400/30'
        return (
          <div className={`inline-flex border rounded-sm px-2 py-1 text-[10px] font-semibold ${tone}`}>
            {extensions === 0
              ? 'Comps qualified on strict rules'
              : comps?.retrieval?.paramFlex?.concessions?.length
                ? `Comp rules widened: ${comps.retrieval.paramFlex.concessions.join('; ')}`
                : `Comp rules extended ${extensions}× (to ×${factor})`}
          </div>
        )
      })()}

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
