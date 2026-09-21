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
import {
  EVAL_RESULT_TTL_SECONDS,
  decodeVerdict,
  evalResultKey,
  hashEvalParams,
  searchOptionsFingerprint,
} from '../utils/eval-cache';
import { drizzle } from 'drizzle-orm/d1';
import { eq, and } from 'drizzle-orm';
import { analysisRuns, savedReports } from '../db/schema';

type Variables = { auth: AuthContext };

const analyze = new Hono<{ Bindings: Env; Variables: Variables }>();

// ─── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Generate a unique job ID
 */
function generateJobId(): string {
  return `job_${Date.now()}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/** 21 days — window in which a repeat evaluation with identical params returns the stored report. */
export { EVAL_RESULT_TTL_SECONDS };

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

  /** Override max age (days) for a Zillow sale to reconcile a stale comp price — default 365 */
  reconciliationSaleAgeDays?: number;

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
 * Start a property analysis. Returns immediately with job ID and a
 * signed SSE stream URL; the work runs inside a per-job Durable Object.
 *
 * Results can be retrieved via:
 * - SSE: GET /sse/analyze/:jobId?token=... (real-time events)
 * - Polling: GET /v1/analyze/jobs/:jobId
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

    // Re-runs attach to an existing job — verify the caller owns it, else an
    // authed user could hijack another user's job DO (jobIds leak via shared
    // report URLs) or collide with their saved_reports row.
    if (isRefresh) {
      const ownerDb = drizzle(c.env.DB);
      const [owner] = await ownerDb
        .select({ userId: savedReports.userId })
        .from(savedReports)
        .where(eq(savedReports.jobId, jobId))
        .limit(1);
      // A failed first run leaves no saved_reports row — fall back to the
      // analysis_runs record so legitimate retries still work.
      const runOwner = owner ? null : (await ownerDb
        .select({ userId: analysisRuns.userId })
        .from(analysisRuns)
        .where(eq(analysisRuns.jobId, jobId))
        .limit(1))[0];
      const ownerId = owner?.userId ?? runOwner?.userId;
      if (!ownerId || ownerId !== auth.userId) {
        return c.json({ success: false, error: 'Job not found' }, 404);
      }
    }

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
      reconciliationSaleAgeDays:
        body.reconciliationSaleAgeDays ?? userSettings.reconciliationSaleAgeDays,
      proximityConfig: userSettings.proximityConfig,
    };

    // 21-day eval-result cache: same address + same effective params returns
    // the stored report; different params hash -> fresh run. skipCache and
    // explicit refresh always bypass.
    const evalParamsHash = await hashEvalParams({
      evalParams,
      searchOptions: searchOptionsFingerprint(body.searchOptions),
    });
    const resultCacheKey = evalResultKey(auth.userId, body.address ?? '', evalParamsHash);
    if (!body.skipCache && !isRefresh && c.env.API_CACHE) {
      try {
        const cachedJobId = await c.env.API_CACHE.get(resultCacheKey)
        // Cached terminal verdict — replay the error without a provider call.
        const verdict = cachedJobId ? decodeVerdict(cachedJobId) : null
        if (verdict) {
          return c.json(
            { success: false, error: verdict.message, code: verdict.code },
            400,
          );
        }
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
    // A live run owns the DO — surface its refusal (e.g. 409 already-running)
    // instead of reporting success for a run that was never started.
    if (!startResp.ok) {
      const errBody = await startResp.json().catch(() => null) as { error?: string } | null;
      return c.json(
        {
          success: false,
          error: errBody?.error ?? 'Analysis could not be started — job already running',
        },
        startResp.status === 409 ? 409 : 502,
      );
    }
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
 * GET /analyze/jobs/:jobId
 *
 * Poll a submitted analysis — the return channel for API clients that
 * can't hold the SSE stream. Returns job status while running and the
 * same AnalysisResponse (incl. jevOutcome) once complete. Falls back to
 * the saved report when the Durable Object state is gone.
 */
analyze.get('/jobs/:jobId', async (c) => {
  const auth = c.get('auth');
  const jobId = c.req.param('jobId');

  const doId = c.env.ANALYSIS_JOB.idFromName(jobId);
  const stub = c.env.ANALYSIS_JOB.get(doId);
  const resp = await stub.fetch('http://internal/state');
  const state = (await resp.json().catch(() => null)) as {
    userId?: string
    status?: string
    pending?: string[]
    events?: Array<{ event: string; data?: unknown }>
    error?: string
    createdAt?: number
  } | null;

  // jobIds are unguessable, but still verify ownership so a leaked id
  // can't read another user's evaluation. Strict: a live job state with no
  // owner is never a pass — only a fully evicted DO may fall through to the
  // (userId-scoped) saved-report fallback below.
  const liveJob = state?.status === 'processing' || state?.status === 'idle'
    || state?.status === 'complete' || state?.status === 'error';
  if (state?.userId ? state.userId !== auth.userId : liveJob) {
    return c.json({ success: false, error: 'Job not found' }, 404);
  }

  const reportResult = async () => {
    const db = drizzle(c.env.DB);
    const [report] = await db
      .select({ fullResponseJson: savedReports.fullResponseJson })
      .from(savedReports)
      .where(and(eq(savedReports.userId, auth.userId), eq(savedReports.jobId, jobId)))
      .limit(1);
    return report?.fullResponseJson ? JSON.parse(report.fullResponseJson) : null;
  };

  // The DO flips status to 'complete' on enrichment_done even after an
  // earlier 'error' event — evaluation_complete is the only reliable
  // success marker; a 'complete' status with an error event and no
  // evaluation_complete is an error.
  const events = state?.events ?? [];
  const evalComplete = events.some((ev) => ev.event === 'evaluation_complete');
  const errorEvent = events.find((ev) => ev.event === 'error');
  const status = state?.status === 'complete' && !evalComplete && errorEvent
    ? 'error'
    : state?.status;

  if (status === 'complete' || status === 'error') {
    // The latest updatedResult event is canonical — llm_complete carries
    // the post-annotation copy.
    let result: unknown = null;
    for (const ev of events) {
      const data = ev.data as { updatedResult?: unknown } | null | undefined;
      if (data && typeof data === 'object' && data.updatedResult) result = data.updatedResult;
    }
    if (!result) result = await reportResult();
    if (result) {
      return c.json({ success: true, data: { jobId, status: 'complete', result } });
    }
    return c.json({
      success: true,
      data: { jobId, status: 'error', error: state?.error ?? 'Evaluation failed' },
    });
  }

  if (status === 'processing' || status === 'idle') {
    return c.json({
      success: true,
      data: {
        jobId,
        status: 'processing',
        pending: state?.pending ?? [],
        lastEvent: events.length ? events[events.length - 1]!.event : null,
        elapsedMs: state?.createdAt ? Date.now() - state.createdAt : null,
      },
    });
  }

  // DO state missing ('not_found') — the saved report outlives it.
  const result = await reportResult();
  if (result) {
    return c.json({ success: true, data: { jobId, status: 'complete', result } });
  }
  return c.json({ success: false, error: 'Job not found' }, 404);
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
