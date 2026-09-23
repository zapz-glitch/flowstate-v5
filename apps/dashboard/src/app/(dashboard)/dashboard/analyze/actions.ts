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
  /**
   * Jev read-only classification of this completed outcome. Display-only —
   * never influenced comp selection, ARV, or the recommendation.
   */
  jevOutcome?: JevOutcomeData | null
  /** Baseline A comp-truth run metadata (dual nouls) — A/B observability */
  jevCompTruth?: { model: string; latencyMs: number; inputTokens: number; scored: number } | null
  /**
   * Candidate B comp price-classification run metadata — mode (shadow or
   * enabled), per-class counts, disagreement count vs Baseline A.
   */
  jevCompClassification?: JevCompClassificationData | null
  jevAttributeScreen?: JevAttributeScreenData | null
  jevHybrid?: JevHybridData | null
  /** Justified evaluation report (subset used by comp feedback) */
  report?: {
    arv?: {
      compPool?: {
        total: number
        enabled: number
        fallbackUsed: string
        fallbackReason?: string
      }
    }
  }
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

/** Candidate B comp-classification run metadata (shadow or enabled) */
export interface JevCompClassificationData {
  status: 'completed' | 'skipped' | 'unavailable'
  reason?: string
  mode: 'enabled' | 'shadow'
  questionVersion: string
  model?: string
  latencyMs?: number
  inputTokens?: number
  eligibleCount?: number
  counts?: { arv: number; asIs: number; unidentified: number }
  disagreements?: number | null
  stateHashes?: string[]
  classifiedAt?: string
  /**
   * Counterfactual (shadow only): what B's pool routing would have produced
   * through the same deterministic valuation math. Display-only.
   */
  shadowValuation?: {
    arv: number | null
    arvComps: number
    arvPrunedBelowSpec: number
    asIsValue: number | null
    asIsComps: number
    buyPrice: number | null
    projectedProfit: number | null
    projectedROI: number | null
    recommendation: string | null
    deltas: { arv: number | null; asIsValue: number | null; buyPrice: number | null }
    assessment?: JevOutcomeData
    arvCompIds?: string[]
    asIsCompIds?: string[]
    arvPrunedCompIds?: string[]
  }
}

export interface JevAttributeScreenData {
  status: 'completed' | 'skipped' | 'unavailable'
  reason?: string
  mode: 'enabled' | 'shadow'
  questionVersion: string
  model?: string
  latencyMs?: number
  inputTokens?: number
  scoredCount?: number
  poolCount?: number
  counts?: { arv: number; asIs: number }
  anchors?: { arvAnchor: number | null; asIsAnchor: number | null }
  stateHashes?: string[]
  classifiedAt?: string
  shadowValuation?: {
    arv: number | null
    arvComps: number
    asIsValue: number | null
    asIsComps: number
    buyPrice: number | null
    projectedProfit: number | null
    projectedROI: number | null
    recommendation: string | null
    deltas: { arv: number | null; asIsValue: number | null; buyPrice: number | null }
    assessment?: JevOutcomeData
    arvCompIds?: string[]
    asIsCompIds?: string[]
  }
}

/** Two-test Jev run metadata — test 1 (raw-field nouls) + test 2 (enriched nouls + distance score) */
export interface JevHybridData {
  status: 'completed' | 'skipped' | 'unavailable'
  reason?: string
  mode: 'enabled' | 'shadow'
  questionVersion: string
  /** Jev run metadata — test 1 + test 2 stages combined */
  model?: string
  latencyMs?: number
  inputTokens?: number
  stateHashes?: string[]
  test1?: { model: string; latencyMs: number; inputTokens: number; stateHashes: string[] } | null
  test2?: { model: string; latencyMs: number; inputTokens: number; stateHashes: string[] } | null
  counts?: {
    pool: number
    ineligible: number
    test1Passed: number
    test1Failed: number
    enriched: number
    test2Passed: number
    test2Failed: number
    core: number
    filled: number
    selected: number
  }
  selection?: {
    /** The ideal core comp set — test-2 passers; the fail bucket fills to this when short */
    coreTarget: number
    noulGate: number
    /** True when fill picks were needed — fewer than the target passed test 2 */
    fillUsed?: boolean
  }
  /** The questions this run asked — generated from the appraisal preset */
  questionSet?: {
    test1: { key: string; label: string }[]
    test2: { key: string; label: string; advisory: boolean }[]
    scoreLevels: string[]
  }
  screenedAt?: string
}

/** Per-comp Jev evaluation record — test 1 fields, test 2 nouls + score, selection */
export interface JevHybridCompScore {
  compId: string
  /**
   * 'ineligible'  = no usable price/date, never tested
   * 'test1_fail'  = failed a test-1 field (or a field could not be verified)
   * 'test1_pass'  = passed test 1 but beyond the enrich cap — never test-2'd
   * 'test2_fail'  = passed test 1, failed test 2 — ineligible but scored
   * 'test2_pass'  = passed both tests — eligible for the core set
   */
  stage: 'ineligible' | 'test1_fail' | 'test1_pass' | 'test2_fail' | 'test2_pass'
  rejectReasons: string[]
  saleAgeDays: number | null
  /** Property-detail data was merged before test 2 */
  enriched?: boolean
  /** Test 1 — the eight raw-field nouls */
  test1: {
    /** field → 0–1 probability the comp matches the subject on it */
    nouls: Record<string, number | null>
    /** Verifiable fields below the gate */
    failedFields: string[]
    /** Fields the data could not verify — count as not passed */
    unverifiableFields: string[]
    /** All fields verified at/above the gate — the "passed test 1" bucket */
    passed: boolean
  } | null
  /** Test 2 — the enriched nouls plus the distance-dominant score */
  test2: {
    nouls: {
      subdivision: number
      neighborhood: number
      /** Advisory — preferred, never gating */
      physicalCharacter: number
      /** Advisory — preferred, never gating */
      material: number
    }
    /** Subdivision yes, or neighborhood yes — eligible for the core set */
    passed: boolean
    /** Distance-dominant spectrum score /100 */
    score: number
    confidence: number | null
    /** Score level index → probability */
    levelProbabilities: Record<string, number>
  } | null
  /** Score /100 for the card — the test-2 score */
  score: number | null
  scoreConfidence: number | null
  /** 1-based rank among test-2-evaluated comps by score — #1 is closest */
  poolRank: number | null
  /** 'core' = test-2 passer in the ARV set · 'fill' = fallback pick from the test-2-fail bucket */
  selected: 'core' | 'fill' | null
  adjustedPrice: number | null
}

/** Jev read-only outcome classification attached to a completed analysis */
export interface JevOutcomeData {
  status: 'completed' | 'skipped' | 'unavailable'
  reason?: string
  classifications?: Partial<Record<JevOutcomeDimension, JevOutcomeSignal>>
  /** Atomic yes/no sub-checks (0–1) exposing what drove each headline label */
  drivers?: Partial<Record<JevOutcomeDimension, Record<string, number>>>
  /** Every answer Jev returned, verbatim — survives question-type changes */
  answers?: Record<string, JevOutcomeAnswer>
  model?: string
  latencyMs?: number
  inputTokens?: number
  classifiedAt?: string
}

export interface JevOutcomeAnswer {
  /** 'choice' | 'score' | 'noul' today; future types pass through */
  type: string
  choice?: string
  score?: number
  noul?: number
  confidence?: number
  probabilities?: Record<string, number>
  [key: string]: unknown
}

export type JevOutcomeDimension =
  | 'evidence_sufficiency'
  | 'comp_set_quality'
  | 'deal_outlook'
  | 'recommendation_agreement'
  | 'risk_flags'

/** A dimension's raw Jev answer — `choice`/`score`/`noul` or future types */
export type JevOutcomeSignal = JevOutcomeAnswer

/** Property classification (As-Is vs After-Renovation) */
export interface ClassificationSummary {
  type: 'as_is' | 'after_renovation' | 'transitional'
  confidence: number
  reasoning: string
  method?: string
}

export interface SubjectData {
  permits?: {
    status: 'available' | 'empty' | 'unavailable' | 'not_requested'
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
  /** Asking/list price scraped from the subject's listing (null when off-market) */
  listPrice?: number | null
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
  /** Neighborhood code from site-location */
  neighborhoodCode?: string | null
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
    /** Verified flip acquisition (priorSale) data points folded into the average */
    flipSaleCount?: number
    compIds?: string[]
    thresholdPercent?: number
    priceCeiling?: number
    noDataReason?: string
  } | null
  /** Asking/list price scraped from the subject's listing */
  listPrice?: number | null
  /** ARV minus list price — negative = ARV below asking (negotiation room) */
  arvVsListPrice?: number | null
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
  saleReconciled?: { previousPrice: number | null; previousDate: string | null; source: 'zillow' } | null
  flip?: { priorSalePrice: number; priorSaleDate: string; daysHeld: number; gainPct: number } | null
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
  /** Neighborhood code from site-location */
  neighborhoodCode?: string | null
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
  /** Jev truth score (0–1): reliable evidence of the subject's after-renovation retail value */
  jevArvTruth?: number | null
  /** Jev truth score (0–1): reliable evidence of the subject's as-is investor value */
  jevInvestmentTruth?: number | null
  /** Candidate B structured price class — present when the v2 classifier ran (shadow or enabled); observability only */
  jevPriceClassification?: {
    class: 'ARV' | 'AS_IS' | 'UNIDENTIFIED'
    probabilities: Record<string, number> | null
    confidence: number | null
    /** Largest / second-largest option probability and their margin — abstention analysis only, never routing */
    top1?: number | null
    top2?: number | null
    margin?: number | null
    rawChoice?: string | null
  } | null
  jevAttributeScores?: Partial<Record<
    | 'same_neighborhood'
    | 'same_subdivision'
    | 'within_sqft_range'
    | 'within_lot_sqft_range'
    | 'same_property_style'
    | 'same_construction'
    | 'same_foundation'
    | 'within_year_built_range',
    number
  >> | null
  jevScreenScore?: number | null
  jevScreenPool?: boolean
  jevScreenBand?: 'arv' | 'as_is' | null
  jevScreenRank?: number | null
  jevScreenBandRank?: number | null
  /** V4 hybrid audit — Jev class, hard-gate result, per-dimension proximity scores, pool rank, role */
  jevHybrid?: JevHybridCompScore | null
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
      /** 'passed' | 'failed' | 'not_verified' — distinguishes a real failure from missing data */
      status?: 'passed' | 'failed' | 'not_verified'
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
  /** 'parcel'/'spatial' = provider FEMA data · 'listing' = Redfin/First Street scrape signal */
  source?: 'parcel' | 'spatial' | 'listing' | null
  specialFloodHazardArea?: string | null
  mapPanel?: string | null
  mapDate?: string | null
  communityName?: string | null
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
