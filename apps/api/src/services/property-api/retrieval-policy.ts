/**
 * Comparable-candidate retrieval policy.
 *
 * The candidate POOL is the universe the appraisal rules see. Provider-side
 * prefilters are only safe when they encode rules that are never relaxed by
 * any evaluation tier; anything else silently shrinks the universe before
 * Flowstate's own methodology runs.
 *
 * CoreLogic/Cotality `/v2/properties/{clipId}/comparables` (bundled OpenAPI
 * spec, providers/docs/corelogic-api-docs.json):
 * - maxComps: default 10, documented MAX 100. Single request — the endpoint
 *   exposes NO pagination params (no page/cursor/offset).
 * - Response = { clip, v1PropertyId, comparables[] } — no totalCount, no
 *   hasMore, no cursor. Provider truncation can only be INFERRED:
 *   received >= effectiveLimit means the pool may continue past the limit.
 * - Ordering: sortBy 'Distance' (ascending) or 'Sale_Date' (latest first).
 *   There is no provider price ordering — retrieval order never decides ARV.
 * - landUse defaults to the subject's — the provider ALWAYS restricts to the
 *   subject's broad land-use class even when the owner disables the
 *   property_type rule. Documented provider-imposed bound; not overridable.
 *
 * Provider prefilter audit (distance / sale window / sqft / year / type):
 * - monthsBack:   SAFE_PROVIDER_PREFILTER at configured sale_age — the
 *   fetched window (default 12mo) is wider than the strictest rule. The
 *   last-resort sale-age tiers (365d/548d ≈ 18mo) reach BEYOND the fetched
 *   window — like radius, an insufficient result widens monthsBack on the
 *   single expansion refetch so those tiers see real candidates.
 * - sqft bounds:  SAFE_PROVIDER_PREFILTER — sqft_diff is never relaxed;
 *   absolute bounds sent only when the rule is enabled AND subject sqft is
 *   known (missing data never disqualifies).
 * - year_built:   not a provider param — evaluated post-fetch. SAFE.
 * - beds/baths:   only sent when the owner configures them (same caveat).
 * - distance:     REQUIRES_EXPANSION_REFETCH — the appraisal expansion
 *   ladder deliberately reaches 2x the fetched radius (subdivision tier)
 *   and then drops distance entirely (geographic tier). A pool fetched at
 *   1mi cannot contain 1-2mi candidates, so reaching those tiers triggers
 *   an explicit second provider request (see expansionRefetchRadius).
 * - landUse:      provider-imposed, not overridable — TOO_RESTRICTIVE
 *   relative to owner rules, recorded as a known bound.
 */
import type { Env } from '../../types'
import type { NormalizedComparable, NormalizedProperty } from './types'

/** Documented CoreLogic comparables maximum per request. */
export const CORELOGIC_MAX_COMPS = 100
/** ATTOM maxComps is passed through; no documented cap in-repo — cap for safety. */
export const ATTOM_MAX_COMPS = 100

/**
 * Largest practical candidate pool: the provider's own supported maximum.
 * Overridable downward via COMPARABLE_CANDIDATE_LIMIT (system config — not an
 * owner-facing Appraisal Rule).
 */
export const DEFAULT_CANDIDATE_LIMIT = CORELOGIC_MAX_COMPS

export function providerMaxComps(provider: string): number {
  return provider === 'attom' ? ATTOM_MAX_COMPS : CORELOGIC_MAX_COMPS
}

/**
 * Resolve the effective candidate limit:
 *   explicit per-request override -> COMPARABLE_CANDIDATE_LIMIT env -> provider max.
 * Always clamped to [1, providerMax].
 */
export function resolveCandidateLimit(
  env: Pick<Env, 'COMPARABLE_CANDIDATE_LIMIT'>,
  provider: string,
  requested?: number,
): number {
  const max = providerMaxComps(provider)
  const envLimit = Number.parseInt(env.COMPARABLE_CANDIDATE_LIMIT ?? '', 10)
  const base = Number.isFinite(requested) && requested! > 0
    ? requested!
    : Number.isFinite(envLimit) && envLimit > 0
      ? envLimit
      : DEFAULT_CANDIDATE_LIMIT
  return Math.max(1, Math.min(base, max))
}

/**
 * What the provider actually gave us — the audit record for pool breadth.
 * `providerCandidatesReported` stays null: the comparables endpoint exposes
 * no total-count field, so "truncated" is an inference, not a fact.
 */
export interface ComparablesRetrievalMeta {
  /** Provider-reported total — always null (endpoint exposes none). */
  providerCandidatesReported: number | null
  /** Candidates actually returned to us. */
  providerCandidatesReceived: number
  /** maxComps we asked for (after env/request resolution, before provider clamp). */
  candidateLimitRequested: number
  /** Limit actually sent to the provider (<= provider max). */
  candidateLimitEffective: number
  /** Inferred: response filled the whole requested window. */
  providerTruncated: boolean
  /** The endpoint has no pagination — always 1 per request. */
  pagesRequested: number
  /** Comparables-endpoint calls used for this pool (1 + any refetch). */
  providerCallsUsed: number
  /** Provider ordering applied to the response ('distance' | 'sale_date'). */
  ordering: 'distance' | 'sale_date'
  /** Radius actually searched. */
  radiusMiles: number
  /** Sale window actually searched (months). */
  monthsBack: number
  /** Candidates skipped before enrichment (provably dead under never-relaxed rules). */
  candidatesPrunedBeforeEnrichment?: number
  /** Candidates that received paid property-detail enrichment. */
  candidatesEnriched?: number
}

export function buildRetrievalMeta(args: {
  requested: number
  effectiveLimit: number
  received: number
  ordering: 'distance' | 'sale_date'
  radiusMiles: number
  monthsBack: number
  providerCallsUsed?: number
}): ComparablesRetrievalMeta {
  return {
    providerCandidatesReported: null,
    providerCandidatesReceived: args.received,
    candidateLimitRequested: args.requested,
    candidateLimitEffective: args.effectiveLimit,
    providerTruncated: args.received >= args.effectiveLimit,
    pagesRequested: 1,
    providerCallsUsed: args.providerCallsUsed ?? 1,
    ordering: args.ordering,
    radiusMiles: args.radiusMiles,
    monthsBack: args.monthsBack,
  }
}

/**
 * Fallback tiers that look beyond the fetched radius. `subdivision_expansion`
 * rescues inside radius x multiplier; `geographic_expansion` drops the
 * distance rule; `nearest_comps`/`insufficient` mean the fetched pool was
 * exhausted. All of these operate on an incomplete geographic pool unless a
 * wider provider request is made — the pool at radius R contains zero
 * candidates beyond R.
 */
const RADIUS_BOUND_FALLBACKS = new Set([
  'subdivision_expansion',
  'geographic_expansion',
  'nearest_comps',
  'insufficient',
])

/**
 * Radius for the single bounded expansion refetch, or null when the ladder
 * stopped inside the fetched radius (strict / year_built / neighborhood).
 * `expansionRadiusMiles` overrides the policy-derived radius (env
 * COMPARABLE_EXPANSION_RADIUS_MILES); otherwise fetchedRadius x
 * geographicDistanceMultiplier — exactly the scope subdivision_expansion
 * searches. `geographic_expansion` drops the distance RULE; the refetch is
 * still a finite radius and that bound is recorded in retrieval metadata.
 */
export function expansionRefetchRadius(
  fallbackUsed: string | undefined,
  fetchedRadiusMiles: number | undefined,
  geographicDistanceMultiplier = 2,
  expansionRadiusMiles?: number,
): number | null {
  if (!fallbackUsed || !RADIUS_BOUND_FALLBACKS.has(fallbackUsed)) return null
  const base = fetchedRadiusMiles && fetchedRadiusMiles > 0 ? fetchedRadiusMiles : 1
  const target = expansionRadiusMiles && expansionRadiusMiles > 0
    ? expansionRadiusMiles
    : base * geographicDistanceMultiplier
  return target > base ? target : null
}

export interface DeadCompThresholds {
  /** Max sale age in days — the DEEPEST configured window any tier may reach. */
  saleAgeDays: number
  /** Max |comp sqft - subject sqft| — never relaxed. */
  sqftDiff: number
  /** Max |comp year - subject year| at the WIDEST sanctioned tolerance. */
  maxYearDiff: number
}

/**
 * Provably-dead predicate for pre-enrichment pruning. A comp is dead only
 * when data the provider ALREADY returned proves it fails a rule beyond
 * the widest ceiling any evaluation tier can reach (sale age at the
 * deepest configured expansion tier, sqft diff, year built at its widest
 * sanctioned tolerance). Missing data is not proof — those comps are
 * still enriched. Distance/subdivision/property-type are NOT here: the
 * expansion ladder can rescue them, so pruning on them would contradict the
 * approved expansion policy.
 */
export function isProvablyDeadComp(
  comp: Pick<NormalizedComparable, 'saleDate' | 'squareFeet' | 'yearBuilt'>,
  subject: Pick<NormalizedProperty, 'squareFeet' | 'yearBuilt'>,
  thresholds: DeadCompThresholds,
  nowMs = Date.now(),
): boolean {
  if (comp.saleDate) {
    const days = (nowMs - new Date(comp.saleDate).getTime()) / 86_400_000
    if (Number.isFinite(days) && days > thresholds.saleAgeDays) return true
  }
  if (comp.squareFeet && subject.squareFeet) {
    // Sub-1,000sf subject bypass: comps ≤1,000sf pass regardless of the
    // ±diff band — matches the shared evaluator's absolute ceiling.
    const sqftOk = subject.squareFeet < 1000
      ? comp.squareFeet <= 1000
      : Math.abs(comp.squareFeet - subject.squareFeet) <= thresholds.sqftDiff
    if (!sqftOk) return true
  }
  if (comp.yearBuilt && subject.yearBuilt && Math.abs(comp.yearBuilt - subject.yearBuilt) > thresholds.maxYearDiff) return true
  return false
}
