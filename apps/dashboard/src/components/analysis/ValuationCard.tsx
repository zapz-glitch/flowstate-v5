'use client'

import { DollarSign, SlidersHorizontal } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { ValuationData } from './shared-types'

function MetricLabel({ label, tooltip }: { label: string; tooltip: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="text-caption text-foreground-tertiary mb-1 underline decoration-dotted decoration-foreground-tertiary/40 underline-offset-2 cursor-help">
          {label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

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
    <TooltipProvider delayDuration={200}>
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

          <div className="grid grid-cols-2 md:grid-cols-5 rounded-xl bg-muted/40 [&>div]:border-r [&>div]:border-border/50 [&>div:last-child]:border-r-0">
            <div className="p-4">
              <MetricLabel
                label="ARV"
                tooltip={
                  <div className="space-y-1.5">
                    <p className="font-medium">After Repair Value</p>
                    <p className="text-foreground-tertiary">Estimated market value of the property after renovations, based on weighted average of comparable sales.</p>
                    <p className="font-mono text-[10px] text-foreground-tertiary mt-1">= Weighted Avg(Comp Adjusted Prices)</p>
                  </div>
                }
              />
              <div className="text-heading-sm font-bold text-primary">
                {isRecalculated && <span className="text-amber-500">~</span>}${valuation.arv?.toLocaleString() || '-'}
              </div>
              {valuation.arvPerSqft != null && (
                <div className="text-caption-sm text-foreground-tertiary mt-1">${valuation.arvPerSqft.toFixed(0)}/sqft</div>
              )}
            </div>
            <div className="p-4">
              <MetricLabel
                label="Max Buy Price"
                tooltip={
                  <div className="space-y-1.5">
                    <p className="font-medium">Maximum Acquisition Price</p>
                    <p className="text-foreground-tertiary">The highest price you should pay for this property to hit your profit target.</p>
                    <p className="font-mono text-[10px] text-foreground-tertiary mt-1">= ARV - Rehab - Closing Costs - Carrying Costs - Desired Profit</p>
                  </div>
                }
              />
              <div className="text-heading-sm font-bold">${valuation.buyPrice?.toLocaleString() || '-'}</div>
              {valuation.buyPricePercent != null && valuation.buyPricePercent !== 0 && (
                <div className="text-caption-sm text-foreground-tertiary mt-1">{valuation.buyPricePercent}% of ARV</div>
              )}
            </div>
            <div className="p-4">
              <MetricLabel
                label="Rehab Cost"
                tooltip={
                  <div className="space-y-1.5">
                    <p className="font-medium">Estimated Renovation Cost</p>
                    <p className="text-foreground-tertiary">Total cost to renovate the property based on rehab level, square footage, and any major items.</p>
                    <p className="font-mono text-[10px] text-foreground-tertiary mt-1">= (SqFt x $/SqFt) + Major Items + Addition Play</p>
                  </div>
                }
              />
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
              <MetricLabel
                label="Projected Profit"
                tooltip={
                  <div className="space-y-1.5">
                    <p className="font-medium">Estimated Net Profit</p>
                    <p className="text-foreground-tertiary">What you stand to make after all costs — purchase, rehab, closing, and carrying.</p>
                    <p className="font-mono text-[10px] text-foreground-tertiary mt-1">= ARV - Buy Price - Rehab - Closing Costs - Carrying Costs</p>
                  </div>
                }
              />
              <div className={cn('text-heading-sm font-semibold', (valuation.projectedProfit ?? 0) > 0 ? 'text-emerald-600' : 'text-red-600')}>
                ${valuation.projectedProfit?.toLocaleString() || '-'}
              </div>
              {valuation.projectedROI != null && valuation.projectedROI !== 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="text-caption-sm text-foreground-tertiary mt-1 underline decoration-dotted decoration-foreground-tertiary/40 underline-offset-2 cursor-help w-fit">
                      {valuation.projectedROI.toFixed(1)}% ROI
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    <div className="space-y-1.5">
                      <p className="font-medium">Return on Investment</p>
                      <p className="text-foreground-tertiary">Percentage return relative to your total cash invested (buy price + rehab).</p>
                      <p className="font-mono text-[10px] text-foreground-tertiary mt-1">= (Projected Profit / Total Investment) x 100</p>
                    </div>
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            {valuation.wholesalePrice != null && (
              <div className="p-4">
                <MetricLabel
                  label="Wholesale Price"
                  tooltip={
                    <div className="space-y-1.5">
                      <p className="font-medium">Wholesale Assignment Price</p>
                      <p className="text-foreground-tertiary">Price to assign the contract to another investor after deducting your wholesale fee.</p>
                      <p className="font-mono text-[10px] text-foreground-tertiary mt-1">= Max Buy Price - Wholesale Fee</p>
                    </div>
                  }
                />
                <div className={cn('text-heading-sm font-semibold', valuation.wholesalePrice >= 0 ? '' : 'text-red-600')}>
                  ${valuation.wholesalePrice.toLocaleString()}
                </div>
              </div>
            )}
          </div>

          {(valuation.totalCosts != null || valuation.totalInvestment != null) && (
            <div className="flex items-center gap-6 mt-3 text-body-sm px-1">
              {valuation.totalCosts != null && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help">
                      <span className="text-foreground-tertiary underline decoration-dotted decoration-foreground-tertiary/40 underline-offset-2">Total Costs</span>
                      <span className="text-foreground-tertiary">: </span>
                      <span className="font-medium">${valuation.totalCosts.toLocaleString()}</span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    <div className="space-y-1.5">
                      <p className="font-medium">Total Transaction Costs</p>
                      <p className="text-foreground-tertiary">Combined closing and carrying costs for the deal.</p>
                      <p className="font-mono text-[10px] text-foreground-tertiary mt-1">= Closing Costs + Carrying Costs</p>
                      <p className="font-mono text-[10px] text-foreground-tertiary">= (ARV x Closing%) + (ARV x Carrying%)</p>
                    </div>
                  </TooltipContent>
                </Tooltip>
              )}
              {valuation.totalInvestment != null && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help">
                      <span className="text-foreground-tertiary underline decoration-dotted decoration-foreground-tertiary/40 underline-offset-2">Total Investment</span>
                      <span className="text-foreground-tertiary">: </span>
                      <span className="font-medium">${valuation.totalInvestment.toLocaleString()}</span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    <div className="space-y-1.5">
                      <p className="font-medium">Total Cash Invested</p>
                      <p className="text-foreground-tertiary">Your total out-of-pocket cost including purchase and renovation.</p>
                      <p className="font-mono text-[10px] text-foreground-tertiary mt-1">= Buy Price + Rehab Cost</p>
                    </div>
                  </TooltipContent>
                </Tooltip>
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
    </TooltipProvider>
  )
}
