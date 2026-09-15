'use client'

import { Droplets, AlertTriangle, ShieldCheck } from 'lucide-react'

interface MapOverlayProps {
  riskFlags?: string[] | null
  floodZone?: { zone?: string | null; inFloodZone?: boolean | null; source?: 'parcel' | 'spatial' | 'listing' | null } | null
}

const LEGEND_ITEMS = [
  { color: '#3b82f6', label: 'Subject' },
  { color: '#10b981', label: 'Included' },
  { color: '#6b7280', label: 'Excluded' },
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

export function MapOverlay({ riskFlags, floodZone }: MapOverlayProps) {
  const hasRiskFlags = !!(riskFlags?.length || floodZone)

  if (!hasRiskFlags) return null

  return (
    <div className="absolute bottom-0 left-0 right-0 z-10 bg-black/60 backdrop-blur-sm no-print">
      {/* Risk flags row */}
      {hasRiskFlags && (
        <div className="px-4 py-2 flex items-center gap-3 overflow-x-auto scrollbar-none whitespace-nowrap border-b border-white/10">
          {floodZone && (
            floodZone.inFloodZone ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-400">
                <Droplets className="w-3.5 h-3.5 flex-shrink-0" />
                {floodZone.source === 'listing'
                  ? `Flood risk: ${floodZone.zone ?? 'elevated'}`
                  : `Flood Zone${floodZone.zone ? ` ${floodZone.zone}` : ''}`}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0" />
                {floodZone.source === 'listing'
                  ? `Flood risk: ${floodZone.zone ?? 'low'}`
                  : 'No Flood Zone'}
              </span>
            )
          )}
          {riskFlags?.map((flag, i) => (
            <span key={i} className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              {flag}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
