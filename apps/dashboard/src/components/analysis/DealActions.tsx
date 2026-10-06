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

interface DealActionsProps {
  /** The price an offer goes out at · wholesale, else buy price */
  offerPrice?: number | null
  /** Fire an offer workflow — returns the outcome the strip flashes. */
  onOfferWorkflow?: (workflow: OfferWorkflow, offerPrice?: number) => Promise<{ ok: boolean }>
  /** Re-run the analysis for this property (fresh data, cache bypassed) */
  onRerun?: () => void
  /** True while a rerun is in flight */
  rerunning?: boolean
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
export function DealActions({ offerPrice, onOfferWorkflow, onRerun, rerunning, onOpenSettings, bare = false, className }: DealActionsProps) {
  // Offer-button state machine: idle (buttons) → busy → done (result
  // chip) → back to idle. Everything crossfades via animate-in/fade-in.
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
      <div className="flex items-center gap-1">
        {onOfferWorkflow && (
          offerPhase === 'idle' ? (
            <div key="offer-buttons" className="flex items-center gap-1 animate-in fade-in duration-300">
              <button
                type="button"
                onClick={() => fireOffer('prep_offer')}
                disabled={!canOffer}
                className={cn(ACTION, 'hover:text-emerald-600 hover:bg-emerald-500/10 dark:hover:text-emerald-400 disabled:opacity-40')}
                title={canOffer ? `Prep offer at $${fmtK(offerPrice)}` : 'Valuation incomplete — no offer price'}
              >
                Prep offer
              </button>
              <button
                type="button"
                onClick={() => fireOffer('no_margin')}
                className={cn(ACTION, ACTION_HOVER)}
                title="No margin — records the decline and notifies the listener"
              >
                No margin
              </button>
              <button
                type="button"
                onClick={() => fireOffer('no_offer')}
                className={cn(ACTION, ACTION_HOVER)}
                title="No offer — decline without an offer and notify the listener"
              >
                No offer
              </button>
            </div>
          ) : offerPhase === 'busy' ? (
            <span key="offer-busy" className="px-2 py-0.5 text-[11px] text-foreground-tertiary whitespace-nowrap animate-in fade-in duration-300">
              Dispatching…
            </span>
          ) : (
            <span
              key="offer-done"
              className={cn(
                'px-2 py-0.5 text-[11px] font-medium whitespace-nowrap animate-in fade-in duration-300',
                offerOutcome?.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400',
              )}
            >
              {offerOutcome?.ok ? 'Success' : 'Fail'}
            </span>
          )
        )}
      </div>
      {onOfferWorkflow && (onRerun || onOpenSettings) && <span className={DIVIDER} aria-hidden />}
      <div className="flex flex-wrap items-center justify-end gap-1">
        {onRerun && (
          <button
            type="button"
            onClick={onRerun}
            disabled={rerunning}
            className={cn(ACTION, ACTION_HOVER, 'disabled:opacity-50')}
            title="Re-run this analysis with fresh data"
          >
            {rerunning ? 'Running…' : 'Re-run'}
          </button>
        )}
        {onRerun && onOpenSettings && <span className={DIVIDER} aria-hidden />}
        {onOpenSettings && (
          <button type="button" onClick={onOpenSettings} className={cn(ACTION, ACTION_HOVER)}>
            Evaluation Settings
          </button>
        )}
      </div>
    </div>
  )
}
