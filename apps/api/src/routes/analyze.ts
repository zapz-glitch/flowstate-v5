/**
 * Property Analysis Route
 *
 * Synchronous endpoint: CoreLogic fetch → evaluation → JSON response.
 * Optional async enrichment via Durable Objects (Market Data + LLM).
 *
 * Flow:
 * 1. Load user settings (appraisal rules, deal params, rehab config)
 * 2. Fetch property bundle from CoreLogic (property + comps + enrichment)
 * 3. performAnalysis() — Group A comp selection, ARV, Group B as-is intel
 * 4. Return JSON immediately
 * 5. (Optional) Start DO-based enrichment: Zillow scraping + LLM analysis via SSE
 */

import { Hono } from 'hono';
import type { Env } from '../types';
import type { AuthContext } from '../middleware/auth';
import {
  REHAB_LEVELS,
  MAJOR_ITEMS,
  type MajorItem,
} from '../services/valuation';
import { loadUserAnalysisSettings } from '../services/user-settings';
import { resolveCandidateLimit } from '../services/property-api/retrieval-policy';
import { generateSseToken } from '../utils/sse-token';
import { AnalysisError } from '../utils/analysis-error';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and } from 'drizzle-orm';
import { savedReports } from '../db/schema';

type Variables = { auth: AuthContext };

const analyze = new Hono<{ Bindings: Env; Variables: Variables }>();

// ─── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Generate a unique job ID
 */
function generateJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
}

/** 21 days — window in which a repeat evaluation with identical params returns the stored report. */
export const EVAL_RESULT_TTL_SECONDS = 21 * 24 * 60 * 60;

/** Stable, order-insensitive stringify for hashing eval params. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

async function hashEvalParams(params: unknown): Promise<string> {
  const data = new TextEncoder().encode(stableStringify(params));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function evalResultKey(userId: string, address: string, paramsHash: string): string {
  const norm = address.trim().toLowerCase().replace(/\s+/g, ' ');
  return `eval-result:${userId}:${norm}:${paramsHash}`;
}

// ─── Request Types ─────────────────────────────────────────────────────────────

interface AnalyzeRequest {
  /** Existing job ID — when set, updates existing report instead of creating new */
  existingJobId?: string;
  // Property identification (one of these required)
  address?: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  propertyId?: string;

  // Comparable search options
  searchOptions?: {
    radiusMiles?: number;
    maxComps?: number;
    monthsBack?: number;
  };

  // Buybox parameters
  buybox?: {
    rehabLevelIndex?: number;
    majorItems?: MajorItem[];
    additionPlay?: number;
    closingCostsPercent?: number;
    carryingCostsPercent?: number;
    wholesaleFee?: number;
  };

  // Enrichment options
  enrichment?: {
    permits?: boolean;
    floodZone?: boolean;
    weatherRisk?: boolean;
  };

  /** Skip cache and fetch fresh data from APIs */
  skipCache?: boolean;

  /** Override ARV comp threshold for this request (top % of comps by sale price) */
  arvThresholdPercent?: number;

  /** Override as-is threshold (% of ARV below which comps are classified as-is) — default 70 */
  asIsThresholdPercent?: number;

  /** Override appraisal rules for this request */
  appraisalOverrides?: {
    filters?: Array<{
      type: string;
      enabled: boolean;
      value: number;
      /** 'hard' = required (verified failure disqualifies) | 'soft' = preferred (ranks only) */
      priority?: 'hard' | 'soft';
    }>;
    adjustments?: Array<{
      type: string;
      enabled: boolean;
      amount: number;
      percent?: number;
    }>;
  };

  /** Market data enrichment: scrape public listing data via Firecrawl */
  marketData?: {
    enabled?: boolean;
  };

  /** LLM-based comp analysis options */
  llmAnalysis?: {
    enabled?: boolean;
    includePhotos?: boolean;
    /** Override model for comp selection */
    compSelectionModel?: string;
    /** Override model for market context search */
    marketSearchModel?: string;
  };
}

const ALLOWED_MODELS = new Set([
  'google/gemini-3-flash-preview',
  'google/gemini-2.5-flash',
]);

function validateModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  if (!ALLOWED_MODELS.has(model)) return undefined;
  return model;
}

// ─── Main Endpoint ─────────────────────────────────────────────────────────────

/**
 * POST /analyze
 *
 * Start a property analysis using Cloudflare Workflows.
 * Returns immediately with job ID and URLs for status/streaming.
 *
 * Processing is handled by AnalysisWorkflow with parallel execution.
 * Results can be retrieved via:
 * - WebSocket: /ws/analyze/:jobId (real-time updates)
 * - Polling: GET /analyze/jobs/:jobId
 */
analyze.post('/', async (c) => {
  try {
    const routeStart = Date.now();
    const body = await c.req.json<AnalyzeRequest>();
    const auth = c.get('auth');

    // Validate input
    if (!body.address && !body.streetAddress && !body.propertyId) {
      return c.json(
        {
          success: false,
          error: 'address, streetAddress, or propertyId is required',
        },
        400,
      );
    }

    const isRefresh = !!body.existingJobId;
    const jobId = isRefresh ? body.existingJobId! : generateJobId();

    // ─── 1. Load user settings ───────────────────────────────────────────────
    const settingsStart = Date.now();
    const userSettings = await loadUserAnalysisSettings(
      c.env.DB,
      {
        userId: auth.userId,
        address: { city: body.city, state: body.state, zipCode: body.zipCode },
        buyboxOverrides: body.buybox,
      },
      c.env.API_CACHE,
    );
    console.log(
      `[Analyze][Timing] User settings: ${Date.now() - settingsStart}ms`,
    );

    // ─── 2. Start streaming analysis in DO ────────────────────────────────────
    // Everything runs in the Durable Object and streams results via SSE.
    // The route returns immediately with jobId + SSE token.

    let appraisalRules = userSettings.appraisalRules;
    if (body.appraisalOverrides) {
      const overrideFilters = body.appraisalOverrides.filters?.map((f) => ({
        type: f.type as import('../services/appraisal').FilterType,
        enabled: f.enabled,
        value: f.value,
        priority: f.priority,
      }));
      const overrideAdjustments = body.appraisalOverrides.adjustments?.map(
        (a) => ({
          type: a.type as import('../services/appraisal').AdjustmentType,
          enabled: a.enabled,
          amount: a.amount,
          percent: a.percent,
        }),
      );
      appraisalRules = {
        filters: overrideFilters ?? appraisalRules?.filters ?? [],
        adjustments: overrideAdjustments ?? appraisalRules?.adjustments ?? [],
      };
    }

    const arvThreshold = body.arvThresholdPercent
      ? { percent: body.arvThresholdPercent }
      : userSettings.arvThreshold;

    const evalParams = {
      appraisalRules,
      buybox: userSettings.mergedBuybox,
      customRehabTable: userSettings.customRehabTable,
      customTierRanges: userSettings.customTierRanges,
      customMajorItemCosts: userSettings.customMajorItemCosts,
      arvThreshold,
      asIsThresholdPercent:
        body.asIsThresholdPercent ?? userSettings.asIsThresholdPercent,
      proximityConfig: userSettings.proximityConfig,
    };

    // 21-day eval-result cache: same address + same effective params returns
    // the stored report; different params hash -> fresh run. skipCache and
    // explicit refresh always bypass.
    const evalParamsHash = await hashEvalParams(evalParams);
    const resultCacheKey = evalResultKey(auth.userId, body.address ?? '', evalParamsHash);
    if (!body.skipCache && !isRefresh && c.env.API_CACHE) {
      try {
        const cachedJobId = await c.env.API_CACHE.get(resultCacheKey)
        if (cachedJobId) {
          const db = drizzle(c.env.DB)
          const [cached] = await db
            .select({ fullResponseJson: savedReports.fullResponseJson })
            .from(savedReports)
            .where(and(eq(savedReports.userId, auth.userId), eq(savedReports.jobId, cachedJobId)))
            .limit(1)
          if (cached?.fullResponseJson) {
            return c.json({
              success: true,
              data: {
                jobId: cachedJobId,
                result: JSON.parse(cached.fullResponseJson),
                cached: true,
                enrichment: null,
              },
            });
          }
          // Report row gone — stale pointer, fall through to a fresh run
          await c.env.API_CACHE.delete(resultCacheKey).catch(() => {})
        }
      } catch { /* cache best-effort */ }
    }

    const sseSecret = c.env.BETTER_AUTH_SECRET || '';
    const token = await generateSseToken(sseSecret, jobId, auth.userId);
    const apiBaseUrl = c.req.url.replace(/\/v1\/analyze.*/, '');
    const streamUrl = `${apiBaseUrl}/sse/analyze/${jobId}`;

    const doId = c.env.ANALYSIS_JOB.idFromName(jobId);
    const stub = c.env.ANALYSIS_JOB.get(doId);
    const startResp = await stub.fetch('http://internal/start-streaming', {
      method: 'POST',
      body: JSON.stringify({
        jobId,
        userId: auth.userId,
        search: {
          address: body.address,
          streetAddress: body.streetAddress,
          city: body.city,
          state: body.state,
          zipCode: body.zipCode,
          propertyId: body.propertyId,
        },
        searchOptions: body.searchOptions ?? {},
        enrichment: body.enrichment,
        skipCache: body.skipCache,
        evalResultCacheKey: resultCacheKey,
        evalParams,
        llmEnabled:
          body.llmAnalysis?.enabled === true && !!c.env.OPENROUTER_API_KEY,
        isRefresh,
        llmOptions: {
          includePhotos: body.llmAnalysis?.includePhotos,
          compSelectionModel: validateModel(
            body.llmAnalysis?.compSelectionModel,
          ),
          marketSearchModel: validateModel(body.llmAnalysis?.marketSearchModel),
        },
      }),
    });
    await startResp.text();

    console.log(
      `[Analyze][Timing] Route returned in ${Date.now() - routeStart}ms (streaming via DO)`,
    );

    return c.json({
      success: true,
      data: {
        jobId,
        // No result — it streams via SSE
        result: null,
        enrichment: {
          streamUrl,
          token,
          pending: ['property_fetch', 'evaluation', 'llm'],
        },
      },
    });
  } catch (error) {
    console.error('[Analyze] Error:', error);

    if (error instanceof AnalysisError) {
      return c.json(
        {
          success: false,
          error: error.message.replace('BAD_DEAL: ', ''),
          ...(error.code ? { code: error.code } : {}),
          ...(error.suggestedFilters
            ? { suggestedFilters: error.suggestedFilters }
            : {}),
          ...(error.suggestedArvThreshold
            ? { suggestedArvThreshold: error.suggestedArvThreshold }
            : {}),
        },
        400,
      );
    }

    const message =
      error instanceof Error ? error.message : 'Failed to analyze property';
    return c.json({ success: false, error: message }, 500);
  }
});

/**
 * GET /analyze/defaults
 *
 * Get default values for appraisal rules and buybox parameters
 */
analyze.get('/defaults', async (c) => {
  return c.json({
    success: true,
    data: {
      searchOptions: {
        radiusMiles: 1,
        maxComps: resolveCandidateLimit(c.env, 'corelogic'),
        monthsBack: 12,
      },
      buybox: {
        rehabLevelIndex: 2,
        closingCostsPercent: 8,
        carryingCostsPercent: 2,
        wholesaleFee: 10000,
      },
      // Permits moved to the on-demand report action; flood signal comes from
      // the Redfin listing scrape (Firecrawl) instead of the paid provider call.
      enrichment: {
        permits: false,
        floodZone: false,
        weatherRisk: false,
      },
      rehabLevels: REHAB_LEVELS.map((name, index) => ({ index, name })),
      majorItems: MAJOR_ITEMS,
    },
  });
});

// ─── Lazy Photo Loading ───────────────────────────────────────────────────────

/**
 * POST /analyze/comp-photos
 *
 * Fetch photos + descriptions for comps on demand.
 * Used when a user enables a previously-disabled comp that didn't have photos fetched.
 * Limited to 5 comps per request.
 */
// Photo endpoint disabled — Firecrawl removed
analyze.post('/comp-photos', async (c) => {
  return c.json({ success: false, error: 'Photo provider not available' }, 503);
});

export default analyze;
