'use client'

import { useEffect, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { useUser } from '@/components/auth/UserProvider'
import {
  getAdminUser,
  updateAdminUser,
  updateAdminApiKey,
  getAdminUserUsage,
  startImpersonation,
  type AdminUserDetail,
  type AdminUsageLog,
  type Pagination,
} from '@/lib/admin-api'
import { useImpersonation } from '@/components/auth/ImpersonationProvider'
import {
  ArrowLeft,
  Shield,
  Key,
  Activity,
  FileText,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  Eye,
} from 'lucide-react'

const PLAN_COLORS: Record<string, string> = {
  free: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  pro: 'bg-secondary text-foreground border-border',
  enterprise: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
}

export default function AdminUserDetailPage() {
  const { user: currentUser } = useUser()
  const { startImpersonating } = useImpersonation()
  const router = useRouter()
  const params = useParams()
  const userId = params.id as string

  const [detail, setDetail] = useState<AdminUserDetail | null>(null)
  const [logs, setLogs] = useState<AdminUsageLog[]>([])
  const [logsPagination, setLogsPagination] = useState<Pagination | null>(null)
  const [logsPage, setLogsPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState<'overview' | 'keys' | 'usage'>('overview')

  useEffect(() => {
    if (currentUser && currentUser.role !== 'admin') {
      router.replace('/dashboard')
      return
    }
    loadUserDetail()
  }, [currentUser, router, userId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (activeTab === 'usage') {
      loadUsageLogs()
    }
  }, [activeTab, logsPage, userId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadUserDetail() {
    setLoading(true)
    try {
      const data = await getAdminUser(userId)
      setDetail(data)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  async function loadUsageLogs() {
    try {
      const data = await getAdminUserUsage(userId, { page: logsPage })
      setLogs(data.logs)
      setLogsPagination(data.pagination)
    } catch (err) {
      console.error(err)
    }
  }

  async function handleUpdateUser(updates: { plan?: string; role?: string }) {
    setSaving(true)
    try {
      await updateAdminUser(userId, updates)
      await loadUserDetail()
    } catch (err) {
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  async function handleToggleKeyActive(keyId: string, isActive: boolean) {
    try {
      await updateAdminApiKey(userId, keyId, { isActive })
      await loadUserDetail()
    } catch (err) {
      console.error(err)
    }
  }

  async function handleResetKeyUsage(keyId: string) {
    try {
      await updateAdminApiKey(userId, keyId, { currentUsage: 0 })
      await loadUserDetail()
    } catch (err) {
      console.error(err)
    }
  }

  async function handleImpersonate() {
    try {
      const result = await startImpersonation(userId)
      startImpersonating(result.impersonating, result.admin)
    } catch (err) {
      console.error('Failed to start impersonation:', err)
    }
  }

  if (loading || !detail) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-foreground" />
      </div>
    )
  }

  const { user: targetUser, apiKeys, usage, subscription, totalReports } = detail

  const tabs = [
    { id: 'overview' as const, label: 'Overview', icon: Activity },
    { id: 'keys' as const, label: `API Keys (${apiKeys.length})`, icon: Key },
    { id: 'usage' as const, label: 'Usage Logs', icon: FileText },
  ]

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Link
          href="/dashboard/admin/users"
          className="mt-1 p-2 rounded-lg border border-border hover:bg-secondary transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-heading-lg font-bold">{targetUser.name}</h1>
            {targetUser.role === 'admin' && (
              <span className="flex items-center gap-1 text-caption bg-amber-500/10 text-amber-400 px-2 py-0.5 rounded-full">
                <Shield className="w-3 h-3" />
                Admin
              </span>
            )}
          </div>
          <p className="text-foreground-secondary mt-0.5">{targetUser.email}</p>
          <p className="text-caption text-foreground-tertiary mt-1">
            Joined {new Date(targetUser.createdAt).toLocaleDateString()}
          </p>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="flex flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <label className="text-body-sm text-foreground-secondary">Plan:</label>
          <select
            value={targetUser.plan}
            onChange={(e) => handleUpdateUser({ plan: e.target.value })}
            disabled={saving}
            className={`text-body-sm font-medium px-3 py-1.5 rounded-lg border ${PLAN_COLORS[targetUser.plan] || PLAN_COLORS.free} bg-transparent cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50`}
          >
            <option value="free">Free</option>
            <option value="pro">Pro</option>
            <option value="enterprise">Enterprise</option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-body-sm text-foreground-secondary">Role:</label>
          <select
            value={targetUser.role}
            onChange={(e) => handleUpdateUser({ role: e.target.value })}
            disabled={saving}
            className="text-body-sm px-3 py-1.5 rounded-lg border border-border bg-transparent cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
          >
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        {currentUser?.id !== targetUser.id && (
          <button
            onClick={handleImpersonate}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 text-body-sm font-medium transition-colors ml-auto"
          >
            <Eye className="w-4 h-4" />
            Impersonate
          </button>
        )}
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-caption text-foreground-secondary">Monthly Requests</p>
          <p className="text-heading-sm font-bold mt-1">
            {usage.monthlyRequests}
            <span className="text-body-sm font-normal text-foreground-tertiary">
              {' / '}{usage.monthlyLimit === -1 ? 'unlimited' : usage.monthlyLimit}
            </span>
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-caption text-foreground-secondary">API Keys</p>
          <p className="text-heading-sm font-bold mt-1">{apiKeys.length}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-caption text-foreground-secondary">Total Reports</p>
          <p className="text-heading-sm font-bold mt-1">{totalReports}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-caption text-foreground-secondary">Subscription</p>
          <p className="text-heading-sm font-bold mt-1 flex items-center gap-2">
            {subscription ? (
              <>
                <CreditCard className="w-4 h-4 text-green-500" />
                <span className="capitalize">{subscription.status}</span>
              </>
            ) : (
              <span className="text-foreground-tertiary">None</span>
            )}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-border">
        <div className="flex gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-body-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-foreground-secondary hover:text-foreground'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <div className="rounded-xl border border-border bg-card p-5 space-y-4">
          <h2 className="text-heading-sm font-semibold">User Details</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-body-sm">
            <div>
              <p className="text-foreground-tertiary">User ID</p>
              <p className="font-mono text-foreground-secondary mt-0.5">{targetUser.id}</p>
            </div>
            <div>
              <p className="text-foreground-tertiary">Email Verified</p>
              <p className="mt-0.5">{targetUser.emailVerified ? 'Yes' : 'No'}</p>
            </div>
            <div>
              <p className="text-foreground-tertiary">Plan</p>
              <p className="mt-0.5 capitalize">{targetUser.plan}</p>
            </div>
            <div>
              <p className="text-foreground-tertiary">Role</p>
              <p className="mt-0.5 capitalize">{targetUser.role}</p>
            </div>
            {subscription && (
              <>
                <div>
                  <p className="text-foreground-tertiary">Stripe Customer ID</p>
                  <p className="font-mono text-foreground-secondary mt-0.5">
                    {subscription.stripeCustomerId || 'N/A'}
                  </p>
                </div>
                <div>
                  <p className="text-foreground-tertiary">Subscription Period End</p>
                  <p className="mt-0.5">
                    {subscription.currentPeriodEnd
                      ? new Date(subscription.currentPeriodEnd).toLocaleDateString()
                      : 'N/A'}
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {activeTab === 'keys' && (
        <div className="space-y-4">
          {apiKeys.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-8 text-center text-foreground-secondary text-body-sm">
              No API keys created
            </div>
          ) : (
            apiKeys.map((key) => (
              <div key={key.id} className="rounded-xl border border-border bg-card p-5">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-body-sm font-medium">{key.name}</p>
                    <p className="text-caption font-mono text-foreground-tertiary mt-0.5">
                      {key.keyPrefix}...
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleResetKeyUsage(key.id)}
                      className="text-caption text-blue-400 hover:text-blue-300 font-medium transition-colors"
                    >
                      Reset Usage
                    </button>
                    <button
                      onClick={() => handleToggleKeyActive(key.id, !key.isActive)}
                      className={`text-caption font-medium transition-colors ${
                        key.isActive
                          ? 'text-red-400 hover:text-red-300'
                          : 'text-green-400 hover:text-green-300'
                      }`}
                    >
                      {key.isActive ? 'Disable' : 'Enable'}
                    </button>
                  </div>
                </div>
                <div className="flex gap-6 mt-3 text-caption text-foreground-secondary">
                  <span>
                    Usage: {key.currentUsage} / {key.monthlyQuota === null ? 'unlimited' : key.monthlyQuota}
                  </span>
                  <span>Status: {key.isActive ? 'Active' : 'Disabled'}</span>
                  <span>
                    Last used: {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : 'Never'}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === 'usage' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border bg-secondary/30">
                    <th className="text-left text-caption font-medium text-foreground-secondary px-4 py-3">
                      Endpoint
                    </th>
                    <th className="text-left text-caption font-medium text-foreground-secondary px-4 py-3">
                      Status
                    </th>
                    <th className="text-left text-caption font-medium text-foreground-secondary px-4 py-3">
                      Property
                    </th>
                    <th className="text-left text-caption font-medium text-foreground-secondary px-4 py-3">
                      Response Time
                    </th>
                    <th className="text-left text-caption font-medium text-foreground-secondary px-4 py-3">
                      Date
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {logs.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-12 text-center text-foreground-secondary text-body-sm">
                        No usage logs found
                      </td>
                    </tr>
                  ) : (
                    logs.map((log) => (
                      <tr key={log.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-3">
                          <span className="text-caption font-mono">
                            {log.method} {log.endpoint}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`text-caption font-medium ${
                              log.statusCode < 400 ? 'text-green-400' : 'text-red-400'
                            }`}
                          >
                            {log.statusCode}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-caption text-foreground-secondary">
                          {log.propertyAddress
                            ? `${log.propertyAddress}, ${log.propertyCity || ''} ${log.propertyState || ''}`
                            : '-'}
                        </td>
                        <td className="px-4 py-3 text-caption text-foreground-secondary">
                          {log.responseTimeMs ? `${log.responseTimeMs}ms` : '-'}
                        </td>
                        <td className="px-4 py-3 text-caption text-foreground-secondary">
                          {new Date(log.createdAt).toLocaleString()}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination */}
          {logsPagination && logsPagination.totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-caption text-foreground-secondary">
                Page {logsPagination.page} of {logsPagination.totalPages} ({logsPagination.total} total)
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setLogsPage((p) => Math.max(1, p - 1))}
                  disabled={logsPage === 1}
                  className="p-2 rounded-lg border border-border hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setLogsPage((p) => Math.min(logsPagination.totalPages, p + 1))}
                  disabled={logsPage === logsPagination.totalPages}
                  className="p-2 rounded-lg border border-border hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
