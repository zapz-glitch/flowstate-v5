'use client'

import { Clock, RefreshCw } from 'lucide-react'
import type { ReportHistoryEntry } from '@/lib/client-api'
import { formatShortDate } from '@/components/analysis/format-helpers'

interface ReportHistoryTimelineProps {
  entries: ReportHistoryEntry[]
  loading: boolean
}

const ACTION_COLORS: Record<string, string> = {
  evaluation_update: 'bg-emerald-500',
  ai_analysis: 'bg-primary',
  reanalyzed: 'bg-amber-500',
  created: 'bg-blue-500',
}

export function ReportHistoryTimeline({ entries, loading }: ReportHistoryTimelineProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center px-5">
        <Clock className="w-8 h-8 text-muted-foreground/30 mb-3" />
        <p className="text-sm text-muted-foreground">No changes recorded yet</p>
        <p className="text-xs text-muted-foreground/60 mt-1">Changes to comp selection, settings, and AI analysis will appear here.</p>
      </div>
    )
  }

  return (
    <div className="relative">
      {/* Timeline line */}
      <div className="absolute left-[23px] top-0 bottom-0 w-px bg-border" />

      {entries.map((entry, i) => {
        const isFirst = i === 0
        const changes = entry.changes as Record<string, unknown> | null
        const actionColor = ACTION_COLORS[entry.action] ?? 'bg-muted-foreground'

        return (
          <div key={entry.id} className={`relative pl-12 pr-5 py-3 ${isFirst ? 'bg-muted/20' : ''}`}>
            {/* Timeline dot */}
            <div className={`absolute left-[19px] top-4 w-[9px] h-[9px] rounded-full border-2 border-background ${actionColor}`} />

            <div className="text-xs font-medium text-foreground">{entry.description}</div>
            <div className="text-[10px] text-foreground-tertiary mt-0.5">
              {formatShortDate(entry.createdAt)}
              {' · '}
              {new Date(entry.createdAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
            </div>

            {/* Change details */}
            {!!changes && (
              <div className="mt-1.5 space-y-0.5 text-[10px] text-foreground-tertiary">
                {changes.arv != null && (
                  <div>ARV: <span className="text-foreground tabular-nums">${Number(changes.arv).toLocaleString()}</span></div>
                )}
                {changes.buyPrice != null && (
                  <div>Buy: <span className="text-foreground tabular-nums">${Number(changes.buyPrice).toLocaleString()}</span></div>
                )}
                {changes.proximityDeduction != null && Number(changes.proximityDeduction) > 0 && (
                  <div>Proximity: <span className="text-red-500 tabular-nums">−${Number(changes.proximityDeduction).toLocaleString()}</span></div>
                )}
                {!!changes.selectedComps && Array.isArray(changes.selectedComps) && (
                  <div>Comps: <span className="text-foreground">{(changes.selectedComps as string[]).length} selected</span></div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
