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
  const [data, setData] = useState<Partial<DashboardData>>({})
  const [errors, setErrors] = useState<Partial<Record<keyof DashboardData, string>>>({})
  const [attempt, setAttempt] = useState(0)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    setErrors({})
    function load<K extends keyof DashboardData>(key: K, request: Promise<DashboardData[K]>) {
      void request.then((value) => {
        if (!cancelled) setData((current) => ({ ...current, [key]: value }))
      }).catch((err: unknown) => {
        if (!cancelled) setErrors((current) => ({
          ...current,
          [key]: err instanceof Error ? err.message : 'Failed to load data',
        }))
      })
    }
    load('user', getUser())
    load('keys', getApiKeys())
    load('usage', getUsageSummary())
    load('recentLogs', getUsageLogs(1, 5).then((result) => result.logs))
    return () => { cancelled = true }
  }, [attempt])

  const curlExample = `curl -X POST https://api.flowstate.homes/v1/analyze \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"address": "123 Main St, Tampa, FL 33607"}'`

  const copyCode = async () => {
    await navigator.clipboard.writeText(curlExample)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const { user, keys, usage, recentLogs } = data
  const planLimits = user ? PLAN_LIMITS[user.plan as Plan] || PLAN_LIMITS.free : null
  const usagePercent = usage && usage.monthlyLimit > 0 ? Math.round((usage.currentUsage / usage.monthlyLimit) * 100) : 0
  const activeKeys = keys?.filter((k) => k.isActive).length
  const avgResponseTime = recentLogs?.length
    ? Math.round(recentLogs.reduce((sum, l) => sum + (l.responseTimeMs || 0), 0) / recentLogs.length)
    : 0
  const successRate = recentLogs?.length
    ? Math.round((recentLogs.filter((l) => l.statusCode >= 200 && l.statusCode < 300).length / recentLogs.length) * 100)
    : null
  const pendingLabel = (...sections: (keyof DashboardData)[]) =>
    sections.some((section) => errors[section]) ? 'Unavailable' : 'Loading…'

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-heading-lg text-foreground tracking-tight">Dashboard</h1>
          <p className="text-body text-foreground-tertiary">
            {user ? `${user.plan.charAt(0).toUpperCase()}${user.plan.slice(1)} plan` : 'Your account overview'}
            {usage ? ` — ${usage.remaining.toLocaleString()} requests remaining` : ''}
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

      {Object.keys(errors).length > 0 && (
        <div role="alert" className="flex items-center justify-between gap-4 rounded-xl border border-border p-4 text-body-sm">
          <span>Some account details couldn’t load. You can still use the dashboard.</span>
          <button onClick={() => setAttempt((value) => value + 1)} className="text-primary font-medium hover:underline shrink-0">
            Try again
          </button>
        </div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="API Keys"
          value={activeKeys !== undefined && planLimits ? `${activeKeys}/${planLimits.maxApiKeys === -1 ? '\u221e' : planLimits.maxApiKeys}` : '—'}
          subtitle={keys && planLimits ? 'active' : pendingLabel('keys', 'user')}
          icon={Key}
          color="neutral"
          href="/dashboard/api-hub"
        />
        <StatCard
          title="Requests"
          value={usage ? usage.currentUsage.toLocaleString() : '—'}
          subtitle={usage ? `of ${usage.monthlyLimit === -1 ? 'unlimited' : usage.monthlyLimit.toLocaleString()}` : pendingLabel('usage')}
          icon={Activity}
          color="emerald"
          href="/dashboard/api-hub?tab=usage"
        />
        <StatCard
          title="Quota Used"
          value={usage ? `${usagePercent}%` : '—'}
          subtitle={usage ? `resets ${new Date(usage.resetDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : pendingLabel('usage')}
          icon={Gauge}
          color={usagePercent >= 90 ? 'red' : usagePercent >= 75 ? 'amber' : 'emerald'}
        />
        <StatCard
          title="Success Rate"
          value={successRate !== null ? `${successRate}%` : '—'}
          subtitle={!recentLogs ? pendingLabel('recentLogs') : avgResponseTime > 0 ? `avg ${avgResponseTime}ms` : recentLogs.length ? 'recent requests' : 'no requests yet'}
          icon={TrendingUp}
          color="blue"
        />
      </div>

      {/* Usage Progress Bar */}
      {usage && usage.monthlyLimit > 0 && (
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

      {/* Rate-Limit Tracker */}
      {usage?.rateLimit && (
        <div className="rounded-2xl border border-border overflow-hidden">
          <div className="px-6 py-4 border-b border-border flex items-center justify-between">
            <div>
              <h2 className="text-heading font-semibold text-foreground">Rate Limits</h2>
              <p className="text-body-sm text-foreground-tertiary mt-0.5">
                Quota rejections and server errors from API + batch runs
              </p>
            </div>
            {usage.rateLimit.hits7d === 0 && usage.rateLimit.serverErrors24h === 0 ? (
              <span className="inline-flex items-center gap-1.5 text-caption font-medium text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-full">
                <CheckCircle2 className="w-3.5 h-3.5" /> Healthy
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-caption font-medium text-amber-600 dark:text-amber-400 bg-amber-500/10 px-2.5 py-1 rounded-full">
                <AlertTriangle className="w-3.5 h-3.5" /> Attention
              </span>
            )}
          </div>
          <div className="p-5">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
              <div>
                <p className="text-caption text-foreground-tertiary">429s — 24h</p>
                <p className={cn(
                  'text-display-sm font-bold tracking-tight',
                  usage.rateLimit.hits24h > 0 ? 'text-amber-500' : 'text-foreground'
                )}>
                  {usage.rateLimit.hits24h}
                </p>
              </div>
              <div>
                <p className="text-caption text-foreground-tertiary">429s — 7 days</p>
                <p className={cn(
                  'text-display-sm font-bold tracking-tight',
                  usage.rateLimit.hits7d > 0 ? 'text-amber-500' : 'text-foreground'
                )}>
                  {usage.rateLimit.hits7d}
                </p>
              </div>
              <div>
                <p className="text-caption text-foreground-tertiary">5xx — 24h</p>
                <p className={cn(
                  'text-display-sm font-bold tracking-tight',
                  usage.rateLimit.serverErrors24h > 0 ? 'text-red-500' : 'text-foreground'
                )}>
                  {usage.rateLimit.serverErrors24h}
                </p>
              </div>
              <div>
                <p className="text-caption text-foreground-tertiary">Provider calls — this month</p>
                <p className={cn(
                  'text-display-sm font-bold tracking-tight',
                  usage.providerCalls && usage.providerCalls.limit > 0 && usage.providerCalls.month >= usage.providerCalls.limit
                    ? 'text-red-500'
                    : usage.providerCalls && usage.providerCalls.limit > 0 && usage.providerCalls.month >= usage.providerCalls.limit * 0.8
                      ? 'text-amber-500'
                      : 'text-foreground'
                )}>
                  {usage.providerCalls?.month ?? 0}
                  {usage.providerCalls && usage.providerCalls.limit > 0 && (
                    <span className="text-body-sm font-normal text-foreground-tertiary"> / {usage.providerCalls.limit.toLocaleString()}</span>
                  )}
                </p>
              </div>
              <div>
                <p className="text-caption text-foreground-tertiary">Avg report time — lifetime</p>
                <p className="text-display-sm font-bold tracking-tight text-foreground">
                  {usage.analysisTiming?.avgMs != null
                    ? usage.analysisTiming.avgMs >= 60_000
                      ? `${Math.floor(usage.analysisTiming.avgMs / 60_000)}m ${Math.round((usage.analysisTiming.avgMs % 60_000) / 1000)}s`
                      : `${(usage.analysisTiming.avgMs / 1000).toFixed(1)}s`
                    : '—'}
                </p>
                <p className="text-caption text-foreground-tertiary">{usage.analysisTiming?.runs ?? 0} reports</p>
              </div>
            </div>
            {usage.rateLimit.recent.length > 0 && (
              <div className="mt-4 pt-4 border-t border-border space-y-2">
                <p className="text-caption text-foreground-tertiary font-medium">Recent rate-limit hits</p>
                {usage.rateLimit.recent.slice(0, 5).map((hit, i) => (
                  <div key={i} className="flex items-center gap-3 text-body-sm">
                    <XCircle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                    <span className="text-foreground truncate flex-1">
                      {hit.propertyAddress || hit.endpoint}
                    </span>
                    <span className="text-caption text-foreground-tertiary flex-shrink-0">
                      {new Date(hit.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </div>
                ))}
              </div>
            )}
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
                <div className="flex-shrink-0 w-7 h-7 rounded-md bg-secondary text-foreground flex items-center justify-center text-xs font-bold">1</div>
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
          {!recentLogs && (
            <div className="rounded-2xl border border-border p-5" role="status">
              <h2 className="text-heading font-semibold text-foreground">Recent Requests</h2>
              <p className="text-body-sm text-foreground-tertiary mt-2">{pendingLabel('recentLogs')}</p>
            </div>
          )}
          {recentLogs && recentLogs.length > 0 && (
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
  color: 'neutral' | 'emerald' | 'blue' | 'amber' | 'red' | 'slate'
  href?: string
}) {
  const colorStyles = {
    neutral: { bg: 'bg-secondary', icon: 'text-foreground' },
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
