'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useUser } from '@/components/auth/UserProvider'
import { getObservabilitySummary, getObservabilityRuns, type ObservabilitySummary, type ObservabilityRun } from '@/lib/admin-api'
import { Activity, CheckCircle2, AlertTriangle, XCircle, Loader2, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

const GRADE_STYLES = {
  pass: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
  warn: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
  fail: 'bg-red-500/10 text-red-400 border-red-500/20',
} as const

function GradeBadge({ grade }: { grade: 'pass' | 'warn' | 'fail' | null }) {
  if (!grade) return <span className="text-[10px] text-foreground-tertiary">—</span>
  return (
    <span className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium uppercase', GRADE_STYLES[grade])}>
      {grade === 'pass' ? <CheckCircle2 className="w-3 h-3" /> : grade === 'warn' ? <AlertTriangle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
      {grade}
    </span>
  )
}

function StatCard({ label, value, sub, icon: Icon }: { label: string; value: string; sub?: string; icon?: typeof Activity }) {
  return (
    <div className="border border-border rounded-sm px-4 py-3">
      <div className="flex items-center gap-1.5 text-[10px] text-foreground-tertiary uppercase tracking-wider">
        {Icon && <Icon className="w-3 h-3" />}
        {label}
      </div>
      <div className="text-xl font-bold tabular-nums mt-1">{value}</div>
      {sub && <div className="text-[10px] text-foreground-tertiary mt-0.5">{sub}</div>}
    </div>
  )
}

export default function ObservabilityPage() {
  const { user } = useUser()
  const router = useRouter()
  const [summary, setSummary] = useState<ObservabilitySummary | null>(null)
  const [runs, setRuns] = useState<ObservabilityRun[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (user && user.role !== 'admin') { router.replace('/dashboard'); return }
    if (!user) return
    Promise.all([getObservabilitySummary(), getObservabilityRuns(50)])
      .then(([s, r]) => { setSummary(s); setRuns(r.runs) })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [user, router])

  if (loading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-heading-lg text-foreground tracking-tight">Observability</h1>
        <p className="text-body text-foreground-tertiary mt-1">Evaluation traces, benchmark gates, and system evidence.</p>
      </div>

      {/* System evidence */}
      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <StatCard label="Runs" value={String(summary.total)} sub={`${summary.completed} completed · ${summary.failed} failed`} icon={Activity} />
          <StatCard label="Success rate" value={`${summary.successRate}%`} sub="completed / total" icon={CheckCircle2} />
          <StatCard label="Benchmark pass" value={`${summary.benchmarkRate}%`} sub={`${summary.benchmark.pass} pass · ${summary.benchmark.warn} warn · ${summary.benchmark.fail} fail`} icon={Activity} />
          <StatCard label="Vision verified" value={`${summary.visionVerifiedRate}%`} sub={`${summary.visionNaRate}% returned NA`} icon={CheckCircle2} />
          <StatCard label="Avg duration" value={summary.avgDurationMs ? `${(summary.avgDurationMs / 1000).toFixed(1)}s` : '—'} sub="per analysis" icon={Activity} />
        </div>
      )}

      {/* Fallback + error leaders — the actionable signals */}
      {summary && (summary.topFallbacks.length > 0 || summary.topErrors.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div className="border border-border rounded-sm">
            <div className="px-3 py-2 border-b border-border/30 text-[10px] font-semibold uppercase tracking-wider text-foreground-tertiary">Top fallbacks</div>
            <div className="divide-y divide-border/30">
              {summary.topFallbacks.map((f) => (
                <div key={f.code} className="px-3 py-1.5 flex items-center justify-between text-xs">
                  <span className="font-mono text-foreground-secondary">{f.code}</span>
                  <span className="tabular-nums text-foreground-tertiary">{f.count}×</span>
                </div>
              ))}
              {summary.topFallbacks.length === 0 && <div className="px-3 py-3 text-xs text-foreground-tertiary">No fallbacks recorded</div>}
            </div>
          </div>
          <div className="border border-border rounded-sm">
            <div className="px-3 py-2 border-b border-border/30 text-[10px] font-semibold uppercase tracking-wider text-foreground-tertiary">Top errors</div>
            <div className="divide-y divide-border/30">
              {summary.topErrors.map((e) => (
                <div key={e.code} className="px-3 py-1.5 flex items-center justify-between text-xs">
                  <span className="font-mono text-red-400">{e.code}</span>
                  <span className="tabular-nums text-foreground-tertiary">{e.count}×</span>
                </div>
              ))}
              {summary.topErrors.length === 0 && <div className="px-3 py-3 text-xs text-foreground-tertiary">No errors recorded</div>}
            </div>
          </div>
        </div>
      )}

      {/* Runs table */}
      <div className="border border-border rounded-sm overflow-hidden">
        <div className="px-3 py-2 border-b border-border/30 text-[10px] font-semibold uppercase tracking-wider text-foreground-tertiary">
          Recent analysis runs
        </div>
        <div className="divide-y divide-border/30">
          {runs.map((r) => (
            <Link
              key={r.jobId}
              href={`/dashboard/admin/observability/${encodeURIComponent(r.jobId)}`}
              className="px-3 py-2.5 flex items-center gap-3 hover:bg-secondary/30 transition-colors"
            >
              <GradeBadge grade={r.grade} />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate">{r.address || 'Unknown address'}</div>
                <div className="text-[10px] text-foreground-tertiary">
                  {r.status === 'error' ? (
                    <span className="text-red-400 font-mono">{r.errorCode ?? 'ERROR'}</span>
                  ) : (
                    <>
                      {r.arv ? `ARV $${Math.round(r.arv).toLocaleString()}` : '—'}
                      {r.compCount != null && ` · ${r.compCount} comps (${r.enabledCompCount ?? 0} passed)`}
                      {r.renovationLevelSource === 'vision' ? ' · vision' : r.visionStatus ? ` · vision ${r.visionStatus}` : ''}
                    </>
                  )}
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-[10px] text-foreground-tertiary tabular-nums">{r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}</div>
                <div className="text-[9px] text-foreground-tertiary">{new Date(r.createdAt).toLocaleString()}</div>
              </div>
              <ChevronRight className="w-3.5 h-3.5 text-foreground-tertiary flex-shrink-0" />
            </Link>
          ))}
          {runs.length === 0 && (
            <div className="px-3 py-8 text-center text-xs text-foreground-tertiary">
              No runs recorded yet — runs are captured after this build ships.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
