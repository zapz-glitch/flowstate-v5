import Link from 'next/link'
import { getUsageLogs, getApiKeys } from '@/lib/api'
import { FileText, ChevronLeft, ChevronRight, Key } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import LogsFilters from './LogsFilters'

const LOGS_PER_PAGE = 50

interface SearchParams {
  page?: string
  apiKeyId?: string
}

async function getLogsData(searchParams: SearchParams) {
  try {
    const page = parseInt(searchParams.page || '1', 10)
    const apiKeyId = searchParams.apiKeyId || undefined

    const [logsResponse, apiKeys] = await Promise.all([
      getUsageLogs(page, LOGS_PER_PAGE, apiKeyId),
      getApiKeys(),
    ])

    return {
      logs: logsResponse.logs,
      pagination: {
        page: logsResponse.pagination.page,
        totalPages: logsResponse.pagination.totalPages,
        totalLogs: logsResponse.pagination.total,
        hasNext: logsResponse.pagination.page < logsResponse.pagination.totalPages,
        hasPrev: logsResponse.pagination.page > 1,
      },
      apiKeys,
      selectedApiKeyId: apiKeyId,
    }
  } catch {
    return null
  }
}

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const data = await getLogsData(params)

  if (!data) {
    return <div>Loading...</div>
  }

  // Create a map of API key IDs to names for display
  const apiKeyNames: Record<string, string> = {}
  data.apiKeys.forEach((key) => {
    apiKeyNames[key.id] = key.name
  })

  return (
    <div className="space-y-10 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex items-end justify-between">
        <div className="space-y-1">
          <h1 className="text-heading-lg text-foreground tracking-tight">API Logs</h1>
          <p className="text-body text-foreground-tertiary">
            Browse and inspect your API request history
          </p>
        </div>
        <p className="text-body-sm text-foreground-tertiary">
          {data.pagination.totalLogs.toLocaleString()} total logs
        </p>
      </div>

      {/* Filters */}
      <LogsFilters
        apiKeys={data.apiKeys}
        selectedApiKeyId={data.selectedApiKeyId}
      />

      {/* Logs table */}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-secondary/30">
                <th className="text-left px-6 py-3 text-caption font-medium text-foreground-tertiary">
                  Time
                </th>
                <th className="text-left px-6 py-3 text-caption font-medium text-foreground-tertiary">
                  API Key
                </th>
                <th className="text-left px-6 py-3 text-caption font-medium text-foreground-tertiary">
                  Method
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
                <th className="text-left px-6 py-3 text-caption font-medium text-foreground-tertiary">
                  Address
                </th>
                <th className="text-left px-6 py-3 text-caption font-medium text-foreground-tertiary">
                  Details
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {data.logs.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center">
                    <FileText className="w-12 h-12 mx-auto mb-3 text-foreground-tertiary opacity-50" />
                    <p className="text-body text-foreground-secondary">No logs found</p>
                    <p className="text-body-sm text-foreground-tertiary mt-1">
                      {data.selectedApiKeyId
                        ? 'No logs for this API key. Try selecting a different key or clear the filter.'
                        : 'Make some API requests to see them here'}
                    </p>
                  </td>
                </tr>
              ) : (
                data.logs.map((log) => (
                  <tr
                    key={log.id}
                    className="hover:bg-secondary/30 transition-colors"
                  >
                    <td className="px-6 py-4 text-body-sm text-foreground-secondary whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleString()}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-1.5">
                        <Key className="w-3 h-3 text-foreground-tertiary" />
                        <span className="text-caption text-foreground-secondary truncate max-w-[100px]">
                          {log.apiKeyId ? (apiKeyNames[log.apiKeyId] || log.apiKeyId.slice(0, 8)) : 'Dashboard'}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-caption-sm font-medium',
                          log.method === 'GET' && 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
                          log.method === 'POST' && 'bg-blue-500/10 text-blue-600 border-blue-500/30',
                          log.method === 'PUT' && 'bg-amber-500/10 text-amber-600 border-amber-500/30',
                          log.method === 'DELETE' && 'bg-red-500/10 text-red-600 border-red-500/30',
                          !['GET', 'POST', 'PUT', 'DELETE'].includes(log.method) && 'bg-secondary text-foreground-tertiary'
                        )}
                      >
                        {log.method}
                      </Badge>
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
                    <td className="px-6 py-4 text-body-sm text-foreground-secondary max-w-[200px] truncate">
                      {log.propertyAddress || '-'}
                    </td>
                    <td className="px-6 py-4">
                      <Link
                        href={`/dashboard/logs/${log.id}`}
                        className="text-body-sm text-primary hover:text-primary/80 transition-colors"
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data.pagination.totalPages > 1 && (
          <div className="flex items-center justify-between px-6 py-4 border-t border-border">
            <p className="text-body-sm text-foreground-tertiary">
              Page {data.pagination.page} of {data.pagination.totalPages}
            </p>
            <div className="flex items-center gap-2">
              {data.pagination.hasPrev ? (
                <Link
                  href={`/dashboard/logs?page=${data.pagination.page - 1}${data.selectedApiKeyId ? `&apiKeyId=${data.selectedApiKeyId}` : ''}`}
                  className="flex items-center gap-1 px-3 py-1.5 text-body-sm text-foreground-secondary hover:bg-secondary rounded-lg transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Previous
                </Link>
              ) : (
                <span className="flex items-center gap-1 px-3 py-1.5 text-body-sm text-foreground-tertiary/50 cursor-not-allowed">
                  <ChevronLeft className="w-4 h-4" />
                  Previous
                </span>
              )}
              {data.pagination.hasNext ? (
                <Link
                  href={`/dashboard/logs?page=${data.pagination.page + 1}${data.selectedApiKeyId ? `&apiKeyId=${data.selectedApiKeyId}` : ''}`}
                  className="flex items-center gap-1 px-3 py-1.5 text-body-sm text-foreground-secondary hover:bg-secondary rounded-lg transition-colors"
                >
                  Next
                  <ChevronRight className="w-4 h-4" />
                </Link>
              ) : (
                <span className="flex items-center gap-1 px-3 py-1.5 text-body-sm text-foreground-tertiary/50 cursor-not-allowed">
                  Next
                  <ChevronRight className="w-4 h-4" />
                </span>
              )}
            </div>
          </div>
        )}
      </Card>
    </div>
  )
}
