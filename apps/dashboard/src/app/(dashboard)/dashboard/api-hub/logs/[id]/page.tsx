import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getUsageLogDetail } from '@/lib/api'
import { ArrowLeft, Clock, Globe, Monitor, Key } from 'lucide-react'
import { JsonViewer } from '@/components/JsonViewer'

async function getLogDetail(logId: string) {
  try {
    return await getUsageLogDetail(logId)
  } catch {
    return null
  }
}

export default async function LogDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const log = await getLogDetail(id)

  if (!log) {
    notFound()
  }

  const statusColor =
    log.statusCode >= 200 && log.statusCode < 300
      ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
      : log.statusCode >= 400
        ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
        : 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400'

  const methodColor =
    log.method === 'GET'
      ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
      : log.method === 'POST'
        ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
        : log.method === 'PUT'
          ? 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400'
          : log.method === 'DELETE'
            ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
            : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-400'

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link
          href="/dashboard/api-hub"
          className="flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to API Hub
        </Link>
      </div>

      <div>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-white">Request Details</h1>
        <p className="text-neutral-600 dark:text-neutral-400 mt-1">
          {new Date(log.createdAt).toLocaleString()}
        </p>
      </div>

      {/* Summary card */}
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
          <div>
            <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-1">
              Method
            </p>
            <span
              className={`inline-flex items-center px-2.5 py-1 rounded text-sm font-medium ${methodColor}`}
            >
              {log.method}
            </span>
          </div>
          <div>
            <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-1">
              Status
            </p>
            <span
              className={`inline-flex items-center px-2.5 py-1 rounded-full text-sm font-medium ${statusColor}`}
            >
              {log.statusCode}
            </span>
          </div>
          <div>
            <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-1">
              Response Time
            </p>
            <p className="text-lg font-semibold text-neutral-900 dark:text-white">
              {log.responseTimeMs ? `${log.responseTimeMs}ms` : '-'}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-1">
              Endpoint
            </p>
            <code className="text-sm text-neutral-700 dark:text-neutral-300 font-mono">
              {log.endpoint}
            </code>
          </div>
        </div>
      </div>

      {/* Metadata */}
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-6">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-white mb-4">
          Request Metadata
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-start gap-3">
            <Key className="w-5 h-5 text-neutral-400 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-neutral-900 dark:text-white">API Key ID</p>
              <p className="text-sm text-neutral-600 dark:text-neutral-400 font-mono">
                {log.apiKeyId}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Clock className="w-5 h-5 text-neutral-400 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-neutral-900 dark:text-white">Timestamp</p>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                {new Date(log.createdAt).toISOString()}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Globe className="w-5 h-5 text-neutral-400 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-neutral-900 dark:text-white">IP Address</p>
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                {log.ipAddress || 'Unknown'}
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <Monitor className="w-5 h-5 text-neutral-400 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-neutral-900 dark:text-white">User Agent</p>
              <p className="text-sm text-neutral-600 dark:text-neutral-400 break-all">
                {log.userAgent || 'Unknown'}
              </p>
            </div>
          </div>
        </div>

        {log.propertyAddress && (
          <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-800">
            <p className="text-sm font-medium text-neutral-900 dark:text-white mb-1">Property</p>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              {log.propertyAddress}
              {log.propertyCity && `, ${log.propertyCity}`}
              {log.propertyState && `, ${log.propertyState}`}
            </p>
          </div>
        )}

        {log.errorMessage && (
          <div className="mt-4 pt-4 border-t border-neutral-200 dark:border-neutral-800">
            <p className="text-sm font-medium text-red-600 dark:text-red-400 mb-1">Error Message</p>
            <p className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-3 rounded-lg">
              {log.errorMessage}
            </p>
          </div>
        )}
      </div>

      {/* Request Headers */}
      <JsonViewer title="Request Headers" data={log.requestHeaders} defaultCollapsed={true} />

      {/* Request Body */}
      <JsonViewer title="Request Body" data={log.requestBody} defaultCollapsed={false} />

      {/* Response Body */}
      <JsonViewer
        title="Response Body"
        data={log.responseBody}
        defaultCollapsed={false}
        maxHeight="600px"
      />
    </div>
  )
}
