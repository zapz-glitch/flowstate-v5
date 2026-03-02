/**
 * Client-side API helper
 *
 * For use in client components. Uses the browser's fetch with credentials.
 */

// API URL - inlined at build time via next.config.js
const API_URL = process.env.NEXT_PUBLIC_API_URL!

async function fetchApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
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

export async function getApiKeys(): Promise<ApiKey[]> {
  const response = await fetchApi<{ keys: ApiKey[] }>('/user/api-keys')
  return response.keys
}

export interface CreateApiKeyResponse {
  id: string
  key: string
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
}

export async function getUsageSummary(): Promise<UsageSummary> {
  return fetchApi<UsageSummary>('/user/usage')
}

export interface UsageLog {
  id: string
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

export async function getUsageLogs(page = 1, limit = 20): Promise<UsageLogsResponse> {
  return fetchApi<UsageLogsResponse>(`/user/usage/logs?page=${page}&limit=${limit}`)
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

// ─── User ────────────────────────────────────────────────────────────────────

export interface User {
  id: string
  name: string
  email: string
  emailVerified: boolean
  plan: string
  createdAt: string
}

export async function getUser(): Promise<User> {
  return fetchApi<User>('/user')
}

// ─── Appraisal Presets ────────────────────────────────────────────────────────

export type FilterType =
  | 'subdivision_match'
  | 'sale_age'
  | 'sqft_diff'
  | 'property_type'
  | 'year_built_diff'
  | 'distance'

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
  filters: Array<{ type: FilterType; enabled: boolean; value: number }>
  adjustments: Array<{ type: AdjustmentType; enabled: boolean; amount: number; percent?: number }>
  filterLabels: Record<FilterType, FilterLabel>
  adjustmentLabels: Record<AdjustmentType, AdjustmentLabel>
}

export async function getAppraisalPresets(): Promise<AppraisalPreset[]> {
  const response = await fetchApi<{ presets: AppraisalPreset[] }>('/appraisal-presets')
  return response.presets
}

export async function getAppraisalPreset(id: string): Promise<AppraisalPreset> {
  const response = await fetchApi<{ preset: AppraisalPreset }>(`/appraisal-presets/${id}`)
  return response.preset
}

export async function getDefaultAppraisalPreset(): Promise<AppraisalPreset | null> {
  const response = await fetchApi<{ preset: AppraisalPreset | null }>('/appraisal-presets/default')
  return response.preset
}

export async function getAppraisalDefaults(): Promise<AppraisalDefaults> {
  return fetchApi<AppraisalDefaults>('/appraisal-presets/defaults')
}

export interface CreatePresetInput {
  name: string
  description?: string
  isDefault?: boolean
  filters?: Array<{ filterType: FilterType; enabled: boolean; value: number }>
  adjustments?: Array<{ adjustmentType: AdjustmentType; enabled: boolean; amount: number; percentage: number }>
}

export async function createAppraisalPreset(input: CreatePresetInput): Promise<AppraisalPreset> {
  const response = await fetchApi<{ preset: AppraisalPreset }>('/appraisal-presets', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return response.preset
}

export interface UpdatePresetInput {
  name?: string
  description?: string
  isDefault?: boolean
  filters?: Array<{ filterType: FilterType; enabled: boolean; value: number }>
  adjustments?: Array<{ adjustmentType: AdjustmentType; enabled: boolean; amount: number; percentage: number }>
}

export async function updateAppraisalPreset(id: string, input: UpdatePresetInput): Promise<AppraisalPreset> {
  const response = await fetchApi<{ preset: AppraisalPreset }>(`/appraisal-presets/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
  return response.preset
}

export async function setDefaultAppraisalPreset(id: string): Promise<void> {
  await fetchApi(`/appraisal-presets/${id}/set-default`, { method: 'POST' })
}

export async function deleteAppraisalPreset(id: string): Promise<void> {
  await fetchApi(`/appraisal-presets/${id}`, { method: 'DELETE' })
}

// ─── Process Documentation Comments ─────────────────────────────────────────

export interface DocCommentUser {
  id: string
  name: string
  email: string
}

export interface DocComment {
  id: string
  sectionId: string
  content: string
  isDeleted: boolean
  createdAt: string
  updatedAt: string
  user: DocCommentUser
  replies: DocComment[]
}

export interface CommentsResponse {
  comments: DocComment[]
  totalCount: number
}

export async function getComments(sectionId: string): Promise<CommentsResponse> {
  return fetchApi<CommentsResponse>(`/comments?sectionId=${encodeURIComponent(sectionId)}`)
}

export async function createComment(data: {
  sectionId: string
  content: string
  parentId?: string
}): Promise<DocComment> {
  return fetchApi<DocComment>('/comments', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateComment(id: string, content: string): Promise<void> {
  await fetchApi(`/comments/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ content }),
  })
}

export async function deleteComment(id: string): Promise<void> {
  await fetchApi(`/comments/${id}`, { method: 'DELETE' })
}
