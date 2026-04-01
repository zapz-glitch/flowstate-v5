'use client'

import { Navigation, Droplets, AlertTriangle, ShieldCheck } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { UseReportSettingsReturn } from '@/hooks/use-report-settings'
import type { RecalcResult } from '@/lib/recalc'

interface MapOverlayProps {
  riskFlags?: string[] | null
  floodZone?: { zone?: string | null; inFloodZone?: boolean | null } | null
  recalcData: RecalcResult | null
  settingsHook: UseReportSettingsReturn
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

export function MapOverlay({ riskFlags, floodZone, recalcData, settingsHook }: MapOverlayProps) {
  const hasRiskFlags = !!(riskFlags?.length || floodZone)

  if (!hasRiskFlags && !recalcData) return null

  return (
    <div className="absolute bottom-0 left-0 right-0 z-10 bg-black/60 backdrop-blur-sm no-print">
      {/* Risk flags row */}
      {hasRiskFlags && (
        <div className="px-4 py-2 flex items-center gap-3 overflow-x-auto scrollbar-none whitespace-nowrap border-b border-white/10">
          {floodZone && (
            floodZone.inFloodZone ? (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-400">
                <Droplets className="w-3.5 h-3.5 flex-shrink-0" />
                Flood Zone{floodZone.zone ? ` ${floodZone.zone}` : ''}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0" />
                No Flood Zone
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
      {/* Proximity row */}
      <div className="px-4 py-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <Navigation className="w-3.5 h-3.5 text-white/60" />
          <span className="text-xs font-medium text-white/70">Traffic / Commercial Adjustments</span>
          {recalcData && recalcData.valuation.proximityDeduction > 0 && (
            <span className="text-xs font-medium text-red-400 tabular-nums">
              −${recalcData.valuation.proximityDeduction.toLocaleString()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {(['siding', 'backing', 'fronting'] as const).map((pos) => {
            const label = pos === 'siding' ? 'Side' : pos === 'backing' ? 'Back' : 'Front'
            const isOn = settingsHook.settings.proximityAdjustments?.[pos] ?? false
            return (
              <label key={pos} className="flex items-center gap-1.5 cursor-pointer">
                <Switch
                  checked={isOn}
                  onCheckedChange={(checked) => {
                    const current = settingsHook.settings.proximityAdjustments ?? { siding: false, backing: false, fronting: false }
                    settingsHook.updateProximityAdjustments({ ...current, [pos]: checked })
                  }}
                  className="scale-90"
                />
                <span className={cn('text-xs', isOn ? 'text-white font-medium' : 'text-white/50')}>{label}</span>
              </label>
            )
          })}
        </div>
      </div>
    </div>
  )
}
