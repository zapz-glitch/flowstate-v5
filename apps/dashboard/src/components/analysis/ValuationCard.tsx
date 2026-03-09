'use client'

import { DollarSign, SlidersHorizontal } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { ValuationData } from './shared-types'

export function ValuationCard({
  valuation,
  isRecalculated = false,
  onOpenSettings,
}: {
  valuation: ValuationData
  isRecalculated?: boolean
  onOpenSettings?: () => void
}) {
  const getRecommendationStyle = (rec?: string) => {
    if (!rec) return 'default'
    const upper = rec.toUpperCase()
    if (upper.includes('PURSUE') || upper.includes('BUY')) return 'success'
    if (upper.includes('PASS') || upper.includes('AVOID')) return 'destructive'
    if (upper.includes('REVIEW') || upper.includes('CAUTION')) return 'warning'
    return 'default'
  }

  const recStyle = getRecommendationStyle(valuation.recommendation)

  return (
    <div className={cn('rounded-xl overflow-hidden border border-border', isRecalculated && 'ring-1 ring-amber-500/30')}>
      <div className="px-6 py-5">
        <div className="flex items-center justify-between gap-3 mb-5">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <DollarSign className="w-4 h-4 text-primary" />
            </div>
            <h3 className="text-body font-semibold">Underwriter Valuation</h3>
          </div>
          <div className="flex items-center gap-2">
            {isRecalculated && (
              <Badge className="bg-amber-500/15 text-amber-700 border-amber-500/30 text-caption-sm no-print">
                <SlidersHorizontal className="w-3 h-3 mr-1" />
                Recalculated
              </Badge>
            )}
            {onOpenSettings && (
              <button
                type="button"
                onClick={onOpenSettings}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-body-sm text-foreground-secondary hover:text-foreground hover:bg-secondary transition-colors border border-border no-print"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Evaluation Settings</span>
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 rounded-xl bg-muted/40">
          <div className="p-4">
            <div className="text-caption text-foreground-tertiary mb-1">ARV</div>
            <div className="text-heading-sm font-bold text-primary">
              {isRecalculated && <span className="text-amber-500">~</span>}${valuation.arv?.toLocaleString() || '-'}
            </div>
            {valuation.arvPerSqft != null && (
              <div className="text-caption-sm text-foreground-tertiary mt-1">${valuation.arvPerSqft.toFixed(0)}/sqft</div>
            )}
          </div>
          <div className="p-4">
            <div className="text-caption text-foreground-tertiary mb-1">Max Buy Price</div>
            <div className="text-heading-sm font-bold">${valuation.buyPrice?.toLocaleString() || '-'}</div>
            {valuation.buyPricePercent != null && valuation.buyPricePercent !== 0 && (
              <div className="text-caption-sm text-foreground-tertiary mt-1">{valuation.buyPricePercent}% of ARV</div>
            )}
          </div>
          <div className="p-4">
            <div className="text-caption text-foreground-tertiary mb-1">Rehab Cost</div>
            <div className="text-heading-sm font-semibold">${valuation.rehabCost?.toLocaleString() || '-'}</div>
            {valuation.rehabLevel && (
              <Badge variant="outline" className="mt-1.5">
                {valuation.rehabLevel}
              </Badge>
            )}
            {(valuation.majorItemsCost ?? 0) > 0 && (
              <div className="text-caption-sm text-foreground-tertiary mt-1">
                Base: ${valuation.baseRehabCost?.toLocaleString()} + Items: ${valuation.majorItemsCost?.toLocaleString()}
              </div>
            )}
          </div>
          <div className="p-4">
            <div className="text-caption text-foreground-tertiary mb-1">Projected Profit</div>
            <div className={cn('text-heading-sm font-semibold', (valuation.projectedProfit ?? 0) > 0 ? 'text-emerald-600' : 'text-red-600')}>
              ${valuation.projectedProfit?.toLocaleString() || '-'}
            </div>
            {valuation.projectedROI != null && valuation.projectedROI !== 0 && (
              <div className="text-caption-sm text-foreground-tertiary mt-1">{valuation.projectedROI.toFixed(1)}% ROI</div>
            )}
          </div>
          {valuation.wholesalePrice != null && (
            <div className="p-4">
              <div className="text-caption text-foreground-tertiary mb-1">Wholesale Price</div>
              <div className={cn('text-heading-sm font-semibold', valuation.wholesalePrice >= 0 ? '' : 'text-red-600')}>
                ${valuation.wholesalePrice.toLocaleString()}
              </div>
            </div>
          )}
        </div>

        {(valuation.totalCosts != null || valuation.totalInvestment != null) && (
          <div className="flex items-center gap-6 mt-3 text-body-sm px-1">
            {valuation.totalCosts != null && (
              <span>
                <span className="text-foreground-tertiary">Total Costs: </span>
                <span className="font-medium">${valuation.totalCosts.toLocaleString()}</span>
              </span>
            )}
            {valuation.totalInvestment != null && (
              <span>
                <span className="text-foreground-tertiary">Total Investment: </span>
                <span className="font-medium">${valuation.totalInvestment.toLocaleString()}</span>
              </span>
            )}
          </div>
        )}

        {valuation.recommendation && (
          <div className="mt-5 pt-5 border-t border-border">
            <div className="flex items-center gap-3 flex-wrap">
              <Badge
                variant={recStyle === 'success' ? 'default' : recStyle === 'destructive' ? 'destructive' : 'outline'}
                className={cn(
                  'text-body-sm px-3 py-1',
                  recStyle === 'success' && 'bg-emerald-500',
                  recStyle === 'warning' && 'bg-amber-500 text-amber-950'
                )}
              >
                {valuation.recommendation}
              </Badge>
              {valuation.recommendationReason && (
                <span className="text-body-sm text-foreground-tertiary">{valuation.recommendationReason}</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
