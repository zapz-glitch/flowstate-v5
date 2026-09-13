'use server'

import { getSession } from '@/lib/api'
import { getCloudflareEnv } from '@/lib/cloudflare'

// ─── Logging Utilities ───────────────────────────────────────────────────────

const LOG_PREFIX = '[Dashboard Analyze]'

function log(message: string, data?: unknown) {
  const timestamp = new Date().toISOString()
  if (data) {
    console.log(`${LOG_PREFIX} ${timestamp} ${message}`, data)
  } else {
    console.log(`${LOG_PREFIX} ${timestamp} ${message}`)
  }
}

function logError(message: string, error?: unknown) {
  const timestamp = new Date().toISOString()
  console.error(`${LOG_PREFIX} ${timestamp} ✗ ${message}`, error)
}

function logApiCall(method: string, url: string, status?: number, durationMs?: number) {
  const timestamp = new Date().toISOString()
  if (status !== undefined) {
    const statusEmoji = status >= 200 && status < 300 ? '✓' : '✗'
    console.log(`${LOG_PREFIX} ${timestamp} ← ${method} ${url} ${statusEmoji} ${status} (${durationMs}ms)`)
  } else {
    console.log(`${LOG_PREFIX} ${timestamp} → ${method} ${url}`)
  }
}

// Get API URL - inlined at build time via next.config.js
function getApiUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL!
}

// Get dashboard internal secret for API auth
async function getDashboardSecret(): Promise<string> {
  const env = await getCloudflareEnv()
  return env.DASHBOARD_INTERNAL_SECRET || ''
}

export interface AnalyzeRequest {
  address: string
  /** Existing job ID — when set, updates existing report instead of creating new */
  existingJobId?: string
  searchOptions?: {
    radiusMiles?: number
    maxComps?: number
    monthsBack?: number
  }
  /** Skip cache and fetch fresh data from APIs */
  skipCache?: boolean
  /** Zillow enrichment: scrape property data from Zillow */
  marketData?: {
    enabled?: boolean
  }
  /** LLM-based comp analysis options */
  llmAnalysis?: {
    enabled?: boolean
  }
  /** Override ARV comp threshold for this request */
  arvThresholdPercent?: number
  /** Override as-is threshold (% of ARV) for this request — default 70 */
  asIsThresholdPercent?: number
  /** Override appraisal rules for this request */
  appraisalOverrides?: {
    filters?: Array<{ type: string; enabled: boolean; value: number; priority?: 'hard' | 'soft' }>
    adjustments?: Array<{ type: string; enabled: boolean; amount: number; percent?: number }>
  }
}

export type AnalyzeResult =
  | { success: true; data: AnalyzeData; timing: { durationMs: number } }
  | { success: false; error: string }

// ─── API Response Types (Simplified Underwriter Format) ──────────────────────

/** API call statistics tracked during analysis */
export interface ApiCallStats {
  corelogic: { total: number; cached: number; endpoints: { endpoint: string; calls: number; cached: number }[] }
  totalExternalCalls: number
}

export interface AnalyzeData {
  evaluationRevision?: number
  manualCompSelection?: string[] | null
  evaluationEngine?: 'python-v4' | 'typescript'
  subject?: SubjectData
  valuation?: ValuationData
  comps?: CompsData
  riskFlags?: string[] | null
  permits?: PermitsData | null
  floodZone?: FloodZoneData | null
  neighbourhood?: NeighbourhoodData | null
  meta?: {
    analysisId?: string
    timestamp?: string
    dataProvider?: string
  }
  /** API call statistics from the analysis workflow */
  apiCallStats?: ApiCallStats | null
  /** Settings used during this analysis (for client-side recalculation initialization) */
  appliedSettings?: {
    filters: Array<{ type: string; enabled: boolean; value: number; priority?: 'hard' | 'soft' }>
    adjustments: Array<{ type: string; enabled: boolean; amount: number; percent?: number }>
    dealParams: {
      closingCostsPercent: number
      carryingCostsPercent: number
      wholesaleFee: number
    }
    rehabLevelIndex: number
    rehabTable: Record<string, Array<{ perSqft: number; minProfit: number }>>
    tierRanges?: Array<{ key: string; label: string; minValue: number | null; maxValue: number | null }>
    majorItems?: Array<{ id: string; enabled: boolean; cost: number }>
    additionPlay: number
    arvThresholdPercent?: number
    asIsThresholdPercent?: number
  }
}

/** Property classification (As-Is vs After-Renovation) */
export interface ClassificationSummary {
  type: 'as_is' | 'after_renovation' | 'transitional'
  confidence: number
  reasoning: string
  method?: string
}

export interface SubjectData {
  permits?: {
    status: 'available' | 'empty' | 'unavailable'
    items: Array<{
      permitId: string
      permitNumber: string | null
      projectType: string | null
      description: string | null
      status: string | null
      effectiveDate: string | null
      jobValue: number | null
    }>
  }
  address?: string
  county?: string | null
  latitude?: number | null
  longitude?: number | null
  bedrooms?: number | null
  bathrooms?: number | null
  /** @deprecated Use bedrooms and bathrooms separately */
  bedsBaths?: string
  squareFeet?: number | null
  lotSizeAcres?: number | null
  yearBuilt?: number | null
  propertyType?: string | null
  /** Subdivision name (if available) */
  subdivision?: string | null
  lastSale?: {
    price?: number
    date?: string | null
    pricePerSqft?: number | null
  } | null
  taxAssessment?: number | null
  photos?: string[]
  /** Vision-assessed condition/renovation level ('NA' when unverifiable) */
  condition?: string | null
  /** Curb-appeal condition label from listing photos */
  curbAppeal?: {
    condition: 'renovated' | 'dated' | 'distressed' | 'unknown'
    source?: 'vision' | 'price'
    confidence: number | null
    summary: string | null
    photosExamined: number
  } | null
  /** Direct listing URL from the provider that delivered photos */
  listingUrl?: string | null
  /** Foundation type (e.g., Slab, Crawl Space, Basement) */
  foundationType?: string | null
  /** Building style (e.g., Colonial, Cape Cod, Ranch) */
  buildingStyle?: string | null
  /** Pool type */
  pool?: string | null
  /** Garage type */
  garage?: string | null
  /** Garage square footage */
  garageSquareFeet?: number | null
  /** Carport type */
  carport?: string | null
  /** Construction type (e.g., Frame, Masonry) */
  constructionType?: string | null
  /** Exterior walls material */
  exteriorWalls?: string | null
  /** Roof type */
  roofType?: string | null
  /** Roof cover material */
  roofCover?: string | null
  /** Stories description (e.g., One Story) */
  storiesType?: string | null
  /** Heating system type */
  heating?: string | null
  /** Cooling system type */
  cooling?: string | null
  /** Fireplace count */
  fireplacesCount?: number | null
  /** Assessor building condition (e.g., Average, Good) */
  buildingCondition?: string | null
  /** Assessor construction grade (e.g., Fair, Good) */
  buildingGrade?: string | null
  /** Assessed improvement value */
  improvementValue?: number | null
  /** Building additions area (sqft) */
  additionSquareFeet?: number | null
  /** Neighborhood name from site-location */
  neighborhoodName?: string | null
  /** CoreLogic Automated Valuation Model — display only, never used in ARV math */
  avm?: {
    value?: number | null
    confidence?: number | null
    valueRangeLow?: number | null
    valueRangeHigh?: number | null
    model?: string | null
    asOfDate?: string | null
  } | null
  /** Property classification (as_is, after_renovation, transitional) */
  classification?: ClassificationSummary | null
}

export interface RehabLevelEstimate {
  index: number
  name: string
  perSqft: number
  estimatedCost: number
  buyPrice: number
  wholesalePrice: number
  projectedProfit: number
  projectedROI: number
  isSelected: boolean
}

export interface ValuationData {
  displayedArv?: number
  displayedBuyPrice?: number
  displayedWholesalePrice?: number
  displayRounding?: { increment: 500 | 1000; mode: 'half_up' }
  arv?: number
  arvSource?: string
  arvPerSqft?: number
  buyPrice?: number
  buyPricePercent?: number
  rehabCost?: number
  baseRehabCost?: number
  majorItemsCost?: number
  rehabLevel?: string
  rehabPerSqft?: number
  /** All rehab level estimates with costs calculated for the current ARV */
  rehabLevelEstimates?: RehabLevelEstimate[]
  closingCosts?: number
  carryingCosts?: number
  totalCosts?: number
  totalInvestment?: number
  projectedProfit?: number
  projectedROI?: number
  wholesalePrice?: number
  /** Location-risk deduction applied to buy price (positional proximity) */
  locationPenalty?: number
  locationPenaltyPercent?: number
  recommendation?: string
  recommendationReason?: string
  /** Confidence gate on the comps driving the ARV */
  confidence?: 'high' | 'medium' | 'low'
  confidenceReasons?: string[]
  /** True unless HIGH — medium flags for review, low withholds the call */
  requiresHumanReview?: boolean
  investorAnalysis?: {
    status: string
    methodLabel: string
    sampleCount: number
    eligibleCount?: number
    value: number | null
    limitations: string[]
  } | null
  /** As-Is market intelligence from Group B comps (display only) */
  asIsMarketIntel?: {
    asIsMarketPrice?: number | null
    avgPricePerSqft?: number | null
    compCount?: number
    compIds?: string[]
    thresholdPercent?: number
    priceCeiling?: number
    noDataReason?: string
  } | null
}

export interface CompsData {
  count?: number
  enabledCount?: number
  disabledCount?: number
  avgPricePerSqft?: number | null
  medianPrice?: number | null
  items?: CompItem[]
}

export interface CompItem {
  id?: string
  selectionPending?: boolean
  priorityRank?: number | null
  rankingDetails?: string[]
  matchPercent?: number | null
  matchRuleCount?: number
  matchRuleTotal?: number
  matchReasons?: string[]
  address?: string
  city?: string | null
  state?: string | null
  zipCode?: string | null
  latitude?: number | null
  longitude?: number | null
  zillowUrl?: string | null
  salePrice?: number | null
  saleDate?: string | null
  squareFeet?: number | null
  pricePerSqft?: number | null
  distanceMiles?: number | null
  bedrooms?: number | null
  bathrooms?: number | null
  /** @deprecated Use bedrooms and bathrooms separately */
  bedsBaths?: string
  yearBuilt?: number | null
  lotSizeAcres?: number | null
  adjustedPrice?: number | null
  qualityScore?: number | null
  condition?: string | null
  isBestComp?: boolean
  photos?: string[]
  /** Subdivision name (if available) */
  subdivision?: string | null
  /** Foundation type (e.g., Slab, Crawl Space, Basement) */
  foundationType?: string | null
  /** Building style (e.g., Colonial, Cape Cod, Ranch) */
  buildingStyle?: string | null
  /** Pool type */
  pool?: string | null
  /** Garage type */
  garage?: string | null
  /** Garage square footage */
  garageSquareFeet?: number | null
  /** Carport type */
  carport?: string | null
  /** Construction type (e.g., Frame, Masonry) */
  constructionType?: string | null
  /** Roof type */
  roofType?: string | null
  /** Exterior walls */
  exteriorWalls?: string | null
  /** Number of stories */
  storiesType?: string | null
  /** Stories count */
  stories?: number | null
  /** Roof cover material */
  roofCover?: string | null
  /** Heating system type */
  heating?: string | null
  /** Cooling system type */
  cooling?: string | null
  /** Fireplace count */
  fireplacesCount?: number | null
  /** Assessor building condition (e.g., Average, Good) */
  buildingCondition?: string | null
  /** Assessor construction grade */
  buildingGrade?: string | null
  /** Neighborhood name from site-location */
  neighborhoodName?: string | null
  /** Building quality code */
  qualityCode?: string | null
  /** Reason this comp was selected/analyzed (LLM reasoning) */
  selectionReason?: string | null
  /** Key features identified by LLM analysis */
  keyFeatures?: string[] | null
  /** Whether this comp is enabled (passed all filters) */
  isEnabled?: boolean
  /** Which comp group: 'arv' (Group A, drives valuation), 'as_is' (Group B, market intel), or null */
  compGroup?: 'arv' | 'as_is' | null
  /** Visual ARV-candidacy check on listing photos (ARV-selected comps only) */
  curbAppeal?: {
    condition: 'renovated' | 'dated' | 'distressed' | 'unknown'
    confidence: number | null
    summary: string | null
    /** vision = verified from photos; price = inferred from top-of-market sale */
    source?: 'vision' | 'price'
    photosExamined: number
  } | null
  /** Price percentile among all comps (1 = highest, 100 = lowest) */
  pricePercentile?: number | null
  /** Reasons why this comp was disabled (if any) */
  disableReasons?: string[]
  /** Property classification (as_is, after_renovation, transitional) */
  classification?: ClassificationSummary | null
  /** Weight contribution to ARV calculation (0-1) */
  weightInArv?: number | null
  /** Appraisal rule evaluation details */
  appraisalRules?: {
    /** Whether this comp passed all filters */
    passedFilters: boolean
    /** Total adjustment amount applied to price */
    totalAdjustment: number
    /** Filter results - which rules matched/failed */
    filters: Array<{
      type: string
      passed: boolean
      reason?: string
      actualValue?: number | string | null
      threshold?: number | string | null
    }>
    /** Adjustment results - what price adjustments were applied */
    adjustments: Array<{
      type: string
      applied: boolean
      amount: number
      reason?: string
    }>
  } | null
}

export interface PermitsData {
  count?: number
  totalValue?: number
  recentTypes?: string[]
}

export interface FloodZoneData {
  zone?: string | null
  inFloodZone?: boolean
  description?: string | null
}

export interface NeighbourhoodData {
  crime?: {
    crimeIndex?: number | null
    crimeRisk?: string | null
    murderIndex?: number | null
    assaultIndex?: number | null
    robberyIndex?: number | null
    burglaryIndex?: number | null
    larcenyIndex?: number | null
    motorVehicleTheftIndex?: number | null
    violentCrimeIndex?: number | null
    propertyCrimeIndex?: number | null
  } | null
  demographics?: {
    population?: number | null
    populationDensity?: number | null
    medianIncome?: number | null
    medianAge?: number | null
    householdCount?: number | null
    medianHomeValue?: number | null
  } | null
  climate?: {
    avgHighTemp?: number | null
    avgLowTemp?: number | null
    annualRainfall?: number | null
    annualSnowfall?: number | null
    comfortIndex?: number | null
  } | null
  schools?: {
    nearby?: Array<{
      name: string
      type?: string | null
      gradeRange?: string | null
      rating?: number | null
      distance?: number | null
      latitude?: number | null
      longitude?: number | null
    }>
    count?: number
  } | null
  poi?: {
    summary?: Record<string, number>
    nearby?: Array<{
      name: string
      category?: string | null
      distance?: number | null
      latitude?: number | null
      longitude?: number | null
    }>
  } | null
}

// Legacy types for backward compatibility (deprecated)
export type PropertyData = SubjectData
export type ComparablesData = CompsData
export type EnrichmentData = {
  permits?: PermitsData | null
  floodZone?: FloodZoneData | null
}

// ─── Async Analysis Types ─────────────────────────────────────────────────────

export interface QueueAnalysisResult {
  success: boolean
  jobId?: string
  error?: string
  /** Full analysis result (synchronous response — legacy) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result?: Record<string, any>
  /** Partial result: raw subject + comps from CoreLogic (no evaluation yet) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  partialResult?: Record<string, any>
  /** Suggested filter values when no comps match (from API error) */
  suggestedFilters?: Array<{ type: string; enabled: boolean; value: number }>
  /** Suggested ARV threshold when no comps match */
  suggestedArvThreshold?: number
  /** SSE enrichment stream info (evaluation + Zillow + LLM) */
  enrichment?: {
    streamUrl: string
    token: string
    pending: string[]
  }
}

/**
 * Submit a property analysis request.
 * Returns result immediately + optional SSE enrichment stream info.
 */
export async function queueAnalysis(request: AnalyzeRequest): Promise<QueueAnalysisResult> {
  log('queueAnalysis called', { address: request.address, skipCache: request.skipCache })

  const session = await getSession()
  if (!session?.user) {
    logError('User not authenticated')
    return {
      success: false,
      error: 'Not authenticated. Please log in to use this feature.',
    }
  }

  log(`User authenticated: ${session.user.id} (${session.user.email})`)

  const dashboardSecret = await getDashboardSecret()
  if (!dashboardSecret) {
    logError('Dashboard secret not configured')
    return {
      success: false,
      error: 'Dashboard configuration error. Please contact support.',
    }
  }

  try {
    const apiUrl = await getApiUrl()

    const analyzeUrl = `${apiUrl}/v1/analyze`
    const requestBody = {
      address: request.address,
      existingJobId: request.existingJobId,
      searchOptions: request.searchOptions ?? {
        radiusMiles: 1,
        maxComps: 15,
        monthsBack: 12,
      },
      skipCache: request.skipCache,
      marketData: request.marketData,
      llmAnalysis: request.llmAnalysis,
      arvThresholdPercent: request.arvThresholdPercent,
      asIsThresholdPercent: request.asIsThresholdPercent,
      appraisalOverrides: request.appraisalOverrides,
    }

    logApiCall('POST', analyzeUrl)
    log('Request body', requestBody)

    const startTime = Date.now()
    const response = await fetch(analyzeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Dashboard-User-Id': session.user.id,
        'X-Dashboard-Secret': dashboardSecret,
      },
      body: JSON.stringify(requestBody),
    })

    const durationMs = Date.now() - startTime
    logApiCall('POST', analyzeUrl, response.status, durationMs)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await response.json() as {
      success?: boolean
      error?: string
      data?: {
        jobId: string
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result?: Record<string, any>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        partialResult?: Record<string, any>
        enrichment?: { streamUrl: string; token: string; pending: string[] }
      }
    }

    if (!response.ok || !result.success) {
      logError('Analysis failed', { status: response.status, error: result.error })
      return {
        success: false,
        error: result.error || `API request failed with status ${response.status}`,
        suggestedFilters: (result as { suggestedFilters?: Array<{ type: string; enabled: boolean; value: number }> }).suggestedFilters,
        suggestedArvThreshold: (result as { suggestedArvThreshold?: number }).suggestedArvThreshold,
      }
    }

    const jobId = result.data?.jobId

    log('Analysis started', { jobId, durationMs, hasPartialResult: !!result.data?.partialResult })

    return {
      success: true,
      jobId,
      result: result.data?.result,
      partialResult: result.data?.partialResult,
      enrichment: result.data?.enrichment,
    }
  } catch (error) {
    logError('queueAnalysis exception', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to analyze property',
    }
  }
}
