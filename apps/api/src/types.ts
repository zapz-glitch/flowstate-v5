/**
 * API Types
 */

/** Minimal shape of a Workers Pipelines stream binding (cloudflare:pipelines). */
export interface PipelineStream<T = Record<string, unknown>> {
  send(records: T[]): Promise<void>
}

export interface Env {
  DB: D1Database
  API_CACHE: KVNamespace
  /** Basin lake — analysis outcome events → Iceberg on R2 */
  FLOWSTATE_ANALYSIS_EVENTS_STREAM?: PipelineStream
  REPORT_ASSETS?: R2Bucket
  /** Workers AI binding — Clef decision models (comp curb-appeal classification) */
  AI?: Ai
  ANALYSIS_JOB: DurableObjectNamespace
  BATCH_JOB: DurableObjectNamespace
  /** Global Cotality request throttle (50 req/min sliding window) */
  RATE_LIMIT_COORDINATOR?: DurableObjectNamespace
  ENVIRONMENT: string
  V4_STAGING_ASSETS_ENABLED?: string

  // ─── Dashboard URL ────────────────────────────────────────────────────────
  /** Production dashboard URL (e.g. 'https://flowstate.homes') */
  DASHBOARD_URL?: string

  // ─── Property Data Provider ────────────────────────────────────────────────
  /** Active provider: 'corelogic' | 'attom' (default: 'corelogic') */
  PROPERTY_PROVIDER?: string
  /** Deployment-level eval harness when the request doesn't name one:
   *  'agent' (Sonnet appraiser) | 'corelogic' (deterministic selector).
   *  alpha.flowstate sets 'corelogic'; unset = deterministic engine. */
  DEFAULT_HARNESS?: string
  /** Deployment-level evidence backend when the request doesn't name one:
   *  'jev' = TypeSafe JEV question-types lane; unset = OpenAI Decisions. */
  DEFAULT_EVIDENCE_BACKEND?: string
  /** Deployment-level assist arm when the request doesn't name one:
   *  'A' haiku | 'B' deepseek-flash | 'C' haiku→sonnet ladder. */
  DEFAULT_ASSIST_ARM?: string
  /** Per-run evidence backend selector read by decisionsRun ('jev' |
   *  anything-else = Decisions). Set from the job config. */
  EVIDENCE_BACKEND?: string
  /** TypeSafe JEV backend (EVIDENCE_BACKEND='jev') — key + endpoint + model */
  JEV_API_KEY?: string
  TYPESAFE_URL?: string
  JEV_MODEL?: string
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
  /** corelogic-alpha working-pool cap — comps the expensive lanes touch
   *  (geo+name matches always kept; fill by distance to this size). */
  CORE_WORKING_POOL?: string
  /** corelogic-alpha scrape budget — max comps the listing-evidence gather
   *  touches per eval (best-ranked working comps first). */
  CORE_SCRAPE_MAX?: string
  /** corelogic-alpha fetch cap — maxComps sent to the provider (default 40:
   *  the 30-comp working pool plus a buffer for pocket comps ranked past 30
   *  by distance). */
  CORE_FETCH_CAP?: string

  // ─── Property Data (ATTOM) ─────────────────────────────────────────────────
  ATTOM_API_KEY?: string

  // ─── ATTOM MCP provider (experimental — PROPERTY_PROVIDER=attom-mcp) ───────
  // OAuth pair injected by scripts/sync-attom-token.mjs from the Devin CLI
  // creds file. Refresh rotates the pair in-isolate; stale env pair → resync.
  /** Static API key — production auth path; bypasses OAuth when set */
  ATTOM_MCP_API_KEY?: string
  ATTOM_MCP_ACCESS_TOKEN?: string
  ATTOM_MCP_REFRESH_TOKEN?: string
  ATTOM_MCP_CLIENT_ID?: string
  /** M2M client_credentials pair — production auth path */
  ATTOM_MCP_M2M_CLIENT_ID?: string
  ATTOM_MCP_CLIENT_SECRET?: string
  /** epoch seconds */
  ATTOM_MCP_EXPIRES_AT?: string
  ATTOM_MCP_ENDPOINT?: string

  // ─── Clef comp-condition classification (input-side evidence, off by default)
  /** 'clef' (27B) or 'clef-flash' (9B, default) */
  CLEF_MODEL?: string
  /** 'true' enables comp curb-appeal evidence in the pipeline */
  CLEF_COMP_CONDITION_ENABLED?: string
  /** Optional cap on comps per run that get Clef classification (default: all returned) */
  CLEF_COMP_MAX?: string

  // ─── Vision Analysis (OpenRouter LLM) ──────────────────────────────────────
  // OpenRouter provides access to multiple models via single API
  OPENROUTER_API_KEY?: string
  OPENAI_API_KEY?: string
  OPENROUTER_MODEL?: string // Default model for general LLM tasks
  VISION_MODEL?: string // Vision-only override (subject reno tier) — defaults to OPENROUTER_MODEL
  // ─── Reasoning lane (Anthropic direct — replaces gpt-6-luna) ───
  ANTHROPIC_API_KEY?: string
  REASONING_PROVIDER?: string // 'anthropic' | 'openrouter' | unset → anthropic when ANTHROPIC_API_KEY set
  REASONING_MODEL?: string // default 'claude-haiku-5-5'
  REASONING_OPENROUTER_MODEL?: string // OpenRouter model for the reasoning lane (assist-model arm B)
  /** Keep only this many comps — the nearest to the subject — as the whole pool */
  COMP_POOL_NEAREST?: string
  /** 'true' holds the reasoning model back until the appraiser stage — no reasoning-model calls during evidence gathering */
  REASONING_STAGE_ONLY?: string
  /** 'false' turns off Google Street View (no coverage check, no image, no street comparison) */
  STREET_VIEW_ENABLED?: string
  /** 'false' turns off Set-B site reads (rooftop pin + aerial water/busy-road + listing pool). */
  SITE_READS_ENABLED?: string
  /** 'false' turns off every OpenStreetMap lookup (Overpass location risks, Nominatim street orientation) */
  OSM_ENABLED?: string
  /** 'true' = the appraiser gets one model call: no questions, no revision */
  APPRAISER_SINGLE_PASS?: string
  /** Pins the appraiser's reasoning effort for every pass: low | medium | high | xhigh | max */
  APPRAISER_EFFORT?: string
  /** 'reasoning' seats the reasoning lane's model as the appraiser (comp selection); unset = Sonnet */
  APPRAISER_SEAT?: string
  /** 'true' records every outbound API call of every run to a 90-day per-job call log */
  CALL_LOG_ENABLED?: string
  // ─── Condition-reader lane ───
  /** 'decisions' routes Clef reads through the OpenAI Decisions API; unset → Workers AI Clef */
  CONDITION_READER?: string
  DECISIONS_MODEL?: string // default 'gpt-6-luna'
  /** Model for comp selection — stronger reasoning (e.g., 'anthropic/claude-sonnet-4', 'google/gemini-2.5-pro-preview') */
  COMP_SELECTION_MODEL?: string
  /** Model for market context web search — fast/cheap (e.g., 'google/gemini-2.0-flash-001') */
  MARKET_SEARCH_MODEL?: string

  // ─── Provider selection ──────────────────────────────────────────────────
  // Read-only post-analysis labeling; absence disables classification only.
  TYPESAFE_API_KEY?: string
  TYPESAFE_MODEL?: string

  // ─── Google AI (Gemini) ──────────────────────────────────────────────────────
  // Direct Google AI API key for Gemini URL context and Zillow data fetching
  GEMINI_API_KEY?: string

  // ─── Firecrawl ─────────────────────────────────────────────────────────────────
  // Firecrawl API for web scraping (Zillow photos)
  FIRECRAWL_API_KEY?: string
  /** Scrapfly — listing fetch engine (Zillow/Redfin/Realtor) + web search
   *  (listing-URL discovery, pocket-desirability evidence) */
  SCRAPFLY_API_KEY?: string
  /** Scrapfly scrape endpoint — defaults to https://api.scrapfly.io/scrape */
  SCRAPFLY_URL?: string
  /** Google Maps Platform — Street View Static curb-appeal fallback */
  GOOGLE_MAPS_KEY?: string
  /** Cloudflare Browser Rendering — dedicated headless-browser pool for
   *  listing-page renders (comp evidence). @cloudflare/puppeteer binding. */
  BROWSER?: Fetcher
  /** Geocodio — metered census-geography lookups (primary path; free 2.5k/day) */
  GEOCODIO_API_KEY?: string

  // ─── Dashboard Integration ─────────────────────────────────────────────────
  // Internal secret for dashboard-to-API authentication (no API key required)
  DASHBOARD_INTERNAL_SECRET?: string

  // ─── CDARV ML Service ──────────────────────────────────────────────────────
  // Session-auth proxy target + shared service token (both directions)
  CDARV_API_URL?: string
  CDARV_INTERNAL_API_TOKEN?: string

  // ─── Close CRM ────────────────────────────────────────────────────────────
  // API key for lead updates (PUT /lead/{id}). Server-side only — never
  // exposed to the client.
  CLOSE_API_KEY?: string

  // ─── Devin Cloud ────────────────────────────────────────────────────────────
  // Service-user key for POST /v1/sessions — offer workflows (prep offer /
  // no margin) run as Devin Cloud sessions. Server-side only.
  DEVIN_API_KEY?: string
  // Optional playbook that defines the prep-offer/no-margin procedures —
  // sessions attach it so the agent knows the workflow steps.
  DEVIN_PLAYBOOK_ID?: string
  // Devin org id — used for POST /v3/organizations/{org}/sessions messages
  // to the persistent offer listener session.
  DEVIN_ORG_ID?: string
  // Auth key for the conversation-intelligence engine worker
  // (offer-draft notifications on offer dispatch).
  ENGINE_API_KEY?: string
  // Bearer token the CI engine uses to push activity events into
  // POST /v1/activity. Server-side only.
  CI_INGEST_KEY?: string
  // Shared secret for POST /pipeline/events — the Devin listener and
  // engine authenticate funnel telemetry with this bearer token.
  FS_EVENTS_KEY?: string

  // ─── Better Auth ─────────────────────────────────────────────────────────────
  BETTER_AUTH_SECRET?: string

  // ─── Transactional Email (Fastmail JMAP) ────────────────────────────────────
  FASTMAIL_API_TOKEN?: string
  /** From identity for auth emails, e.g. 'hello@flowstate.homes' (must exist as a Fastmail identity) */
  AUTH_EMAIL_FROM?: string
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
