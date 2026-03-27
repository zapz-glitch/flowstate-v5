'use client'

import { SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SubjectData, ValuationData } from './shared-types'
import { AddressDisplay } from './AddressDisplay'
import { ClassificationBadge } from './ClassificationBadge'

interface DealSummaryHeroProps {
  subject: SubjectData
  valuation: ValuationData
  isRecalculated?: boolean
  onOpenSettings?: () => void
  riskFlags?: string[] | null
  floodZone?: { zone?: string | null; inFloodZone?: boolean | null } | null
}

function fmt(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '-'
  return v.toLocaleString()
}

function deriveRecommendation(rec: string | undefined | null, roi: number | undefined | null): string {
  if (rec) return rec
  if (roi == null) return ''
  if (roi >= 30) return 'Strong Buy'
  if (roi >= 15) return 'Buy'
  if (roi >= 5) return 'Hold'
  return 'Pass'
}

function formatRecommendation(rec: string): string {
  const map: Record<string, string> = { 'strong-buy': 'Strong Buy', 'buy': 'Buy', 'hold': 'Hold', 'pass': 'Pass' }
  return map[rec.toLowerCase()] || rec
}

function getRecConfig(rec: string) {
  if (!rec) return { label: '', bg: '', text: 'text-foreground', badge: 'bg-muted text-foreground', ring: 'ring-border', glow: '' }
  const label = formatRecommendation(rec)
  const lower = rec.toLowerCase()
  if (lower.includes('strong') || lower === 'buy')
    return { label, bg: 'bg-emerald-500/8', text: 'text-emerald-400', badge: 'bg-emerald-500 text-white', ring: 'ring-emerald-500/30', glow: 'shadow-emerald-500/5 shadow-lg' }
  if (lower === 'pass' || lower.includes('avoid'))
    return { label, bg: 'bg-red-500/8', text: 'text-red-400', badge: 'bg-red-500 text-white', ring: 'ring-red-500/30', glow: 'shadow-red-500/5 shadow-lg' }
  if (lower === 'hold' || lower.includes('review') || lower.includes('caution'))
    return { label, bg: 'bg-amber-500/8', text: 'text-amber-400', badge: 'bg-amber-500 text-white', ring: 'ring-amber-500/30', glow: 'shadow-amber-500/5 shadow-lg' }
  return { label, bg: '', text: 'text-primary', badge: 'bg-primary text-white', ring: 'ring-primary/30', glow: '' }
}

export function DealSummaryHero({ subject, valuation, isRecalculated, onOpenSettings, riskFlags, floodZone }: DealSummaryHeroProps) {
  const recommendation = deriveRecommendation(valuation.recommendation, valuation.projectedROI)
  const rec = getRecConfig(recommendation)
  const hasRisks = (riskFlags && riskFlags.length > 0) || floodZone?.inFloodZone

  return (
    <div className={cn('border border-border/60 overflow-hidden bg-background/80 backdrop-blur-sm corner-accents corner-accents-bottom', rec.ring, rec.glow)}>

      {/* Row 1: Address + Recommendation badge + Actions */}
      <div className="px-4 py-3 flex items-center gap-3 border-b border-border/30">
        <div className="flex-1 min-w-0">
          <AddressDisplay
            address={subject.address || 'Unknown Address'}
            latitude={subject.latitude}
            longitude={subject.longitude}
            className="text-body-sm font-semibold"
          />
          {subject.subdivision && (
            <div className="text-caption text-foreground-tertiary mt-0.5">{subject.subdivision}</div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {rec.label && (
            <span className={cn('text-xs font-bold px-2.5 py-1 rounded', rec.badge)}>
              {rec.label}
            </span>
          )}
          {subject.classification && <ClassificationBadge classification={subject.classification} />}
          {onOpenSettings && (
            <button type="button" onClick={onOpenSettings} className="p-1.5 rounded-lg text-foreground-tertiary hover:text-foreground hover:bg-secondary transition-colors no-print" title="Evaluation Settings">
              <SlidersHorizontal className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Row 2: Property stats grid */}
      <div className="flex flex-wrap bg-muted/30 border-b border-border/30">
        {[
          { label: 'Beds', value: subject.bedrooms ?? '-' },
          { label: 'Baths', value: subject.bathrooms ?? '-' },
          { label: 'Sq Ft', value: subject.squareFeet?.toLocaleString() || '-' },
          { label: 'Year', value: subject.yearBuilt || '-' },
          { label: 'Lot', value: subject.lotSizeAcres ? `${Number(subject.lotSizeAcres).toFixed(3)} ac` : '-' },
          { label: 'Foundation', value: subject.foundationType || '-' },
          { label: 'Style', value: subject.buildingStyle || '-' },
        ].map(({ label, value }) => (
          <div key={label} className="py-1.5 px-2 text-center border-r border-border/30 last:border-r-0 min-w-[60px] flex-1">
            <div className="text-[10px] text-foreground-tertiary leading-tight">{label}</div>
            <div className="text-caption font-medium">{value}</div>
          </div>
        ))}
      </div>

      {/* Row 3: Key financials */}
      <div className="grid grid-cols-2 sm:grid-cols-4 border-b border-border/30">
        <div className="px-4 py-2.5 border-r border-b sm:border-b-0 border-border/30">
          <div className="text-[10px] text-foreground-tertiary">ARV</div>
          <div className="text-body font-bold text-primary tabular-nums">${fmt(valuation.arv)}</div>
          {valuation.arvPerSqft != null && <div className="text-[10px] text-foreground-tertiary">${valuation.arvPerSqft.toFixed(0)}/sqft</div>}
        </div>
        <div className="px-4 py-2.5 border-b sm:border-b-0 sm:border-r border-border/30">
          <div className="text-[10px] text-foreground-tertiary">Max Buy Price</div>
          <div className="text-body font-bold tabular-nums">${fmt(valuation.buyPrice)}</div>
          {valuation.buyPricePercent != null && valuation.buyPricePercent > 0 && <div className="text-[10px] text-foreground-tertiary">{valuation.buyPricePercent}% of ARV</div>}
        </div>
        <div className="px-4 py-2.5 border-r border-border/30">
          <div className="text-[10px] text-foreground-tertiary">Rehab Cost</div>
          <div className="text-body font-semibold tabular-nums">${fmt(valuation.rehabCost)}</div>
          {valuation.rehabLevel && <div className="text-[10px] text-foreground-tertiary">{valuation.rehabLevel}</div>}
        </div>
        <div className="px-4 py-2.5">
          <div className="text-[10px] text-foreground-tertiary">Projected Profit</div>
          <div className={cn('text-body font-bold tabular-nums', (valuation.projectedProfit ?? 0) > 0 ? 'text-emerald-500' : 'text-red-500')}>
            ${fmt(valuation.projectedProfit)}
          </div>
        </div>
      </div>

      {/* Row 4: Secondary metrics — all on one line */}
      <div className="px-4 py-2 flex items-center gap-3 sm:gap-5 flex-wrap text-[11px] tabular-nums text-foreground-tertiary">
        {valuation.closingCosts != null && <span>Closing <span className="text-foreground font-medium">${fmt(valuation.closingCosts)}</span></span>}
        {valuation.carryingCosts != null && <span>Carrying <span className="text-foreground font-medium">${fmt(valuation.carryingCosts)}</span></span>}
        {valuation.totalInvestment != null && <span>Investment <span className="text-foreground font-medium">${fmt(valuation.totalInvestment)}</span></span>}
        {valuation.wholesalePrice != null && <span>Wholesale <span className="text-foreground font-medium">${fmt(valuation.wholesalePrice)}</span></span>}
        {isRecalculated && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-500">Recalculated</span>}
      </div>

      {/* Row 5: Risk flags */}
      {hasRisks && (
        <div className="px-4 py-2 border-t border-border/30 flex items-center gap-2 flex-wrap">
          {floodZone?.inFloodZone && (
            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-red-500/15 text-red-500 border border-red-500/20">
              Flood Zone: {floodZone.zone || 'Yes'}
            </span>
          )}
          {riskFlags?.map((flag, i) => (
            <span key={i} className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-500 border border-amber-500/20">
              {flag}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
