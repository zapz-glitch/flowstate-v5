'use client'

import { TrendingUp, TrendingDown, Minus, Clock, Package, Building2, Users, AlertTriangle, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'

interface MarketContext {
  marketTrends?: {
    medianPriceDirection?: string | null
    yoyPriceChange?: string | null
    avgDaysOnMarket?: number | null
    inventoryLevel?: string | null
    summary?: string | null
  }
  neighborhoodFactors?: {
    recentDevelopment?: string | null
    schoolDistrictRating?: string | null
    majorEmployers?: string | null
  }
  recentSales?: {
    notableSales?: string | null
    foreclosureActivity?: string | null
  }
  investorSentiment?: string | null
  sources?: string[]
  model?: string
}

interface MarketContextCardProps {
  data: MarketContext
}

export function MarketContextCard({ data }: MarketContextCardProps) {
  const trends = data.marketTrends
  const neighborhood = data.neighborhoodFactors
  const sales = data.recentSales

  const hasContent = trends?.summary || trends?.medianPriceDirection || data.investorSentiment

  if (!hasContent) return null

  const TrendIcon = trends?.medianPriceDirection === 'rising' ? TrendingUp
    : trends?.medianPriceDirection === 'declining' ? TrendingDown
    : Minus

  const trendColor = trends?.medianPriceDirection === 'rising' ? 'text-emerald-500'
    : trends?.medianPriceDirection === 'declining' ? 'text-red-500'
    : 'text-foreground-tertiary'

  return (
    <div className="border border-border rounded-sm overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border/30 flex items-center gap-2">
        <TrendingUp className="w-3.5 h-3.5 text-blue-500" />
        <span className="text-[10px] font-semibold text-foreground-tertiary uppercase tracking-wider">Market Research</span>
        {data.model && (
          <span className="text-[9px] text-foreground-tertiary/50 ml-auto">{data.model.split('/').pop()}</span>
        )}
      </div>

      <div className="px-4 py-3 space-y-3">
        {/* Summary */}
        {trends?.summary && (
          <p className="text-body-sm text-foreground-secondary">{trends.summary}</p>
        )}

        {/* Key metrics row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {trends?.medianPriceDirection && (
            <div className="space-y-0.5">
              <div className="text-[9px] text-foreground-tertiary uppercase">Price Trend</div>
              <div className={cn('text-xs font-medium flex items-center gap-1', trendColor)}>
                <TrendIcon className="w-3 h-3" />
                {trends.medianPriceDirection}
                {trends.yoyPriceChange && <span className="text-[10px] opacity-70">({trends.yoyPriceChange})</span>}
              </div>
            </div>
          )}
          {trends?.avgDaysOnMarket != null && (
            <div className="space-y-0.5">
              <div className="text-[9px] text-foreground-tertiary uppercase">Avg DOM</div>
              <div className="text-xs font-medium flex items-center gap-1">
                <Clock className="w-3 h-3 text-foreground-tertiary" />
                {trends.avgDaysOnMarket} days
              </div>
            </div>
          )}
          {trends?.inventoryLevel && (
            <div className="space-y-0.5">
              <div className="text-[9px] text-foreground-tertiary uppercase">Inventory</div>
              <div className="text-xs font-medium flex items-center gap-1">
                <Package className="w-3 h-3 text-foreground-tertiary" />
                {trends.inventoryLevel}
              </div>
            </div>
          )}
          {data.investorSentiment && (
            <div className="space-y-0.5">
              <div className="text-[9px] text-foreground-tertiary uppercase">Investor</div>
              <div className="text-xs font-medium flex items-center gap-1">
                <Users className="w-3 h-3 text-foreground-tertiary" />
                {data.investorSentiment.length > 30 ? data.investorSentiment.slice(0, 30) + '...' : data.investorSentiment}
              </div>
            </div>
          )}
        </div>

        {/* Details */}
        {(neighborhood?.recentDevelopment || neighborhood?.schoolDistrictRating || neighborhood?.majorEmployers || sales?.notableSales || sales?.foreclosureActivity) && (
          <div className="space-y-1.5 pt-1 border-t border-border/20">
            {neighborhood?.recentDevelopment && (
              <div className="flex gap-2 text-[11px]">
                <Building2 className="w-3 h-3 text-foreground-tertiary flex-shrink-0 mt-0.5" />
                <span className="text-foreground-secondary">{neighborhood.recentDevelopment}</span>
              </div>
            )}
            {sales?.foreclosureActivity && (
              <div className="flex gap-2 text-[11px]">
                <AlertTriangle className="w-3 h-3 text-amber-500 flex-shrink-0 mt-0.5" />
                <span className="text-foreground-secondary">{sales.foreclosureActivity}</span>
              </div>
            )}
            {sales?.notableSales && (
              <div className="flex gap-2 text-[11px]">
                <TrendingUp className="w-3 h-3 text-foreground-tertiary flex-shrink-0 mt-0.5" />
                <span className="text-foreground-secondary">{sales.notableSales}</span>
              </div>
            )}
          </div>
        )}

        {/* Sources */}
        {data.sources && data.sources.length > 0 && (
          <div className="flex items-center gap-1 pt-1 border-t border-border/20">
            <ExternalLink className="w-2.5 h-2.5 text-foreground-tertiary" />
            <span className="text-[9px] text-foreground-tertiary">
              {data.sources.length} source{data.sources.length !== 1 ? 's' : ''}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
