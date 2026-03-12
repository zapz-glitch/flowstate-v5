'use client'

import { useState } from 'react'
import { Check, AlertTriangle, AlertCircle, Info, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { PhotoFinding } from '@/lib/client-api'

interface PhotoAnalysisFindingsProps {
  findings: PhotoFinding[]
  analysisModel?: string | null
  /** Set of majorItemIds that have already been applied */
  appliedItems: Set<string>
  onApplyItem: (majorItemId: string) => void
}

const SEVERITY_CONFIG = {
  critical: { label: 'Critical', icon: AlertCircle, className: 'bg-red-500/10 text-red-700 border-red-500/30' },
  high: { label: 'High', icon: AlertTriangle, className: 'bg-orange-500/10 text-orange-700 border-orange-500/30' },
  medium: { label: 'Medium', icon: Info, className: 'bg-amber-500/10 text-amber-700 border-amber-500/30' },
  low: { label: 'Low', icon: Info, className: 'bg-blue-500/10 text-blue-700 border-blue-500/30' },
} as const

export function PhotoAnalysisFindings({
  findings,
  analysisModel,
  appliedItems,
  onApplyItem,
}: PhotoAnalysisFindingsProps) {
  const [expanded, setExpanded] = useState(true)

  if (!findings.length) {
    return (
      <div className="p-4 rounded-xl bg-emerald-500/5 border border-emerald-500/20">
        <div className="flex items-center gap-2">
          <Check className="w-4 h-4 text-emerald-600" />
          <span className="text-caption font-medium text-emerald-700">No issues detected</span>
        </div>
        <p className="text-caption text-foreground-tertiary mt-1">
          AI analysis found no visible property condition issues in the uploaded photos.
        </p>
      </div>
    )
  }

  const mappableFindings = findings.filter((f) => f.majorItemId)
  const generalFindings = findings.filter((f) => !f.majorItemId)
  const unappliedMappable = mappableFindings.filter((f) => !appliedItems.has(f.majorItemId!))

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-caption font-medium text-foreground-secondary hover:text-foreground transition-colors"
        >
          <Zap className="w-4 h-4 text-amber-500" />
          AI Photo Analysis
          <Badge variant="outline" className="text-[10px] ml-1">
            {findings.length} finding{findings.length !== 1 ? 's' : ''}
          </Badge>
        </button>
        {unappliedMappable.length > 0 && (
          <button
            type="button"
            onClick={() => unappliedMappable.forEach((f) => onApplyItem(f.majorItemId!))}
            className="text-caption font-medium text-primary hover:text-primary/80 transition-colors"
          >
            Apply All ({unappliedMappable.length})
          </button>
        )}
      </div>

      {expanded && (
        <div className="space-y-2">
          {/* Mappable findings (can be applied to major items) */}
          {mappableFindings.map((finding) => {
            const severity = SEVERITY_CONFIG[finding.severity]
            const SeverityIcon = severity.icon
            const isApplied = appliedItems.has(finding.majorItemId!)

            return (
              <div
                key={finding.id}
                className={cn(
                  'flex items-start gap-3 p-3 rounded-lg border transition-colors',
                  isApplied
                    ? 'bg-emerald-500/5 border-emerald-500/20'
                    : 'bg-muted/30 border-border'
                )}
              >
                <SeverityIcon className={cn('w-4 h-4 mt-0.5 flex-shrink-0', severity.className.split(' ').find(c => c.startsWith('text-')))} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-caption font-medium text-foreground">{finding.title}</span>
                    <Badge variant="outline" className={cn('text-[10px]', severity.className)}>
                      {severity.label}
                    </Badge>
                    <span className="text-[10px] text-foreground-tertiary">
                      {Math.round(finding.confidence * 100)}% confidence
                    </span>
                  </div>
                  <p className="text-caption text-foreground-tertiary mt-0.5 leading-relaxed">
                    {finding.description}
                  </p>
                </div>
                <div className="flex-shrink-0">
                  {isApplied ? (
                    <span className="flex items-center gap-1 text-caption text-emerald-600">
                      <Check className="w-3.5 h-3.5" />
                      Applied
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onApplyItem(finding.majorItemId!)}
                      className="px-2.5 py-1 rounded-md text-caption font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                    >
                      Apply
                    </button>
                  )}
                </div>
              </div>
            )
          })}

          {/* General findings (informational only) */}
          {generalFindings.map((finding) => {
            const severity = SEVERITY_CONFIG[finding.severity]
            const SeverityIcon = severity.icon

            return (
              <div
                key={finding.id}
                className="flex items-start gap-3 p-3 rounded-lg bg-muted/20 border border-border/60"
              >
                <SeverityIcon className={cn('w-4 h-4 mt-0.5 flex-shrink-0', severity.className.split(' ').find(c => c.startsWith('text-')))} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-caption font-medium text-foreground">{finding.title}</span>
                    <Badge variant="outline" className={cn('text-[10px]', severity.className)}>
                      {severity.label}
                    </Badge>
                    <span className="text-[10px] text-foreground-tertiary">
                      {Math.round(finding.confidence * 100)}% confidence
                    </span>
                  </div>
                  <p className="text-caption text-foreground-tertiary mt-0.5 leading-relaxed">
                    {finding.description}
                  </p>
                </div>
              </div>
            )
          })}

          {analysisModel && (
            <p className="text-[10px] text-foreground-tertiary/60 text-right">
              Analyzed by {analysisModel}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
