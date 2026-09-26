'use client'

import { SlidersHorizontal, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ValuationData } from './shared-types'
import { formatValuationNumber as fmt } from './valuation-number'
import { formatHeadlineMoney } from './headline-money'

interface DealSummaryHeroProps {
  valuation: ValuationData
  isRecalculated?: boolean
  onOpenSettings?: () => void
  /** Re-run the analysis for this property (fresh data, cache bypassed) */
  onRerun?: () => void
  /** True while a rerun is in flight */
  rerunning?: boolean
}

export function DealSummaryHero({ valuation, isRecalculated, onOpenSettings, onRerun, rerunning }: DealSummaryHeroProps) {

  return (
    <div className="border border-border rounded-sm bg-background/95 backdrop-blur-sm">
      {/* Header: title + recommendation + settings */}
      <div className="px-3 py-1.5 border-b border-border/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold text-foreground-tertiary uppercase tracking-wider">Valuation</span>
          {isRecalculated && (
            <span className="text-[8px] font-medium px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-500">Recalculated</span>
          )}
          {valuation.confidence && (
            <span
              className={cn(
                'text-[8px] font-medium px-1.5 py-0.5 rounded uppercase tracking-wide',
                valuation.confidence === 'high' && 'bg-emerald-500/15 text-emerald-500',
                valuation.confidence === 'medium' && 'bg-amber-500/15 text-amber-500',
                valuation.confidence === 'low' && 'bg-red-500/15 text-red-500',
              )}
              title={(valuation.confidenceReasons ?? []).join('\n')}
            >
              {valuation.confidence === 'low'
                ? 'Low confidence'
                : valuation.confidence === 'medium'
                  ? 'Medium confidence'
                  : 'High confidence'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {onRerun && (
            <button
              type="button"
              onClick={onRerun}
              disabled={rerunning}
              className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-foreground-tertiary hover:text-foreground hover:bg-secondary transition-colors no-print disabled:opacity-50"
              title="Re-run this analysis with fresh data"
            >
              <RefreshCw className={cn('w-3 h-3', rerunning && 'animate-spin')} />
              {rerunning ? 'Running…' : 'Re-run'}
            </button>
          )}
          {onOpenSettings && (
            <button type="button" onClick={onOpenSettings} className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-foreground-tertiary hover:text-foreground hover:bg-secondary transition-colors no-print">
              <SlidersHorizontal className="w-3 h-3" />
              Evaluation Settings
            </button>
          )}
        </div>
      </div>

      {/* Primary metrics grid */}
      <div className="hero-stats">
        {valuation.listPrice != null && (
          <div
            className="px-3 py-2.5 border-r border-border/20"
            title={valuation.listPriceRealism
              ? `Asking $${fmt(Math.abs(valuation.listPriceRealism.gapDollars))} (${fmt(Math.abs(valuation.listPriceRealism.gapPercent))}%) ${valuation.listPriceRealism.gapDollars > 0 ? 'above' : 'below'} the $${fmt(valuation.listPriceRealism.wholesalePrice)} wholesale ceiling`
              : "Seller's asking price, scraped from the active listing"}
          >
            <div className="text-[11px] text-foreground-tertiary uppercase tracking-wider">List</div>
            <div className="text-base font-bold tabular-nums mt-0.5">${fmt(valuation.listPrice)}</div>
            <div className={cn(
              'text-[10px] tabular-nums mt-0.5',
              valuation.arvVsListPrice != null && valuation.arvVsListPrice !== 0
                ? valuation.arvVsListPrice < 0 ? 'text-emerald-500' : 'text-amber-500'
                : 'text-foreground-tertiary'
            )}>
              {valuation.arvVsListPrice != null && valuation.arvVsListPrice !== 0
                ? `ARV $${fmt(Math.abs(valuation.arvVsListPrice))} ${valuation.arvVsListPrice < 0 ? 'below' : 'above'} list`
                : valuation.listPriceRealism
                  ? valuation.listPriceRealism.verdict === 'high' ? 'Realistic ask' : valuation.listPriceRealism.verdict === 'medium' ? 'Negotiable gap' : 'Unrealistic ask'
                  : 'Asking price'}
            </div>
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
            {valuation.asIsMarketIntel?.asIsMarketPrice != null ? `$${fmt(valuation.asIsMarketIntel.asIsMarketPrice)}` : '—'}
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
        <div className="px-3 py-2.5 border-r border-border/20">
          <div className="text-[11px] text-foreground-tertiary uppercase tracking-wider">ARV</div>
          <div className="text-base font-bold tabular-nums text-primary mt-0.5">${formatHeadlineMoney(valuation.arv, valuation.displayedArv, valuation.displayRounding)}</div>
          {valuation.arvPerSqft != null && <div className="text-[10px] text-foreground-tertiary tabular-nums mt-0.5">${valuation.arvPerSqft.toFixed(0)}/sf</div>}
        </div>
        <div className="px-3 py-2.5 border-r border-border/20">
          <div className="text-[11px] text-foreground-tertiary uppercase tracking-wider">Buy</div>
          <div className="text-base font-bold tabular-nums mt-0.5">${formatHeadlineMoney(valuation.buyPrice, valuation.displayedBuyPrice, valuation.displayRounding)}</div>
          {valuation.buyPricePercent != null && valuation.buyPricePercent > 0 && <div className="text-[10px] text-foreground-tertiary tabular-nums mt-0.5">{fmt(valuation.buyPricePercent)}% of ARV</div>}
        </div>
        <div className="px-3 py-2.5 border-r border-border/20">
          <div className="text-[11px] text-foreground-tertiary uppercase tracking-wider">Rehab</div>
          <div className="text-base font-bold tabular-nums mt-0.5">${fmt(valuation.rehabCost)}</div>
          {valuation.rehabLevel && <div className="text-[10px] text-foreground-tertiary mt-0.5">{valuation.rehabLevel}</div>}
        </div>
        <div className="px-3 py-2.5 border-r border-border/20">
          <div className="text-[11px] text-foreground-tertiary uppercase tracking-wider">Profit</div>
          <div className={cn('text-base font-bold tabular-nums mt-0.5', (valuation.projectedProfit ?? 0) > 0 ? 'text-emerald-500' : 'text-red-500')}>${fmt(valuation.projectedProfit)}</div>
          {valuation.projectedROI != null && <div className="text-[10px] text-foreground-tertiary tabular-nums mt-0.5">{fmt(valuation.projectedROI)}% ROI</div>}
        </div>
      </div>

      {/* Footer: secondary costs */}
      <div className="px-3 py-1.5 border-t border-border/30 flex items-center gap-3 text-[10px] tabular-nums text-foreground-tertiary/70">
        {valuation.closingCosts != null && <span>Close ${fmt(valuation.closingCosts)}</span>}
        {valuation.carryingCosts != null && <span>Carry ${fmt(valuation.carryingCosts)}</span>}
        {valuation.totalInvestment != null && <span>Invest ${fmt(valuation.totalInvestment)}</span>}
        {valuation.wholesalePrice != null && <span>Wholesale ${formatHeadlineMoney(valuation.wholesalePrice, valuation.displayedWholesalePrice, valuation.displayRounding)}</span>}
      </div>
    </div>
  )
}
