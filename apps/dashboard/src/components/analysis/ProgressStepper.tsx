'use client'

import { cn } from '@/lib/utils'
import type { StepProgress, AnalysisStep } from '@/types/analysis'
import { STEP_CONFIGS, getStepConfig } from '@/types/analysis'
import { CheckCircle2, Circle, Loader2, XCircle, SkipForward, Zap } from 'lucide-react'

interface ProgressStepperProps {
  steps: StepProgress[]
  currentStep: AnalysisStep | null
  className?: string
  compact?: boolean
}

export function ProgressStepper({
  steps,
  currentStep,
  className,
  compact = false,
}: ProgressStepperProps) {
  const getStepIcon = (step: StepProgress, config: ReturnType<typeof getStepConfig>) => {
    switch (step.status) {
      case 'completed':
        return (
          <div className={cn(
            'flex items-center justify-center w-8 h-8 rounded-full transition-all duration-500',
            step.fromCache ? 'bg-blue-500 text-white' : 'bg-emerald-500 text-white'
          )}>
            {step.fromCache ? (
              <Zap className="h-4 w-4" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
          </div>
        )
      case 'in_progress':
        return (
          <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground animate-pulse">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        )
      case 'failed':
        return (
          <div className="flex items-center justify-center w-8 h-8 rounded-full bg-destructive text-destructive-foreground">
            <XCircle className="h-4 w-4" />
          </div>
        )
      case 'skipped':
        return (
          <div className="flex items-center justify-center w-8 h-8 rounded-full bg-muted text-muted-foreground">
            <SkipForward className="h-4 w-4" />
          </div>
        )
      default:
        return (
          <div className="flex items-center justify-center w-8 h-8 rounded-full border-2 border-muted text-muted-foreground/50 bg-background">
            <span className="text-sm">{config?.icon || '○'}</span>
          </div>
        )
    }
  }

  if (compact) {
    return (
      <div className={cn('flex items-center gap-2', className)}>
        {steps.map((step, index) => {
          const config = getStepConfig(step.step)
          const isActive = step.step === currentStep

          return (
            <div key={step.step} className="flex items-center">
              <div
                className={cn(
                  'transition-all duration-300',
                  isActive && 'scale-110'
                )}
                title={`${config?.label || step.step}: ${step.status}${step.fromCache ? ' (cached)' : ''}`}
              >
                {getStepIcon(step, config)}
              </div>
              {index < steps.length - 1 && (
                <div className={cn(
                  'w-6 h-0.5 mx-1 transition-all duration-500',
                  step.status === 'completed' || step.status === 'skipped'
                    ? step.fromCache ? 'bg-blue-500' : 'bg-emerald-500'
                    : 'bg-muted'
                )} />
              )}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className={cn('space-y-1', className)}>
      {steps.map((step, index) => {
        const config = getStepConfig(step.step)
        const isActive = step.step === currentStep
        const isPending = step.status === 'pending'

        return (
          <div
            key={step.step}
            className={cn(
              'flex items-center gap-3 p-3 rounded-xl transition-all duration-300',
              isActive && 'bg-primary/5 scale-[1.02]',
              step.status === 'completed' && !step.fromCache && 'bg-emerald-500/5',
              step.status === 'completed' && step.fromCache && 'bg-blue-500/5',
              step.status === 'failed' && 'bg-destructive/5',
              isPending && 'opacity-50'
            )}
          >
            {/* Step number/icon */}
            <div className="flex-shrink-0 relative">
              {getStepIcon(step, config)}
              {/* Pulse ring for active step */}
              {isActive && (
                <div className="absolute inset-0 rounded-full bg-primary/20 animate-ping" />
              )}
            </div>

            {/* Step content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h4 className={cn(
                    'text-sm font-medium transition-colors',
                    isActive && 'text-primary',
                    step.status === 'completed' && !step.fromCache && 'text-emerald-600',
                    step.status === 'completed' && step.fromCache && 'text-blue-600',
                    step.status === 'failed' && 'text-destructive',
                    isPending && 'text-muted-foreground'
                  )}>
                    {config?.label || step.step}
                  </h4>
                  {step.fromCache && step.status === 'completed' && (
                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-600 font-medium">
                      cached
                    </span>
                  )}
                </div>
                {step.durationMs !== undefined && step.status === 'completed' && (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {step.durationMs < 1000
                      ? `${step.durationMs}ms`
                      : `${(step.durationMs / 1000).toFixed(1)}s`}
                  </span>
                )}
              </div>
              <p className={cn(
                'text-xs mt-0.5 transition-colors',
                isActive ? 'text-primary/70' : 'text-muted-foreground'
              )}>
                {step.message || config?.description}
              </p>
              {step.error && (
                <p className="text-xs text-destructive mt-1">{step.error}</p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Progress Bar ─────────────────────────────────────────────────────────────

interface ProgressBarProps {
  steps: StepProgress[]
  className?: string
}

export function ProgressBar({ steps, className }: ProgressBarProps) {
  const completed = steps.filter(
    (s) => s.status === 'completed' || s.status === 'skipped'
  ).length
  const inProgress = steps.filter((s) => s.status === 'in_progress').length
  const total = steps.length
  const completedPercent = Math.round((completed / total) * 100)
  const progressPercent = Math.round(((completed + inProgress * 0.5) / total) * 100)

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          Step {completed + (inProgress > 0 ? 1 : 0)} of {total}
        </span>
        <span className="font-medium text-primary">{completedPercent}%</span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden relative">
        {/* Completed progress */}
        <div
          className="absolute inset-y-0 left-0 bg-primary rounded-full transition-all duration-500 ease-out"
          style={{ width: `${completedPercent}%` }}
        />
        {/* In-progress shimmer */}
        {inProgress > 0 && (
          <div
            className="absolute inset-y-0 bg-primary/30 rounded-full transition-all duration-500 ease-out overflow-hidden"
            style={{ left: `${completedPercent}%`, width: `${(100 / total)}%` }}
          >
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-primary/50 to-transparent animate-shimmer" />
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Compact Step Indicator ───────────────────────────────────────────────────

interface StepIndicatorProps {
  steps: StepProgress[]
  currentStep: AnalysisStep | null
  className?: string
}

export function StepIndicator({ steps, currentStep, className }: StepIndicatorProps) {
  const currentConfig = currentStep ? getStepConfig(currentStep) : null
  const completedCount = steps.filter(
    (s) => s.status === 'completed' || s.status === 'skipped'
  ).length
  const cacheHits = steps.filter((s) => s.fromCache).length

  return (
    <div className={cn('flex items-center justify-between p-3 rounded-xl bg-primary/5', className)}>
      <div className="flex items-center gap-3">
        <div className="relative">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
          <div className="absolute inset-0 rounded-full bg-primary/20 animate-ping" />
        </div>
        <div>
          <p className="text-sm font-medium text-primary">
            {currentConfig?.label || 'Processing...'}
          </p>
          <p className="text-xs text-muted-foreground">
            {currentConfig?.description}
          </p>
        </div>
      </div>
      <div className="text-right">
        <p className="text-sm font-medium">
          {completedCount}/{steps.length}
        </p>
        {cacheHits > 0 && (
          <p className="text-xs text-blue-600 flex items-center gap-1">
            <Zap className="h-3 w-3" />
            {cacheHits} cached
          </p>
        )}
      </div>
    </div>
  )
}
