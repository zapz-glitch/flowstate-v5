'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { OfferWorkflow } from '@/lib/client-api'
import { useEvaluation } from '@/hooks/use-evaluation'
import type { ValuationData } from './shared-types'
import { formatValuationNumber as fmt, formatMoneyThousands as fmtK } from './valuation-number'
import { formatHeadlineMoney } from './headline-money'

interface DealSummaryHeroProps {
  valuation: ValuationData
  isRecalculated?: boolean
  /** Prior disposition this session — renders a dated warning chip */
  disposition?: { workflow: OfferWorkflow; at: number } | null
}

export function DealSummaryHero({ valuation, isRecalculated, disposition }: DealSummaryHeroProps) {
  const { arvOverride, onArvOverride, subject } = useEvaluation()

  // Inline ARV edit — click the value, type a new ARV, Enter/blur commits
  // (auto-recalcs + autosaves via the settings → recalc pipeline).
  const [arvEditing, setArvEditing] = useState(false)
  const [arvDraft, setArvDraft] = useState('')

  // Named floor source · shown only for a floor-grade result whose source the
  // server named in a form we recognise; otherwise nothing is claimed.
  // The displayed-ARV source wins; then the server's own source string, matched
  // from its start so "median+50% AVM uplift" reads Median, not AVM.
  const bSource = valuation.bMechanics?.source ?? ''
  const floorSource = valuation.resultGrade !== 'floor' ? null
    : valuation.arvSource === 'avm' || /^T3 AVM floor/i.test(bSource) ? 'AVM estimate'
    : valuation.arvSource === 'assessed' || /^T4 assessed/i.test(bSource) ? 'County value'
    : /^median/i.test(bSource) ? 'Median'
    : /^as[- ]?is/i.test(bSource) ? 'As-is'
    : null

  return (
    <div className="border border-border rounded-sm bg-background">
      {/* Header: title + flags · the deal actions live on the subject card */}
      <div className="px-3 py-1.5 border-b border-border/30 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[10px] font-semibold text-foreground-tertiary uppercase tracking-wider">Valuation</span>
          {isRecalculated && (
            <span className="text-[8px] font-medium px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-500">Recalculated</span>
          )}
          {disposition && (
            <span
              className={cn(
                'text-[8px] font-medium px-1.5 py-0.5 rounded',
                disposition.workflow === 'prep_offer' ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400' : disposition.workflow === 'no_offer' ? 'bg-red-500/20 text-red-600 dark:text-red-400' : 'bg-amber-500/20 text-amber-600 dark:text-amber-400',
              )}
              title="This property was already dispositioned this session"
            >
              {disposition.workflow === 'prep_offer' ? 'Offer prepped' : disposition.workflow === 'no_offer' ? 'No offer' : 'No margin'} · {new Date(disposition.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} {new Date(disposition.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
            </span>
          )}
        </div>
        {/* Costs, right-aligned: Close at the left of the line, Wholesale at the right.
            List price is not repeated here · it is already the List tile below. */}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-0.5 text-[10px] tabular-nums text-foreground-tertiary/70">
          {valuation.closingCosts != null && <span>Close ${fmtK(valuation.closingCosts)}</span>}
          {valuation.carryingCosts != null && <span>Carry ${fmtK(valuation.carryingCosts)}</span>}
          {valuation.totalInvestment != null && <span>Invest ${fmtK(valuation.totalInvestment)}</span>}
          {valuation.wholesalePrice != null && <span>Wholesale ${formatHeadlineMoney(valuation.wholesalePrice, valuation.displayedWholesalePrice, valuation.displayRounding)}</span>}
        </div>
      </div>

      {/* Primary metrics grid */}
      <div className="hero-stats">
        {subject?.avm?.value != null && (
          <div
            className="px-3 py-2.5 border-r border-border/20"
            title={`${subject.avm.model ?? 'AVM'} modeled value${subject.avm.confidence != null ? ` — ${subject.avm.confidence}% confidence` : ''}${subject.avm.valueRangeLow != null && subject.avm.valueRangeHigh != null ? ` (range $${fmtK(subject.avm.valueRangeLow)}–$${fmtK(subject.avm.valueRangeHigh)})` : ''} — reference only, not comp-verified`}
          >
            <div className="text-[11px] text-foreground-tertiary uppercase tracking-wider">AVM</div>
            <div className="text-base font-bold tabular-nums mt-0.5">${fmtK(subject.avm.value)}</div>
            {valuation.arv != null && subject.avm.value !== valuation.arv && (
              <div className="text-[10px] text-foreground-tertiary tabular-nums mt-0.5">
                {((valuation.arv - subject.avm.value) / subject.avm.value * 100).toFixed(0)}% {valuation.arv > subject.avm.value ? 'below' : 'above'} ARV
              </div>
            )}
          </div>
        )}
        <div
          className="px-3 py-2.5 border-r border-border/20"
          title={valuation.asIsMarketIntel?.asIsMarketPrice != null
            ? `As-is AVG across ${valuation.asIsMarketIntel.compCount ?? 0} investment-classified comps matching appraisal rules${(valuation.asIsMarketIntel.flipSaleCount ?? 0) > 0 ? ` + ${valuation.asIsMarketIntel.flipSaleCount} verified flip acquisition(s)` : ''} — insight only, does not affect ARV`
            : 'No investment-classified comps matched the appraisal rules — insight only, does not affect ARV'}
        >
          <div className="text-[11px] text-foreground-tertiary uppercase tracking-wider">As-is AVG</div>
          <div className="text-base font-bold tabular-nums mt-0.5">
            {valuation.asIsMarketIntel?.asIsMarketPrice != null ? `$${fmtK(valuation.asIsMarketIntel.asIsMarketPrice)}` : '—'}
          </div>
          <div className="text-[10px] text-foreground-tertiary tabular-nums mt-0.5">
            {valuation.asIsMarketIntel?.avgPricePerSqft != null
              ? `$${valuation.asIsMarketIntel.avgPricePerSqft.toFixed(0)}/sf`
              : `${(valuation.asIsMarketIntel?.compCount ?? 0) + (valuation.asIsMarketIntel?.flipSaleCount ?? 0)} sales`}
            {(valuation.asIsMarketIntel?.flipSaleCount ?? 0) > 0 && (
              <span className="text-foreground-tertiary/50"> · {valuation.asIsMarketIntel!.flipSaleCount} flip</span>
            )}
          </div>
        </div>
        <div
          className="px-3 py-2.5 border-r border-border/20"
          title={valuation.listPriceRealism
            ? `Asking $${fmtK(Math.abs(valuation.listPriceRealism.gapDollars))} (${fmt(Math.abs(valuation.listPriceRealism.gapPercent))}%) ${valuation.listPriceRealism.gapDollars > 0 ? 'above' : 'below'} the $${fmtK(valuation.listPriceRealism.wholesalePrice)} wholesale ceiling`
            : valuation.listPrice != null
              ? "Seller's asking price, scraped from the active listing"
              : 'No asking price — no active listing found at eval time'}
        >
          <div className="text-[11px] text-foreground-tertiary uppercase tracking-wider">List</div>
          <div className="text-base font-bold tabular-nums mt-0.5">{valuation.listPrice != null ? `$${fmtK(valuation.listPrice)}` : '—'}</div>
          <div className="text-[10px] tabular-nums mt-0.5 text-foreground-tertiary">
            {valuation.listPrice == null
              ? 'No ask recorded'
              : valuation.wholesalePrice != null
                ? valuation.listPrice === valuation.wholesalePrice
                  ? 'Same as wholesale'
                  : `$${fmtK(Math.abs(valuation.listPrice - valuation.wholesalePrice))} ${valuation.listPrice > valuation.wholesalePrice ? 'more' : 'less'} than wholesale`
                : 'Asking price'}
          </div>
        </div>
        <div className="px-3 py-2.5 border-r border-border/20">
          <div className="text-[11px] text-foreground-tertiary uppercase tracking-wider flex items-center gap-1">
            ARV
            {arvOverride != null && (
              <button
                type="button"
                onClick={() => onArvOverride?.(null)}
                className="text-[8px] px-1 rounded bg-amber-500/20 text-amber-600 dark:text-amber-400 hover:bg-amber-500/30 no-print"
                title="Manual ARV in force (adjustments paused) — click to restore the computed value"
              >
                manual ✕
              </button>
            )}
          </div>
          {/* Same height and left edge in both states (24px line, text starts at the tile's edge),
              so clicking the number swaps it for the box without moving anything around it. */}
          {arvEditing ? (
            <div className="mt-0.5 -mx-1.5 flex h-6 w-[calc(100%+0.75rem)] items-center rounded border border-primary/50 bg-secondary/50 px-[5px] text-base font-bold tabular-nums text-primary focus-within:border-primary focus-within:ring-1 focus-within:ring-primary/40 transition-colors">
              <span aria-hidden>$</span>
              <input
                autoFocus
                type="number"
                inputMode="numeric"
                aria-label="Manual ARV"
                value={arvDraft}
                onChange={(e) => setArvDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur()
                }}
                onBlur={() => {
                  const v = parseFloat(arvDraft)
                  onArvOverride?.(Number.isFinite(v) && v > 0 ? Math.round(v) : null)
                  setArvEditing(false)
                }}
                className="min-w-0 flex-1 bg-transparent p-0 font-bold tabular-nums leading-none text-primary outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => { setArvDraft(String(arvOverride ?? valuation.arv ?? '')); setArvEditing(true) }}
              className="mt-0.5 block h-6 text-base font-bold leading-6 tabular-nums text-primary hover:underline decoration-dotted underline-offset-4 no-print"
              title="Click to set a manual ARV — recalculates the whole deal"
            >
              ${formatHeadlineMoney(valuation.arv, valuation.displayedArv, valuation.displayRounding)}
            </button>
          )}
          {valuation.arvPerSqft != null && <div className="text-[10px] text-foreground-tertiary tabular-nums mt-0.5">${valuation.arvPerSqft.toFixed(0)}/sf</div>}
          {valuation.bMechanics?.ceiling != null && (
            <div className="text-[10px] text-foreground-tertiary tabular-nums mt-0.5 no-print" title="The most the comp evidence supports">
              Ceiling ${fmtK(valuation.bMechanics.ceiling)}
            </div>
          )}
          {floorSource && (
            <div className="text-[10px] text-foreground-tertiary mt-0.5 no-print" title={`This ARV is a floor, not comp-verified evidence${bSource ? ` · ${bSource}` : ''}`}>
              Floor {floorSource}
            </div>
          )}
        </div>
        <div className="px-3 py-2.5 border-r border-border/20">
          <div className="text-[11px] text-foreground-tertiary uppercase tracking-wider">Buy</div>
          <div className="text-base font-bold tabular-nums mt-0.5">${formatHeadlineMoney(valuation.buyPrice, valuation.displayedBuyPrice, valuation.displayRounding)}</div>
          {valuation.buyPricePercent != null && valuation.buyPricePercent > 0 && <div className="text-[10px] text-foreground-tertiary tabular-nums mt-0.5">{fmt(valuation.buyPricePercent)}% of ARV</div>}
        </div>
        <div className="px-3 py-2.5 border-r border-border/20">
          <div className="text-[11px] text-foreground-tertiary uppercase tracking-wider">Rehab</div>
          <div className="text-base font-bold tabular-nums mt-0.5">${fmtK(valuation.rehabCost)}</div>
          {valuation.rehabLevel && <div className="text-[10px] text-foreground-tertiary mt-0.5">{valuation.rehabLevel}</div>}
        </div>
        <div className="px-3 py-2.5 border-r border-border/20">
          <div className="text-[11px] text-foreground-tertiary uppercase tracking-wider">Profit</div>
          <div className={cn('text-base font-bold tabular-nums mt-0.5', (valuation.projectedProfit ?? 0) > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>${fmtK(valuation.projectedProfit)}</div>
          {valuation.projectedROI != null && <div className="text-[10px] text-foreground-tertiary tabular-nums mt-0.5">{fmt(valuation.projectedROI)}% ROI</div>}
        </div>
      </div>
    </div>
  )
}
