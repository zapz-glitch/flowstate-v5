/**
 * Client-side API helper
 *
 * For use in client components. Uses the browser's fetch with credentials.
 */

import { getImpersonatedUserId } from '@/components/auth/ImpersonationProvider'
import type { AnalyzeData } from '@/app/(dashboard)/dashboard/analyze/actions'

// API URL - inlined at build time via next.config.js
const API_URL = process.env.NEXT_PUBLIC_API_URL!

async function fetchApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  // Inject impersonation header if admin is impersonating a user
  const impersonateId = getImpersonatedUserId()
  const impersonateHeaders: Record<string, string> = impersonateId
    ? { 'X-Impersonate-User-Id': impersonateId }
    : {}

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...impersonateHeaders,
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

// ─── Address Typeahead ───────────────────────────────────────────────────────

export interface TypeaheadResult {
  clip: string
  address: string
  addressLine1: string
  city: string
  state: string
  zip: string
}

export async function searchTypeahead(input: string): Promise<TypeaheadResult[]> {
  if (input.length < 3) return []
  const response = await fetchApi<{ results: TypeaheadResult[] }>(
    `/typeahead?input=${encodeURIComponent(input)}`
  )
  return response.results ?? []
}

// ─── ARV Threshold ──────────────────────────────────────────────────────────

export interface ArvThresholdConfig {
  percent: number
  asIsThresholdPercent?: number
}

export interface ArvThresholdResponse {
  config: ArvThresholdConfig
  isCustom: boolean
  updatedAt?: string
}

export async function getArvThreshold(): Promise<ArvThresholdResponse> {
  return fetchApi<ArvThresholdResponse>('/arv-threshold')
}

export async function saveArvThreshold(config: ArvThresholdConfig): Promise<ArvThresholdResponse> {
  return fetchApi('/arv-threshold', {
    method: 'PUT',
    body: JSON.stringify(config),
  })
}

export async function resetArvThreshold(): Promise<ArvThresholdResponse> {
  return fetchApi('/arv-threshold', { method: 'DELETE' })
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

export async function getUsageLogs(page = 1, limit = 20, apiKeyId?: string): Promise<UsageLogsResponse> {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) })
  if (apiKeyId) params.set('apiKeyId', apiKeyId)
  return fetchApi<UsageLogsResponse>(`/user/usage/logs?${params}`)
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
  | 'building_style_match'
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

// ─── Rehab Config ─────────────────────────────────────────────────────────────

export type ArvTier = string

export interface RehabEstimate {
  perSqft: number
  minProfit: number
}

export type RehabTable = Record<string, RehabEstimate[]>

export interface TierRangeDefinition {
  key: string
  label: string
  minValue: number | null
  maxValue: number | null
}

export const DEFAULT_TIER_RANGES: TierRangeDefinition[] = [
  { key: 'under501k', label: 'Under $501K', minValue: null, maxValue: 501000 },
  { key: '501kTo999k', label: '$501K – $999K', minValue: 501000, maxValue: 1000000 },
  { key: '1mTo3m', label: '$1M – $3M', minValue: 1000000, maxValue: 3000000 },
  { key: 'over3m', label: 'Over $3M', minValue: 3000000, maxValue: null },
]

export const REHAB_LEVEL_NAMES = [
  'Lipstick',
  'Light Cosmetic',
  'Full Cosmetic',
  'Heavy Rehab',
  'Down to Stud',
] as const

/** Auto-compute a tier label from its boundaries */
export function computeTierLabel(range: TierRangeDefinition): string {
  const fmtBoundary = (n: number): string => {
    if (n >= 1_000_000) {
      const m = n / 1_000_000
      return m % 1 === 0 ? `$${m}M` : `$${m.toFixed(1)}M`
    }
    return `$${Math.round(n / 1000)}K`
  }
  if (range.minValue === null && range.maxValue !== null) return `Under ${fmtBoundary(range.maxValue)}`
  if (range.minValue !== null && range.maxValue === null) return `Over ${fmtBoundary(range.minValue)}`
  if (range.minValue !== null && range.maxValue !== null) return `${fmtBoundary(range.minValue)} \u2013 ${fmtBoundary(range.maxValue)}`
  return 'All Values'
}

export function getTierLabel(key: string, tierRanges?: TierRangeDefinition[]): string {
  const ranges = tierRanges ?? DEFAULT_TIER_RANGES
  const range = ranges.find((t) => t.key === key)
  if (!range) return key
  return computeTierLabel(range)
}

export const ARV_TIER_LABELS: Record<string, string> = {
  under501k: 'Under $501k',
  '501kTo999k': '$501k – $999k',
  '1mTo3m': '$1M – $3M',
  over3m: 'Over $3M',
}

export const ARV_TIERS: string[] = ['under501k', '501kTo999k', '1mTo3m', 'over3m']

export interface RehabConfigResponse {
  config: RehabTable
  tierRanges: TierRangeDefinition[]
  isCustom: boolean
  updatedAt?: string
}

export async function getRehabConfig(): Promise<RehabConfigResponse> {
  return fetchApi<RehabConfigResponse>('/rehab-config')
}

export async function getRehabConfigDefaults(): Promise<{ config: RehabTable; tierRanges: TierRangeDefinition[] }> {
  return fetchApi<{ config: RehabTable; tierRanges: TierRangeDefinition[] }>('/rehab-config/defaults')
}

export async function saveRehabConfig(
  config: RehabTable,
  tierRanges?: TierRangeDefinition[]
): Promise<RehabConfigResponse & { success: boolean }> {
  return fetchApi('/rehab-config', {
    method: 'PUT',
    body: JSON.stringify({ config, tierRanges }),
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
  asIsThresholdPercent?: number
  arvThresholdPercent?: number
}

export interface DealParamsResponse {
  config: DealParamsConfig
  isCustom: boolean
  updatedAt?: string
}

export async function getDealParams(): Promise<DealParamsResponse> {
  return fetchApi<DealParamsResponse>('/deal-params')
}

export async function saveDealParams(config: Partial<DealParamsConfig>): Promise<DealParamsResponse> {
  return fetchApi('/deal-params', {
    method: 'PUT',
    body: JSON.stringify(config),
  })
}

export async function resetDealParams(): Promise<DealParamsResponse> {
  return fetchApi('/deal-params', { method: 'DELETE' })
}

// ─── Proximity Adjustment Config ─────────────────────────────────────────────

export interface ProximityPosition {
  flat: number
  percent: number
}

export interface ProximityConfig {
  arvThreshold: number
  siding: ProximityPosition
  backing: ProximityPosition
  fronting: ProximityPosition
}

export interface ProximityConfigResponse {
  config: ProximityConfig
  isCustom: boolean
  updatedAt?: string
}

export const PROXIMITY_DEFAULTS: ProximityConfig = {
  arvThreshold: 500000,
  siding:   { flat: 10000, percent: 10 },
  backing:  { flat: 10000, percent: 15 },
  fronting: { flat: 10000, percent: 20 },
}

export async function getProximityConfig(): Promise<ProximityConfigResponse> {
  return fetchApi<ProximityConfigResponse>('/proximity-config')
}

export async function saveProximityConfig(config: Partial<ProximityConfig>): Promise<ProximityConfigResponse> {
  return fetchApi('/proximity-config', {
    method: 'PUT',
    body: JSON.stringify(config),
  })
}

export async function resetProximityConfig(): Promise<ProximityConfigResponse> {
  return fetchApi('/proximity-config', { method: 'DELETE' })
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

export type LocationSettingType = 'appraisal' | 'rehab' | 'deal' | 'major' | 'arv_threshold' | 'proximity'

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
  tierRangesJson?: TierRangeDefinition[] | null
  dealParamsJson?: DealParamsConfig | null
  majorItemCostsJson?: Record<string, number> | null
  arvThresholdJson?: ArvThresholdConfig | null
  proximityConfigJson?: ProximityConfig | null
  hasRehabConfig: boolean
  hasTierRanges: boolean
  hasDealParams: boolean
  hasMajorItemCosts: boolean
  hasArvThreshold: boolean
  hasProximityConfig: boolean
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
  tierRangesJson?: TierRangeDefinition[] | null
  dealParamsJson?: DealParamsConfig | null
  majorItemCostsJson?: Record<string, number> | null
  arvThresholdJson?: ArvThresholdConfig | null
  proximityConfigJson?: ProximityConfig | null
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

// ─── Reports ─────────────────────────────────────────────────────────────────

export async function getSavedReport(
  jobId: string
): Promise<{ jobId: string; address: string; createdAt: string; analysis: unknown }> {
  return fetchApi(`/user/reports/${jobId}`)
}

export interface ExistingReport {
  id: string
  jobId: string
  propertyAddress: string
  propertyClip: string | null
  arv: number | null
  maxAllowableOffer: number | null
  estimatedRepairs: number | null
  createdAt: string
}

export async function getReportsByProperty(opts: { clip?: string; address?: string }): Promise<{ reports: ExistingReport[] }> {
  const params = new URLSearchParams()
  if (opts.clip) params.set('clip', opts.clip)
  else if (opts.address) params.set('address', opts.address)
  return fetchApi(`/user/reports/by-property?${params.toString()}`)
}

export interface ReportMapPoint {
  jobId: string | null
  propertyAddress: string
  propertyCity: string
  propertyState: string
  arv: number | null
  maxAllowableOffer: number | null
  createdAt: string
  latitude: number
  longitude: number
}

export async function getReportMapPoints(): Promise<{ points: ReportMapPoint[] }> {
  return fetchApi('/user/reports/map-points')
}

export interface ReportHistoryEntry {
  id: string
  action: string
  description: string
  changes: unknown
  createdAt: string
}

export async function getReportHistory(jobId: string): Promise<{ history: ReportHistoryEntry[] }> {
  return fetchApi(`/user/reports/${jobId}/history`)
}

export async function addReportHistory(jobId: string, action: string, description: string, changes?: unknown): Promise<void> {
  await fetchApi(`/user/reports/${jobId}/history`, {
    method: 'POST',
    body: JSON.stringify({ action, description, changes }),
  })
}

export async function updateSavedReport(jobId: string, opts: {
  fullResponseJson?: string
  arv?: number
  maxAllowableOffer?: number
  estimatedRepairs?: number
  historyAction?: string
  historyDescription?: string
  historyChanges?: unknown
}): Promise<void> {
  await fetchApi(`/user/reports/${jobId}`, {
    method: 'PUT',
    body: JSON.stringify(opts),
  })
}

export async function recalculateReportComps(jobId: string, selectedCompIds: string[] | null, expectedRevision: number): Promise<AnalyzeData> {
  const result = await fetchApi<{ analysis: AnalyzeData }>(`/user/reports/${encodeURIComponent(jobId)}/comps`, {
    method: 'POST',
    body: JSON.stringify({ selectedCompIds, expectedRevision }),
  })
  return result.analysis
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

export async function deleteReport(jobId: string): Promise<void> {
  await fetchApi(`/user/reports/${jobId}`, { method: 'DELETE' })
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

// ─── Lazy Comp Photos ─────────────────────────────────────────────────────────

export interface CompPhotoRequest {
  propertyId: string
  address: string
  city?: string
  state?: string
  zipCode?: string
}

export interface CompPhotoData {
  photos: string[]
  description?: string
  features?: string[]
  sourceUrl?: string
}

export interface CompPhotoResponse {
  success: boolean
  data: Record<string, CompPhotoData>
  summary: {
    total: number
    successful: number
    failed: number
    totalPhotos: number
  }
}

export async function fetchCompPhotos(comps: CompPhotoRequest[]): Promise<CompPhotoResponse> {
  return fetchApi<CompPhotoResponse>('/v1/analyze/comp-photos', {
    method: 'POST',
    body: JSON.stringify({ comps }),
  })
}



// ─── Comp Selection (LLM-only) ──────────────────────────────────────────────

export interface CompSelectionResult {
  success: boolean
  error?: string
  updatedComps?: {
    items: Array<Record<string, unknown>>
    count?: number
    enabledCount?: number
    disabledCount?: number
  }
  llmAnalysis?: {
    model: string
    latencyMs: number
    tokenUsage?: { prompt: number; completion: number; estimatedCostUsd: number }
    compCount: number
    summary: string
    selectedForArv: string[]
    confidenceLevel?: string
  }
  rankings?: Array<{
    compId: string
    score: number
    reasoning: string
    keyFeatures: string[]
    confidenceLevel: string
  }>
  latencyMs?: number
}

export async function runCompSelection(params: {
  subject: Record<string, unknown>
  comps: { items: Array<Record<string, unknown>>; count?: number; enabledCount?: number; disabledCount?: number }
  riskFlags?: string[]
  settings?: {
    filters?: Array<{ type: string; enabled: boolean; value: number }>
    adjustments?: Array<{ type: string; enabled: boolean; amount: number; percent?: number }>
    dealParams?: { closingCostsPercent: number; carryingCostsPercent: number; wholesaleFee: number }
    rehabLevelIndex?: number
    arvThresholdPercent?: number
    asIsThresholdPercent?: number
  }
}): Promise<CompSelectionResult> {
  return fetchApi<CompSelectionResult>('/comp-selection/analyze', {
    method: 'POST',
    body: JSON.stringify(params),
  })
}
