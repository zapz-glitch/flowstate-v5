import { getApiKeys, getUsageSummary, getUsageLogs } from '@/lib/api'
import { PLAN_LIMITS } from '@/lib/client-api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

async function getUsageData() {
  try {
    const [keys, usage, logsResponse] = await Promise.all([
      getApiKeys(),
      getUsageSummary(),
      getUsageLogs(1, 100),
    ])

    const plan = usage.plan as keyof typeof PLAN_LIMITS
    const planLimits = PLAN_LIMITS[plan]

    // Calculate success rate from recent logs
    const successfulRequests = logsResponse.logs.filter(
      (l) => l.statusCode >= 200 && l.statusCode < 300
    ).length
    const successRate =
      logsResponse.logs.length > 0
        ? Math.round((successfulRequests / logsResponse.logs.length) * 100)
        : 100

    // Calculate average response time
    const responseTimes = logsResponse.logs
      .filter((l) => l.responseTimeMs)
      .map((l) => l.responseTimeMs!)
    const avgResponseTime =
      responseTimes.length > 0
        ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
        : 0

    return {
      keys,
      logs: logsResponse.logs,
      plan,
      planLimits,
      successRate,
      avgResponseTime,
      totalUsage: usage.currentUsage,
      accountQuota: usage.monthlyLimit === -1 ? null : usage.monthlyLimit,
    }
  } catch {
    return null
  }
}

export default async function UsagePage() {
  const data = await getUsageData()

  if (!data) {
    return <div>Loading...</div>
  }

  const quotaPercent = data.accountQuota
    ? Math.min(100, Math.round((data.totalUsage / data.accountQuota) * 100))
    : 0

  // Get requests today from logs
  const today = new Date().toISOString().split('T')[0]
  const requestsToday = data.logs.filter((l) => l.createdAt.startsWith(today)).length

  return (
    <div className="space-y-10 animate-in fade-in duration-500">
      {/* Header */}
      <div className="space-y-1">
        <h1 className="text-heading-lg text-foreground tracking-tight">Usage</h1>
        <p className="text-body text-foreground-tertiary">Monitor your API usage and requests</p>
      </div>

      {/* Account Quota Progress */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-heading font-semibold text-foreground">Account Quota</h2>
            <Badge variant="outline" className="capitalize">
              {data.plan} Plan
            </Badge>
          </div>
          <div className="flex items-baseline gap-2 mb-4">
            <span className="text-display-sm font-bold text-foreground">
              {data.totalUsage.toLocaleString()}
            </span>
            <span className="text-body text-foreground-tertiary">
              / {data.accountQuota ? data.accountQuota.toLocaleString() : 'Unlimited'} requests
            </span>
          </div>
          {data.accountQuota && (
            <div className="w-full bg-secondary rounded-full h-3">
              <div
                className={cn(
                  'h-3 rounded-full transition-all duration-500',
                  quotaPercent >= 90
                    ? 'bg-red-500'
                    : quotaPercent >= 75
                      ? 'bg-amber-500'
                      : 'bg-emerald-500'
                )}
                style={{ width: `${quotaPercent}%` }}
              />
            </div>
          )}
          {data.accountQuota && (
            <p className="text-body-sm text-foreground-tertiary mt-3">
              {data.accountQuota - data.totalUsage > 0
                ? `${(data.accountQuota - data.totalUsage).toLocaleString()} requests remaining`
                : 'Quota exceeded'}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
        <Card>
          <CardContent className="p-5">
            <p className="text-caption text-foreground-tertiary">Active Keys</p>
            <p className="text-display-sm font-bold text-foreground mt-2">
              {data.keys.filter((k) => k.isActive).length}
            </p>
            <p className="text-caption-sm text-foreground-tertiary mt-1">
              of {data.planLimits.maxApiKeys === -1 ? '∞' : data.planLimits.maxApiKeys} allowed
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <p className="text-caption text-foreground-tertiary">Requests Today</p>
            <p className="text-display-sm font-bold text-foreground mt-2">{requestsToday}</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <p className="text-caption text-foreground-tertiary">Success Rate</p>
            <p className="text-display-sm font-bold text-foreground mt-2">{data.successRate}%</p>
            <p className="text-caption-sm text-foreground-tertiary mt-1">2xx responses</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-5">
            <p className="text-caption text-foreground-tertiary">Avg Response Time</p>
            <p className="text-display-sm font-bold text-foreground mt-2">{data.avgResponseTime}ms</p>
          </CardContent>
        </Card>
      </div>

      {/* Per-Key Usage */}
      {data.keys.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Usage per API Key</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {data.keys.map((key) => {
              const keyQuota = key.monthlyQuota || data.planLimits.monthlyRequests
              const keyPercent =
                keyQuota === -1
                  ? 0
                  : Math.min(100, Math.round((key.currentUsage / keyQuota) * 100))
              return (
                <div key={key.id}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-body font-medium text-foreground">{key.name}</span>
                      <code className="text-caption-sm text-foreground-tertiary bg-secondary px-2 py-0.5 rounded-lg">
                        {key.keyPrefix}...
                      </code>
                      {!key.isActive && (
                        <Badge variant="outline" className="bg-red-500/10 text-red-600 border-red-500/30 text-caption-sm">
                          Disabled
                        </Badge>
                      )}
                    </div>
                    <span className="text-body-sm text-foreground-secondary">
                      {key.currentUsage.toLocaleString()}{' '}
                      {keyQuota !== -1 && `/ ${keyQuota.toLocaleString()}`}
                    </span>
                  </div>
                  {keyQuota !== -1 && (
                    <div className="w-full bg-secondary rounded-full h-2">
                      <div
                        className={cn(
                          'h-2 rounded-full transition-all duration-500',
                          keyPercent >= 90
                            ? 'bg-red-500'
                            : keyPercent >= 75
                              ? 'bg-amber-500'
                              : 'bg-primary'
                        )}
                        style={{ width: `${keyPercent}%` }}
                      />
                    </div>
                  )}
                  {key.lastUsedAt && (
                    <p className="text-caption-sm text-foreground-tertiary mt-1.5">
                      Last used: {new Date(key.lastUsedAt).toLocaleString()}
                    </p>
                  )}
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}

      {/* Recent requests */}
      <Card>
        <CardHeader className="border-b border-border">
          <CardTitle>Recent Requests</CardTitle>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-secondary/30">
                <th className="text-left px-6 py-3 text-caption font-medium text-foreground-tertiary">
                  Time
                </th>
                <th className="text-left px-6 py-3 text-caption font-medium text-foreground-tertiary">
                  Endpoint
                </th>
                <th className="text-left px-6 py-3 text-caption font-medium text-foreground-tertiary">
                  Status
                </th>
                <th className="text-left px-6 py-3 text-caption font-medium text-foreground-tertiary">
                  Response Time
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {data.logs.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-6 py-8 text-center text-body-sm text-foreground-tertiary">
                    No requests yet
                  </td>
                </tr>
              ) : (
                data.logs.slice(0, 20).map((log) => (
                  <tr key={log.id} className="hover:bg-secondary/30 transition-colors">
                    <td className="px-6 py-4 text-body-sm text-foreground-secondary">
                      {new Date(log.createdAt).toLocaleString()}
                    </td>
                    <td className="px-6 py-4">
                      <code className="text-body-sm text-foreground-secondary font-mono">
                        {log.endpoint}
                      </code>
                    </td>
                    <td className="px-6 py-4">
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-caption-sm',
                          log.statusCode >= 200 && log.statusCode < 300
                            ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30'
                            : log.statusCode >= 400
                              ? 'bg-red-500/10 text-red-600 border-red-500/30'
                              : 'bg-amber-500/10 text-amber-600 border-amber-500/30'
                        )}
                      >
                        {log.statusCode}
                      </Badge>
                    </td>
                    <td className="px-6 py-4 text-body-sm text-foreground-secondary">
                      {log.responseTimeMs ? `${log.responseTimeMs}ms` : '-'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
