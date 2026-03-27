'use client'

import { SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SubjectData, ValuationData } from './shared-types'
import { AddressDisplay } from './AddressDisplay'

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
  if (!rec) return { label: '', badge: 'bg-muted text-foreground', ring: 'ring-border', glow: '' }
  const label = formatRecommendation(rec)
  const lower = rec.toLowerCase()
  if (lower.includes('strong') || lower === 'buy')
    return { label, badge: 'bg-emerald-500 text-white', ring: 'ring-emerald-500/30', glow: 'shadow-emerald-500/5 shadow-lg' }
  if (lower === 'pass' || lower.includes('avoid'))
    return { label, badge: 'bg-red-500 text-white', ring: 'ring-red-500/30', glow: 'shadow-red-500/5 shadow-lg' }
  if (lower === 'hold' || lower.includes('review') || lower.includes('caution'))
    return { label, badge: 'bg-amber-500 text-white', ring: 'ring-amber-500/30', glow: 'shadow-amber-500/5 shadow-lg' }
  return { label, badge: 'bg-primary text-white', ring: 'ring-primary/30', glow: '' }
}

export function DealSummaryHero({ subject, valuation, isRecalculated, onOpenSettings, riskFlags, floodZone }: DealSummaryHeroProps) {
  const recommendation = deriveRecommendation(valuation.recommendation, valuation.projectedROI)
  const rec = getRecConfig(recommendation)
  const hasRisks = (riskFlags && riskFlags.length > 0) || floodZone?.inFloodZone

  // Build compact property details string
  const details = [
    subject.bedrooms != null ? `${subject.bedrooms}bd` : null,
    subject.bathrooms != null ? `${subject.bathrooms}ba` : null,
    subject.squareFeet != null ? `${subject.squareFeet.toLocaleString()} sqft` : null,
    subject.yearBuilt ? String(subject.yearBuilt) : null,
    subject.lotSizeAcres ? `${Number(subject.lotSizeAcres).toFixed(3)} ac` : null,
    subject.foundationType || null,
    subject.buildingStyle || null,
  ].filter(Boolean)

  return (
    <div className={cn('border border-border/60 overflow-hidden bg-background/80 backdrop-blur-sm corner-accents corner-accents-bottom', rec.ring, rec.glow)}>

      {/* Layer 1: Address + Recommendation badge + Settings */}
      <div className="px-4 py-2.5 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <AddressDisplay
            address={subject.address || 'Unknown Address'}
            latitude={subject.latitude}
            longitude={subject.longitude}
            className="text-body-sm font-semibold"
          />
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {rec.label && (
            <span className={cn('text-xs font-bold px-2.5 py-1 rounded', rec.badge)}>{rec.label}</span>
          )}
          {onOpenSettings && (
            <button type="button" onClick={onOpenSettings} className="p-1.5 rounded-lg text-foreground-tertiary hover:text-foreground hover:bg-secondary transition-colors no-print" title="Evaluation Settings">
              <SlidersHorizontal className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Layer 2: KEY FINANCIALS — the hero section, largest visual weight */}
      <div className="grid grid-cols-2 sm:grid-cols-4 border-t border-border/30">
        <div className="px-4 py-3 border-r border-b sm:border-b-0 border-border/30">
          <div className="text-[10px] text-foreground-tertiary uppercase tracking-wide">ARV</div>
          <div className="text-lg font-bold text-primary tabular-nums mt-0.5">${fmt(valuation.arv)}</div>
          {valuation.arvPerSqft != null && <div className="text-[10px] text-foreground-tertiary">${valuation.arvPerSqft.toFixed(0)}/sqft</div>}
        </div>
        <div className="px-4 py-3 border-b sm:border-b-0 sm:border-r border-border/30">
          <div className="text-[10px] text-foreground-tertiary uppercase tracking-wide">Max Buy Price</div>
          <div className="text-lg font-bold tabular-nums mt-0.5">${fmt(valuation.buyPrice)}</div>
          {valuation.buyPricePercent != null && valuation.buyPricePercent > 0 && <div className="text-[10px] text-foreground-tertiary">{valuation.buyPricePercent}% of ARV</div>}
        </div>
        <div className="px-4 py-3 border-r border-border/30">
          <div className="text-[10px] text-foreground-tertiary uppercase tracking-wide">Rehab</div>
          <div className="text-lg font-semibold tabular-nums mt-0.5">${fmt(valuation.rehabCost)}</div>
          {valuation.rehabLevel && <div className="text-[10px] text-foreground-tertiary">{valuation.rehabLevel}</div>}
        </div>
        <div className="px-4 py-3">
          <div className="text-[10px] text-foreground-tertiary uppercase tracking-wide">Profit</div>
          <div className={cn('text-lg font-bold tabular-nums mt-0.5', (valuation.projectedProfit ?? 0) > 0 ? 'text-emerald-500' : 'text-red-500')}>
            ${fmt(valuation.projectedProfit)}
          </div>
          {valuation.projectedROI != null && <div className="text-[10px] text-foreground-tertiary">{valuation.projectedROI.toFixed(1)}% ROI</div>}
        </div>
      </div>

      {/* Layer 3: Property details — compact inline, lower visual weight */}
      {details.length > 0 && (
        <div className="px-4 py-2 border-t border-border/30 flex items-center gap-1.5 flex-wrap text-caption text-foreground-tertiary">
          {details.map((d, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-border">·</span>}
              <span>{d}</span>
            </span>
          ))}
          {subject.subdivision && (
            <span className="flex items-center gap-1.5">
              <span className="text-border">·</span>
              <span className="truncate max-w-[180px]">{subject.subdivision}</span>
            </span>
          )}
          {isRecalculated && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-500 ml-1">Recalculated</span>
          )}
        </div>
      )}

      {/* Layer 4: Secondary costs — smallest text, muted */}
      {(valuation.closingCosts != null || valuation.wholesalePrice != null) && (
        <div className="px-4 py-1.5 border-t border-border/20 flex items-center gap-3 sm:gap-4 flex-wrap text-[10px] tabular-nums text-foreground-tertiary/70">
          {valuation.closingCosts != null && <span>Closing <span className="text-foreground-tertiary">${fmt(valuation.closingCosts)}</span></span>}
          {valuation.carryingCosts != null && <span>Carrying <span className="text-foreground-tertiary">${fmt(valuation.carryingCosts)}</span></span>}
          {valuation.totalInvestment != null && <span>Invested <span className="text-foreground-tertiary">${fmt(valuation.totalInvestment)}</span></span>}
          {valuation.wholesalePrice != null && <span>Wholesale <span className="text-foreground-tertiary">${fmt(valuation.wholesalePrice)}</span></span>}
        </div>
      )}

      {/* Layer 5: Risk flags — alert level */}
      {hasRisks && (
        <div className="px-4 py-2 border-t border-border/30 flex items-center gap-2 flex-wrap">
          {floodZone?.inFloodZone && (
            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-red-500/15 text-red-500 border border-red-500/20">
              Flood Zone{floodZone.zone ? `: ${floodZone.zone}` : ''}
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
