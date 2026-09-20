/**
 * API Types
 */

export interface Env {
  DB: D1Database
  API_CACHE: KVNamespace
  REPORT_ASSETS?: R2Bucket
  ANALYSIS_JOB: DurableObjectNamespace
  BATCH_JOB: DurableObjectNamespace
  /** Global Cotality request throttle (50 req/min sliding window) */
  RATE_LIMIT_COORDINATOR?: DurableObjectNamespace
  ENVIRONMENT: string
  V4_LOCAL_BRIDGE_URL?: string
  V4_LOCAL_BRIDGE_TOKEN?: string
  V4_HOSTED_API_URL?: string
  V4_HOSTED_USER_CREDENTIALS?: string
  V4_STAGING_ASSETS_ENABLED?: string
  V4_SNAPSHOT_ACTIVE_KEY_ID?: string
  V4_SNAPSHOT_KEYS?: string
  V4_SNAPSHOT_LEGACY_KEYS?: string

  // ─── Dashboard URL ────────────────────────────────────────────────────────
  /** Production dashboard URL (e.g. 'https://flowstate.homes') */
  DASHBOARD_URL?: string

  // ─── Property Data Provider ────────────────────────────────────────────────
  /** Active provider: 'corelogic' | 'attom' (default: 'corelogic') */
  PROPERTY_PROVIDER?: string
  /**
   * Candidate-pool size for comparable retrieval (system config — not an
   * owner-facing Appraisal Rule). Defaults to the provider maximum
   * (CoreLogic maxComps = 100); values above the provider max are clamped.
   */
  COMPARABLE_CANDIDATE_LIMIT?: string
  /**
   * Radius used when the appraisal expansion ladder needs candidates beyond
   * the fetched radius (default: fetched radius x geographicDistanceMultiplier).
   */
  COMPARABLE_EXPANSION_RADIUS_MILES?: string

  // ─── Property Data (CoreLogic) ─────────────────────────────────────────────
  CORELOGIC_CLIENT_ID?: string
  CORELOGIC_CLIENT_SECRET?: string
  /** Rotation pool — keys 0..8, each with its own API-product entitlements */
  CORELOGIC_CLIENT_ID_0?: string
  CORELOGIC_CLIENT_SECRET_0?: string
  CORELOGIC_CLIENT_ID_1?: string
  CORELOGIC_CLIENT_SECRET_1?: string
  CORELOGIC_CLIENT_ID_2?: string
  CORELOGIC_CLIENT_SECRET_2?: string
  CORELOGIC_CLIENT_ID_3?: string
  CORELOGIC_CLIENT_SECRET_3?: string
  CORELOGIC_CLIENT_ID_4?: string
  CORELOGIC_CLIENT_SECRET_4?: string
  CORELOGIC_CLIENT_ID_5?: string
  CORELOGIC_CLIENT_SECRET_5?: string
  CORELOGIC_CLIENT_ID_6?: string
  CORELOGIC_CLIENT_SECRET_6?: string
  CORELOGIC_CLIENT_ID_7?: string
  CORELOGIC_CLIENT_SECRET_7?: string
  CORELOGIC_CLIENT_ID_8?: string
  CORELOGIC_CLIENT_SECRET_8?: string

  // ─── Property Data (ATTOM) ─────────────────────────────────────────────────
  ATTOM_API_KEY?: string

  // ─── Vision Analysis (OpenRouter LLM) ──────────────────────────────────────
  // OpenRouter provides access to multiple models via single API
  OPENROUTER_API_KEY?: string
  OPENAI_API_KEY?: string
  OPENROUTER_MODEL?: string // Default model for general LLM tasks
  /** Model for comp selection — stronger reasoning (e.g., 'anthropic/claude-sonnet-4', 'google/gemini-2.5-pro-preview') */
  COMP_SELECTION_MODEL?: string
  /** Model for market context web search — fast/cheap (e.g., 'google/gemini-2.0-flash-001') */
  MARKET_SEARCH_MODEL?: string

  // ─── Jev Outcome Classification (Typesafe SystemOne) ───────────────────────
  // Read-only post-analysis labeling; absence disables classification only.
  TYPESAFE_API_KEY?: string
  TYPESAFE_MODEL?: string
  /**
   * 'true' → Candidate B (structured ARV/AS_IS/UNIDENTIFIED choice) drives
   * comp routing. Default false — Baseline A dual-noul argmax is production.
   */
  JEV_COMP_CLASSIFIER_V2_ENABLED?: string
  /**
   * 'false' disables the Candidate B shadow run. Default on: B classifies
   * gate-eligible comps alongside Baseline A and records the result on the
   * response without affecting routing, valuation, or recommendation.
   */
  JEV_COMP_CLASSIFIER_V2_SHADOW?: string

  // ─── Google AI (Gemini) ──────────────────────────────────────────────────────
  // Direct Google AI API key for Gemini URL context and Zillow data fetching
  GEMINI_API_KEY?: string

  // ─── Firecrawl ─────────────────────────────────────────────────────────────────
  // Firecrawl API for web scraping (Zillow photos)
  FIRECRAWL_API_KEY?: string

  // ─── Dashboard Integration ─────────────────────────────────────────────────
  // Internal secret for dashboard-to-API authentication (no API key required)
  DASHBOARD_INTERNAL_SECRET?: string

  // ─── CDARV ML Service ──────────────────────────────────────────────────────
  // Session-auth proxy target + shared service token (both directions)
  CDARV_API_URL?: string
  CDARV_INTERNAL_API_TOKEN?: string

  // ─── Better Auth ─────────────────────────────────────────────────────────────
  BETTER_AUTH_SECRET?: string

  // ─── SMTP Email ─────────────────────────────────────────────────────────────
  SMTP_HOST?: string
  SMTP_PORT?: string
  SMTP_USER?: string
  SMTP_PASS?: string
  SMTP_FROM?: string // e.g., 'Flowstate <noreply@flowstate.homes>'
}

// NOTE: AuthContext is defined in middleware/auth.ts and should be imported from there

// ─── CoreLogic Types ─────────────────────────────────────────────────────────

export interface OAuthTokenResponse {
  access_token: string
  token_type: string
  expires_in: number
}

export interface PropertySearchResponse {
  items?: PropertySearchItem[]
  messages?: { message?: string }[]
}

export interface PropertySearchItem {
  clip: string
  clipId?: string
  propertyAddress?: {
    streetAddress?: string
    city?: string
    state?: string
    zipCode?: string
    county?: string
  }
  address?: {
    streetAddress?: string
    city?: string
    state?: string
    zipCode?: string
    county?: string
  }
  location?: {
    latitude?: number
    longitude?: number
  }
  parcelNumber?: string
}

export interface PropertyDetailResponse {
  property?: {
    clip?: string
    address?: {
      streetAddress?: string
      city?: string
      state?: string
      zipCode?: string
      county?: string
    }
    building?: {
      bedrooms?: number
      bathrooms?: number
      buildingSquareFeet?: number
      yearBuilt?: number
      stories?: number
      constructionType?: string
      roofType?: string
      foundation?: string
      foundationType?: string
      heating?: string
      cooling?: string
      parkingSpaces?: number
      garageSquareFeet?: number
      garageType?: string
      garageSpaces?: number
      poolType?: string
      fireplaces?: number
      basement?: {
        type?: string
        squareFeet?: number
        finishedSquareFeet?: number
      }
    }
    lot?: {
      lotSquareFeet?: number
      lotAcres?: number
      zoning?: string
      landUseCode?: string
    }
    site?: {
      pool?: string
    }
    location?: {
      latitude?: number
      longitude?: number
      subdivision?: string
    }
    owner?: {
      ownerName?: string
      ownerOccupied?: boolean
      mailingAddress?: string
    }
    ownership?: {
      ownerName?: string
      ownerOccupied?: boolean
      mailingAddress?: string
    }
    assessment?: {
      assessedValue?: number
      marketValue?: number
    }
    tax?: {
      assessedValue?: number
      marketValue?: number
      taxAmount?: number
      taxYear?: number
    }
    summary?: {
      propertyType?: string
    }
    landUse?: string
    zoning?: string
    lastSale?: {
      saleDate?: string
      salePrice?: number
      pricePerSqft?: number
      deedType?: string
    }
  }
  buildings?: {
    data?: {
      allBuildingsSummary?: {
        bedroomsCount?: number
        bathroomsCount?: number
        fullBathroomsCount?: number
        halfBathroomsCount?: number
        livingAreaSquareFeet?: number
        totalAreaSquareFeet?: number
        fireplacesCount?: number
      }
      buildings?: Array<{
        yearBuilt?: number
        effectiveYearBuilt?: number
        constructionType?: string
        roofType?: string
        exteriorWalls?: string
        foundation?: string
        heating?: string
        cooling?: string
        parkingSpacesCount?: number
        garageSquareFeet?: number
        poolType?: string
        storiesCount?: number
        basement?: {
          type?: string
          squareFeet?: number
          finishedSquareFeet?: number
        }
      }>
    }
  }
  ownership?: {
    data?: {
      owners?: Array<{ fullName?: string }>
      ownerOccupied?: boolean
      mailingAddress?: {
        streetAddress?: string
        city?: string
        state?: string
        zip?: string
      }
    }
  }
  siteLocation?: {
    data?: {
      coordinatesParcel?: { lat?: number; lng?: number }
      locationLegal?: { subdivision?: string }
      lot?: { areaAcres?: number; areaSquareFeet?: number }
      landUseAndZoningCodes?: { landUseDescription?: string; zoningCode?: string }
    }
  }
  taxAssessment?: {
    data?: {
      totalMarketValue?: number
      totalAssessedValue?: number
      landAssessedValue?: number
      improvementAssessedValue?: number
      taxAmount?: number
      taxYear?: number
    }
  }
  lastMarketSale?: {
    data?: {
      saleDate?: string
      salePrice?: number
      pricePerSquareFoot?: number
    }
  }
  mostRecentOwnerTransfer?: {
    data?: {
      saleDate?: string
      salePrice?: number
      buyerName?: string
      sellerName?: string
    }
  }
}

export interface ComparablesResponse {
  clip?: string
  comparables?: ComparableProperty[]
}

export interface ComparableProperty {
  clip: string
  clipId?: string
  streetAddress?: string
  city?: string
  state?: string
  zip?: string
  latitude?: number
  longitude?: number
  bedrooms?: number
  baths?: number
  buildingSquareFeet?: number
  lotSquareFeet?: number
  yearBuilt?: string
  salePrice?: number
  saleDate?: string
  distance?: number
  pricePerSquareFoot?: number
  // Nested structure for route compatibility
  address?: {
    streetAddress?: string
    city?: string
    state?: string
    zipCode?: string
  }
  location?: {
    latitude?: number
    longitude?: number
  }
  building?: {
    bedrooms?: number
    bathrooms?: number
    buildingSquareFeet?: number
    yearBuilt?: number
  }
  lot?: {
    lotSquareFeet?: number
  }
  summary?: {
    propertyType?: string
  }
  lastSale?: {
    saleDate?: string
    salePrice?: number
    daysOnMarket?: number
  }
  similarityScore?: number
  adjustedPrice?: number
}

export interface FloodZoneResponse {
  floodHazardZone?: string
  sfha?: string
  within250FtOfFloodZone?: string
  communityName?: string
  mapPanel?: string
  floodZone?: string
  panelNumber?: string
  mapDate?: string
}

// ─── API Response Types ──────────────────────────────────────────────────────

export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
  meta?: {
    requestId: string
    timestamp: string
    quota?: {
      used: number
      limit: number
      remaining: number
    }
  }
}

export interface PropertyData {
  clip: string
  address: string
  city: string
  state: string
  zipCode: string
  county: string | null
  // Building
  bedrooms: number | null
  bathrooms: number | null
  squareFeet: number | null
  yearBuilt: number | null
  stories: number | null
  // Construction
  constructionType: string | null
  roofType: string | null
  foundation: string | null
  heating: string | null
  cooling: string | null
  // Features
  fireplaces: number | null
  parkingSpaces: number | null
  garageSquareFeet: number | null
  poolType: string | null
  basement: { type: string | null; squareFeet: number | null; finishedSquareFeet: number | null } | null
  // Location
  latitude: number | null
  longitude: number | null
  subdivision: string | null
  lotAcres: number | null
  lotSquareFeet: number | null
  landUse: string | null
  zoning: string | null
  // Ownership
  ownerName: string | null
  ownerOccupied: boolean | null
  mailingAddress: string | null
  // Tax
  assessedValue: number | null
  marketValue: number | null
  taxAmount: number | null
  taxYear: number | null
  // Last sale
  lastSalePrice: number | null
  lastSaleDate: string | null
  lastSalePricePerSqft: number | null
  // Flood zone
  floodZone: {
    zone: string | null
    isInFloodZone: boolean
    isNearFloodZone: boolean
  } | null
}

export interface ComparableData {
  clip: string
  address: string
  city: string
  state: string
  zipCode: string
  latitude: number | null
  longitude: number | null
  bedrooms: number | null
  bathrooms: number | null
  squareFeet: number | null
  lotSquareFeet: number | null
  yearBuilt: number | null
  salePrice: number | null
  saleDate: string | null
  pricePerSqft: number | null
  distance: number | null
}

export interface ValuationData {
  arv: number
  arvTier: string
  pricePerSqft: number
  // Rehab
  rehabLevel: string
  rehabPerSqft: number
  estimatedRehabCost: number
  // Buy price
  buyPrice: number
  buyPricePercent: number
  // Wholesale
  wholesalePrice: number
  wholesalePricePercent: number
  // Profit
  projectedProfit: number
  projectedROI: number
  // Recommendation
  recommendation: 'strong-buy' | 'buy' | 'hold' | 'pass'
}
