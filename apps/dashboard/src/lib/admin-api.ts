/**
 * Admin API helpers
 *
 * Client-side API calls for admin panel. Uses session cookies.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL!

async function fetchAdmin<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}/admin${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    credentials: 'include',
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Unknown error' })) as { error?: string }
    throw new Error(errorData.error || `API error: ${response.status}`)
  }

  return response.json()
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AdminUser {
  id: string
  name: string
  email: string
  emailVerified: boolean
  plan: string
  role: string
  createdAt: string
  updatedAt?: string
}

export interface AdminApiKey {
  id: string
  name: string
  keyPrefix: string
  currentUsage: number
  monthlyQuota: number | null
  quotaResetAt: string
  isActive: boolean
  lastUsedAt: string | null
  createdAt: string
}

export interface AdminUsageLog {
  id: string
  apiKeyId: string | null
  endpoint: string
  method: string
  statusCode: number
  responseTimeMs: number | null
  propertyAddress: string | null
  propertyCity: string | null
  propertyState: string | null
  createdAt: string
}

export interface Pagination {
  page: number
  limit: number
  total: number
  totalPages: number
}

export interface AdminStats {
  totalUsers: number
  planBreakdown: Record<string, number>
  monthlyRequests: number
  totalReports: number
}

export interface AdminUserDetail {
  user: AdminUser
  apiKeys: AdminApiKey[]
  usage: {
    monthlyRequests: number
    monthlyLimit: number
    remaining: number
  }
  subscription: {
    id: string
    status: string
    stripeCustomerId: string | null
    stripePriceId: string | null
    currentPeriodEnd: string | null
  } | null
  totalReports: number
}

export interface DailyUsage {
  date: string
  count: number
  unique_users: number
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export async function getAdminStats(): Promise<AdminStats> {
  return fetchAdmin<AdminStats>('/stats')
}

// ─── Users ───────────────────────────────────────────────────────────────────

export async function getAdminUsers(params?: {
  page?: number
  limit?: number
  search?: string
  plan?: string
}): Promise<{ users: AdminUser[]; pagination: Pagination }> {
  const searchParams = new URLSearchParams()
  if (params?.page) searchParams.set('page', String(params.page))
  if (params?.limit) searchParams.set('limit', String(params.limit))
  if (params?.search) searchParams.set('search', params.search)
  if (params?.plan) searchParams.set('plan', params.plan)

  const qs = searchParams.toString()
  return fetchAdmin(`/users${qs ? `?${qs}` : ''}`)
}

export async function getAdminUser(userId: string): Promise<AdminUserDetail> {
  return fetchAdmin(`/users/${userId}`)
}

export async function updateAdminUser(
  userId: string,
  updates: { plan?: string; role?: string }
): Promise<{ success: boolean }> {
  return fetchAdmin(`/users/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  })
}

// ─── User Usage ──────────────────────────────────────────────────────────────

export async function getAdminUserUsage(
  userId: string,
  params?: { page?: number; limit?: number }
): Promise<{ logs: AdminUsageLog[]; pagination: Pagination }> {
  const searchParams = new URLSearchParams()
  if (params?.page) searchParams.set('page', String(params.page))
  if (params?.limit) searchParams.set('limit', String(params.limit))

  const qs = searchParams.toString()
  return fetchAdmin(`/users/${userId}/usage${qs ? `?${qs}` : ''}`)
}

// ─── API Key Management ──────────────────────────────────────────────────────

export async function updateAdminApiKey(
  userId: string,
  keyId: string,
  updates: { monthlyQuota?: number; isActive?: boolean; currentUsage?: number }
): Promise<{ success: boolean }> {
  return fetchAdmin(`/users/${userId}/api-keys/${keyId}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  })
}

// ─── Platform Usage ──────────────────────────────────────────────────────────

export async function getAdminDailyUsage(): Promise<{ daily: DailyUsage[] }> {
  return fetchAdmin('/usage/daily')
}

// ─── Impersonation ──────────────────────────────────────────────────────────

export interface ImpersonateResponse {
  success: boolean
  impersonating: {
    id: string
    name: string
    email: string
    plan: string
    role: string
  }
  admin: {
    id: string
    name: string
    email: string
  }
}

export async function startImpersonation(userId: string): Promise<ImpersonateResponse> {
  return fetchAdmin(`/impersonate/${userId}`, { method: 'POST' })
}
