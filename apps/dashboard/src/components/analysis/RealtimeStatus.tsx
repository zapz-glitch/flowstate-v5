'use client'

import { cn } from '@/lib/utils'
import type { AnalysisState, AnalysisStep, StatusMessage } from '@/types/analysis'
import { Button } from '@/components/ui/button'
import {
  CheckCircle2,
  XCircle,
  AlertCircle,
  RefreshCw,
  Clock,
  Loader2,
} from 'lucide-react'

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-[2px] ml-0.5">
      <span className="w-1 h-1 rounded-full bg-current animate-[bounce_1.4s_ease-in-out_0s_infinite]" />
      <span className="w-1 h-1 rounded-full bg-current animate-[bounce_1.4s_ease-in-out_0.2s_infinite]" />
      <span className="w-1 h-1 rounded-full bg-current animate-[bounce_1.4s_ease-in-out_0.4s_infinite]" />
    </span>
  )
}

const FRIENDLY_LABELS: Record<AnalysisStep, string> = {
  property_fetch: 'Analyzing subject property',
  appraisal_rules: 'Evaluating comparable sales',
  photo_fetch: 'Fetching property photos',
  comp_selection: 'Classifying properties',
  valuation: 'Calculating valuation',
  response_build: 'Finalizing results',
  vision_analysis: 'AI vision analysis',
}

function getStatusLabel(step: AnalysisStep | null): string {
  if (!step) return 'Starting analysis'
  return FRIENDLY_LABELS[step] ?? 'Processing'
}

interface RealtimeStatusProps {
  state: AnalysisState
  isConnecting?: boolean
  className?: string
  onCancel?: () => void
  onSwitchToPolling?: () => void
  usePolling?: boolean
}

export function RealtimeStatus({
  state,
  isConnecting,
  className,
  onCancel,
  onSwitchToPolling,
  usePolling,
}: RealtimeStatusProps) {
  const { status, currentStep, steps, totalDurationMs, error, isConnected } = state

  const completed = steps.filter((s) => s.status === 'completed' || s.status === 'skipped').length
  const inProgress = steps.filter((s) => s.status === 'in_progress').length
  const total = steps.length
  const percent = Math.round(((completed + inProgress * 0.5) / total) * 100)

  const isActive = status === 'processing' || status === 'queued'

  const statusText = status === 'completed'
    ? 'Analysis complete'
    : status === 'failed'
      ? 'Analysis failed'
      : getStatusLabel(currentStep)

  return (
    <div className={cn('rounded-xl overflow-hidden border border-border', className)}>
      <div className="px-6 py-5 space-y-4">
        {/* Status text */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            {status === 'completed' ? (
              <CheckCircle2 className="h-4.5 w-4.5 text-emerald-500 flex-shrink-0" />
            ) : status === 'failed' ? (
              <XCircle className="h-4.5 w-4.5 text-destructive flex-shrink-0" />
            ) : null}
            <span
              key={statusText}
              className={cn(
                'text-sm font-medium animate-in fade-in slide-in-from-bottom-1 duration-300',
                isActive && 'text-foreground',
                status === 'completed' && 'text-emerald-600',
                status === 'failed' && 'text-destructive',
              )}
            >
              {statusText}
              {isActive && <TypingDots />}
            </span>
          </div>
          {status === 'completed' && totalDurationMs != null && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {totalDurationMs < 1000
                ? `${totalDurationMs}ms`
                : `${(totalDurationMs / 1000).toFixed(1)}s`}
            </span>
          )}
        </div>

        {/* Progress bar */}
        {(status === 'processing' || status === 'queued') && (
          <div className="h-1.5 bg-muted rounded-full overflow-hidden relative">
            <div
              className="absolute inset-y-0 left-0 bg-primary rounded-full transition-all duration-700 ease-out"
              style={{ width: `${percent}%` }}
            />
            {inProgress > 0 && (
              <div
                className="absolute inset-y-0 bg-primary/30 rounded-full transition-all duration-700 ease-out overflow-hidden"
                style={{ left: `${Math.round((completed / total) * 100)}%`, width: `${Math.round((1 / total) * 100)}%` }}
              >
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-primary/50 to-transparent animate-shimmer" />
              </div>
            )}
          </div>
        )}

        {/* Error display */}
        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10">
            <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
            <p className="text-sm text-destructive/80">{error}</p>
          </div>
        )}

        {/* Switch to polling fallback */}
        {status === 'processing' && !isConnected && !usePolling && onSwitchToPolling && (
          <Button variant="outline" size="sm" onClick={onSwitchToPolling}>
            <RefreshCw className="h-3 w-3 mr-1" />
            Switch to Polling
          </Button>
        )}
      </div>
    </div>
  )
}

// ─── Compact Status ───────────────────────────────────────────────────────────

interface CompactStatusProps {
  state: AnalysisState
  className?: string
}

export function CompactStatus({ state, className }: CompactStatusProps) {
  const { status, currentStep } = state

  if (!status || status === 'queued') {
    return (
      <div className={cn('flex items-center gap-2 text-muted-foreground', className)}>
        <Clock className="h-4 w-4" />
        <span className="text-sm">Waiting to start...</span>
      </div>
    )
  }

  if (status === 'processing') {
    return (
      <div className={cn('flex items-center gap-2', className)}>
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        <span className="text-sm font-medium">{getStatusLabel(currentStep)}</span>
      </div>
    )
  }

  if (status === 'completed') {
    return (
      <div className={cn('flex items-center gap-2 text-emerald-600', className)}>
        <CheckCircle2 className="h-4 w-4" />
        <span className="text-sm font-medium">Analysis Complete</span>
      </div>
    )
  }

  if (status === 'failed') {
    return (
      <div className={cn('flex items-center gap-2 text-destructive', className)}>
        <XCircle className="h-4 w-4" />
        <span className="text-sm font-medium">Analysis Failed</span>
      </div>
    )
  }

  return null
}

// ─── Message Log ──────────────────────────────────────────────────────────────

interface MessageLogProps {
  messages: StatusMessage[]
  maxMessages?: number
  className?: string
}

export function MessageLog({ messages, maxMessages = 10, className }: MessageLogProps) {
  const displayMessages = messages.slice(-maxMessages)

  return (
    <div className={cn('space-y-1 font-mono text-xs', className)}>
      {displayMessages.map((msg, i) => (
        <div key={i} className="flex items-start gap-2 text-muted-foreground">
          <span className="text-muted-foreground/50 flex-shrink-0">
            {new Date(msg.timestamp).toLocaleTimeString()}
          </span>
          <span
            className={cn(
              msg.type === 'job_completed' && 'text-emerald-600',
              msg.type === 'job_failed' && 'text-destructive',
              msg.type === 'cache_hit' && 'text-blue-600',
              msg.type === 'step_failed' && 'text-amber-600'
            )}
          >
            [{msg.type}] {JSON.stringify(msg.data)}
          </span>
        </div>
      ))}
    </div>
  )
}
