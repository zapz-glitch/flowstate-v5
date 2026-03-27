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

/** Derive recommendation from ROI if the API doesn't provide one */
function deriveRecommendation(rec: string | undefined | null, roi: number | undefined | null): string {
  if (rec) return rec
  if (roi == null) return ''
  if (roi >= 30) return 'Strong Buy'
  if (roi >= 15) return 'Buy'
  if (roi >= 5) return 'Hold'
  return 'Pass'
}

/** Human-readable label for API recommendation codes */
function formatRecommendation(rec: string): string {
  const map: Record<string, string> = {
    'strong-buy': 'Strong Buy',
    'buy': 'Buy',
    'hold': 'Hold',
    'pass': 'Pass',
  }
  return map[rec.toLowerCase()] || rec
}

function getRecommendationConfig(rec: string): { label: string; bg: string; text: string; ring: string; glow: string } {
  if (!rec) return { label: '', bg: 'bg-muted', text: 'text-foreground', ring: 'ring-border', glow: '' }
  const label = formatRecommendation(rec)
  const lower = rec.toLowerCase()
  if (lower.includes('strong') || lower === 'buy')
    return { label, bg: 'bg-emerald-500/15', text: 'text-emerald-400', ring: 'ring-emerald-500/30', glow: 'shadow-emerald-500/10 shadow-lg' }
  if (lower === 'pass' || lower.includes('avoid'))
    return { label, bg: 'bg-red-500/15', text: 'text-red-400', ring: 'ring-red-500/30', glow: 'shadow-red-500/10 shadow-lg' }
  if (lower === 'hold' || lower.includes('review') || lower.includes('caution'))
    return { label, bg: 'bg-amber-500/15', text: 'text-amber-400', ring: 'ring-amber-500/30', glow: 'shadow-amber-500/10 shadow-lg' }
  return { label, bg: 'bg-primary/10', text: 'text-primary', ring: 'ring-primary/30', glow: '' }
}

export function DealSummaryHero({ subject, valuation, isRecalculated, onOpenSettings, riskFlags, floodZone }: DealSummaryHeroProps) {
  const recommendation = deriveRecommendation(valuation.recommendation, valuation.projectedROI)
  const rec = getRecommendationConfig(recommendation)
  const hasRisks = (riskFlags && riskFlags.length > 0) || floodZone?.inFloodZone

  return (
    <div className={cn('rounded-xl border overflow-hidden', rec.ring, rec.glow)}>
      {/* Recommendation + ROI — THE VERDICT */}
      <div className={cn('px-5 py-4', rec.bg)}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className={cn('text-xl sm:text-2xl font-black tracking-tight', rec.text)}>
              {rec.label}
            </span>
            {valuation.projectedROI != null && (
              <span className={cn('text-lg sm:text-xl font-bold tabular-nums', rec.text)}>
                {valuation.projectedROI.toFixed(1)}% ROI
              </span>
            )}
            {isRecalculated && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-500">Recalculated</span>
            )}
          </div>
          {onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              className="p-2 rounded-lg text-foreground-tertiary hover:text-foreground hover:bg-background/50 transition-colors no-print"
              title="Evaluation Settings"
            >
              <SlidersHorizontal className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Property identity — one compact line */}
      <div className="px-5 py-3 border-b border-border/50">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <AddressDisplay
              address={subject.address || 'Unknown Address'}
              latitude={subject.latitude}
              longitude={subject.longitude}
              className="text-body-sm font-semibold"
            />
            <div className="flex items-center gap-2 mt-1 text-caption text-foreground-tertiary flex-wrap">
              {subject.bedrooms != null && <span>{subject.bedrooms}bd/{subject.bathrooms ?? '-'}ba</span>}
              {subject.squareFeet != null && <><span className="text-border">·</span><span>{subject.squareFeet.toLocaleString()} sqft</span></>}
              {subject.yearBuilt != null && <><span className="text-border">·</span><span>{subject.yearBuilt}</span></>}
              {subject.foundationType && <><span className="text-border">·</span><span>{subject.foundationType}</span></>}
              {subject.buildingStyle && <><span className="text-border">·</span><span>{subject.buildingStyle}</span></>}
              {subject.subdivision && <><span className="text-border">·</span><span className="truncate max-w-[150px]">{subject.subdivision}</span></>}
            </div>
          </div>
          {subject.classification && (
            <ClassificationBadge classification={subject.classification} />
          )}
        </div>
      </div>

      {/* Key financials — 4 columns */}
      <div className="grid grid-cols-2 sm:grid-cols-4">
        <div className="px-4 py-3 border-r border-b sm:border-b-0 border-border/50">
          <div className="text-caption-sm text-foreground-tertiary">ARV</div>
          <div className="text-heading-sm font-bold text-primary tabular-nums">${fmt(valuation.arv)}</div>
          {valuation.arvPerSqft != null && (
            <div className="text-caption-sm text-foreground-tertiary">${valuation.arvPerSqft.toFixed(0)}/sqft</div>
          )}
        </div>
        <div className="px-4 py-3 border-b sm:border-b-0 sm:border-r border-border/50">
          <div className="text-caption-sm text-foreground-tertiary">Max Buy Price</div>
          <div className="text-heading-sm font-bold tabular-nums">${fmt(valuation.buyPrice)}</div>
          {valuation.buyPricePercent != null && valuation.buyPricePercent > 0 && (
            <div className="text-caption-sm text-foreground-tertiary">{valuation.buyPricePercent}% of ARV</div>
          )}
        </div>
        <div className="px-4 py-3 border-r border-border/50">
          <div className="text-caption-sm text-foreground-tertiary">Rehab Cost</div>
          <div className="text-heading-sm font-semibold tabular-nums">${fmt(valuation.rehabCost)}</div>
          {valuation.rehabLevel && (
            <div className="text-caption-sm text-foreground-tertiary">{valuation.rehabLevel}</div>
          )}
        </div>
        <div className="px-4 py-3">
          <div className="text-caption-sm text-foreground-tertiary">Projected Profit</div>
          <div className={cn('text-heading-sm font-bold tabular-nums', (valuation.projectedProfit ?? 0) > 0 ? 'text-emerald-500' : 'text-red-500')}>
            ${fmt(valuation.projectedProfit)}
          </div>
          {valuation.totalInvestment != null && (
            <div className="text-caption-sm text-foreground-tertiary">${fmt(valuation.totalInvestment)} invested</div>
          )}
        </div>
      </div>

      {/* Risk flags — inline badges */}
      {hasRisks && (
        <div className="px-5 py-2.5 border-t border-border/50 flex items-center gap-2 flex-wrap">
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
