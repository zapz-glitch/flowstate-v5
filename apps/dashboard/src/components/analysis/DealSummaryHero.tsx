'use client'

import Link from 'next/link'
import { SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SubjectData, ValuationData } from './shared-types'
import { AddressDisplay } from './AddressDisplay'
import { StatCell } from './StatCell'

interface DealSummaryHeroProps {
  subject: SubjectData
  valuation: ValuationData
  isRecalculated?: boolean
  onOpenSettings?: () => void
  riskFlags?: string[] | null
  floodZone?: { zone?: string | null; inFloodZone?: boolean | null } | null
  /** Job ID for linking to the full report */
  jobId?: string | null
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

export function DealSummaryHero({ subject, valuation, isRecalculated, onOpenSettings, riskFlags, floodZone, jobId }: DealSummaryHeroProps) {
  const recommendation = deriveRecommendation(valuation.recommendation, valuation.projectedROI)
  const rec = getRecConfig(recommendation)
  const hasRisks = (riskFlags && riskFlags.length > 0) || floodZone

  return (
    <div className="flex flex-col gap-4">

      {/* Card 1: Subject Property */}
      <div className="border border-border/60 overflow-hidden bg-background/80 backdrop-blur-sm corner-accents corner-accents-bottom">
        {/* Address + Report link */}
        <div className="px-4 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <AddressDisplay
            address={subject.address || 'Unknown Address'}
            latitude={subject.latitude}
            longitude={subject.longitude}
            className="text-body-sm font-semibold"
          />
            {jobId && (
              <Link href={`/dashboard/reports/${jobId}`} className="text-caption text-primary hover:underline flex-shrink-0 no-print">
                View Report
              </Link>
            )}
          </div>
          {subject.subdivision && (
            <div className="text-caption text-foreground-tertiary mt-0.5">{subject.subdivision}</div>
          )}
        </div>

        {/* Stats grid — identical to comp cards */}
        <div className="flex flex-wrap border-t border-border/30 bg-muted/40">
          <StatCell label="Beds" value={subject.bedrooms ?? '-'} />
          <StatCell label="Baths" value={subject.bathrooms ?? '-'} />
          <StatCell label="Sq Ft" value={subject.squareFeet?.toLocaleString() || '-'} />
          <StatCell label="Year" value={subject.yearBuilt || '-'} />
          <StatCell label="Lot" value={subject.lotSizeAcres ? `${Number(subject.lotSizeAcres).toFixed(3)} ac` : '-'} />
          <StatCell label="Foundation" value={subject.foundationType || '-'} />
          <StatCell label="House Style" value={subject.buildingStyle || '-'} />
        </div>

        {/* Risk flags + flood zone — inline badges */}
        {hasRisks && (
          <div className="px-4 py-2 border-t border-border/30 flex items-center gap-2 flex-wrap">
            {floodZone && (
              floodZone.inFloodZone ? (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-red-500/15 text-red-500 border border-red-500/20">
                  Flood Zone{floodZone.zone ? `: ${floodZone.zone}` : ''}
                </span>
              ) : (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-500 border border-emerald-500/20">
                  Flood Zone: No
                </span>
              )
            )}
            {riskFlags?.map((flag, i) => (
              <span key={i} className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-500 border border-amber-500/20">
                {flag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Card 2: Valuation */}
      <div className={cn('border border-border/60 overflow-hidden bg-background/80 backdrop-blur-sm corner-accents corner-accents-bottom', rec.ring, rec.glow)}>
        {/* Header: title + recommendation + settings */}
        <div className="px-4 py-2.5 flex items-center justify-between gap-3">
          <span className="text-caption font-medium text-foreground-tertiary uppercase tracking-wide">Valuation</span>
          <div className="flex items-center gap-2">
            {isRecalculated && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-500">Recalculated</span>
            )}
            {rec.label && (
              <span className={cn('text-xs font-bold px-2.5 py-1 rounded', rec.badge)}>{rec.label}</span>
            )}
            {onOpenSettings && (
              <button type="button" onClick={onOpenSettings} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-caption text-foreground-tertiary hover:text-foreground hover:bg-secondary transition-colors border border-border no-print">
                <SlidersHorizontal className="w-3 h-3" />
                Evaluation Settings
              </button>
            )}
          </div>
        </div>

        {/* Key financials */}
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

        {/* Secondary costs */}
        {(valuation.closingCosts != null || valuation.wholesalePrice != null) && (
          <div className="px-4 py-1.5 border-t border-border/20 flex items-center gap-3 sm:gap-4 flex-wrap text-[10px] tabular-nums text-foreground-tertiary/70">
            {valuation.closingCosts != null && <span>Closing <span className="text-foreground-tertiary">${fmt(valuation.closingCosts)}</span></span>}
            {valuation.carryingCosts != null && <span>Carrying <span className="text-foreground-tertiary">${fmt(valuation.carryingCosts)}</span></span>}
            {valuation.totalInvestment != null && <span>Invested <span className="text-foreground-tertiary">${fmt(valuation.totalInvestment)}</span></span>}
            {valuation.wholesalePrice != null && <span>Wholesale <span className="text-foreground-tertiary">${fmt(valuation.wholesalePrice)}</span></span>}
          </div>
        )}
      </div>

    </div>
  )
}
