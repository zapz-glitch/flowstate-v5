/**
 * API Client for Dashboard
 *
 * Wraps all calls to the API. Uses cookies for session authentication.
 * All user data comes from the API, not direct D1 access.
 */

import { cookies } from 'next/headers'

// API URL - inlined at build time via next.config.js
const API_URL = process.env.NEXT_PUBLIC_API_URL!

// ─── Logging Utilities ───────────────────────────────────────────────────────

const LOG_PREFIX = '[Dashboard API]'

function logRequest(method: string, path: string, body?: unknown) {
  const timestamp = new Date().toISOString()
  console.log(`${LOG_PREFIX} ${timestamp} → ${method} ${path}`)
  if (body && process.env.NODE_ENV === 'development') {
    console.log(`${LOG_PREFIX} Request body:`, JSON.stringify(body, null, 2).slice(0, 500))
  }
}

function logResponse(method: string, path: string, status: number, durationMs: number, error?: string) {
  const timestamp = new Date().toISOString()
  const statusEmoji = status >= 200 && status < 300 ? '✓' : '✗'
  console.log(`${LOG_PREFIX} ${timestamp} ← ${method} ${path} ${statusEmoji} ${status} (${durationMs}ms)`)
  if (error) {
    console.error(`${LOG_PREFIX} Error: ${error}`)
  }
}

// Helper to make authenticated API calls from server components
async function fetchApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const cookieStore = await cookies()
  const allCookies = cookieStore.getAll()
  const cookieHeader = allCookies.map((c) => `${c.name}=${c.value}`).join('; ')

  const method = options.method || 'GET'
  const startTime = Date.now()

  // Log request
  logRequest(method, path, options.body ? JSON.parse(options.body as string) : undefined)

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeader,
      ...options.headers,
    },
    credentials: 'include',
  })

  const durationMs = Date.now() - startTime

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Unknown error' })) as { error?: string }
    logResponse(method, path, response.status, durationMs, errorData.error)
    throw new Error(errorData.error || `API error: ${response.status}`)
  }

  logResponse(method, path, response.status, durationMs)
  return response.json()
}

// ─── User ────────────────────────────────────────────────────────────────────

export interface User {
  id: string
  name: string
  email: string
  emailVerified: boolean
  plan: string
  createdAt: string
}

export async function getUser(): Promise<User | null> {
  try {
    return await fetchApi<User>('/user')
  } catch {
    return null
  }
}

// ─── Session ─────────────────────────────────────────────────────────────────

export interface Session {
  user: {
    id: string
    name: string
    email: string
    emailVerified: boolean
    createdAt: Date
    updatedAt: Date
  }
  session: {
    id: string
    userId: string
    expiresAt: Date
    token: string
  }
}

export async function getSession(): Promise<Session | null> {
  try {
    return await fetchApi<Session>('/auth/get-session')
  } catch {
    return null
  }
}

// ─── API Keys ────────────────────────────────────────────────────────────────

export interface ApiKey {
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

export interface ApiKeysResponse {
  keys: ApiKey[]
}

export async function getApiKeys(): Promise<ApiKey[]> {
  const response = await fetchApi<ApiKeysResponse>('/user/api-keys')
  return response.keys
}

export interface CreateApiKeyResponse {
  id: string
  key: string // Full key, only returned once
  name: string
  keyPrefix: string
}

export async function createApiKey(name: string): Promise<CreateApiKeyResponse> {
  return fetchApi<CreateApiKeyResponse>('/user/api-keys', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

export async function deleteApiKey(id: string): Promise<void> {
  await fetchApi(`/user/api-keys/${id}`, { method: 'DELETE' })
}

export async function toggleApiKey(id: string, isActive: boolean): Promise<void> {
  await fetchApi(`/user/api-keys/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ isActive }),
  })
}

// ─── Usage ───────────────────────────────────────────────────────────────────

export interface UsageSummary {
  plan: string
  monthlyLimit: number
  currentUsage: number
  remaining: number
  resetDate: string
  rateLimit?: {
    hits24h: number
    hits7d: number
    serverErrors24h: number
    recent: Array<{
      endpoint: string
      propertyAddress: string | null
      errorMessage: string | null
      createdAt: string
    }>
  }
  /** Real CoreLogic calls this month (cache hits excluded) — display-only */
  providerCalls?: { month: number; limit: number }
  analysisTiming?: { avgMs: number | null; runs: number }
}

export async function getUsageSummary(): Promise<UsageSummary> {
  return fetchApi<UsageSummary>('/user/usage')
}

export interface UsageLog {
  id: string
  apiKeyId: string
  endpoint: string
  method: string
  statusCode: number
  responseTimeMs: number | null
  propertyAddress: string | null
  propertyCity: string | null
  propertyState: string | null
  createdAt: string
}

export interface UsageLogsResponse {
  logs: UsageLog[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

export async function getUsageLogs(
  page = 1,
  limit = 20,
  apiKeyId?: string
): Promise<UsageLogsResponse> {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) })
  if (apiKeyId) {
    params.append('apiKeyId', apiKeyId)
  }
  return fetchApi<UsageLogsResponse>(`/user/usage/logs?${params.toString()}`)
}

export interface UsageLogDetail extends UsageLog {
  requestBody: string | null
  responseBody: string | null
  requestHeaders: string | null
  ipAddress: string | null
  userAgent: string | null
  errorMessage: string | null
  apiKeyId: string
}

export async function getUsageLogDetail(id: string): Promise<UsageLogDetail> {
  const response = await fetchApi<{ log: UsageLogDetail }>(`/user/usage/logs/${id}`)
  return response.log
}

// ─── Appraisal Presets ────────────────────────────────────────────────────────

export type FilterType =
  | 'subdivision_match'
  | 'neighborhood_match'
  | 'building_style_match'
  | 'foundation_match'
  | 'construction_material_match'
  | 'pool_match'
  | 'garage_match'
  | 'stories_match'
  | 'roof_material_match'
  | 'condition_match'
  | 'sale_age'
  | 'sqft_diff'
  | 'property_type'
  | 'year_built_diff'
  | 'distance'
  | 'lot_size_diff'
  | 'road_barrier'

export type AdjustmentType =
  | 'old_comp_discount'
  | 'bedroom'
  | 'bathroom'
  | 'pool'
  | 'garage'
  | 'carport'

export interface AppraisalFilter {
  id: string
  presetId: string
  filterType: FilterType
  enabled: boolean
  value: number
  /** 'hard' = required (disqualifies) | 'soft' = preferred (ranks only) */
  priority: 'hard' | 'soft'
  createdAt: string
}

export interface AppraisalAdjustment {
  id: string
  presetId: string
  adjustmentType: AdjustmentType
  enabled: boolean
  amount: number
  percentage: number
  createdAt: string
}

export interface AppraisalPreset {
  id: string
  userId: string
  name: string
  description: string | null
  isDefault: boolean
  filters: AppraisalFilter[]
  adjustments: AppraisalAdjustment[]
  createdAt: string
  updatedAt: string
}

export interface FilterLabel {
  label: string
  shortLabel: string
  unit: string
  description: string
}

export interface AdjustmentLabel {
  label: string
  description: string
  isPercentage?: boolean
  unavailable?: boolean
}

export interface AppraisalDefaults {
  filters: Array<{ type: FilterType; enabled: boolean; value: number; priority?: 'hard' | 'soft' }>
  adjustments: Array<{ type: AdjustmentType; enabled: boolean; amount: number; percent?: number }>
  filterLabels: Record<FilterType, FilterLabel>
  adjustmentLabels: Record<AdjustmentType, AdjustmentLabel>
}

export async function getAppraisalPresets(): Promise<AppraisalPreset[]> {
  try {
    const response = await fetchApi<{ presets: AppraisalPreset[] }>('/appraisal-presets')
    return response.presets
  } catch {
    return []
  }
}

export async function getAppraisalPreset(id: string): Promise<AppraisalPreset | null> {
  try {
    const response = await fetchApi<{ preset: AppraisalPreset }>(`/appraisal-presets/${id}`)
    return response.preset
  } catch {
    return null
  }
}

export async function getDefaultAppraisalPreset(): Promise<AppraisalPreset | null> {
  try {
    const response = await fetchApi<{ preset: AppraisalPreset | null }>('/appraisal-presets/default')
    return response.preset
  } catch {
    return null
  }
}

export async function getAppraisalDefaults(): Promise<AppraisalDefaults | null> {
  try {
    return await fetchApi<AppraisalDefaults>('/appraisal-presets/defaults')
  } catch {
    return null
  }
}

export interface CreatePresetInput {
  name: string
  description?: string
  isDefault?: boolean
  filters?: Array<{ filterType: FilterType; enabled: boolean; value: number; priority?: 'hard' | 'soft' }>
  adjustments?: Array<{ adjustmentType: AdjustmentType; enabled: boolean; amount: number; percentage: number }>
}

export interface UpdatePresetInput {
  name?: string
  description?: string
  isDefault?: boolean
  filters?: Array<{ filterType: FilterType; enabled: boolean; value: number; priority?: 'hard' | 'soft' }>
  adjustments?: Array<{ adjustmentType: AdjustmentType; enabled: boolean; amount: number; percentage: number }>
}

export async function createAppraisalPreset(input: CreatePresetInput): Promise<AppraisalPreset> {
  const response = await fetchApi<{ preset: AppraisalPreset }>('/appraisal-presets', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return response.preset
}

export async function updateAppraisalPreset(id: string, input: UpdatePresetInput): Promise<AppraisalPreset> {
  const response = await fetchApi<{ preset: AppraisalPreset }>(`/appraisal-presets/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
  return response.preset
}

export async function deleteAppraisalPreset(id: string): Promise<void> {
  await fetchApi(`/appraisal-presets/${id}`, { method: 'DELETE' })
}

export async function setDefaultAppraisalPreset(id: string): Promise<void> {
  await fetchApi(`/appraisal-presets/${id}/set-default`, { method: 'POST' })
}

// ─── Saved Reports ──────────────────────────────────────────────────────────

export interface SavedReportListItem {
  id: string
  jobId: string
  propertyAddress: string
  propertyCity: string
  propertyState: string
  arv: number | null
  maxAllowableOffer: number | null
  estimatedRepairs: number | null
  isShared: boolean
  createdAt: string
}

export interface ReportsListResponse {
  reports: SavedReportListItem[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
  }
}

export async function getSavedReports(
  page = 1,
  limit = 20,
  search = ''
): Promise<ReportsListResponse> {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) })
  if (search) params.set('search', search)
  return fetchApi<ReportsListResponse>(`/user/reports?${params.toString()}`)
}

export async function getSavedReport(
  jobId: string
): Promise<{ jobId: string; address: string; createdAt: string; analysis: unknown }> {
  return fetchApi(`/user/reports/${jobId}`)
}
