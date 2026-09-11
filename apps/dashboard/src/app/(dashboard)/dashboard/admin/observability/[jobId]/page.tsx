'use client'

import { useEffect, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { useUser } from '@/components/auth/UserProvider'
import { getObservabilityRun, type ObservabilityRunDetail } from '@/lib/admin-api'
import { ArrowLeft, CheckCircle2, AlertTriangle, XCircle, Loader2, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'

const STATUS_ICON = { pass: CheckCircle2, warn: AlertTriangle, fail: XCircle } as const
const STATUS_COLOR = { pass: 'text-emerald-500', warn: 'text-amber-500', fail: 'text-red-400' } as const
const STEP_COLOR: Record<string, string> = {
  completed: 'text-emerald-500',
  fallback: 'text-amber-500',
  failed: 'text-red-400',
  error: 'text-red-400',
  skipped: 'text-foreground-tertiary',
}

export default function ObservabilityRunPage() {
  const { user } = useUser()
  const router = useRouter()
  const params = useParams()
  const jobId = decodeURIComponent(String(params.jobId))
  const [detail, setDetail] = useState<ObservabilityRunDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (user && user.role !== 'admin') { router.replace('/dashboard'); return }
    if (!user) return
    getObservabilityRun(jobId).then(setDetail).catch((e) => setError(e.message))
  }, [user, router, jobId])

  if (error) return <div className="p-8 text-sm text-red-400">{error}</div>
  if (!detail) return <div className="flex items-center justify-center py-20"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>

  const { run, reportId, responseSummary } = detail
  const val = responseSummary?.valuation as Record<string, unknown> | null | undefined
  const vision = responseSummary?.visionAssessment as Record<string, unknown> | null | undefined

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-5 max-w-5xl mx-auto">
      <Link href="/dashboard/admin/observability" className="inline-flex items-center gap-1.5 text-xs text-foreground-tertiary hover:text-foreground">
        <ArrowLeft className="w-3.5 h-3.5" /> Observability
      </Link>

      {/* Run header */}
      <div className="border border-border rounded-sm px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-base font-semibold truncate">{[run.propertyAddress, run.propertyCity, run.propertyState].filter(Boolean).join(', ') || 'Unknown'}</h1>
            <div className="text-[10px] text-foreground-tertiary font-mono mt-0.5">{run.jobId} · {new Date(run.createdAt).toLocaleString()}</div>
          </div>
          {run.eval && (
            <span className={cn('inline-flex items-center gap-1 px-2 py-1 rounded border text-xs font-semibold uppercase flex-shrink-0',
              run.eval.grade === 'pass' ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
              : run.eval.grade === 'warn' ? 'bg-amber-500/10 text-amber-500 border-amber-500/20'
              : 'bg-red-500/10 text-red-400 border-red-500/20')}>
              Benchmark: {run.eval.grade}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-foreground-secondary">
          <span>Status: <span className={cn('font-medium', run.status === 'completed' ? 'text-emerald-500' : 'text-red-400')}>{run.status}</span></span>
          {run.errorCode && <span className="font-mono text-red-400">{run.errorCode}</span>}
          {run.durationMs != null && <span className="tabular-nums">{(run.durationMs / 1000).toFixed(1)}s</span>}
          {run.arv != null && <span className="tabular-nums">ARV ${Math.round(run.arv).toLocaleString()}</span>}
          {reportId && <Link href={`/dashboard/reports/${reportId}`} className="text-primary hover:underline">Open report →</Link>}
        </div>
        {run.errorMessage && <p className="mt-2 text-xs text-red-400">{run.errorMessage}</p>}
      </div>

      {/* Benchmark checks */}
      {run.eval && (
        <div className="border border-border rounded-sm">
          <div className="px-3 py-2 border-b border-border/30 text-[10px] font-semibold uppercase tracking-wider text-foreground-tertiary">
            Benchmark checks ({run.eval.checks.length})
          </div>
          <ul className="divide-y divide-border/30">
            {run.eval.checks.map((chk) => {
              const Icon = STATUS_ICON[chk.status]
              return (
                <li key={chk.key} className="px-3 py-2 flex items-start gap-2.5">
                  <Icon className={cn('w-3.5 h-3.5 mt-0.5 flex-shrink-0', STATUS_COLOR[chk.status])} />
                  <div className="min-w-0">
                    <div className="text-xs font-medium">{chk.label}</div>
                    <div className="text-[10px] text-foreground-tertiary">{chk.detail}</div>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* Execution trace */}
      {run.steps.length > 0 && (
        <div className="border border-border rounded-sm">
          <div className="px-3 py-2 border-b border-border/30 text-[10px] font-semibold uppercase tracking-wider text-foreground-tertiary">
            Execution trace ({run.steps.length} steps)
          </div>
          <ul className="divide-y divide-border/30">
            {run.steps.map((step, i) => (
              <li key={i} className="px-3 py-2 flex items-start gap-2.5">
                <span className={cn('text-[10px] font-mono font-semibold uppercase w-16 flex-shrink-0 pt-0.5', STEP_COLOR[step.status] ?? 'text-foreground-tertiary')}>
                  {step.status}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-medium font-mono">{step.name}</div>
                  {step.detail && <div className="text-[10px] text-foreground-secondary mt-0.5">{step.detail}</div>}
                </div>
                {step.durationMs != null && <span className="text-[10px] text-foreground-tertiary tabular-nums flex-shrink-0">{(step.durationMs / 1000).toFixed(1)}s</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Fallbacks */}
      {run.fallbacks.length > 0 && (
        <div className="border border-border rounded-sm px-3 py-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-foreground-tertiary mb-1.5">Fallbacks used</div>
          <div className="flex flex-wrap gap-1.5">
            {run.fallbacks.map((f) => (
              <span key={f} className="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 border border-amber-500/20 text-[10px] font-mono">{f}</span>
            ))}
          </div>
        </div>
      )}

      {/* Subject + vision evidence */}
      {(responseSummary?.subject || vision) && (
        <div className="border border-border rounded-sm px-3 py-2.5 text-xs space-y-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-foreground-tertiary mb-1.5">Subject evidence</div>
          {responseSummary?.subject && (
            <>
              {(responseSummary.subject as Record<string, unknown>).condition != null && (
                <div>Condition: <span className="font-medium">{String((responseSummary.subject as Record<string, unknown>).condition)}</span></div>
              )}
              {(responseSummary.subject as Record<string, unknown>).curbAppeal != null && (() => {
                const ca = (responseSummary.subject as Record<string, unknown>).curbAppeal as Record<string, unknown>
                return <div>Curb appeal: <span className="font-medium">{String(ca.condition)} ({String(ca.source)}){ca.confidence != null ? ` @${ca.confidence}%` : ''}</span>{ca.summary != null && <span className="text-foreground-tertiary"> — {String(ca.summary)}</span>}</div>
              })()}
              <div className="text-foreground-tertiary">Photos: {String((responseSummary.subject as Record<string, unknown>).photoCount ?? 0)} · Provider: {String(responseSummary.photoProvider ?? '—')}</div>
            </>
          )}
          {vision && (
            <div className="text-foreground-tertiary">Vision: {String(vision.status)} · level {String(vision.renovationLevel ?? '—')} · confidence {String(vision.confidence ?? '—')}%</div>
          )}
        </div>
      )}

      {/* Comp evidence */}
      {responseSummary && responseSummary.comps.length > 0 && (
        <div className="border border-border rounded-sm">
          <div className="px-3 py-2 border-b border-border/30 text-[10px] font-semibold uppercase tracking-wider text-foreground-tertiary">
            Comparable evidence ({responseSummary.comps.length})
          </div>
          <ul className="divide-y divide-border/30">
            {responseSummary.comps.map((cmp, i) => (
              <li key={i} className="px-3 py-1.5 flex items-center gap-3 text-xs">
                <span className={cn('w-2 h-2 rounded-full flex-shrink-0',
                  cmp.compGroup === 'arv' ? 'bg-emerald-500' : cmp.compGroup === 'as_is' ? 'bg-amber-500' : 'bg-neutral-600')} />
                <span className="flex-1 min-w-0 truncate">{String(cmp.address)}</span>
                {cmp.curbAppeal != null && (() => {
                  const ca = cmp.curbAppeal as Record<string, unknown>
                  return <span className="text-[10px] text-foreground-secondary flex-shrink-0">{String(ca.condition)}{ca.source === 'price' ? ' (price)' : ''}</span>
                })()}
                <span className="text-[10px] tabular-nums text-foreground-tertiary flex-shrink-0">
                  {cmp.salePrice != null ? `$${Number(cmp.salePrice).toLocaleString()}` : '—'}
                </span>
                {cmp.isEnabled ? <CheckCircle2 className="w-3 h-3 text-emerald-500 flex-shrink-0" /> : <Minus className="w-3 h-3 text-foreground-tertiary flex-shrink-0" />}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* API call stats */}
      {responseSummary?.apiCallStats && (
        <div className="border border-border rounded-sm px-3 py-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-foreground-tertiary mb-1.5">External calls</div>
          <pre className="text-[10px] font-mono text-foreground-secondary overflow-x-auto">{JSON.stringify(responseSummary.apiCallStats, null, 2)}</pre>
        </div>
      )}
    </div>
  )
}
