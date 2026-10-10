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

import { Hono, type Context } from 'hono';
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
import { eq, and, or, lt, asc } from 'drizzle-orm';
import { analysisRuns, harnessQueue, savedReports, compTierOverrides } from '../db/schema';
import { applyCompTierOverrides } from '../utils/comp-tier-overrides';

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

  /** Close CRM lead this evaluation belongs to — persisted on the report so
   *  the report's "Update CRM" action can write back to the lead */
  leadId?: string;

  /** Close CRM opportunity linked to the lead (stored alongside leadId) */
  opportunityId?: string;

  /** 'agent' runs the evidence pipeline then parks the job as
   *  `awaiting_agent` — the Evaluation Agent posts its comp-selection
   *  verdict to /jobs/:jobId/harness/selection and the deterministic tail
   *  finishes the eval. Omitted = today's deterministic Set-B path. */
  harness?: 'agent' | 'corelogic' | 'typescript';
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
    let existingCrmLink: { leadId?: string; opportunityId?: string } | null = null;
    if (isRefresh) {
      const ownerDb = drizzle(c.env.DB);
      const [owner] = await ownerDb
        .select({ userId: savedReports.userId, fullResponseJson: savedReports.fullResponseJson })
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
      // Recover the CRM link from the stored report so a Refresh keeps
      // fetching realtor notes even when the caller didn't send leadId.
      if (owner?.fullResponseJson) {
        try {
          const prior = JSON.parse(owner.fullResponseJson) as {
            leadId?: unknown
            opportunityId?: unknown
          };
          existingCrmLink = {
            leadId: typeof prior.leadId === 'string' ? prior.leadId : undefined,
            opportunityId: typeof prior.opportunityId === 'string' ? prior.opportunityId : undefined,
          };
        } catch { /* unparsable report JSON — treat as no CRM link */ }
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
    // The env default counts too — a DEFAULT_HARNESS=typescript run with no
    // explicit harness must not inherit the caller's preset grid, or the same
    // request evaluates differently per user's saved preset. Same resolution
    // the result-cache key uses below.
    const seatHarness = (body.harness === 'agent' || body.harness === 'corelogic' || body.harness === 'typescript')
      ? body.harness
      : (c.env.DEFAULT_HARNESS === 'corelogic' || c.env.DEFAULT_HARNESS === 'agent' || c.env.DEFAULT_HARNESS === 'typescript'
          ? c.env.DEFAULT_HARNESS
          : undefined)
    if (body.appraisalOverrides || seatHarness) {
      const overrideFilters = body.appraisalOverrides?.filters?.map((f) => ({
        type: f.type as import('../services/appraisal').FilterType,
        enabled: f.enabled,
        value: f.value,
        priority: f.priority,
      }));
      const overrideAdjustments = body.appraisalOverrides?.adjustments?.map(
        (a) => ({
          type: a.type as import('../services/appraisal').AdjustmentType,
          enabled: a.enabled,
          amount: a.amount,
          percent: a.percent,
        }),
      );
      appraisalRules = seatHarness != null
        // Agent runs are governed by EVAL-AGENT-RULESET.md — the caller's
        // overrides are verbatim and the user's preset never merges in.
        // With no filters enabled, comps stay enabled except for the hard
        // data gates (non-market price, lot mismatch, transaction noise).
        ? {
            filters: overrideFilters ?? [],
            adjustments: overrideAdjustments ?? [],
          }
        : {
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
    // Harness mode gets its own cache keyspace — a deterministic report is
    // never served to an agent run (it needs to park for the verdict), and
    // an agent verdict never leaks into deterministic cached results.
    // Resolve the effective harness the same way evalParams does — an
    // env-defaulted harness must key the cache too, or a corelogic-default
    // deployment serves deterministic-harness reports to ordinary requests
    // (and vice versa) through the shared KV.
    const resultCacheKey = evalResultKey(
      auth.userId,
      body.address ?? '',
      evalParamsHash + (seatHarness ? `:${seatHarness}` : ''),
    );
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
            const cachedResult = JSON.parse(cached.fullResponseJson) as Record<string, unknown>
            // Attach a newly supplied CRM link onto the stored report so the
            // Update CRM action works even when the run was served from cache.
            if ((typeof body.leadId === 'string' && body.leadId && cachedResult.leadId !== body.leadId) ||
                (typeof body.opportunityId === 'string' && body.opportunityId && cachedResult.opportunityId !== body.opportunityId)) {
              if (body.leadId) cachedResult.leadId = body.leadId
              if (body.opportunityId) cachedResult.opportunityId = body.opportunityId
              await db.update(savedReports)
                .set({ fullResponseJson: JSON.stringify(cachedResult) })
                .where(eq(savedReports.jobId, cachedJobId))
                .catch(() => {})
            }
            return c.json({
              success: true,
              data: {
                jobId: cachedJobId,
                result: cachedResult,
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
        // A refresh is definitionally a cache-bust: skipCache must apply
        // even when the caller didn't pass the flag explicitly.
        skipCache: body.skipCache || isRefresh,
        evalResultCacheKey: resultCacheKey,
        evalParams,
        llmEnabled:
          body.llmAnalysis?.enabled === true && !!c.env.OPENROUTER_API_KEY,
        isRefresh,
        leadId: (typeof body.leadId === 'string' ? body.leadId.slice(0, 128) : undefined)
          ?? existingCrmLink?.leadId?.slice(0, 128),
        opportunityId: (typeof body.opportunityId === 'string' ? body.opportunityId.slice(0, 128) : undefined)
          ?? existingCrmLink?.opportunityId?.slice(0, 128),
        callerRef: c.req.header('Idempotency-Key')?.slice(0, 128),
        llmOptions: {
          includePhotos: body.llmAnalysis?.includePhotos,
          compSelectionModel: validateModel(
            body.llmAnalysis?.compSelectionModel,
          ),
          marketSearchModel: validateModel(body.llmAnalysis?.marketSearchModel),
        },
        // Explicit harness param wins; else the deployment's DEFAULT_HARNESS
        // env drives it (alpha.flowstate runs the corelogic harness
        // deployment-wide — same dashboard, different eval seat).
        harness: (body.harness === 'agent' || body.harness === 'corelogic' || body.harness === 'typescript')
          ? body.harness
          : (c.env.DEFAULT_HARNESS === 'corelogic' || c.env.DEFAULT_HARNESS === 'agent' || c.env.DEFAULT_HARNESS === 'typescript'
              ? c.env.DEFAULT_HARNESS
              : undefined),
      }),
    });
    // A live run owns the DO — don't error, hand the caller the same job
    // and stream so it SUBSCRIBES to the in-flight evaluation. The jobId
    // is deterministic per user+property and the SSE token validates
    // against it regardless of when the run started — late-join replays
    // the step state already streamed.
    if (!startResp.ok) {
      if (startResp.status === 409) {
        return c.json({
          success: true,
          data: {
            jobId,
            result: null,
            alreadyRunning: true,
            enrichment: {
              streamUrl,
              token,
              pending: ['property_fetch', 'evaluation'],
            },
          },
        })
      }
      const errBody = await startResp.json().catch(() => null) as { error?: string } | null;
      return c.json(
        {
          success: false,
          error: errBody?.error ?? 'Analysis could not be started',
        },
        502,
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
          pending: ['property_fetch', 'evaluation'],
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
 * same AnalysisResponse once complete. Falls back to
 * the saved report when the Durable Object state is gone.
 */
// Registered before /jobs/:jobId so 'queue' isn't captured as a jobId param.
analyze.get('/jobs/queue', harnessQueueListHandler);

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
    || state?.status === 'awaiting_agent'
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
      await applyCompTierOverrides(c.env, auth.userId, jobId, result);
      return c.json({ success: true, data: { jobId, status: 'complete', result } });
    }
    return c.json({
      success: true,
      data: { jobId, status: 'error', error: state?.error ?? 'Evaluation failed' },
    });
  }

  if (status === 'awaiting_agent') {
    return c.json({
      success: true,
      data: {
        jobId,
        status: 'awaiting_agent',
        pending: state?.pending ?? [],
        lastEvent: events.length ? events[events.length - 1]!.event : null,
        elapsedMs: state?.createdAt ? Date.now() - state.createdAt : null,
      },
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
    await applyCompTierOverrides(c.env, auth.userId, jobId, result);
    return c.json({ success: true, data: { jobId, status: 'complete', result } });
  }
  return c.json({ success: false, error: 'Job not found' }, 404);
});

/**
 * PUT /analyze/jobs/:jobId/comp-tier
 *
 * Manual comp-tier assignment — pin a comparable to 'arv' or 'as_is', or
 * clear the pin with tier null. Stored per (job, comp) and applied onto
 * the report at read time, so the automatic classification is never
 * rewritten — the override rides alongside it on the card and report.
 */
analyze.put('/jobs/:jobId/comp-tier', async (c) => {
  const auth = c.get('auth');
  const jobId = c.req.param('jobId');
  const body = await c.req
    .json<{ compId?: string; tier?: string | null }>()
    .catch(() => ({}) as { compId?: string; tier?: string | null });
  const compId = typeof body.compId === 'string' && body.compId.length > 0 ? body.compId : null;
  const tier = body.tier ?? null;
  if (!compId || (tier !== 'arv' && tier !== 'as_is' && tier !== null)) {
    return c.json(
      { success: false, error: 'Invalid assignment — compId plus tier "arv"|"as_is"|null required' },
      400,
    );
  }

  // Same ownership check as GET — live DO state carries the owner; an
  // evicted DO falls back to the userId-scoped saved report.
  const doId = c.env.ANALYSIS_JOB.idFromName(jobId);
  const stub = c.env.ANALYSIS_JOB.get(doId);
  const resp = await stub.fetch('http://internal/state');
  const state = (await resp.json().catch(() => null)) as {
    userId?: string
    status?: string
  } | null;

  const db = drizzle(c.env.DB);
  const liveJob = state?.status === 'processing' || state?.status === 'idle'
    || state?.status === 'complete' || state?.status === 'error';
  if (state?.userId ? state.userId !== auth.userId : liveJob) {
    return c.json({ success: false, error: 'Job not found' }, 404);
  }
  if (!liveJob && !state?.userId) {
    const [report] = await db
      .select({ id: savedReports.id })
      .from(savedReports)
      .where(and(eq(savedReports.userId, auth.userId), eq(savedReports.jobId, jobId)))
      .limit(1);
    if (!report) return c.json({ success: false, error: 'Job not found' }, 404);
  }

  const now = new Date().toISOString();
  if (tier === null) {
    await db
      .delete(compTierOverrides)
      .where(
        and(
          eq(compTierOverrides.jobId, jobId),
          eq(compTierOverrides.compId, compId),
          eq(compTierOverrides.userId, auth.userId),
        ),
      );
  } else {
    await db
      .insert(compTierOverrides)
      .values({ userId: auth.userId, jobId, compId, tier, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [compTierOverrides.jobId, compTierOverrides.compId],
        set: { tier, updatedAt: now },
      });
  }
  return c.json({ success: true });
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

// ─── Evaluation Agent harness seam ──────────────────────────────────────────

/** Ownership check shared by both harness endpoints — a live job's DO state
 *  carries the owner; anything else 404s the same way /jobs/:jobId does.
 *  Returns a 404 response when unauthorized, or the job's DO stub. */
async function harnessOwnerCheck(c: Context, jobId: string): Promise<Response | { fetch: (url: string, init?: RequestInit) => Promise<Response> }> {
  const auth = c.get('auth');
  const doId = c.env.ANALYSIS_JOB.idFromName(jobId);
  const stub = c.env.ANALYSIS_JOB.get(doId);
  const resp = await stub.fetch('http://internal/state');
  const state = (await resp.json().catch(() => null)) as { userId?: string } | null;
  if (state?.userId !== auth.userId) {
    return c.json({ success: false, error: 'Job not found' }, 404) as unknown as Response;
  }
  return stub as unknown as { fetch: (url: string, init?: RequestInit) => Promise<Response> };
}

/**
 * GET /analyze/jobs/:jobId/harness/evidence
 *
 * Frozen BSubject+BComps evidence bundle for the Evaluation Agent — the exact
 * pool and subject fields the deterministic engine would have seen. 409
 * unless the job is parked in `awaiting_agent`.
 */
analyze.get('/jobs/:jobId/harness/evidence', async (c) => {
  const ownership = await harnessOwnerCheck(c, c.req.param('jobId'));
  if (ownership instanceof Response) return ownership;
  const resp = await ownership.fetch('http://internal/harness/evidence');
  const text = await resp.text();
  return new Response(text, { status: resp.status, headers: { 'Content-Type': 'application/json' } });
});

/**
 * POST /analyze/jobs/:jobId/harness/selection
 *
 * The agent's verdict (or `{ needsMoreEvidence: 'deepen' }`). Server validates
 * picks against the enabled pool and the evidence envelope, then resumes the
 * deterministic tail — the saved report and dashboard see only the selected
 * comps. `agent` must echo the claimedBy token returned by /harness/claim.
 */
analyze.post('/jobs/:jobId/harness/selection', async (c) => {
  const ownership = await harnessOwnerCheck(c, c.req.param('jobId'));
  if (ownership instanceof Response) return ownership;
  // Lease gate: when a live claim exists, only the lease holder may verdict —
  // drainers share one API user, so ownership alone can't isolate them. The
  // claimedBy token carries a random suffix minted at claim time, so posting
  // a verdict requires having actually made the claim, not just knowing a
  // drainer's label.
  const rawBody = await c.req.text();
  const body = (() => { try { return JSON.parse(rawBody) as { agent?: string }; } catch { return null; } })();
  if (body) {
    const db = drizzle(c.env.DB);
    const now = new Date().toISOString();
    const [row] = await db
      .select({ status: harnessQueue.status, claimedBy: harnessQueue.claimedBy, leaseExpiresAt: harnessQueue.leaseExpiresAt })
      .from(harnessQueue)
      .where(and(eq(harnessQueue.jobId, c.req.param('jobId')), eq(harnessQueue.userId, c.get('auth').userId)))
      .limit(1);
    if (row?.status === 'claimed' && row.leaseExpiresAt && row.leaseExpiresAt > now && row.claimedBy !== body.agent) {
      return c.json({ success: false, error: 'Job claimed by another agent' }, 409);
    }
  }
  const resp = await ownership.fetch('http://internal/harness/selection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody,
  });
  const text = await resp.text();
  return new Response(text, { status: resp.status, headers: { 'Content-Type': 'application/json' } });
});

/**
 * POST /analyze/jobs/:jobId/harness/consult
 *
 * Expert second opinion for the Evaluation Agent — claude-opus-5-5 reviews
 * a proposed selection against the same evidence + gate grade, read-only.
 * Intended for revision turns: check the consult's suggestedFixes before
 * re-posting to /harness/selection. Never consumes the revision budget.
 */
analyze.post('/jobs/:jobId/harness/consult', async (c) => {
  const ownership = await harnessOwnerCheck(c, c.req.param('jobId'));
  if (ownership instanceof Response) return ownership;
  const resp = await ownership.fetch('http://internal/harness/consult', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: await c.req.text(),
  });
  const text = await resp.text();
  return new Response(text, { status: resp.status, headers: { 'Content-Type': 'application/json' } });
});

/**
 * The Evaluation Agent's work queue: this caller's parked jobs — status
 * `awaiting_agent`, plus `claimed` rows whose lease expired (a crashed
 * drainer's job returns to the pool). FIFO by park time.
 * Declared as a hoisted function; registered at GET /jobs/queue above
 * /jobs/:jobId so 'queue' isn't captured as a jobId param.
 */
async function harnessQueueListHandler(c: Context) {
  const auth = c.get('auth');
  const db = drizzle(c.env.DB);
  const now = new Date().toISOString();
  const rows = await db
    .select({
      jobId: harnessQueue.jobId,
      propertyAddress: harnessQueue.propertyAddress,
      propertyCity: harnessQueue.propertyCity,
      propertyState: harnessQueue.propertyState,
      propertyZip: harnessQueue.propertyZip,
      callerRef: harnessQueue.callerRef,
      leadId: harnessQueue.leadId,
      status: harnessQueue.status,
      claimedBy: harnessQueue.claimedBy,
      leaseExpiresAt: harnessQueue.leaseExpiresAt,
      rounds: harnessQueue.rounds,
      deadlineAt: harnessQueue.deadlineAt,
      parkedAt: harnessQueue.parkedAt,
    })
    .from(harnessQueue)
    .where(and(
      eq(harnessQueue.userId, auth.userId),
      or(
        eq(harnessQueue.status, 'awaiting_agent'),
        and(eq(harnessQueue.status, 'claimed'), lt(harnessQueue.leaseExpiresAt, now)),
      ),
    ))
    .orderBy(asc(harnessQueue.parkedAt))
    .limit(50);
  // Mask claimedBy to the drainer label — the stored value embeds the lease
  // token minted at claim and must not leak via the list.
  const jobs = rows.map(({ claimedBy, ...r }) => ({ ...r, claimedBy: claimedBy?.split(':')[0] ?? null }));
  return c.json({ success: true, data: { jobs, count: jobs.length } });
}

/**
 * POST /analyze/jobs/:jobId/harness/claim
 *
 * Atomic claim so two drainer sessions can't work the same parked job.
 * Body: { agent?: string } — a drainer label for observability; the stored
 * claimedBy gets an unguessable suffix so a rival drainer can't echo a
 * predictable agent id into /harness/selection. 409 when the job isn't
 * claimable (not parked, or a live lease is held). The claim is a 10-minute
 * lease; an expired lease returns the job to the queue.
 */
analyze.post('/jobs/:jobId/harness/claim', async (c) => {
  const auth = c.get('auth');
  const jobId = c.req.param('jobId');
  const body = await c.req.json<{ agent?: string }>().catch(() => ({} as { agent?: string }));
  const agentLabel = typeof body.agent === 'string' && body.agent.trim() ? body.agent.trim().slice(0, 48) : 'drainer';
  const agent = `${agentLabel}:${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const db = drizzle(c.env.DB);
  const now = new Date().toISOString();
  const lease = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const res = await db
    .update(harnessQueue)
    .set({
      status: 'claimed',
      claimedBy: agent,
      claimedAt: now,
      leaseExpiresAt: lease,
      updatedAt: now,
    })
    .where(and(
      eq(harnessQueue.jobId, jobId),
      eq(harnessQueue.userId, auth.userId),
      or(
        eq(harnessQueue.status, 'awaiting_agent'),
        and(eq(harnessQueue.status, 'claimed'), lt(harnessQueue.leaseExpiresAt, now)),
      ),
    ))
    .run();
  if ((res.meta?.changes ?? 0) === 0) {
    return c.json({ success: false, error: 'Job not claimable (not parked or lease held)' }, 409);
  }
  return c.json({ success: true, data: { jobId, claimedBy: agent, leaseExpiresAt: lease } });
});

export default analyze;
