'use server'

import { getSession, getSessionStrict, type Session } from '@/lib/api'
import { getCloudflareEnv } from '@/lib/cloudflare'
import type { DealContext } from '@/lib/deal-context'

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
  /** Close CRM lead — lets reruns keep fetching realtor notes */
  leadId?: string
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
  evaluationEngine?: 'python-v4' | 'typescript' | 'ts-v5'
  /** Close CRM lead this report belongs to (from POST /v1/analyze leadId) — enables the Update CRM action */
  leadId?: string | null
  /** Close CRM opportunity linked to the lead */
  opportunityId?: string | null
  /** Realtor conversation-log notes fetched from Close at eval time */
  sellerNotes?: {
    fetchedAt: string
    notes: Array<{ id: string; createdAt: string; text: string }>
  } | null
  /** Note-derived items ADDED to the rehab ledger this run (additive only) */
  rehabAdditions?: Array<{
    itemId: string | null
    item: string
    estimatedCost: number
    evidence: string
  }> | null
  /** Notes suggesting a charged rehab item may be unneeded — display-only */
  rehabAdvisories?: Array<{
    itemId: string | null
    item: string
    suggestion: 'consider_removing' | 'informational'
    note: string
    evidence: string
  }> | null
  subject?: SubjectData
  valuation?: ValuationData
  /** Investor floor (Group B evidence) — survives a no-ARV run */
  asIsMarketIntel?: {
    asIsMarketPrice?: number | null
    avgPricePerSqft?: number | null
    compCount?: number
    flipSaleCount?: number
    compIds?: string[]
    thresholdPercent?: number
    priceCeiling?: number
    noDataReason?: string
  } | null
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
    /** Per-report manual ARV override (null/absent = computed) */
    arvOverride?: number | null
    /** Per-report ARV adjustment application/overrides keyed by rule id */
    arvAdjustments?: Record<string, { applied: boolean; percent?: number; direction?: 'deduction' | 'addition' }>
  }
}

export interface ClassificationSummary {
  type: 'as_is' | 'after_renovation' | 'transitional'
  confidence: number
  reasoning: string
  method?: string
}


export interface ListingDetails {
  beds?: number | null
  bathsFull?: number | null
  bathsHalf?: number | null
  squareFeet?: number | null
  yearBuilt?: number | null
  stories?: number | null
  lotSquareFeet?: number | null
  style?: string | null
  propertyType?: string | null
  hoaMonthly?: number | null
  listPrice?: number | null
  daysOnRedfin?: number | null
  mlsSource?: string | null
  roof?: string | null
  foundation?: string | null
  construction?: string | null
  heating?: string | null
  cooling?: string | null
  flooring?: string[]
  appliances?: string[]
  exteriorFeatures?: string[]
  parking?: string | null
  garage?: string | null
  pool?: boolean | null
  utilities?: string[]
  interiorFeatures?: string[]
  communityFeatures?: string[]
  schools?: Array<{ name: string; level?: string | null; rating?: number | null; assigned?: boolean | null; distanceMi?: number | null }>
  climateRisks?: {
    floodFactor?: number | null
    fireFactor?: number | null
    heatFactor?: number | null
    windFactor?: number | null
    airFactor?: number | null
  }
  subdivision?: string | null
  zoning?: string | null
  apn?: string | null
  county?: string | null
  saleHistory?: Array<{ date: string; event: string; price: number | null }>
  sourceUrl?: string
}

export type PhysicalCharacteristicSource = 'redfin' | 'zillow' | 'attom'
export type PhysicalCharacteristicStatus = 'verified' | 'conflict' | 'unverified'
export type PhysicalCharacteristicValue = string | number | boolean

export interface PhysicalCharacteristic<T extends PhysicalCharacteristicValue = PhysicalCharacteristicValue> {
  value: T | null
  status: PhysicalCharacteristicStatus
  sources: Array<{ source: PhysicalCharacteristicSource; value: PhysicalCharacteristicValue }>
}

export interface PhysicalCharacteristics {
  style: PhysicalCharacteristic<string>
  stories: PhysicalCharacteristic<number>
  constructionType: PhysicalCharacteristic<string>
  exterior: PhysicalCharacteristic<string>
  roof: PhysicalCharacteristic<string>
  foundation: PhysicalCharacteristic<string>
  garage: PhysicalCharacteristic<string>
  pool: PhysicalCharacteristic<boolean>
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
  lotSizeSquareFeet?: number | null
  yearBuilt?: number | null
  stories?: number | null
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
  /** One-sentence rationale for the assigned renovation level */
  conditionSummary?: string | null
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
  /** Redfin MLS property-details — shadow evidence */
  listingDetails?: ListingDetails | null
  /** Listing-source physical fields resolved after valuation; display-only. */
  physicalCharacteristics?: PhysicalCharacteristics
  /** Asking/list price scraped from the subject's listing (null when off-market) */
  listPrice?: number | null
  /** Set-B evidence fields — serialized from the pipeline */
  censusTract?: string | null
  censusBlockGroup?: string | null
  sameBlockGroup?: boolean | null
  crossesMajorRoad?: boolean | null
  landAssessedValue?: number | null
  evidenceVerification?: { staleness?: string | null; priceCheck?: string | null; pocketRatio?: number | null; flags?: string[] | null } | null
  /** Sqft-conflict evidence — provider-vs-marketed divergence + permit verdict */
  sqftEvidence?: { provider: number | null; listing: number | null; conflict: string | null; resolution: string | null; note: string | null } | null
  /** Land extraction — sale − contributory improvement = implied land value */
  landEvidence?: { address?: string | null; impliedLand: number; landPpsf: number; lotSf: number; basis: string } | null
  improvementAssessedValue?: number | null
  disableReasons?: string[] | null
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
  /** ATTOM AVM for the comparable */
  avmValue?: number | null
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
  /** Run-level trust grade — verified/weak/floor/withheld (server-computed) */
  resultGrade?: 'verified' | 'weak' | 'floor' | 'withheld'
  /** Did the run earn it — clean / retried / unverified */
  processGrade?: 'clean' | 'retried' | 'unverified'
  /** One-line server explanation for the result/confidence badge */
  statusReason?: string
  /** Set-B trade-tricks ARV (the pipeline ARV post-swap) */
  arvB?: number | null
  /** Set-B mechanics trail — anchor, drivers, ceiling, flags */
  bMechanics?: {
    source: string
    confidence: 'high' | 'medium' | 'low' | 'none'
    bracket: string
    flags: string[]
    anchorAddress: string | null
    conditionAdj: number | null
    ceiling: number | null
    landRateSource: string | null
    sqftRateSource: string | null
    healed: boolean
    /** Pool rates + band thresholds — replay inputs for client-side toggles */
    landRate?: number | null
    sqftRate?: number | null
    bandLo?: number | null
    bandHi?: number | null
    /** Land-extraction evidence — implied land $/lot-sf + land_play mode */
    land?: {
      pocketRate: number | null
      source: string | null
      subjectLandValue: number | null
      mode: 'land_play' | null
      comps: Array<{ address?: string | null; impliedLand: number; landPpsf: number; lotSf: number; basis: string }>
    } | null
    attemptTrail: string[]
    drivers: { address: string | null; contribution: number; landAdj?: number | null; tier: string; conditionTier: string }[]
    decisions?: { compAddress?: string | null; stage: string; rule: string; verdict: string; value?: number | string | null; note?: string }[]
  } | null
  buyPrice?: number
  buyPricePercent?: number
  rehabCost?: number
  baseRehabCost?: number
  majorItemsCost?: number
  rehabLevel?: string | null
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
  /** Wholesale fee deducted from buy price to reach the wholesale ceiling */
  wholesaleFee?: number
  /** Ask-vs-wholesale-ceiling realism — null when the subject has no list price */
  listPriceRealism?: {
    listPrice: number
    wholesalePrice: number
    /** listPrice − wholesalePrice (negative = ask below the ceiling) */
    gapDollars: number
    /** Gap as % of ask — ≤10% high, ≤20% medium, else low */
    gapPercent: number
    verdict: 'high' | 'medium' | 'low'
  } | null
  /** Location-risk deduction applied to buy price (positional proximity) */
  locationPenalty?: number
  locationPenaltyPercent?: number
  /** Characteristic additions/deductions applied to ARV this render */
  arvAdjustments?: Array<{ id: string; label: string; amount: number; direction: 'deduction' | 'addition' }>
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
  /** As-is (unrenovated) market value estimate */
  asIsValue?: number | null
  /** Asking/list price scraped from the subject's listing */
  listPrice?: number | null
  /** ARV minus list price — negative = ARV below asking (negotiation room) */
  arvVsListPrice?: number | null
}

export interface CompsData {
  count?: number
  enabledCount?: number
  disabledCount?: number
  /** True when the pool couldn't support a valuation — valuation is null */
  insufficientComps?: boolean
  avgPricePerSqft?: number | null
  medianPrice?: number | null
  /** Provider retrieval audit — includes paramFlex escalation record */
  retrieval?: {
    paramFlex?: { extensions: number; factor: number; concessions?: string[] } | null
  } | null
  /** Investor floor (Group B evidence) — survives a no-ARV run */
  asIsMarketIntel?: {
    asIsMarketPrice?: number | null
    avgPricePerSqft?: number | null
    compCount?: number
    flipSaleCount?: number
    compIds?: string[]
  } | null
  items?: CompItem[]
}

export interface CompBadges {
  price: 'renovated' | 'median' | 'as_is' | null
  condition: 'reno' | 'dated' | 'distressed' | 'unverified' | null
  pocket: 'in' | 'equal' | 'above' | 'below' | 'unknown' | null
  /** How the pocket match was earned — tract | block | name; null when out */
  pocketVia: 'tract' | 'block' | 'name' | null
  trust: 'verified' | 'partial' | 'unverified' | null
  checks: {
    pocket: boolean | null
    size: boolean | null
    fresh: boolean | null
    priceFit: boolean | null
  }
  /** Failed filters the run's expansion rescued (empty = strict admission) */
  widenedOn: string[]
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
  /** Provider-flagged distressed sale (e.g. ATTOM distressedStatus) — investor/as-is evidence */
  distressedSale?: boolean | null
  squareFeet?: number | null
  pricePerSqft?: number | null
  distanceMiles?: number | null
  bedrooms?: number | null
  bathrooms?: number | null
  /** @deprecated Use bedrooms and bathrooms separately */
  bedsBaths?: string
  yearBuilt?: number | null
  lotSizeAcres?: number | null
  lotSizeSquareFeet?: number | null
  propertyType?: string | null
  adjustedPrice?: number | null
  qualityScore?: number | null
  condition?: string | null
  isBestComp?: boolean
  photos?: string[]
  /** Subdivision name (if available) */
  subdivision?: string | null
  /** Set-B evidence fields — serialized from the pipeline */
  landAssessedValue?: number | null
  evidenceVerification?: { staleness?: string | null; priceCheck?: string | null; pocketRatio?: number | null; flags?: string[] | null } | null
  /** Sqft-conflict evidence — provider-vs-marketed divergence + permit verdict */
  sqftEvidence?: { provider: number | null; listing: number | null; conflict: string | null; resolution: string | null; note: string | null } | null
  /** Land extraction — sale − contributory improvement = implied land value */
  landEvidence?: { address?: string | null; impliedLand: number; landPpsf: number; lotSf: number; basis: string } | null
  improvementAssessedValue?: number | null
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
  /** ATTOM AVM for the comparable */
  avmValue?: number | null
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
  /**
   * Set-B verdict — which comps the server's verified ARV actually used.
   * 'anchor' = the sale the ARV is priced off, 'driver' = verified evidence,
   * 'pool' = evaluated but not a driver, 'excluded' = not in the Set-B pool.
   * Display-only; separate from the appraisal-grid enabled/compGroup state.
   */
  bRole?: 'anchor' | 'driver' | 'pool' | 'excluded' | null
  /** Server↔client trust contract — the server computes, the card renders */
  badges?: CompBadges | null
  /**
   * Reviewer's manual tier pin — 'arv' or 'as_is' — assigned on the comp
   * card. Rides alongside the automatic evidence class; never rewrites it.
   */
  userTier?: 'arv' | 'as_is' | null
  /** Census tract GEOID (Census geocoder, free tier) */
  censusTract?: string | null
  /** 12-digit Census block-group GEOID */
  censusBlockGroup?: string | null
  /** Road-barrier proxy — census tract differs from the subject's. Absent = unverified. */
  crossesMajorRoad?: boolean
  /** Same census block group as the subject — same micro-market evidence. Absent/null = unverified. */
  sameBlockGroup?: boolean | null
  /** Neither Census nor ATTOM produced a tract — geography never verified. */
  geographyUnverified?: boolean
  /** Visual ARV-candidacy check on listing photos (ARV-selected comps only) */
  curbAppeal?: {
    condition: 'renovated' | 'dated' | 'distressed' | 'unknown'
    confidence: number | null
    summary: string | null
    /** vision = verified from photos; price = inferred from top-of-market sale */
    source?: 'vision' | 'price'
    photosExamined: number
  } | null
  /** Redfin MLS property-details — shadow evidence */
  listingDetails?: ListingDetails | null
  /** Listing-source physical fields resolved after valuation; display-only. */
  physicalCharacteristics?: PhysicalCharacteristics
  /** Price percentile among all comps (1 = highest, 100 = lowest) */
  pricePercentile?: number | null
  /** Reasons why this comp was disabled (if any) */
  disableReasons?: string[]
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
  /** Run-level trust grade — verified/weak/floor/withheld (server-computed) */
  resultGrade?: 'verified' | 'weak' | 'floor' | 'withheld'
  /** Did the run earn it — clean / retried / unverified */
  processGrade?: 'clean' | 'retried' | 'unverified'
  /** One-line server explanation for the result/confidence badge */
  statusReason?: string
  /** Set-B trade-tricks ARV (the pipeline ARV post-swap) */
  arvB?: number | null
  /** Set-B mechanics trail — anchor, drivers, ceiling, flags */
  bMechanics?: {
    source: string
    confidence: 'high' | 'medium' | 'low' | 'none'
    bracket: string
    flags: string[]
    anchorAddress: string | null
    conditionAdj: number | null
    ceiling: number | null
    landRateSource: string | null
    sqftRateSource: string | null
    healed: boolean
    /** Pool rates + band thresholds — replay inputs for client-side toggles */
    landRate?: number | null
    sqftRate?: number | null
    bandLo?: number | null
    bandHi?: number | null
    /** Land-extraction evidence — implied land $/lot-sf + land_play mode */
    land?: {
      pocketRate: number | null
      source: string | null
      subjectLandValue: number | null
      mode: 'land_play' | null
      comps: Array<{ address?: string | null; impliedLand: number; landPpsf: number; lotSf: number; basis: string }>
    } | null
    attemptTrail: string[]
    drivers: { address: string | null; contribution: number; landAdj?: number | null; tier: string; conditionTier: string }[]
    decisions?: { compAddress?: string | null; stage: string; rule: string; verdict: string; value?: number | string | null; note?: string }[]
  } | null
  buyPrice?: number
  buyPricePercent?: number
  rehabCost?: number
  baseRehabCost?: number
  majorItemsCost?: number
  rehabLevel?: string | null
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
  /** Wholesale fee deducted from buy price to reach the wholesale ceiling */
  wholesaleFee?: number
  /** Ask-vs-wholesale-ceiling realism — null when the subject has no list price */
  listPriceRealism?: {
    listPrice: number
    wholesalePrice: number
    /** listPrice − wholesalePrice (negative = ask below the ceiling) */
    gapDollars: number
    /** Gap as % of ask — ≤10% high, ≤20% medium, else low */
    gapPercent: number
    verdict: 'high' | 'medium' | 'low'
  } | null
  /** Location-risk deduction applied to buy price (positional proximity) */
  locationPenalty?: number
  locationPenaltyPercent?: number
  /** Characteristic additions/deductions applied to ARV this render */
  arvAdjustments?: Array<{ id: string; label: string; amount: number; direction: 'deduction' | 'addition' }>
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
  /** As-is (unrenovated) market value estimate */
  asIsValue?: number | null
  /** Asking/list price scraped from the subject's listing */
  listPrice?: number | null
  /** ARV minus list price — negative = ARV below asking (negotiation room) */
  arvVsListPrice?: number | null
}

export interface CompsData {
  count?: number
  enabledCount?: number
  disabledCount?: number
  /** True when the pool couldn't support a valuation — valuation is null */
  insufficientComps?: boolean
  avgPricePerSqft?: number | null
  medianPrice?: number | null
  /** Provider retrieval audit — includes paramFlex escalation record */
  retrieval?: {
    paramFlex?: { extensions: number; factor: number; concessions?: string[] } | null
  } | null
  /** Investor floor (Group B evidence) — survives a no-ARV run */
  asIsMarketIntel?: {
    asIsMarketPrice?: number | null
    avgPricePerSqft?: number | null
    compCount?: number
    flipSaleCount?: number
    compIds?: string[]
  } | null
  items?: CompItem[]
}

export interface CompBadges {
  price: 'renovated' | 'median' | 'as_is' | null
  condition: 'reno' | 'dated' | 'distressed' | 'unverified' | null
  pocket: 'in' | 'equal' | 'above' | 'below' | 'unknown' | null
  /** How the pocket match was earned — tract | block | name; null when out */
  pocketVia: 'tract' | 'block' | 'name' | null
  trust: 'verified' | 'partial' | 'unverified' | null
  checks: {
    pocket: boolean | null
    size: boolean | null
    fresh: boolean | null
    priceFit: boolean | null
  }
  /** Failed filters the run's expansion rescued (empty = strict admission) */
  widenedOn: string[]
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
  /** Provider-flagged distressed sale (e.g. ATTOM distressedStatus) — investor/as-is evidence */
  distressedSale?: boolean | null
  squareFeet?: number | null
  pricePerSqft?: number | null
  distanceMiles?: number | null
  bedrooms?: number | null
  bathrooms?: number | null
  /** @deprecated Use bedrooms and bathrooms separately */
  bedsBaths?: string
  yearBuilt?: number | null
  lotSizeAcres?: number | null
  lotSizeSquareFeet?: number | null
  propertyType?: string | null
  adjustedPrice?: number | null
  qualityScore?: number | null
  condition?: string | null
  isBestComp?: boolean
  photos?: string[]
  /** Subdivision name (if available) */
  subdivision?: string | null
  /** Set-B evidence fields — serialized from the pipeline */
  landAssessedValue?: number | null
  evidenceVerification?: { staleness?: string | null; priceCheck?: string | null; pocketRatio?: number | null; flags?: string[] | null } | null
  /** Sqft-conflict evidence — provider-vs-marketed divergence + permit verdict */
  sqftEvidence?: { provider: number | null; listing: number | null; conflict: string | null; resolution: string | null; note: string | null } | null
  /** Land extraction — sale − contributory improvement = implied land value */
  landEvidence?: { address?: string | null; impliedLand: number; landPpsf: number; lotSf: number; basis: string } | null
  improvementAssessedValue?: number | null
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
  /** ATTOM AVM for the comparable */
  avmValue?: number | null
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
  /**
   * Set-B verdict — which comps the server's verified ARV actually used.
   * 'anchor' = the sale the ARV is priced off, 'driver' = verified evidence,
   * 'pool' = evaluated but not a driver, 'excluded' = not in the Set-B pool.
   * Display-only; separate from the appraisal-grid enabled/compGroup state.
   */
  bRole?: 'anchor' | 'driver' | 'pool' | 'excluded' | null
  /** Server↔client trust contract — the server computes, the card renders */
  badges?: CompBadges | null
  /**
   * Reviewer's manual tier pin — 'arv' or 'as_is' — assigned on the comp
   * card. Rides alongside the automatic evidence class; never rewrites it.
   */
  userTier?: 'arv' | 'as_is' | null
  /** Census tract GEOID (Census geocoder, free tier) */
  censusTract?: string | null
  /** 12-digit Census block-group GEOID */
  censusBlockGroup?: string | null
  /** Road-barrier proxy — census tract differs from the subject's. Absent = unverified. */
  crossesMajorRoad?: boolean
  /** Same census block group as the subject — same micro-market evidence. Absent/null = unverified. */
  sameBlockGroup?: boolean | null
  /** Neither Census nor ATTOM produced a tract — geography never verified. */
  geographyUnverified?: boolean
  /** Visual ARV-candidacy check on listing photos (ARV-selected comps only) */
  curbAppeal?: {
    condition: 'renovated' | 'dated' | 'distressed' | 'unknown'
    confidence: number | null
    summary: string | null
    /** vision = verified from photos; price = inferred from top-of-market sale */
    source?: 'vision' | 'price'
    photosExamined: number
  } | null
  /** Redfin MLS property-details — shadow evidence */
  listingDetails?: ListingDetails | null
  /** Listing-source physical fields resolved after valuation; display-only. */
  physicalCharacteristics?: PhysicalCharacteristics
  /** Price percentile among all comps (1 = highest, 100 = lowest) */
  pricePercentile?: number | null
  /** Reasons why this comp was disabled (if any) */
  disableReasons?: string[]
    class: 'ARV' | 'AS_IS' | 'UNIDENTIFIED'
    probabilities: Record<string, number> | null
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
  /** The job was already live — this response attaches to it, not starts it */
  alreadyRunning?: boolean
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

  let session: Session | null
  try {
    // getSessionStrict throws when the API is down — a transient outage is
    // not an auth failure, and telling a signed-in user to log in sends
    // them chasing the wrong fix.
    session = await getSessionStrict()
  } catch (e) {
    logError('Session check failed — API unreachable or erroring', e)
    return {
      success: false,
      error: 'The analysis service is unreachable right now — it may still be starting up. Try again in a few seconds.',
    }
  }
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
      leadId: request.leadId,
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
        alreadyRunning?: boolean
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
      alreadyRunning: result.data?.alreadyRunning,
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

/**
 * Manual comp-tier assignment — pin a comparable to 'arv' or 'as_is' from the
 * comp card (Property Search), or clear the pin with null. Persisted per
 * (job, comp) on the API and applied onto the report at read time — the
 * automatic classification is never rewritten, the pin rides alongside it.
 */
export async function assignCompTier(
  jobId: string,
  compId: string,
  tier: 'arv' | 'as_is' | null,
): Promise<{ success: boolean; error?: string }> {
  const session = await getSession()
  if (!session?.user) {
    return { success: false, error: 'Not authenticated. Please log in to use this feature.' }
  }
  const dashboardSecret = await getDashboardSecret()
  if (!dashboardSecret) {
    return { success: false, error: 'Dashboard configuration error. Please contact support.' }
  }
  try {
    const apiUrl = await getApiUrl()
    const url = `${apiUrl}/v1/analyze/jobs/${encodeURIComponent(jobId)}/comp-tier`
    logApiCall('PUT', url)
    const startTime = Date.now()
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Dashboard-User-Id': session.user.id,
        'X-Dashboard-Secret': dashboardSecret,
      },
      body: JSON.stringify({ compId, tier }),
    })
    logApiCall('PUT', url, response.status, Date.now() - startTime)
    const data = (await response.json().catch(() => ({}))) as { success?: boolean; error?: string }
    if (!response.ok || data?.success !== true) {
      return { success: false, error: data?.error ?? `API request failed with status ${response.status}` }
    }
    return { success: true }
  } catch (error) {
    logError('assignCompTier exception', error)
    return { success: false, error: error instanceof Error ? error.message : 'Failed to assign comp tier' }
  }
}

// ─── Offer dispatch (Devin listener session + engine) ────────────────────────

export interface OfferPrepInput {
  /** Optional — the listener resolves the lead in Close by address */
  leadId?: string
  propertyAddress: string
  purchasePrice: number
  opportunityId?: string
  /** Report jobId — persisted with the disposition so revisit links
   *  survive even after the lead leaves the queue. */
  jobId?: string
  /** Full deal context the UI decided on — forwarded to the engine. */
  deal?: DealContext | null
}

export interface OfferDispatchResult {
  ok: boolean
  error?: string
  idempotent?: boolean
}

/** Dispatch a PREP OFFER to the persistent Devin session + engine. */
export async function dispatchOfferPrep(input: OfferPrepInput): Promise<OfferDispatchResult> {
  const session = await getSession()
  if (!session?.user) return { ok: false, error: 'Not authenticated' }
  const dashboardSecret = await getDashboardSecret()
  if (!dashboardSecret) return { ok: false, error: 'Dashboard configuration error' }
  try {
    const apiUrl = await getApiUrl()
    const response = await fetch(`${apiUrl}/v1/offers/prep`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Dashboard-User-Id': session.user.id,
        'X-Dashboard-Secret': dashboardSecret,
      },
      body: JSON.stringify(input),
    })
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; idempotent?: boolean }
    if (!response.ok || data?.ok !== true) {
      return { ok: false, error: data?.error ?? `API request failed with status ${response.status}` }
    }
    return { ok: true, idempotent: data.idempotent }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to dispatch offer prep' }
  }
}

/** Record a no-margin decline for a lead (identified by leadId or address). */
export async function declineOffer(input: { leadId?: string; propertyAddress?: string; jobId?: string; purchasePrice?: number; workflow?: 'no_margin' | 'no_offer'; deal?: DealContext | null }): Promise<OfferDispatchResult> {
  const session = await getSession()
  if (!session?.user) return { ok: false, error: 'Not authenticated' }
  const dashboardSecret = await getDashboardSecret()
  if (!dashboardSecret) return { ok: false, error: 'Dashboard configuration error' }
  try {
    const apiUrl = await getApiUrl()
    const response = await fetch(`${apiUrl}/v1/offers/decline`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Dashboard-User-Id': session.user.id,
        'X-Dashboard-Secret': dashboardSecret,
      },
      body: JSON.stringify(input),
    })
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    if (!response.ok || data?.ok !== true) {
      return { ok: false, error: data?.error ?? `API request failed with status ${response.status}` }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Failed to record decline' }
  }
}
