'use client'

import { Droplets, AlertTriangle, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MAP_COLORS } from './map-colors'

interface MapOverlayProps {
  riskFlags?: string[] | null
  floodZone?: { zone?: string | null; inFloodZone?: boolean | null; source?: 'parcel' | 'spatial' | 'listing' | null } | null
}

const LEGEND_ITEMS = [
  { color: MAP_COLORS.subject, label: 'Subject' },
  { color: MAP_COLORS.included, label: 'Included' },
  { color: MAP_COLORS.excluded, label: 'Excluded' },
]

export function MapLegend() {
  return (
    <div className="absolute top-2 right-2 z-10 flex flex-col gap-1 bg-black/50 backdrop-blur-sm rounded px-2.5 py-1.5">
      {LEGEND_ITEMS.map((item) => (
        <div key={item.label} className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-full border-[1.5px] border-white flex-shrink-0" style={{ background: item.color }} />
          <span className="text-[10px] text-white/80">{item.label}</span>
        </div>
      ))}
    </div>
  )
}

// The valuation gap vs list price already lives in the valuation box —
// dropping it here keeps the map strip to real location/flood risks.
const ARV_LIST_FLAG = /^ARV (\$[\d,]+ (above|below) list price|at list price)$/
// AVM-vs-ARV commentary is verdict meta, not a location risk — same rule.
const AVM_FLAG = /as-is (AVM|estimate)|comp-evidenced ARV|as-is estimate/i

/** Flood and location risks as one wrapping line · lives in the subject card */
export function RiskLine({ riskFlags, floodZone }: MapOverlayProps) {
  const flags = riskFlags?.filter((flag) => !ARV_LIST_FLAG.test(flag) && !AVM_FLAG.test(flag)) ?? []
  if (!floodZone && flags.length === 0) return null
  const flood = floodZone
    ? floodZone.inFloodZone
      ? (floodZone.source === 'listing' ? `Flood risk ${floodZone.zone ?? 'elevated'}` : `Flood zone${floodZone.zone ? ` ${floodZone.zone}` : ''}`)
      : (floodZone.source === 'listing' ? `Flood risk ${floodZone.zone ?? 'low'}` : 'No flood zone')
    : null
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px]">
      {flood && (
        <span className={cn('font-medium', floodZone?.inFloodZone ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>{flood}</span>
      )}
      {flags.map((flag, i) => (
        <span key={i} className="font-medium text-amber-600 dark:text-amber-400">{flag}</span>
      ))}
    </div>
  )
}

export function MapOverlay({ riskFlags, floodZone }: MapOverlayProps) {
  const mapFlags = riskFlags?.filter((flag) => !ARV_LIST_FLAG.test(flag) && !AVM_FLAG.test(flag))
  const hasRiskFlags = !!(mapFlags?.length || floodZone)

  if (!hasRiskFlags) return null

  return (
    <div className="shrink-0 bg-background no-print">
      {/* Risk flags row */}
      {hasRiskFlags && (
        <div className="px-2 py-2 flex items-center gap-3 overflow-x-auto scrollbar-none whitespace-nowrap">
          {floodZone && (
            floodZone.inFloodZone ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400">
                <Droplets className="w-3.5 h-3.5 flex-shrink-0" />
                {floodZone.source === 'listing'
                  ? `Flood risk: ${floodZone.zone ?? 'elevated'}`
                  : `Flood Zone${floodZone.zone ? ` ${floodZone.zone}` : ''}`}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0" />
                {floodZone.source === 'listing'
                  ? `Flood risk: ${floodZone.zone ?? 'low'}`
                  : 'No Flood Zone'}
              </span>
            )
          )}
          {mapFlags?.map((flag, i) => (
            <span key={i} className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              {flag}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
