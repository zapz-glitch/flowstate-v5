'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useUser } from '@/components/auth/UserProvider'
import { getAdminStats, getAdminDailyUsage, type AdminStats, type DailyUsage } from '@/lib/admin-api'
import Link from 'next/link'
import { Users, Activity, FileText, TrendingUp, ArrowRight } from 'lucide-react'

export default function AdminOverviewPage() {
  const { user } = useUser()
  const router = useRouter()
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [dailyUsage, setDailyUsage] = useState<DailyUsage[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (user && user.role !== 'admin') {
      router.replace('/dashboard')
      return
    }

    Promise.all([getAdminStats(), getAdminDailyUsage()])
      .then(([statsData, usageData]) => {
        setStats(statsData)
        setDailyUsage(usageData.daily)
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [user, router])

  if (loading || !stats) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-foreground" />
      </div>
    )
  }

  const statCards = [
    { label: 'Total Users', value: stats.totalUsers, icon: Users, color: 'text-blue-500' },
    { label: 'Monthly Requests', value: stats.monthlyRequests, icon: Activity, color: 'text-green-500' },
    { label: 'Total Reports', value: stats.totalReports, icon: FileText, color: 'text-foreground' },
    {
      label: 'Pro Users',
      value: (stats.planBreakdown.pro || 0) + (stats.planBreakdown.enterprise || 0),
      icon: TrendingUp,
      color: 'text-amber-500',
    },
  ]

  const maxCount = Math.max(...dailyUsage.map((d) => d.count), 1)

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-heading-lg font-bold">Admin Panel</h1>
          <p className="text-foreground-secondary mt-1">Platform overview and user management</p>
        </div>
        <Link
          href="/dashboard/admin/users"
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-secondary text-foreground hover:bg-accent text-body-sm font-medium transition-colors"
        >
          Manage Users
          <ArrowRight className="w-4 h-4" />
        </Link>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCards.map((card) => (
          <div
            key={card.label}
            className="rounded-xl border border-border bg-card p-5"
          >
            <div className="flex items-center justify-between">
              <p className="text-body-sm text-foreground-secondary">{card.label}</p>
              <card.icon className={`w-5 h-5 ${card.color}`} />
            </div>
            <p className="text-display-sm font-bold mt-2">{card.value.toLocaleString()}</p>
          </div>
        ))}
      </div>

      {/* Plan Breakdown */}
      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-heading-sm font-semibold mb-4">Users by Plan</h2>
        <div className="flex gap-6">
          {['free', 'pro', 'enterprise'].map((plan) => (
            <div key={plan} className="flex items-center gap-3">
              <div
                className={`w-3 h-3 rounded-full ${
                  plan === 'free'
                    ? 'bg-muted-foreground/40'
                    : plan === 'pro'
                      ? 'bg-foreground'
                      : 'bg-foreground/50'
                }`}
              />
              <div>
                <p className="text-body-sm font-medium capitalize">{plan}</p>
                <p className="text-caption text-foreground-tertiary">
                  {stats.planBreakdown[plan] || 0} users
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Daily Usage Chart (simple bar chart) */}
      <div className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-heading-sm font-semibold mb-4">Daily API Requests (Last 30 Days)</h2>
        {dailyUsage.length === 0 ? (
          <p className="text-foreground-secondary text-body-sm">No usage data available</p>
        ) : (
          <div className="flex items-end gap-1 h-40">
            {dailyUsage.map((day) => (
              <div
                key={day.date}
                className="flex-1 group relative"
                title={`${day.date}: ${day.count} requests, ${day.unique_users} users`}
              >
                <div
                  className="bg-foreground/50 hover:bg-foreground/80 rounded-t transition-colors w-full"
                  style={{ height: `${Math.max((day.count / maxCount) * 100, 2)}%` }}
                />
              </div>
            ))}
          </div>
        )}
        {dailyUsage.length > 0 && (
          <div className="flex justify-between mt-2 text-caption text-foreground-tertiary">
            <span>{dailyUsage[0]?.date}</span>
            <span>{dailyUsage[dailyUsage.length - 1]?.date}</span>
          </div>
        )}
      </div>
    </div>
  )
}
