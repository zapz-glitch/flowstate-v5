'use client'

import { SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ValuationData } from './shared-types'
import { formatValuationNumber as fmt } from './valuation-number'
import { formatHeadlineMoney } from './headline-money'

interface DealSummaryHeroProps {
  valuation: ValuationData
  /** Subject AVM — informational only, never used in ARV/buy-price math */
  avm?: { value?: number | null; confidence?: number | null; model?: string | null; asOfDate?: string | null } | null
  isRecalculated?: boolean
  onOpenSettings?: () => void
}

export function DealSummaryHero({ valuation, avm, isRecalculated, onOpenSettings }: DealSummaryHeroProps) {

  const avmDelta = avm?.value != null && valuation.arv != null ? valuation.arv - avm.value : null

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
                ? 'Low confidence — verify manually'
                : valuation.confidence === 'medium'
                  ? 'Medium — review'
                  : 'High confidence'}
            </span>
          )}
        </div>
        {onOpenSettings && (
          <button type="button" onClick={onOpenSettings} className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] text-foreground-tertiary hover:text-foreground hover:bg-secondary transition-colors no-print">
            <SlidersHorizontal className="w-3 h-3" />
            Evaluation Settings
          </button>
        )}
      </div>

      {/* Primary metrics grid */}
      <div className="hero-stats">
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
        {avm !== undefined && (
          <div className="px-3 py-2.5" title={`${avm?.model ?? 'Provider AVM'} — reference only, excluded from valuation math${avm?.value == null ? ' (not returned for this property)' : ''}`}>
            <div className="text-[11px] text-foreground-tertiary uppercase tracking-wider">AVM</div>
            <div className="text-base font-bold tabular-nums mt-0.5">{avm?.value != null ? `$${fmt(avm.value)}` : '—'}</div>
            {avmDelta != null && (
              <div className={cn(
                'text-[10px] tabular-nums mt-0.5',
                Math.abs(avmDelta) <= Math.max(5000, (valuation.arv ?? 0) * 0.02) ? 'text-foreground-tertiary' : avmDelta > 0 ? 'text-emerald-500' : 'text-amber-500'
              )}>
                {avmDelta > 0 ? '+' : ''}{fmt(avmDelta)} vs AVM
              </div>
            )}
          </div>
        )}
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
