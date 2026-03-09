'use client'

import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import type { AnalysisState, StatusMessage, JobStatus } from '@/types/analysis'
import { getStepConfig } from '@/types/analysis'
import { ProgressStepper, ProgressBar } from './ProgressStepper'
import { Button } from '@/components/ui/button'
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Zap,
  Wifi,
  WifiOff,
  AlertCircle,
  RefreshCw,
} from 'lucide-react'

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
  const { status, currentStep, steps, totalDurationMs, error, isConnected, messages } = state

  const getStatusBadge = (status: JobStatus | null) => {
    switch (status) {
      case 'queued':
        return (
          <Badge variant="secondary" className="gap-1">
            <Clock className="h-3 w-3" />
            Queued
          </Badge>
        )
      case 'processing':
        return (
          <Badge variant="default" className="gap-1 bg-primary">
            <Loader2 className="h-3 w-3 animate-spin" />
            Processing
          </Badge>
        )
      case 'completed':
        return (
          <Badge variant="default" className="gap-1 bg-emerald-500">
            <CheckCircle2 className="h-3 w-3" />
            Completed
          </Badge>
        )
      case 'failed':
        return (
          <Badge variant="destructive" className="gap-1">
            <XCircle className="h-3 w-3" />
            Failed
          </Badge>
        )
      default:
        return null
    }
  }

  // Calculate stats
  const completedSteps = steps.filter((s) => s.status === 'completed').length
  const skippedSteps = steps.filter((s) => s.status === 'skipped').length
  const cacheHits = steps.filter((s) => s.fromCache).length
  const failedSteps = steps.filter((s) => s.status === 'failed').length

  return (
    <div className={cn('rounded-xl overflow-hidden border border-border', className)}>
      <div className="px-6 py-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
              <Zap className="w-4 h-4 text-primary" />
            </div>
            <h3 className="text-body font-semibold">Analysis Progress</h3>
          </div>
          <div className="flex items-center gap-2">
            {/* Connection status */}
            {usePolling ? (
              <Badge variant="outline" className="gap-1 text-blue-600 border-blue-600 bg-blue-50 dark:bg-blue-500/10">
                <RefreshCw className="h-3 w-3" />
                Polling
              </Badge>
            ) : isConnecting ? (
              <Badge variant="outline" className="gap-1 bg-background/50">
                <Loader2 className="h-3 w-3 animate-spin" />
                Connecting
              </Badge>
            ) : isConnected ? (
              <Badge variant="outline" className="gap-1 text-emerald-600 border-emerald-600 bg-emerald-50 dark:bg-emerald-500/10">
                <Wifi className="h-3 w-3" />
                Live
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1 text-muted-foreground bg-background/50">
                <WifiOff className="h-3 w-3" />
                Offline
              </Badge>
            )}
            {/* Job status */}
            {getStatusBadge(status)}
          </div>
        </div>

        {/* Progress bar */}
        <ProgressBar steps={steps} />

        {/* Step details */}
        <ProgressStepper steps={steps} currentStep={currentStep} />

        {/* Error display */}
        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-destructive/10">
            <AlertCircle className="h-5 w-5 text-destructive flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-destructive">Analysis Failed</p>
              <p className="text-xs text-destructive/80 mt-0.5">{error}</p>
            </div>
          </div>
        )}

        {/* Actions (when processing) */}
        {status === 'processing' && (onCancel || onSwitchToPolling) && (
          <div className="flex items-center gap-2 pt-2">
            {!isConnected && !usePolling && onSwitchToPolling && (
              <Button variant="outline" size="sm" onClick={onSwitchToPolling}>
                <RefreshCw className="h-3 w-3 mr-1" />
                Switch to Polling
              </Button>
            )}
          </div>
        )}

        {/* Summary stats (when completed) */}
        {status === 'completed' && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
            <StatCard
              label="Total Time"
              value={
                totalDurationMs
                  ? totalDurationMs < 1000
                    ? `${totalDurationMs}ms`
                    : `${(totalDurationMs / 1000).toFixed(1)}s`
                  : '-'
              }
              icon={<Clock className="h-4 w-4" />}
            />
            <StatCard
              label="Steps"
              value={`${completedSteps}/${steps.length}`}
              subtext={skippedSteps > 0 ? `${skippedSteps} skipped` : undefined}
              icon={<CheckCircle2 className="h-4 w-4" />}
            />
            <StatCard
              label="Cache Hits"
              value={cacheHits.toString()}
              className={cacheHits > 0 ? 'text-blue-600' : ''}
              icon={<Zap className="h-4 w-4" />}
            />
            {failedSteps > 0 && (
              <StatCard
                label="Failed"
                value={failedSteps.toString()}
                className="text-destructive"
                icon={<XCircle className="h-4 w-4" />}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Stat Card ────────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string
  value: string
  subtext?: string
  icon?: React.ReactNode
  className?: string
}

function StatCard({ label, value, subtext, icon, className }: StatCardProps) {
  return (
    <div className={cn('p-3 rounded-xl bg-muted/40', className)}>
      <div className="flex items-center gap-2 text-muted-foreground mb-1">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <p className="text-lg font-semibold">{value}</p>
      {subtext && <p className="text-xs text-muted-foreground">{subtext}</p>}
    </div>
  )
}

// ─── Compact Status ───────────────────────────────────────────────────────────

interface CompactStatusProps {
  state: AnalysisState
  className?: string
}

export function CompactStatus({ state, className }: CompactStatusProps) {
  const { status, currentStep, steps } = state
  const currentConfig = currentStep ? getStepConfig(currentStep) : null
  const completedCount = steps.filter(
    (s) => s.status === 'completed' || s.status === 'skipped'
  ).length

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
      <div className={cn('flex items-center gap-3', className)}>
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span className="text-sm font-medium">{currentConfig?.label || 'Processing'}</span>
        </div>
        <span className="text-xs text-muted-foreground">
          Step {completedCount + 1}/{steps.length}
        </span>
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
