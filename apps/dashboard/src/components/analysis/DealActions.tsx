'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { OfferWorkflow } from '@/lib/client-api'
import { formatMoneyThousands as fmtK } from './valuation-number'

/** A plain word, same pill as the comp tier row */
const ACTION = 'text-[11px] px-1.5 py-0.5 rounded whitespace-nowrap text-foreground-tertiary transition-colors'
const ACTION_HOVER = 'hover:text-foreground hover:bg-secondary'
/** Thin line between action groups · the same mark as between Investor and Report */
const DIVIDER = 'w-px h-3 bg-border mx-0.5 flex-shrink-0'

/** One compact status line for the rerun control — stage text + progress hint */
export interface RerunStatus {
  text: string
  tone?: 'progress' | 'done' | 'error'
}

interface DealActionsProps {
  /** The price an offer goes out at · wholesale, else buy price */
  offerPrice?: number | null
  /** Fire an offer workflow — returns the outcome the strip flashes. */
  onOfferWorkflow?: (workflow: OfferWorkflow, offerPrice?: number) => Promise<{ ok: boolean }>
  /** Re-run the analysis for this property (fresh data, cache bypassed) */
  onRerun?: () => void
  /** True while a rerun is in flight */
  rerunning?: boolean
  /** Live stage line for the rerun ("Pulling comps · 3/6"), or a brief Done/Failed */
  rerunStatus?: RerunStatus | null
  onOpenSettings?: () => void
  /** No border or padding of its own · it sits in a strip with other content */
  bare?: boolean
  className?: string
}

/**
 * What you can do with the deal, in one horizontal row at the right of the subject
 * card's foot: decide (prep offer, no margin, no offer), then tools (re-run,
 * evaluation settings), set apart by a thin line.
 */
export function DealActions({ offerPrice, onOfferWorkflow, onRerun, rerunning, rerunStatus, onOpenSettings, bare = false, className }: DealActionsProps) {
  // Offer-button state machine: idle (buttons) → busy → done (result
  // chip) → back to idle. The result fades in over the buttons' own space.
  // Both workflows dispatch immediately — no price editing.
  const [offerPhase, setOfferPhase] = useState<'idle' | 'busy' | 'done'>('idle')
  const [offerOutcome, setOfferOutcome] = useState<{ ok: boolean } | null>(null)
  const canOffer = offerPrice != null && offerPrice > 0

  const fireOffer = async (workflow: OfferWorkflow) => {
    if (!onOfferWorkflow || offerPhase !== 'idle') return
    setOfferPhase('busy')
    try {
      setOfferOutcome(await onOfferWorkflow(workflow))
    } catch {
      setOfferOutcome({ ok: false })
    }
    setOfferPhase('done')
    setTimeout(() => {
      setOfferPhase('idle')
      setOfferOutcome(null)
    }, 3500)
  }

  if (!onOfferWorkflow && !onRerun && !onOpenSettings) return null

  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-end gap-x-1 gap-y-0.5 no-print',
        !bare && 'border-t border-border/60 px-3 py-1',
        className,
      )}
    >
      {onOfferWorkflow && (
        // The three buttons always hold their place; "Dispatching…" and "Success" are laid over them in
        // the same cell, so the row never changes width or moves its neighbors while an offer goes out.
        <div className="grid items-center">
          <div
            className={cn(
              'col-start-1 row-start-1 flex items-center gap-1 transition-opacity duration-300',
              offerPhase !== 'idle' && 'opacity-0 pointer-events-none',
            )}
            aria-hidden={offerPhase !== 'idle'}
            inert={offerPhase !== 'idle'}
          >
            <button
              type="button"
              onClick={() => fireOffer('prep_offer')}
              data-deal="prep"
              disabled={!canOffer}
              className={cn(ACTION, 'hover:text-emerald-600 hover:bg-emerald-500/10 dark:hover:text-emerald-400 disabled:opacity-40')}
              title={canOffer ? `Prep offer at $${fmtK(offerPrice)}` : 'Valuation incomplete — no offer price'}
            >
              Prep offer
            </button>
            <span className={DIVIDER} aria-hidden />
            <button
              type="button"
              onClick={() => fireOffer('no_margin')}
              data-deal="decline"
              className={cn(ACTION, ACTION_HOVER)}
              title="No margin — records the decline and notifies the listener"
            >
              No margin
            </button>
            <span className={DIVIDER} aria-hidden />
            <button
              type="button"
              onClick={() => fireOffer('no_offer')}
              data-deal="decline"
              className={cn(ACTION, ACTION_HOVER)}
              title="No offer — decline without an offer and notify the listener"
            >
              No offer
            </button>
          </div>
          {offerPhase !== 'idle' && (
            <span
              key={offerPhase}
              role="status"
              className={cn(
                'col-start-1 row-start-1 justify-self-center whitespace-nowrap text-[11px] animate-in fade-in duration-300',
                offerPhase === 'busy' ? 'text-foreground-tertiary' : cn('font-medium', offerOutcome?.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'),
              )}
            >
              {offerPhase === 'busy' ? 'Dispatching…' : offerOutcome?.ok ? 'Success' : 'Fail'}
            </span>
          )}
        </div>
      )}
      {onOfferWorkflow && (onRerun || onOpenSettings) && <span className={DIVIDER} aria-hidden />}
      <div className="flex flex-wrap items-center justify-end gap-1">
        {rerunStatus && (
          <span
            role="status"
            className={cn(
              'text-[11px] whitespace-nowrap truncate max-w-[10rem]',
              rerunStatus.tone === 'done'
                ? 'text-emerald-600 dark:text-emerald-400'
                : rerunStatus.tone === 'error'
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-foreground-tertiary',
            )}
          >
            {rerunStatus.text}
          </span>
        )}
        {onRerun && (
          <button
            type="button"
            onClick={onRerun}
            data-deal="tool"
            disabled={rerunning}
            className={cn(ACTION, ACTION_HOVER, 'disabled:opacity-50')}
            title="Re-run this analysis with fresh data"
          >
            {/* Both words share one cell, so "Re-run" and "Running…" take the same width and nothing moves */}
            <span className="grid">
              <span className="invisible col-start-1 row-start-1" aria-hidden>Running…</span>
              <span className="col-start-1 row-start-1">{rerunning ? 'Running…' : 'Re-run'}</span>
            </span>
          </button>
        )}
        {onRerun && onOpenSettings && <span className={DIVIDER} aria-hidden />}
        {onOpenSettings && (
          <button type="button" onClick={onOpenSettings} data-deal="tool" className={cn(ACTION, ACTION_HOVER)}>
            Evaluation Settings
          </button>
        )}
      </div>
    </div>
  )
}
