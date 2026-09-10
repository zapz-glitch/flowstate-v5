'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useUser } from '@/components/auth/UserProvider'
import {
  getAdminUsers,
  updateAdminUser,
  type AdminUser,
  type Pagination,
} from '@/lib/admin-api'
import { Search, ChevronLeft, ChevronRight, Crown, Shield } from 'lucide-react'

const PLAN_COLORS: Record<string, string> = {
  free: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  pro: 'bg-secondary text-foreground border-border',
  enterprise: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
}

export default function AdminUsersPage() {
  const { user } = useUser()
  const router = useRouter()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [pagination, setPagination] = useState<Pagination | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [planFilter, setPlanFilter] = useState('')
  const [page, setPage] = useState(1)

  const fetchUsers = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getAdminUsers({ page, search: search || undefined, plan: planFilter || undefined })
      setUsers(data.users)
      setPagination(data.pagination)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }, [page, search, planFilter])

  useEffect(() => {
    if (user && user.role !== 'admin') {
      router.replace('/dashboard')
      return
    }
    fetchUsers()
  }, [user, router, fetchUsers])

  // Debounced search
  const [searchInput, setSearchInput] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput)
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  const handleQuickPlanChange = async (userId: string, newPlan: string) => {
    try {
      await updateAdminUser(userId, { plan: newPlan })
      fetchUsers()
    } catch (err) {
      console.error(err)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-heading-lg font-bold">User Management</h1>
        <p className="text-foreground-secondary mt-1">
          {pagination ? `${pagination.total} total users` : 'Loading...'}
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground-tertiary" />
          <input
            type="text"
            placeholder="Search by name or email..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-full pl-10 pr-4 py-2 rounded-lg border border-border bg-background text-body-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <select
          value={planFilter}
          onChange={(e) => {
            setPlanFilter(e.target.value)
            setPage(1)
          }}
          className="px-4 py-2 rounded-lg border border-border bg-background text-body-sm focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="">All Plans</option>
          <option value="free">Free</option>
          <option value="pro">Pro</option>
          <option value="enterprise">Enterprise</option>
        </select>
      </div>

      {/* Users Table */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-secondary/30">
                <th className="text-left text-caption font-medium text-foreground-secondary px-4 py-3">
                  User
                </th>
                <th className="text-left text-caption font-medium text-foreground-secondary px-4 py-3">
                  Plan
                </th>
                <th className="text-left text-caption font-medium text-foreground-secondary px-4 py-3">
                  Role
                </th>
                <th className="text-left text-caption font-medium text-foreground-secondary px-4 py-3">
                  Joined
                </th>
                <th className="text-right text-caption font-medium text-foreground-secondary px-4 py-3">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-foreground-secondary">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-foreground mx-auto" />
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-foreground-secondary text-body-sm">
                    No users found
                  </td>
                </tr>
              ) : (
                users.map((u) => (
                  <tr key={u.id} className="border-b border-border last:border-0 hover:bg-secondary/20 transition-colors">
                    <td className="px-4 py-3">
                      <Link href={`/dashboard/admin/users/${u.id}`} className="block">
                        <p className="text-body-sm font-medium text-foreground hover:text-foreground-secondary transition-colors">
                          {u.name}
                        </p>
                        <p className="text-caption text-foreground-tertiary">{u.email}</p>
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={u.plan}
                        onChange={(e) => handleQuickPlanChange(u.id, e.target.value)}
                        className={`text-caption font-medium px-2 py-1 rounded border ${PLAN_COLORS[u.plan] || PLAN_COLORS.free} bg-transparent cursor-pointer focus:outline-none`}
                      >
                        <option value="free">Free</option>
                        <option value="pro">Pro</option>
                        <option value="enterprise">Enterprise</option>
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1.5 text-caption">
                        {u.role === 'admin' ? (
                          <>
                            <Shield className="w-3.5 h-3.5 text-amber-400" />
                            <span className="text-amber-400 font-medium">Admin</span>
                          </>
                        ) : (
                          <span className="text-foreground-secondary">User</span>
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-caption text-foreground-secondary">
                      {new Date(u.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/dashboard/admin/users/${u.id}`}
                        className="text-caption text-foreground-secondary hover:text-foreground font-medium transition-colors"
                      >
                        View Details
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-caption text-foreground-secondary">
            Page {pagination.page} of {pagination.totalPages}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="p-2 rounded-lg border border-border hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
              disabled={page === pagination.totalPages}
              className="p-2 rounded-lg border border-border hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
