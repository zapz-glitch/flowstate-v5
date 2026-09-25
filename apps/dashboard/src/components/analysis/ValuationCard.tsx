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
import { formatHeadlineMoney } from './headline-money'
import { formatValuationNumber as safeFmt } from './valuation-number'

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
      <div className={cn('overflow-hidden border border-border', isRecalculated && 'ring-1 ring-amber-500/30')}>
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

          <div className="flex flex-wrap bg-muted/40 [&>div]:border-r [&>div]:border-border/50 [&>div:last-child]:border-r-0">
            <div className="p-3 min-w-[120px] flex-1">
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
                ${formatHeadlineMoney(valuation.arv, valuation.displayedArv, valuation.displayRounding)}
              </div>
              {valuation.arvPerSqft != null && (
                <div className="text-caption-sm text-foreground-tertiary mt-1">${valuation.arvPerSqft.toFixed(0)}/sqft</div>
              )}
            </div>
            {valuation.listPrice != null && (
              <div className="p-3 min-w-[120px] flex-1">
                <MetricLabel
                  label="List Price"
                  tooltip={
                    <div className="space-y-1.5">
                      <p className="font-medium">Asking Price</p>
                      <p className="text-foreground-tertiary">The seller's listed asking price, scraped from the property's active listing.</p>
                      <p className="font-mono text-[10px] text-foreground-tertiary mt-1">ARV delta = ARV - List Price</p>
                    </div>
                  }
                />
                <div className="text-heading-sm font-semibold">${safeFmt(valuation.listPrice)}</div>
                {valuation.arvVsListPrice != null && valuation.arvVsListPrice !== 0 && (
                  <div className={cn('text-caption-sm mt-1', valuation.arvVsListPrice < 0 ? 'text-emerald-600' : 'text-amber-600')}>
                    ARV ${safeFmt(Math.abs(valuation.arvVsListPrice))} {valuation.arvVsListPrice < 0 ? 'below' : 'above'} list
                  </div>
                )}
                {valuation.listPriceRealism && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="mt-1.5 w-fit cursor-help">
                        <Badge
                          variant="outline"
                          className={cn(
                            valuation.listPriceRealism.verdict === 'high' && 'border-emerald-600/40 text-emerald-600',
                            valuation.listPriceRealism.verdict === 'medium' && 'border-amber-600/40 text-amber-600',
                            valuation.listPriceRealism.verdict === 'low' && 'border-red-600/40 text-red-600'
                          )}
                        >
                          {valuation.listPriceRealism.verdict === 'high' ? 'Realistic ask' : valuation.listPriceRealism.verdict === 'medium' ? 'Negotiable gap' : 'Unrealistic ask'}
                        </Badge>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs">
                      <div className="space-y-1.5">
                        <p className="font-medium">Ask vs wholesale ceiling</p>
                        <p className="text-foreground-tertiary">
                          {valuation.listPriceRealism.gapDollars > 0
                            ? `Asking $${safeFmt(valuation.listPriceRealism.gapDollars)} (${safeFmt(valuation.listPriceRealism.gapPercent)}%) above the $${safeFmt(valuation.listPriceRealism.wholesalePrice)} wholesale ceiling.`
                            : `Asking at or below the $${safeFmt(valuation.listPriceRealism.wholesalePrice)} wholesale ceiling.`}
                        </p>
                        <p className="font-mono text-[10px] text-foreground-tertiary mt-1">Realistic ≤10% of ask · Negotiable ≤20% · Unrealistic &gt;20%</p>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            )}
            <div className="p-3 min-w-[120px] flex-1">
              <MetricLabel
                label="Max Buy Price"
                tooltip={
                  <div className="space-y-1.5">
                    <p className="font-medium">Maximum Acquisition Price</p>
                    <p className="text-foreground-tertiary">The highest price you should pay for this property to hit your profit target.</p>
                    <p className="font-mono text-[10px] text-foreground-tertiary mt-1">= ARV - Rehab - Flip Profit - Closing Costs - Carrying Costs{valuation.locationPenalty ? ' - Location Penalty' : ''}</p>
                  </div>
                }
              />
              <div className="text-heading-sm font-bold">${formatHeadlineMoney(valuation.buyPrice, valuation.displayedBuyPrice, valuation.displayRounding)}</div>
              {valuation.buyPricePercent != null && valuation.buyPricePercent !== 0 && (
                <div className="text-caption-sm text-foreground-tertiary mt-1">{safeFmt(valuation.buyPricePercent)}% of ARV</div>
              )}
            </div>
            <div className="p-3 min-w-[120px] flex-1">
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
              <div className="text-heading-sm font-semibold">${safeFmt(valuation.rehabCost)}</div>
              {valuation.rehabLevel && (
                <Badge variant="outline" className="mt-1.5">
                  {valuation.rehabLevel}
                </Badge>
              )}
              {(valuation.majorItemsCost ?? 0) > 0 && (
                <div className="text-caption-sm text-foreground-tertiary mt-1">
                  Base: ${safeFmt(valuation.baseRehabCost)} + Items: ${safeFmt(valuation.majorItemsCost)}
                </div>
              )}
            </div>
            <div className="p-3 min-w-[120px] flex-1">
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
                ${safeFmt(valuation.projectedProfit)}
              </div>
              {valuation.projectedROI != null && valuation.projectedROI !== 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="text-caption-sm text-foreground-tertiary mt-1 underline decoration-dotted decoration-foreground-tertiary/40 underline-offset-2 cursor-help w-fit">
                      {safeFmt(valuation.projectedROI)}% ROI
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
                      <p className="font-mono text-[10px] text-foreground-tertiary mt-1">= ARV - Rehab - Flip Profit - Wholesale Fee - Closing Costs - Carrying Costs</p>
                    </div>
                  }
                />
                <div className={cn('text-heading-sm font-semibold', (valuation.wholesalePrice ?? 0) >= 0 ? '' : 'text-red-600')}>
                  ${formatHeadlineMoney(valuation.wholesalePrice, valuation.displayedWholesalePrice, valuation.displayRounding)}
                </div>
                {valuation.wholesaleFee != null && (
                  <div className="text-caption-sm text-foreground-tertiary mt-1">
                    after ${safeFmt(valuation.wholesaleFee)} fee
                  </div>
                )}
              </div>
            )}
          </div>

          {(valuation.closingCosts != null || valuation.carryingCosts != null || valuation.totalInvestment != null || (valuation.locationPenalty ?? 0) > 0) && (
            <div className="flex items-center flex-wrap gap-x-6 gap-y-1 mt-3 text-body-sm px-1">
              {valuation.closingCosts != null && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help">
                      <span className="text-foreground-tertiary underline decoration-dotted decoration-foreground-tertiary/40 underline-offset-2">Closing Cost</span>
                      <span className="text-foreground-tertiary">: </span>
                      <span className="font-medium">${safeFmt(valuation.closingCosts)}</span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    <div className="space-y-1.5">
                      <p className="font-medium">Closing Costs</p>
                      <p className="text-foreground-tertiary">Transaction costs at closing (title, escrow, commissions, etc.).</p>
                      <p className="font-mono text-[10px] text-foreground-tertiary mt-1">= ARV x Closing%</p>
                    </div>
                  </TooltipContent>
                </Tooltip>
              )}
              {valuation.carryingCosts != null && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help">
                      <span className="text-foreground-tertiary underline decoration-dotted decoration-foreground-tertiary/40 underline-offset-2">Carrying Cost</span>
                      <span className="text-foreground-tertiary">: </span>
                      <span className="font-medium">${safeFmt(valuation.carryingCosts)}</span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    <div className="space-y-1.5">
                      <p className="font-medium">Carrying Costs</p>
                      <p className="text-foreground-tertiary">Ongoing costs while holding the property (insurance, taxes, utilities, etc.).</p>
                      <p className="font-mono text-[10px] text-foreground-tertiary mt-1">= ARV x Carrying%</p>
                    </div>
                  </TooltipContent>
                </Tooltip>
              )}
              {(valuation.locationPenalty ?? 0) > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help">
                      <span className="text-amber-600 dark:text-amber-400 underline decoration-dotted decoration-amber-500/40 underline-offset-2">Location Penalty</span>
                      <span className="text-foreground-tertiary">: </span>
                      <span className="font-medium text-amber-600 dark:text-amber-400">−${safeFmt(valuation.locationPenalty)}</span>
                      {valuation.locationPenaltyPercent ? <span className="text-foreground-tertiary"> ({safeFmt(valuation.locationPenaltyPercent)}%)</span> : null}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-xs">
                    <div className="space-y-1.5">
                      <p className="font-medium">Proximity Deduction</p>
                      <p className="text-foreground-tertiary">Deduction for the subject fronting, backing, or siding a major road/commercial corridor. Tiers are configured in Evaluation Settings → Proximity.</p>
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
                      <span className="font-medium">${safeFmt(valuation.totalInvestment)}</span>
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
