'use client'

import { Building2 } from 'lucide-react'
import { fmtNumber as fmt } from './format-helpers'

interface InvestorPurchaseIntel {
  avgInvestorPrice?: number | null
  avgPricePerSqft?: number | null
  compCount?: number
  groupBCompCount?: number
  noDataReason?: string
}

interface InvestorPurchaseCardProps {
  data: InvestorPurchaseIntel
}

export function InvestorPurchaseCard({ data }: InvestorPurchaseCardProps) {
  const hasData = data.compCount != null && data.compCount > 0

  if (!hasData && !data.noDataReason) return null

  return (
    <div className="border border-border rounded-sm bg-background/95">
      <div className="px-3 py-1.5 border-b border-border/30 flex items-center gap-2">
        <Building2 className="w-3.5 h-3.5 text-blue-500" />
        <span className="text-[10px] font-semibold text-foreground-tertiary uppercase tracking-wider">Investor Purchase Intel</span>
        {hasData && (
          <span className="text-[10px] text-blue-500 font-medium ml-auto">
            {data.compCount} of {data.groupBCompCount} as-is comps
          </span>
        )}
      </div>

      {hasData ? (
        <div className="grid grid-cols-2 divide-x divide-border/20">
          <div className="px-3 py-2">
            <div className="text-[10px] text-foreground-tertiary uppercase tracking-wider">Avg Investor Price</div>
            <div className="text-sm font-bold tabular-nums text-blue-500 mt-0.5">
              ${fmt(data.avgInvestorPrice)}
            </div>
          </div>
          <div className="px-3 py-2">
            <div className="text-[10px] text-foreground-tertiary uppercase tracking-wider">Avg $/SqFt</div>
            <div className="text-sm font-bold tabular-nums mt-0.5">
              ${data.avgPricePerSqft?.toFixed(0) ?? '-'}/sf
            </div>
          </div>
        </div>
      ) : (
        <div className="px-3 py-2.5 text-[11px] text-foreground-tertiary">
          {data.noDataReason}
        </div>
      )}
    </div>
  )
}
