'use client'

import { useEffect, useState } from 'react'
import { getApiKeys, getUsageSummary, getUser, getUsageLogs, PLAN_LIMITS } from '@/lib/client-api'
import type { ApiKey, UsageSummary, User, UsageLog, Plan } from '@/lib/client-api'
import {
  Key,
  Activity,
  TrendingUp,
  Gauge,
  ArrowRight,
  Loader2,
  Copy,
  Check,
  AlertTriangle,
  BookOpen,
  Settings2,
  Zap,
  Clock,
  CheckCircle2,
  XCircle,
} from 'lucide-react'
import Link from 'next/link'
import { cn } from '@/lib/utils'

interface DashboardData {
  user: User
  keys: ApiKey[]
  usage: UsageSummary
  recentLogs: UsageLog[]
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    async function loadData() {
      try {
        const [user, keys, usage, logsRes] = await Promise.all([
          getUser(),
          getApiKeys(),
          getUsageSummary(),
          getUsageLogs(1, 5),
        ])
        setData({ user, keys, usage, recentLogs: logsRes.logs })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load data')
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [])

  const curlExample = `curl -X POST https://api.flowstate.homes/v1/analyze \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"address": "123 Main St, Tampa, FL 33607"}'`

  const copyCode = async () => {
    await navigator.clipboard.writeText(curlExample)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-purple-500" />
          <p className="text-sm text-muted-foreground">Loading dashboard...</p>
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center max-w-md">
          <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-4">
            <AlertTriangle className="w-6 h-6 text-red-500" />
          </div>
          <h3 className="text-lg font-semibold text-foreground mb-2">Failed to load data</h3>
          <p className="text-sm text-muted-foreground mb-4">{error || 'An unexpected error occurred'}</p>
          <button
            onClick={() => window.location.reload()}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-secondary text-foreground text-sm font-medium hover:bg-secondary/80 transition-colors"
          >
            Try again
          </button>
        </div>
      </div>
    )
  }

  const { user, keys, usage, recentLogs } = data
  const planLimits = PLAN_LIMITS[user.plan as Plan] || PLAN_LIMITS.free
  const usagePercent = usage.monthlyLimit > 0 ? Math.round((usage.currentUsage / usage.monthlyLimit) * 100) : 0
  const activeKeys = keys.filter((k) => k.isActive).length
  const avgResponseTime = recentLogs.length > 0
    ? Math.round(recentLogs.reduce((sum, l) => sum + (l.responseTimeMs || 0), 0) / recentLogs.length)
    : 0
  const successRate = recentLogs.length > 0
    ? Math.round((recentLogs.filter((l) => l.statusCode >= 200 && l.statusCode < 300).length / recentLogs.length) * 100)
    : 100

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-heading-lg text-foreground tracking-tight">Dashboard</h1>
          <p className="text-body text-foreground-tertiary">
            {user.plan.charAt(0).toUpperCase() + user.plan.slice(1)} plan — {usage.remaining.toLocaleString()} requests remaining
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Link
            href="/dashboard/api-hub"
            className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl border border-border text-foreground font-medium text-body hover:bg-secondary transition-colors"
          >
            <Key className="w-4 h-4" />
            API Hub
          </Link>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="API Keys"
          value={`${activeKeys}/${planLimits.maxApiKeys === -1 ? '\u221e' : planLimits.maxApiKeys}`}
          subtitle="active"
          icon={Key}
          color="purple"
          href="/dashboard/api-hub"
        />
        <StatCard
          title="Requests"
          value={usage.currentUsage.toLocaleString()}
          subtitle={`of ${usage.monthlyLimit === -1 ? 'unlimited' : usage.monthlyLimit.toLocaleString()}`}
          icon={Activity}
          color="emerald"
          href="/dashboard/api-hub?tab=usage"
        />
        <StatCard
          title="Quota Used"
          value={`${usagePercent}%`}
          subtitle={`resets ${new Date(usage.resetDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
          icon={Gauge}
          color={usagePercent >= 90 ? 'red' : usagePercent >= 75 ? 'amber' : 'emerald'}
        />
        <StatCard
          title="Success Rate"
          value={`${successRate}%`}
          subtitle={avgResponseTime > 0 ? `avg ${avgResponseTime}ms` : 'no requests yet'}
          icon={TrendingUp}
          color="blue"
        />
      </div>

      {/* Usage Progress Bar */}
      {usage.monthlyLimit > 0 && (
        <div className="rounded-2xl border border-border p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-body-sm font-medium text-foreground">Monthly Usage</span>
            <span className="text-caption text-foreground-tertiary">
              {usage.currentUsage.toLocaleString()} / {usage.monthlyLimit.toLocaleString()}
            </span>
          </div>
          <div className="w-full h-2.5 rounded-full bg-secondary overflow-hidden">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-500',
                usagePercent >= 90
                  ? 'bg-red-500'
                  : usagePercent >= 75
                    ? 'bg-amber-500'
                    : 'bg-emerald-500'
              )}
              style={{ width: `${Math.min(usagePercent, 100)}%` }}
            />
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Quick Start */}
        <div className="rounded-2xl border border-border overflow-hidden">
          <div className="px-6 py-4 border-b border-border">
            <h2 className="text-heading font-semibold text-foreground">Quick Start</h2>
            <p className="text-body-sm text-foreground-tertiary mt-0.5">Analyze a property in one API call</p>
          </div>

          <div className="p-5 space-y-5">
            {/* Steps */}
            <div className="space-y-4">
              <div className="flex gap-3">
                <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-purple-500/10 text-purple-500 flex items-center justify-center text-xs font-bold">1</div>
                <div className="flex-1 min-w-0">
                  <p className="text-body-sm font-medium text-foreground">Create an API key</p>
                  <Link href="/dashboard/api-hub" className="text-caption text-primary hover:underline inline-flex items-center gap-1 mt-0.5">
                    Go to API Hub <ArrowRight className="w-3 h-3" />
                  </Link>
                </div>
              </div>
              <div className="flex gap-3">
                <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-emerald-500/10 text-emerald-500 flex items-center justify-center text-xs font-bold">2</div>
                <div className="flex-1 min-w-0">
                  <p className="text-body-sm font-medium text-foreground">POST to <code className="text-xs bg-secondary px-1.5 py-0.5 rounded">/v1/analyze</code></p>
                  <p className="text-caption text-foreground-tertiary mt-0.5">Returns a job ID + property data immediately</p>
                </div>
              </div>
              <div className="flex gap-3">
                <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-blue-500/10 text-blue-500 flex items-center justify-center text-xs font-bold">3</div>
                <div className="flex-1 min-w-0">
                  <p className="text-body-sm font-medium text-foreground">Stream results via SSE or poll</p>
                  <p className="text-caption text-foreground-tertiary mt-0.5">Get ARV, comps, rehab costs, and recommendation</p>
                </div>
              </div>
            </div>

            {/* Code Example */}
            <div className="rounded-xl border border-border overflow-hidden bg-secondary/50">
              <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-secondary">
                <span className="text-caption text-foreground-tertiary font-mono">terminal</span>
                <button
                  onClick={copyCode}
                  className="flex items-center gap-1.5 text-caption text-foreground-tertiary hover:text-foreground transition-colors"
                >
                  {copied ? (
                    <>
                      <Check className="w-3 h-3 text-green-500" />
                      <span className="text-green-500">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      Copy
                    </>
                  )}
                </button>
              </div>
              <pre className="p-3 text-xs text-foreground/90 overflow-x-auto font-mono leading-relaxed">
                <code>{curlExample}</code>
              </pre>
            </div>
          </div>
        </div>

        {/* Quick Links + Recent Activity */}
        <div className="space-y-6">
          {/* Quick Links */}
          <div className="rounded-2xl border border-border overflow-hidden">
            <div className="px-6 py-4 border-b border-border">
              <h2 className="text-heading font-semibold text-foreground">Quick Links</h2>
            </div>
            <div className="divide-y divide-border">
              <QuickLink
                href="/dashboard/api-hub"
                icon={Key}
                title="API Hub"
                description="Manage keys, view usage, and configure integrations"
              />
              <QuickLink
                href="/dashboard/evaluation-settings"
                icon={Settings2}
                title="Evaluation Settings"
                description="Appraisal rules, rehab levels, deal parameters"
              />
              <QuickLink
                href="/docs"
                icon={BookOpen}
                title="API Documentation"
                description="Full API reference with Swagger UI"
              />
              <QuickLink
                href="/dashboard/reports"
                icon={Zap}
                title="Reports"
                description="View and share saved analysis reports"
              />
            </div>
          </div>

          {/* Recent Activity */}
          {recentLogs.length > 0 && (
            <div className="rounded-2xl border border-border overflow-hidden">
              <div className="px-6 py-4 border-b border-border flex items-center justify-between">
                <h2 className="text-heading font-semibold text-foreground">Recent Requests</h2>
                <Link href="/dashboard/api-hub?tab=usage" className="text-caption text-primary hover:underline inline-flex items-center gap-1">
                  View all <ArrowRight className="w-3 h-3" />
                </Link>
              </div>
              <div className="divide-y divide-border">
                {recentLogs.map((log) => (
                  <div key={log.id} className="px-5 py-3 flex items-center gap-3">
                    {log.statusCode >= 200 && log.statusCode < 300 ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                    ) : (
                      <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-body-sm text-foreground truncate">
                        {log.propertyAddress
                          ? `${log.propertyAddress}${log.propertyCity ? `, ${log.propertyCity}` : ''}${log.propertyState ? ` ${log.propertyState}` : ''}`
                          : `${log.method} ${log.endpoint}`}
                      </p>
                      <p className="text-caption text-foreground-tertiary">
                        {new Date(log.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {log.responseTimeMs && (
                        <span className="text-caption text-foreground-tertiary flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {log.responseTimeMs}ms
                        </span>
                      )}
                      <span className={cn(
                        'text-caption font-mono px-1.5 py-0.5 rounded',
                        log.statusCode >= 200 && log.statusCode < 300
                          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                          : 'bg-red-500/10 text-red-600 dark:text-red-400'
                      )}>
                        {log.statusCode}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function StatCard({
  title,
  value,
  subtitle,
  icon: Icon,
  color,
  href,
}: {
  title: string
  value: string
  subtitle?: string
  icon: React.ElementType
  color: 'purple' | 'emerald' | 'blue' | 'amber' | 'red' | 'slate'
  href?: string
}) {
  const colorStyles = {
    purple: { bg: 'bg-purple-500/10', icon: 'text-purple-500' },
    emerald: { bg: 'bg-emerald-500/10', icon: 'text-emerald-500' },
    blue: { bg: 'bg-blue-500/10', icon: 'text-blue-500' },
    amber: { bg: 'bg-amber-500/10', icon: 'text-amber-500' },
    red: { bg: 'bg-red-500/10', icon: 'text-red-500' },
    slate: { bg: 'bg-slate-500/10', icon: 'text-slate-500' },
  }

  const styles = colorStyles[color]

  const content = (
    <div
      className={cn(
        'rounded-2xl border border-border p-5 transition-all duration-200',
        href && 'hover:bg-border/20 cursor-pointer group'
      )}
    >
      <div className="flex items-start justify-between">
        <div className="space-y-1">
          <p className="text-caption text-foreground-tertiary">{title}</p>
          <p className="text-display-sm font-bold text-foreground tracking-tight">{value}</p>
          {subtitle && (
            <p className="text-caption text-foreground-tertiary">{subtitle}</p>
          )}
        </div>
        <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center', styles.bg)}>
          <Icon className={cn('w-5 h-5', styles.icon)} />
        </div>
      </div>
      {href && (
        <div className="mt-3 pt-3 border-t border-border flex items-center text-caption text-primary font-medium">
          View details
          <ArrowRight className="w-3.5 h-3.5 ml-1.5 transition-transform group-hover:translate-x-1" />
        </div>
      )}
    </div>
  )

  if (href) {
    return <Link href={href}>{content}</Link>
  }

  return content
}

function QuickLink({
  href,
  icon: Icon,
  title,
  description,
}: {
  href: string
  icon: React.ElementType
  title: string
  description: string
}) {
  return (
    <Link href={href} className="flex items-center gap-4 px-5 py-3.5 hover:bg-secondary/50 transition-colors group">
      <div className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center flex-shrink-0">
        <Icon className="w-4.5 h-4.5 text-foreground-tertiary" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-body-sm font-medium text-foreground">{title}</p>
        <p className="text-caption text-foreground-tertiary">{description}</p>
      </div>
      <ArrowRight className="w-4 h-4 text-foreground-tertiary opacity-0 group-hover:opacity-100 transition-opacity" />
    </Link>
  )
}
