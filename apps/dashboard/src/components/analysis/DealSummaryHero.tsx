'use client'

import { SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ValuationData } from './shared-types'
import { fmtNumber as fmt } from './format-helpers'

interface DealSummaryHeroProps {
  valuation: ValuationData
  isRecalculated?: boolean
  onOpenSettings?: () => void
}

export function DealSummaryHero({ valuation, isRecalculated, onOpenSettings }: DealSummaryHeroProps) {

  return (
    <div className="border border-border rounded-sm bg-background/95 backdrop-blur-sm">
      {/* Header: title + recommendation + settings */}
      <div className="px-3 py-1.5 border-b border-border/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-semibold text-foreground-tertiary uppercase tracking-wider">Valuation</span>
          {isRecalculated && (
            <span className="text-[8px] font-medium px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-500">Recalculated</span>
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
      <div className="grid grid-cols-4">
        <div className="px-3 py-2.5 border-r border-border/20">
          <div className="text-[11px] text-foreground-tertiary uppercase tracking-wider">ARV</div>
          <div className="text-base font-bold tabular-nums text-primary mt-0.5">${fmt(valuation.arv)}</div>
          {valuation.arvPerSqft != null && <div className="text-[10px] text-foreground-tertiary tabular-nums mt-0.5">${valuation.arvPerSqft.toFixed(0)}/sf</div>}
        </div>
        <div className="px-3 py-2.5 border-r border-border/20">
          <div className="text-[11px] text-foreground-tertiary uppercase tracking-wider">Buy</div>
          <div className="text-base font-bold tabular-nums mt-0.5">${fmt(valuation.buyPrice)}</div>
          {valuation.buyPricePercent != null && valuation.buyPricePercent > 0 && <div className="text-[10px] text-foreground-tertiary tabular-nums mt-0.5">{valuation.buyPricePercent}% of ARV</div>}
        </div>
        <div className="px-3 py-2.5 border-r border-border/20">
          <div className="text-[11px] text-foreground-tertiary uppercase tracking-wider">Rehab</div>
          <div className="text-base font-bold tabular-nums mt-0.5">${fmt(valuation.rehabCost)}</div>
          {valuation.rehabLevel && <div className="text-[10px] text-foreground-tertiary mt-0.5">{valuation.rehabLevel}</div>}
        </div>
        <div className="px-3 py-2.5">
          <div className="text-[11px] text-foreground-tertiary uppercase tracking-wider">Profit</div>
          <div className={cn('text-base font-bold tabular-nums mt-0.5', (valuation.projectedProfit ?? 0) > 0 ? 'text-emerald-500' : 'text-red-500')}>${fmt(valuation.projectedProfit)}</div>
          {valuation.projectedROI != null && <div className="text-[10px] text-foreground-tertiary tabular-nums mt-0.5">{valuation.projectedROI.toFixed(1)}% ROI</div>}
        </div>
      </div>

      {/* Footer: secondary costs */}
      <div className="px-3 py-1.5 border-t border-border/30 flex items-center gap-3 text-[10px] tabular-nums text-foreground-tertiary/70">
        {valuation.closingCosts != null && <span>Close ${fmt(valuation.closingCosts)}</span>}
        {valuation.carryingCosts != null && <span>Carry ${fmt(valuation.carryingCosts)}</span>}
        {valuation.totalInvestment != null && <span>Invest ${fmt(valuation.totalInvestment)}</span>}
        {valuation.wholesalePrice != null && <span>Wholesale ${fmt(valuation.wholesalePrice)}</span>}
      </div>
    </div>
  )
}
