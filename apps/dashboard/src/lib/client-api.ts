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

/** Returns the user's single default preset, auto-creating it if it doesn't exist. */
export async function getOrCreateDefaultPreset(): Promise<AppraisalPreset> {
  const response = await fetchApi<{ preset: AppraisalPreset }>('/appraisal-presets/mine')
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

// ─── Rehab Config ─────────────────────────────────────────────────────────────

export type ArvTier = 'under501k' | '501kTo999k' | '1mTo3m' | 'over3m'

export interface RehabEstimate {
  perSqft: number
  minProfit: number
}

export type RehabTable = Record<ArvTier, RehabEstimate[]>

export const REHAB_LEVEL_NAMES = [
  'Lipstick',
  'Light Cosmetic',
  'Full Cosmetic',
  'Heavy Rehab',
  'Down to Stud',
  'Low Cost Market',
  'High Cost Market',
] as const

export const ARV_TIER_LABELS: Record<ArvTier, string> = {
  under501k: 'Under $501k',
  '501kTo999k': '$501k – $999k',
  '1mTo3m': '$1M – $3M',
  over3m: 'Over $3M',
}

export const ARV_TIERS: ArvTier[] = ['under501k', '501kTo999k', '1mTo3m', 'over3m']

export interface RehabConfigResponse {
  config: RehabTable
  isCustom: boolean
  updatedAt?: string
}

export async function getRehabConfig(): Promise<RehabConfigResponse> {
  return fetchApi<RehabConfigResponse>('/rehab-config')
}

export async function getRehabConfigDefaults(): Promise<{ config: RehabTable }> {
  return fetchApi<{ config: RehabTable }>('/rehab-config/defaults')
}

export async function saveRehabConfig(config: RehabTable): Promise<RehabConfigResponse & { success: boolean }> {
  return fetchApi('/rehab-config', {
    method: 'PUT',
    body: JSON.stringify({ config }),
  })
}

export async function resetRehabConfig(): Promise<RehabConfigResponse> {
  return fetchApi('/rehab-config', { method: 'DELETE' })
}

// ─── Deal Params ───────────────────────────────────────────────────────────────

export interface DealParamsConfig {
  closingCostsPercent: number
  carryingCostsPercent: number
  wholesaleFee: number
  desiredProfit: number | null
}

export interface DealParamsResponse {
  config: DealParamsConfig
  isCustom: boolean
  updatedAt?: string
}

export async function getDealParams(): Promise<DealParamsResponse> {
  return fetchApi<DealParamsResponse>('/deal-params')
}

export async function saveDealParams(config: DealParamsConfig): Promise<DealParamsResponse> {
  return fetchApi('/deal-params', {
    method: 'PUT',
    body: JSON.stringify(config),
  })
}

export async function resetDealParams(): Promise<DealParamsResponse> {
  return fetchApi('/deal-params', { method: 'DELETE' })
}

// ─── Location Settings ─────────────────────────────────────────────────────────

export interface LocationAppraisalFilter {
  filterType: FilterType
  enabled: boolean
  value: number
}

export interface LocationAppraisalAdjustment {
  adjustmentType: AdjustmentType
  enabled: boolean
  amount: number
  percentage: number
}

export type LocationSettingType = 'appraisal' | 'rehab' | 'deal' | 'major'

export interface LocationSetting {
  id: string
  settingType: LocationSettingType
  isEnabled: boolean
  state?: string | null
  city?: string | null
  zipCode?: string | null
  appraisalPresetId?: string | null
  appraisalFilters?: LocationAppraisalFilter[] | null
  appraisalAdjustments?: LocationAppraisalAdjustment[] | null
  hasAppraisalOverride: boolean
  rehabConfigJson?: RehabTable | null
  dealParamsJson?: DealParamsConfig | null
  majorItemCostsJson?: Record<string, number> | null
  hasRehabConfig: boolean
  hasDealParams: boolean
  hasMajorItemCosts: boolean
  createdAt: string
  updatedAt: string
}

export interface LocationSettingInput {
  settingType?: LocationSettingType
  isEnabled?: boolean
  state?: string
  city?: string
  zipCode?: string
  appraisalPresetId?: string | null
  appraisalFilters?: LocationAppraisalFilter[] | null
  appraisalAdjustments?: LocationAppraisalAdjustment[] | null
  rehabConfigJson?: RehabTable | null
  dealParamsJson?: DealParamsConfig | null
  majorItemCostsJson?: Record<string, number> | null
}

export async function getLocationSettings(type?: LocationSettingType): Promise<LocationSetting[]> {
  const url = type ? `/location-settings?type=${type}` : '/location-settings'
  const res = await fetchApi<{ settings: LocationSetting[] }>(url)
  return res.settings
}

export async function createLocationSetting(input: LocationSettingInput): Promise<LocationSetting> {
  const res = await fetchApi<{ setting: LocationSetting }>('/location-settings', {
    method: 'POST',
    body: JSON.stringify(input),
  })
  return res.setting
}

export async function updateLocationSetting(id: string, input: Partial<LocationSettingInput>): Promise<LocationSetting> {
  const res = await fetchApi<{ setting: LocationSetting }>(`/location-settings/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
  return res.setting
}

export async function deleteLocationSetting(id: string): Promise<void> {
  await fetchApi(`/location-settings/${id}`, { method: 'DELETE' })
}

// ─── Major Item Costs ──────────────────────────────────────────────────────────

export interface MajorItemInfo {
  id: string
  name: string
  defaultCost: number
  customCost: number | null
  effectiveCost: number
  ageThreshold: number | null
}

export interface MajorItemCostsResponse {
  items: MajorItemInfo[]
  isCustom: boolean
  updatedAt: string | null
}

export async function getMajorItemCosts(): Promise<MajorItemCostsResponse> {
  return fetchApi<MajorItemCostsResponse>('/major-item-costs')
}

export async function saveMajorItemCosts(costs: Record<string, number | null>): Promise<MajorItemCostsResponse> {
  return fetchApi<MajorItemCostsResponse>('/major-item-costs', {
    method: 'PUT',
    body: JSON.stringify({ costs }),
  })
}

export async function resetMajorItemCosts(): Promise<MajorItemCostsResponse> {
  const res = await fetchApi<MajorItemCostsResponse>('/major-item-costs', { method: 'DELETE' })
  return res
}

// ─── GHL Integration Settings ────────────────────────────────────────────────

export interface GHLMappableField {
  label: string
  type: 'number' | 'string'
}

export interface GHLSettingsData {
  locationId: string
  isEnabled: boolean
  fieldMappings: Record<string, string>
  monetaryValueField: string
  webhookUrl: string
  webhookSecret: string
  updatedAt: string
  hasApiToken: boolean
  apiTokenMasked: string | null
}

export interface GHLSettingsResponse {
  settings: GHLSettingsData | null
  isConfigured: boolean
}

export interface GHLFieldsResponse {
  fields: Record<string, GHLMappableField>
}

export interface GHLTestResult {
  success: boolean
  error?: string
}

export interface GHLSettingsInput {
  apiToken?: string
  locationId?: string
  isEnabled?: boolean
  fieldMappings?: Record<string, string>
  monetaryValueField?: string
}

export async function getGHLSettings(): Promise<GHLSettingsResponse> {
  return fetchApi<GHLSettingsResponse>('/ghl-settings')
}

export async function getGHLMappableFields(): Promise<GHLFieldsResponse> {
  return fetchApi<GHLFieldsResponse>('/ghl-settings/fields')
}

export async function saveGHLSettings(input: GHLSettingsInput): Promise<GHLSettingsResponse> {
  return fetchApi<GHLSettingsResponse>('/ghl-settings', {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export async function deleteGHLSettings(): Promise<GHLSettingsResponse> {
  return fetchApi<GHLSettingsResponse>('/ghl-settings', { method: 'DELETE' })
}

export async function testGHLConnection(): Promise<GHLTestResult> {
  return fetchApi<GHLTestResult>('/ghl-settings/test', { method: 'POST' })
}

// ─── Report Sharing ──────────────────────────────────────────────────────────

export interface ShareSettings {
  isShared: boolean
  hasPassword: boolean
  shareUrl: string
}

export async function getReportShareSettings(jobId: string): Promise<ShareSettings> {
  return fetchApi<ShareSettings>(`/user/reports/${jobId}/share`)
}

export async function updateReportShareSettings(
  jobId: string,
  settings: { isShared: boolean; password?: string }
): Promise<ShareSettings> {
  return fetchApi<ShareSettings>(`/user/reports/${jobId}/share`, {
    method: 'PUT',
    body: JSON.stringify(settings),
  })
}

// ─── Plan Limits ───────────────────────────────────────────────────────────────

export const PLAN_LIMITS = {
  free: {
    monthlyRequests: 100,
    maxApiKeys: 1,
    features: ['property-search', 'comparables'],
  },
  pro: {
    monthlyRequests: 5000,
    maxApiKeys: 5,
    features: ['property-search', 'comparables', 'valuation', 'underwriting', 'reports'],
  },
  enterprise: {
    monthlyRequests: -1,
    maxApiKeys: -1,
    features: ['property-search', 'comparables', 'valuation', 'underwriting', 'reports', 'bulk'],
  },
} as const

export type Plan = keyof typeof PLAN_LIMITS
