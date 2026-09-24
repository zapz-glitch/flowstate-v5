/**
 * Property Evaluation Service
 *
 * Hands-off evaluation pipeline: appraisal rules → photo fetch → vision
 * renovation assessment → permit-derived major items → valuation → report.
 * Photo and vision stages are async but fully non-fatal — they degrade to
 * honest "insufficient evidence" outcomes rather than failing the run.
 */

import type { Env } from '../../types'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { majorItemSetting, majorItemCosts } from '../../db/schema'
import type { PropertyBundle } from '../property-api'
import type { NormalizedComparable, NormalizedProperty } from '../property-api/types'
import {
  createAppraisalService,
  DEFAULT_FILTERS,
  DEFAULT_ADJUSTMENTS,
  DEFAULT_EXPANSION_POLICY,
  defaultFilterPriority,
  saleAgeExpansionSteps,
  summarizeClassifications,
  type AppraisedComparable,
  type AppraisalResultWithFallback,
  type AppraisalFilter,
  type AppraisalAdjustment,
} from '../appraisal'
import { createValuationService, MAJOR_ITEMS, type MajorItem } from '../valuation'
import type { ClassificationResult } from '../classification'
import type { RehabTable, TierRangeDefinition } from '@flowstate-api/shared/valuation'
import {
  buildAnalysisResponse,
  calculateAllRehabLevelEstimates,
  mergeZillowDataIntoBundle,
  type AnalysisResponse,
  type ApiCallStats,
  type ResponseContext,
} from '../analysis'
import { createPhotoService, type PhotoBundle, type PropertyIdentifier, type PropertyPhotos } from '../photo-provider'
import {
  COMP_ARV_TOP_PERCENT,
  COMP_HYBRID_VERSION,
  runJevEvaluation,
  type HybridRun,
} from '../comp-hybrid'

import { persistReportAssets } from '../report-assets'
import { expansionRefetchRadius } from '../property-api/retrieval-policy'
import { assessRenovationFromPhotos, unavailableAssessment, type RenovationAssessment, type CurbAppealCheck } from '../vision/renovation'
import { PROXIMITY_DEFAULTS } from '../../routes/proximity-config'
import { deriveBuybox } from './derivation'
import { buildEvaluationReport } from './report'
import { classifyOutcomeWithJev } from '../jev'
import type { ReportStep } from './types'
import { AnalysisError } from '../../utils/analysis-error'

function formatUsd(amount: number): string {
  return `$${Math.round(amount).toLocaleString()}`
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EvaluationParams {
  jobId: string
  userId?: string
  bundle: PropertyBundle
  appraisalRules?: {
    filters?: AppraisalFilter[]
    adjustments?: AppraisalAdjustment[]
  }
  buybox?: {
    rehabLevelIndex?: number
    majorItems?: MajorItem[]
    additionPlay?: number
    closingCostsPercent?: number
    carryingCostsPercent?: number
    wholesaleFee?: number
    desiredProfit?: number
    /** Location-risk deduction as % of ARV (major road/railroad/commercial proximity) */
    locationPenaltyPercent?: number
  }
  /** Proximity deduction config — siding/backing/fronting + ARV threshold */
  proximityConfig?: import('../../routes/proximity-config').ProximityConfig
  customRehabTable?: RehabTable
  customTierRanges?: TierRangeDefinition[]
  customMajorItemCosts?: Record<string, number>
  /** ARV comp threshold: top % of comps by sale price for ARV calculation */
  arvThreshold?: { percent: number }
  /** Threshold for Group B: comps with salePrice <= X% of ARV (default: 70) */
  asIsThresholdPercent?: number
  /** Max age (days) for a Zillow sale event to reconcile a stale comp price (default: 365) */
  reconciliationSaleAgeDays?: number
  apiCallStats?: ApiCallStats
  /**
   * Expansion refetch seam. When the appraisal ladder reaches a tier that
   * searches beyond the fetched radius, the pool provably lacks those
   * candidates — the caller makes ONE additional provider request at the
   * wider radius and returns the merged, enriched pool. Deterministic
   * selection always runs after retrieval; this never picks comps itself.
   */
  expandComparablesPool?: (radiusMiles: number, monthsBack?: number) => Promise<NormalizedComparable[] | null>
  /**
   * Property-detail seam for the Jev evaluation — enriches the
   * top-screened candidates (building style, foundation, construction,
   * features, transaction) before the cross-examination.
   */
  enrichComparables?: (comps: NormalizedComparable[]) => Promise<NormalizedComparable[]>
  /**
   * Subject photo bundle prefetched by the caller so the scrape overlaps the
   * comparables fetch. `undefined` = not prefetched — fetch inline.
   * `null` = prefetch ran and found nothing / provider unavailable — don't
   * refetch.
   */
  prefetchedPhotoBundle?: PhotoBundle | null
}

export interface GroupBResult {
  /** Comp IDs included in Group B (as-is market comps) */
  compIds: string[]
  /** Weighted average as-is price (sqft-scaled to subject) */
  asIsMarketPrice: number | null
  /** Average $/sqft across Group B comps */
  avgPricePerSqft: number | null
  /** Number of comps that qualified */
  count: number
  /** Verified flip acquisition (priorSale) data points folded into the average */
  flipSaleCount: number
  /** Threshold used: salePrice <= X% of ARV */
  thresholdPercent: number
  /** The ARV value used to determine the threshold */
  arvUsed: number
  /** Price ceiling: arvUsed * thresholdPercent / 100 */
  priceCeiling: number
  /** Reason when no comps qualify */
  noDataReason?: string
}

export interface EvaluationResult {
  response: AnalysisResponse
  appraisalResult: AppraisalResultWithFallback
  compClassifications: Map<string, ClassificationResult>
  /** Group B as-is market intelligence (display only) */
  groupB: GroupBResult | null
}

// ─── Price Classification ────────────────────────────────────────────────────

/**
 * Classify comps by sale price percentile.
 * Top X% by sale price are considered "renovated" (higher price = better condition).
 */
export function classifyCompsByPrice(
  comparables: NormalizedComparable[],
  topPercentile: number
): Map<string, ClassificationResult> {
  const classifications = new Map<string, ClassificationResult>()

  const withPrice = comparables
    .filter(c => c.salePrice != null && c.salePrice > 0)
    .map(c => ({ id: c.id, salePrice: c.salePrice! }))
    .sort((a, b) => b.salePrice - a.salePrice)

  if (withPrice.length === 0) return classifications

  const topCount = Math.max(1, Math.ceil(withPrice.length * topPercentile / 100))
  const topIds = new Set(withPrice.slice(0, topCount).map(c => c.id))
  const threshold = withPrice[topCount - 1]?.salePrice ?? 0

  for (const comp of comparables) {
    const isRenovated = topIds.has(comp.id)
    classifications.set(comp.id, {
      classification: isRenovated ? 'after_renovation' : 'as_is',
      confidence: isRenovated ? 75 : 60,
      method: 'price_analysis',
      reasoning: isRenovated
        ? `Sale price in top ${topPercentile}% (≥$${Math.round(threshold).toLocaleString()})`
        : `Sale price below top ${topPercentile}% threshold`,
      indicators: {},
    })
  }

  return classifications
}

// ─── Best Match Selection ────────────────────────────────────────────────────

function selectBestMatch(
  subject: NormalizedProperty,
  enabledComps: AppraisedComparable[]
): { compId: string; reasoning: string } | undefined {
  if (enabledComps.length === 0) return undefined
  if (enabledComps.length === 1) {
    return { compId: enabledComps[0].id, reasoning: 'Only comparable that passed all appraisal criteria.' }
  }

  const scored = enabledComps.map((comp) => {
    let score = 0
    const reasons: string[] = []

    // Higher price per sqft
    if (comp.salePrice && comp.squareFeet && comp.squareFeet > 0) {
      const pricePerSqft = comp.salePrice / comp.squareFeet
      score += Math.min(100, Math.round(pricePerSqft / 3))
      reasons.push(`$${Math.round(pricePerSqft)}/sqft`)
    }

    // Subdivision match
    const subMatch = comp.evaluation.filterResults.find((f) => f.type === 'subdivision_match')?.passed
    if (subMatch) {
      score += 50
      reasons.push('same subdivision')
    }

    // Sqft similarity
    if (subject.squareFeet && comp.squareFeet) {
      const sqftDiff = Math.abs(subject.squareFeet - comp.squareFeet) / subject.squareFeet
      score += Math.max(0, 30 - Math.round(sqftDiff * 100))
    }

    // Proximity
    if (comp.distanceMiles != null) {
      score += Math.max(0, 20 - Math.round(comp.distanceMiles * 20))
    }

    // Fewer adjustments = more reliable
    const adjCount = comp.evaluation.adjustmentResults.filter((a) => a.applied).length
    score += Math.max(0, 10 - adjCount * 3)

    return { comp, score, reasons }
  })

  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]

  return {
    compId: best.comp.id,
    reasoning: `Best match: ${best.reasons.join(', ')}. Score: ${best.score}.`,
  }
}
// ─── Group B: As-Is Market Intelligence ─────────────────────────────────────

/**
 * Select as-is market comps: enabled comps that didn't make the ARV group and
 * sold at or below `thresholdPercent` of ARV. Display-only market intelligence.
 */
function selectGroupBComps(
  subject: NormalizedProperty,
  appraisalResult: AppraisalResultWithFallback,
  arv: number,
  thresholdPercent: number,
  groupACompIds: Set<string>,
): GroupBResult | null {
  const priceCeiling = Math.round((arv * thresholdPercent) / 100)

  const qualifying = appraisalResult.comparables.filter(
    (c) =>
      c.isEnabled &&
      !groupACompIds.has(c.id) &&
      c.salePrice != null &&
      c.salePrice > 0 &&
      c.salePrice <= priceCeiling
  )

  const hasFlips = appraisalResult.comparables.some((c) => c.flip != null)
  if (qualifying.length === 0 && !hasFlips) {
    return {
      compIds: [],
      asIsMarketPrice: null,
      avgPricePerSqft: null,
      count: 0,
      flipSaleCount: 0,
      thresholdPercent,
      arvUsed: arv,
      priceCeiling,
      noDataReason: `No enabled comps sold at or below ${thresholdPercent}% of ARV (${formatUsd(priceCeiling)})`,
    }
  }

  return summarizeGroupB(qualifying, subject, arv, thresholdPercent, priceCeiling, appraisalResult.comparables)
}

/**
 * Sqft-scale each comp's sale price to the subject's sqft, then average —
 * shared by the price-threshold Group B and Jev's investment selection.
 */
function summarizeGroupB(
  qualifying: AppraisedComparable[],
  subject: NormalizedProperty,
  arv: number,
  thresholdPercent: number,
  priceCeiling: number,
  allComparables?: AppraisedComparable[],
): GroupBResult {

  // Sqft-scale each comp's sale price to the subject's sqft, then average
  const subjectSqft = subject.squareFeet ?? 0
  const scaledPrices: number[] = []
  const perSqftPrices: number[] = []

  const addSale = (price: number, compSqft: number | null | undefined) => {
    if (compSqft && compSqft > 0) {
      const perSqft = price / compSqft
      perSqftPrices.push(perSqft)
      scaledPrices.push(subjectSqft > 0 ? perSqft * subjectSqft : price)
    } else {
      scaledPrices.push(price)
    }
  }

  for (const comp of qualifying) {
    addSale(comp.salePrice!, comp.squareFeet)
  }

  // Verified flips also contribute their acquisition sale — the priorSale is
  // what an investor actually paid for the same property as-is. A flip comp
  // may sit in the ARV bucket on its resale, so scan the full evaluated pool,
  // not just the as-is picks.
  let flipSaleCount = 0
  for (const comp of allComparables ?? qualifying) {
    if (!comp.flip || !(comp.flip.priorSalePrice > 0)) continue
    addSale(comp.flip.priorSalePrice, comp.squareFeet)
    flipSaleCount++
  }

  const asIsMarketPrice =
    scaledPrices.length > 0
      ? Math.round(scaledPrices.reduce((s, p) => s + p, 0) / scaledPrices.length)
      : null
  const avgPricePerSqft =
    perSqftPrices.length > 0
      ? Math.round((perSqftPrices.reduce((s, p) => s + p, 0) / perSqftPrices.length) * 100) / 100
      : null

  return {
    compIds: qualifying.map((c) => c.id),
    asIsMarketPrice,
    avgPricePerSqft,
    count: qualifying.length,
    flipSaleCount,
    thresholdPercent,
    arvUsed: arv,
    priceCeiling,
  }
}

// ─── Major-Item Settings Loader ──────────────────────────────────────────────

/**
 * Load the user's Evaluation Settings → Major Items overrides (permit-age rules).
 * Merges the `major_item_setting` table (enabled/cost/ageThreshold) with the
 * legacy `major_item_costs` JSON overrides (cost only). Rows absent from both
 * inherit MAJOR_ITEMS defaults.
 */
export async function loadMajorItemConfig(
  env: Env,
  userId: string | undefined
): Promise<Record<string, { enabled?: boolean; cost?: number; ageThreshold?: number | null }>> {
  if (!userId) return {}
  const config: Record<string, { enabled?: boolean; cost?: number; ageThreshold?: number | null }> = {}

  try {
    const db = drizzle(env.DB)

    const rows = await db
      .select()
      .from(majorItemSetting)
      .where(eq(majorItemSetting.userId, userId))
    for (const row of rows) {
      config[row.itemId] = {
        enabled: row.enabled,
        cost: row.cost,
        ageThreshold: row.ageThreshold,
      }
    }

    const [costRow] = await db
      .select()
      .from(majorItemCosts)
      .where(eq(majorItemCosts.userId, userId))
      .limit(1)
    if (costRow?.costsJson) {
      const costs = JSON.parse(costRow.costsJson) as Record<string, number>
      for (const [itemId, cost] of Object.entries(costs)) {
        config[itemId] = { ...config[itemId], cost }
      }
    }
  } catch (error) {
    console.warn('[Evaluate] Failed to load major-item settings:', error)
  }

  return config
}

/**
 * Proximity deduction — Evaluation Settings' Proximity Adjustments:
 * worst detected position wins (fronting > backing > siding);
 * flat $ below the ARV threshold, % of ARV at/above it.
 */
export function computeLocationPenalty(
  locationRisks: Array<{ position?: 'fronting' | 'backing' | 'siding' | null }> | null | undefined,
  arv: number,
  config?: import('../../routes/proximity-config').ProximityConfig
): number {
  if (!locationRisks?.length) return 0
  const cfg = config ?? PROXIMITY_DEFAULTS
  const rank = { fronting: 3, backing: 2, siding: 1 } as const
  const worst = locationRisks.reduce<keyof typeof rank | null>((w, r) => {
    const pos = r.position ?? 'siding'
    return !w || rank[pos] > rank[w] ? pos : w
  }, null)
  if (!worst) return 0
  const tier = cfg[worst]
  return arv >= cfg.arvThreshold ? Math.round(arv * (tier.percent / 100)) : tier.flat
}

// ─── Main Evaluation Pipeline ────────────────────────────────────────────────

/**
 * Hands-off evaluation pipeline: appraisal rules → photo fetch → vision
 * renovation assessment → permit-derived major items → valuation → report.
 *
 * - Appraisal: filters + adjustments with expansion fallback; insufficient
 *   comps produces a BAD_DEAL AnalysisError (never a fabricated ARV).
 * - Photos: Zillow → Redfin → Realtor.com fallback; all-fail is non-fatal.
 * - Vision: subject-photo renovation level drives the rehab tier (falls back
 *   to the caller's buybox or defaults when no evidence exists).
 */
export async function performAnalysis(
  params: EvaluationParams,
  env: Env,
  onProgress?: (message: string, data?: Record<string, unknown>) => void
): Promise<EvaluationResult> {
  const { jobId } = params
  let { bundle } = params
  const appraisalService = createAppraisalService()
  const rules = params.appraisalRules ?? {}
  const filters = [...(rules.filters ?? DEFAULT_FILTERS)]
  const adjustments = rules.adjustments ?? DEFAULT_ADJUSTMENTS

  // Filters the preset doesn't define at all are injected with system defaults
  // so the audit trail always covers every rule. Filters the preset DOES define
  // keep the user's own enabled + required(preferred) choices — the preset is
  // authoritative for those.
  for (const defaultFilter of DEFAULT_FILTERS) {
    if (!filters.some((f) => f.type === defaultFilter.type)) {
      filters.push({ ...defaultFilter })
    }
  }

  const steps: ReportStep[] = []
  const fallbacksUsed: string[] = []
  const step = (name: string, status: ReportStep['status'], detail?: string) => {
    steps.push({ step: name, label: name, status, detail })
  }

  // ── 1. Appraisal: filter comps, apply adjustments, select ARV comps ────────
  let appraisalResult = appraisalService.evaluateWithFallback(
    bundle.property,
    bundle.comparables,
    { filters, adjustments, expansion: DEFAULT_EXPANSION_POLICY }
  )

  if (appraisalResult.fallbackUsed && appraisalResult.fallbackUsed !== 'none') {
    fallbacksUsed.push(`comp_fallback:${appraisalResult.fallbackUsed}`)
  }

  // ── 1b. Expansion refetch: radius-bound tiers (subdivision 2x, geographic,
  // pool exhaustion) search geography the fetched pool provably lacks. The
  // caller performs ONE wider provider request; deterministic selection then
  // re-runs on the real, merged candidate universe.
  const refetchRadius = expansionRefetchRadius(
    appraisalResult.fallbackUsed,
    bundle.metadata?.comparablesParams?.radiusMiles,
    DEFAULT_EXPANSION_POLICY.geographicDistanceMultiplier,
    Number.parseFloat(env.COMPARABLE_EXPANSION_RADIUS_MILES ?? '') || undefined,
  )
  // Time axis too: the fetched window (default 12mo) provably lacks older
  // sales — when the ladder still ends insufficient after its sale-age
  // tiers, the ONE allowed refetch also widens monthsBack to cover the
  // deepest configured tier (e.g. 548d ≈ 18mo), like radius-bound tiers
  // widen radius. The window comes from the preset's sale_age_expansion*
  // filter rows — the same configured values the ladder just walked.
  const fetchedMonthsBack = bundle.metadata?.comparablesParams?.monthsBack ?? 12
  const saleAgeSteps = saleAgeExpansionSteps(
    filters,
    filters.find((f) => f.type === 'sale_age')?.value ?? 0,
  )
  const deepestSaleAgeDays = saleAgeSteps[saleAgeSteps.length - 1] ?? 0
  const saleAgeRefetchMonths = Math.ceil(deepestSaleAgeDays / 30.44)
  const refetchMonthsBack =
    appraisalResult.fallbackUsed === 'insufficient' &&
    DEFAULT_EXPANSION_POLICY.allowSaleAgeExpansion &&
    saleAgeRefetchMonths > fetchedMonthsBack
      ? saleAgeRefetchMonths
      : undefined
  if ((refetchRadius != null || refetchMonthsBack != null) && params.expandComparablesPool) {
    try {
      const widened = await params.expandComparablesPool(
        refetchRadius ?? bundle.metadata?.comparablesParams?.radiusMiles ?? 1,
        refetchMonthsBack,
      )
      if (widened && widened.length > 0) {
        bundle = { ...bundle, comparables: widened }
        appraisalResult = appraisalService.evaluateWithFallback(
          bundle.property,
          bundle.comparables,
          { filters, adjustments, expansion: DEFAULT_EXPANSION_POLICY }
        )
        fallbacksUsed.push('pool_expansion_refetch')
        step(
          'comparables_fetch',
          'fallback',
          `Expanded provider search to ${refetchRadius}mi — ${widened.length} candidates in merged pool`,
        )
        if (appraisalResult.fallbackUsed && appraisalResult.fallbackUsed !== 'none'
            && !fallbacksUsed.includes(`comp_fallback:${appraisalResult.fallbackUsed}`)) {
          fallbacksUsed.push(`comp_fallback:${appraisalResult.fallbackUsed}`)
        }
      } else {
        fallbacksUsed.push('pool_expansion_refetch')
        step('comparables_fetch', 'fallback', `Refetch at ${refetchRadius}mi returned no additional candidates`)
      }
    } catch (refetchError) {
      console.warn('[Evaluate] Expansion refetch failed (non-fatal):', refetchError)
      step('comparables_fetch', 'failed', `Expansion refetch failed: ${refetchError instanceof Error ? refetchError.message : 'unknown'}`)
    }
  }

  // ── 2. Photos: subject + comps via Zillow → Redfin → Realtor chain ─────────
  let photoBundle: PhotoBundle | null = null
  try {
    const photoService = createPhotoService(env)
    if (params.prefetchedPhotoBundle !== undefined) {
      // Caller overlapped the scrape with the comps fetch — use it as-is.
      photoBundle = params.prefetchedPhotoBundle
    } else if (photoService.isAvailable()) {
      const subjectIdent: PropertyIdentifier = {
        propertyId: bundle.property.id,
        address: bundle.property.address,
        city: bundle.property.city,
        state: bundle.property.state,
        zipCode: bundle.property.zipCode,
      }
      // Subject-only scrape — comp cards render map imagery, so no
      // Firecrawl/Zillow calls are spent on comparables. (This also ends
      // the comp price-history supplement used for stale-sale
      // reconciliation; subject listing data still fills subject gaps
      // and carries the flood signal.)
      photoBundle = await photoService.fetchPhotoBundle(subjectIdent, [], { maxComps: 0 })
    }
    if (params.prefetchedPhotoBundle !== undefined || photoService.isAvailable()) {
      step(
        'photo_fetch',
        photoBundle?.subject ? 'completed' : 'fallback',
        photoBundle?.subject
          ? `${photoBundle.subject.photos.length} subject photos via ${photoBundle.subject.source}`
          : 'No subject photos found'
      )
    } else {
      step('photo_fetch', 'fallback', 'No photo provider configured')
    }
  } catch (error) {
    console.warn('[Evaluate] Photo fetch failed (non-fatal):', error)
    step('photo_fetch', 'fallback', error instanceof Error ? error.message : 'photo fetch failed')
  }
  onProgress?.('Photos fetched')

  // ── 2b. Zillow fallback fills: provider building data takes priority, ──────
  // but when a field is missing we fill it from the Zillow listing we already
  // fetched for photos (style, foundation, construction, roof, stories,
  // heating/cooling, parking, pool). Re-run the appraisal when fills landed —
  // a comp that was not_verified may now verify (or disqualify) for real.
  if (photoBundle) {
    const mergeResult = mergeZillowDataIntoBundle(bundle, photoBundle, {
      maxSaleAgeDays: params.reconciliationSaleAgeDays ?? 365,
    })
    const filledCount =
      mergeResult.subjectSupplementedFields.length +
      [...mergeResult.compSupplementedFields.values()].reduce((n, f) => n + f.length, 0)
    if (filledCount > 0) {
      bundle = mergeResult.bundle
      appraisalResult = appraisalService.evaluateWithFallback(
        bundle.property,
        bundle.comparables,
        { filters, adjustments, expansion: DEFAULT_EXPANSION_POLICY }
      )
      if (appraisalResult.fallbackUsed && appraisalResult.fallbackUsed !== 'none'
          && !fallbacksUsed.includes(`comp_fallback:${appraisalResult.fallbackUsed}`)) {
        fallbacksUsed.push(`comp_fallback:${appraisalResult.fallbackUsed}`)
      }
      step('zillow_supplement', 'completed', `${filledCount} field(s) supplemented from Zillow listings`)
    }
  }

  // ── 2c. Flood signal from the listing scrape — the subject photo fetch
  // already resolves the Redfin/Realtor page, which embeds First Street
  // "Flood Factor" data. Free (Firecrawl, not the property provider), so it
  // replaces the paid flood-zone call. Provider data wins when present.
  if (!bundle.enrichment.floodZone) {
    const sig = photoBundle?.subject?.metadata?.floodRisk
    if (sig && typeof sig === 'object' && typeof (sig as { level?: unknown }).level === 'string') {
      const level = (sig as { level: string; source?: string }).level
      const elevated = /moderate|major|severe|extreme|zone /i.test(level)
      bundle.enrichment.floodZone = {
        floodZone: level,
        floodZoneDescription: `Flood risk signal from the ${photoBundle!.subject!.source} listing (First Street)`,
        isInFloodZone: elevated,
        isNearFloodZone: !elevated && !/minimal/i.test(level),
        communityName: null,
        communityNumber: null,
        firmMapNumber: null,
        mapPanel: null,
        mapDate: null,
        participationStatus: null,
        specialFloodHazardArea: null,
        source: 'listing',
      }
      bundle.enrichment.evidenceLimitations = (bundle.enrichment.evidenceLimitations ?? [])
        .filter((m) => !/flood/i.test(m))
      step('photo_fetch', 'completed', `Flood signal from listing: ${level}`)
    }
  }

  // ── Vision + photo persistence — concurrent with the Jev funnel ───────────
  // Neither feeds comp selection; the renovation level is needed only at
  // deriveBuybox, so this branch is awaited after Jev completes. The photo
  // URLs are captured up front so R2 persistence can rewrite them while
  // vision reads the live CDN links.
  const visionAndPersist = (async (): Promise<RenovationAssessment> => {
    const subjectPhotos = [...(photoBundle?.subject?.photos ?? [])]
    // The subject condition fetch is required for eval completion — a thrown
    // error still resolves as an explicit 'unavailable' verdict so the run
    // records the outcome instead of silently completing without it.
    const renovationPromise = (async (): Promise<RenovationAssessment> => {
      try {
        return await assessRenovationFromPhotos(env, subjectPhotos, {
          address: bundle.property.address,
          squareFeet: bundle.property.squareFeet,
          yearBuilt: bundle.property.yearBuilt,
        })
      } catch (e) {
        return unavailableAssessment({
          error: e instanceof Error ? e.message : 'Vision assessment failed',
          limitations: ['Assessment call threw — no level invented'],
        })
      }
    })()

    // ── Persist listing photos into private report storage ────────────────
    // Copy image bytes to R2 and rewrite CDN URLs to /user/reports/{jobId}/
    // assets/{id} so saved reports keep working photos indefinitely — listing
    // CDN links rot or get hotlink-blocked. Non-fatal: failures keep the
    // original URLs.
    if (photoBundle && env.REPORT_ASSETS) {
      const persistPhotos = async (propertyId: string, entry: PropertyPhotos | null) => {
        if (!entry || entry.photos.length === 0) return
        try {
          const src = entry.source
          const { assets, rejected } = await persistReportAssets(env, jobId, propertyId,
            entry.photos.map((url) => ({
              url,
              kind: 'photo' as const,
              sourcePageUrl: entry.sourceUrl,
              source: src === 'zillow' || src === 'redfin' || src === 'realtor' ? src : undefined,
            })))
          const dropped = new Set(rejected)
          const persisted = new Set(assets.map((a) => a.sourceUrl))
          entry.photos = [...assets.map((a) => a.url), ...entry.photos.filter((u) => !persisted.has(u) && !dropped.has(u))]
        } catch { /* non-fatal — keep CDN URLs */ }
      }
      await Promise.race([
        Promise.all([
          persistPhotos(bundle.property.id, photoBundle.subject),
          ...Object.entries(photoBundle.comps).map(([id, entry]) => persistPhotos(id, entry)),
        ]),
        new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
      ])
    }

    return renovationPromise
  })()

  // ── Jev comp evaluation — the only selection logic ────────────────────────
  // Test 1 asks Jev's raw-field nouls — squareFeet, lotSize, yearBuilt,
  // salePrice, saleDate — "does this comp match the subject on this field
  // per the appraisal rules?" Passers get a composite score (proximity +
  // field strength) and the top-10 get enriched.
  // Test 2 asks the enriched nouls — subdivision yes, else neighborhood
  // yes — plus advisory physical-character/material/foundation nouls that
  // lift the score from a 90 baseline toward 100. Passers split by price:
  // the top 15% become the ARV set (variable count), the rest the as-is
  // reference. No fill — zero passers flags human handoff. ARV = mean
  // adjusted price of the ARV set — the only non-Jev step.
  let jevInvestmentCompIds: string[] = []
  let hybridRun: HybridRun | null = null
  let jevSelection: {
    selected: { compId: string; score: number | null; fullMatch: boolean; verdict: string; confidence: number | null }[]
    counts: NonNullable<HybridRun['counts']> | null
    humanHandoff: boolean
    asIsCompIds: string[]
    topCompId: string | null
  } | null = null
  if (appraisalResult.comparables.length > 0) {
    try {
      const jev = await runJevEvaluation(bundle.property, appraisalResult.comparables, filters, adjustments, env, {
        rules: { filters, adjustments },
        enrich: params.enrichComparables,
        onProgress,
      })

      // Fold enriched detail back onto the pool so cards/audit see the
      // property data test 2 used (subdivision, neighborhood, style…) —
      // and so ARV prices adjustments off the enriched record: the entry's
      // adjustedPrice was recomputed on the merged data inside the funnel.
      const entryById = new Map(jev.entries.map((e) => [e.compId, e]))
      if (jev.enrichedComps.size > 0) {
        appraisalResult.comparables = appraisalResult.comparables.map((comp) => {
          const e = jev.enrichedComps.get(comp.id)
          if (!e) return comp
          const adjusted = entryById.get(comp.id)?.adjustedPrice
          return {
            ...comp,
            ...e,
            adjustedSalePrice: adjusted ?? comp.adjustedSalePrice,
          }
        })
      }

      appraisalResult.comparables = appraisalResult.comparables.map((comp) => ({
        ...comp,
        jevHybrid: entryById.get(comp.id) ?? null,
      }))

      const humanHandoff = jev.humanHandoff
      hybridRun = {
        status: 'completed', mode: 'enabled', questionVersion: COMP_HYBRID_VERSION,
        model: jev.test2?.model ?? jev.test1?.model,
        latencyMs: (jev.test1?.latencyMs ?? 0) + (jev.test2?.latencyMs ?? 0),
        inputTokens: (jev.test1?.inputTokens ?? 0) + (jev.test2?.inputTokens ?? 0),
        stateHashes: [...(jev.test1?.stateHashes ?? []), ...(jev.test2?.stateHashes ?? [])],
        test1: jev.test1, test2: jev.test2,
        counts: jev.counts,
        selection: { noulGate: jev.noulGate, arvTopPercent: COMP_ARV_TOP_PERCENT, humanHandoff },
        questionSet: jev.questionSet,
        screenedAt: new Date().toISOString(),
      }
      jevSelection = {
        selected: jev.arvCompIds.map((id) => {
          const e = entryById.get(id)
          return {
            compId: id,
            score: e?.score ?? null,
            fullMatch: e?.stage === 'test2_pass',
            verdict: e?.selected ?? 'core',
            confidence: e?.scoreConfidence ?? null,
          }
        }),
        counts: jev.counts,
        humanHandoff,
        asIsCompIds: jev.asIsCompIds,
        topCompId: jev.entries.find((e) => e.poolRank === 1)?.compId ?? null,
      }

      if (jev.arvCompIds.length === 0) {
        // Zero test-2 passers — human handoff. The rules selection stands
        // as a reference number; the flag tells the consumer it is
        // unexamined. Test results still attach for display.
        step('jev_evaluation', 'fallback', `Jev tested ${jev.counts.pool} candidates — none passed both tests — human handoff (${jev.test1?.model ?? 'jev'})`)
        fallbacksUsed.push('jev_evaluation:human_handoff')
      } else {
        const selectedIds = new Set(jev.arvCompIds)
        appraisalResult.comparables = appraisalResult.comparables.map((comp) => ({
          ...comp,
          isEnabled: selectedIds.has(comp.id),
          arvStatus: selectedIds.has(comp.id)
            ? 'selected' as const
            : comp.arvStatus === 'selected' ? 'not_examined' as const : comp.arvStatus,
        }))
        appraisalResult.selectedCompIds = jev.arvCompIds
        appraisalResult.arv = appraisalService.calculateARV(
          appraisalResult.comparables.filter((c) => selectedIds.has(c.id)),
        )
        appraisalResult.insufficientComps = false
        step('jev_evaluation', 'completed',
          `Jev tested ${jev.counts.pool} → ${jev.counts.test1Passed} passed test 1 → ${jev.counts.test2Passed} passed test 2 → ${jev.counts.arv} ARV / ${jev.counts.asIs} as-is · ${jev.counts.ineligible} ineligible (${jev.test2?.model ?? jev.test1?.model ?? 'jev'})`)
      }
    } catch (error) {
      console.warn('[Evaluate] Jev evaluation failed:', error instanceof Error ? error.message : error)
      step('jev_evaluation', 'fallback', 'Jev evaluation unavailable — appraisal-rules selection used')
      fallbacksUsed.push('jev_evaluation:unavailable')
      hybridRun = { status: 'unavailable', mode: 'enabled', questionVersion: COMP_HYBRID_VERSION, reason: 'jev_failed' }
    }
  }

  const enabledComps = appraisalResult.comparables.filter((c) => c.isEnabled)
  if (appraisalResult.insufficientComps || enabledComps.length === 0) {
    step('appraisal_rules', 'failed', appraisalResult.fallbackReason ?? 'insufficient comps')
    throw new AnalysisError(
      appraisalResult.fallbackReason ??
        `Only ${enabledComps.length} comps satisfy appraisal rules (required: 3). Try adjusting your appraisal filters.`,
      { code: 'INSUFFICIENT_COMPS' }
    )
  }
  step(
    'appraisal_rules',
    appraisalResult.fallbackUsed === 'none' ? 'completed' : 'fallback',
    `${enabledComps.length}/${bundle.comparables.length} comps passed` +
      (appraisalResult.fallbackUsed !== 'none' ? ` (${appraisalResult.fallbackUsed})` : '')
  )
  let finalArv = appraisalResult.arv

  // ── 3. Vision: subject renovation + curb appeal (one merged LLM call) ─────
  // Subject-only — comps are never photo-scraped, so there is no per-comp
  // vision pass. The renovation level drives the rehab tier; the curb-appeal
  // condition is the subject's detected condition. Launched alongside the
  // Jev funnel above — the result is only needed here.
  const compById = new Map(appraisalResult.comparables.map((c) => [c.id, c]))
  // Required step — the fetch always resolves a verdict object. Non-ok
  // statuses are recorded in fallbacksUsed so the report exposes that the
  // subject condition could not be verified from photos.
  const renovation: RenovationAssessment = await visionAndPersist
  step(
    'renovation_assessment',
    renovation.renovationLevelIndex != null ? 'completed' : 'fallback',
    renovation.renovationLevelIndex != null
      ? `${renovation.renovationLevel} @ ${renovation.confidence ?? '?'}% (${renovation.photosExamined} photos)`
      : `condition fetch completed — ${renovation.status}${renovation.error ? ` (${renovation.error})` : ''}`
  )
  if (renovation.status !== 'ok') {
    fallbacksUsed.push(`vision:${renovation.status}`)
  }
  onProgress?.('Renovation level assessed')

  // Subject curb appeal comes from the merged vision pass (one LLM call for
  // both renovation level + curb-appeal condition).
  const subjectCurbAppeal: CurbAppealCheck | null = renovation.curbAppeal ?? null

  // ── ARV condition evidence ────────────────────────────────────────────────
  // Product spec: the rules already picked the comps — condition verification
  // is the cherry on top that boosts confidence, NOT a selection gate.
  //   • verified AR-quality (assessor Good+) → confidence +
  //   • verified NOT AR-quality (assessor Fair/Poor/Very Poor) → excluded —
  //     confirmed evidence it isn't ARV spec
  //   • unverifiable → KEPT: top-of-market comps matching the rules are valid
  //     ARV anchors; lack of condition data only lowers confidence.

  // Assessor condition is the primary signal — Good/Very Good/Excellent are
  // retail-ready; Fair/Poor/Very Poor are confirmed below ARV spec.
  const ARV_POSITIVE_CONDITIONS = new Set(['excellent', 'verygood', 'good'])
  const ARV_NEGATIVE_CONDITIONS = new Set(['fair', 'poor', 'verypoor'])
  const assessorSignal = (compId: string): 'positive' | 'negative' | 'average' | null => {
    const cond = compById.get(compId)?.buildingCondition?.toLowerCase().replace(/[^a-z]/g, '')
    if (!cond) return null
    if (ARV_POSITIVE_CONDITIONS.has(cond)) return 'positive'
    if (ARV_NEGATIVE_CONDITIONS.has(cond)) return 'negative'
    return 'average' // 'average' and unmapped values — usable, no boost
  }

  const unverifiable: string[] = []
  const prunedFromArv: string[] = []
  let verifiedPositiveCount = 0
  for (const id of appraisalResult.selectedCompIds ?? []) {
    const assessor = assessorSignal(id)
    if (assessor === 'negative') {
      prunedFromArv.push(id)
    } else if (assessor === 'positive') {
      verifiedPositiveCount++
    } else if (assessor !== 'average') {
      // No signal at all — kept in the ARV set, counted for confidence
      unverifiable.push(id)
    }
  }
  if (prunedFromArv.length > 0) {
    const remaining = (appraisalResult.selectedCompIds ?? []).filter((id) => !prunedFromArv.includes(id))
    const remainingComps = appraisalResult.comparables.filter((c) => remaining.includes(c.id))
    if (remainingComps.length >= 3) {
      appraisalResult.arv = appraisalService.calculateARV(remainingComps)
      appraisalResult.selectedCompIds = remaining
      finalArv = appraisalResult.arv
      fallbacksUsed.push(`arv_condition_pruned:${prunedFromArv.length}`)
      step('arv_condition_gate', 'fallback',
        `${prunedFromArv.length} comp(s) excluded — verified below ARV spec (poor assessor condition); ARV recomputed on ${remainingComps.length}`)
    } else {
      // Can't recompose a 3-comp ARV — keep the set but mark the evidence
      fallbacksUsed.push('arv_condition_thin')
      step('arv_condition_gate', 'fallback',
        `${prunedFromArv.length} comp(s) verified below ARV spec — ARV kept on ${remainingComps.length + prunedFromArv.length} comps, fewer than 3 verified`)
    }
  } else if (appraisalResult.selectedCompIds?.length) {
    step('arv_condition_gate', 'completed',
      `${appraisalResult.selectedCompIds.length} comp(s) selected — ${verifiedPositiveCount} verified AR-quality${unverifiable.length ? `, ${unverifiable.length} unverified (kept: rules-matched)` : ''}`)
  }
  if (unverifiable.length > 0) {
    fallbacksUsed.push(`arv_condition_unverified:${unverifiable.length}`)
  }

  // ── 4. Classifications (price percentile, display grouping) ─────────────────
  const arvThreshold = params.arvThreshold ?? { percent: 15 }
  const compClassifications = classifyCompsByPrice(bundle.comparables, arvThreshold.percent)
  const classificationSummary = summarizeClassifications(
    appraisalResult.comparables,
    compClassifications
  )

  // ── 5. Derive buybox: vision level → rehab tier, permits → major items ──────
  const majorItemConfig = await loadMajorItemConfig(env, params.userId)
  const derivedBuybox = deriveBuybox(bundle.property, undefined, params.buybox, {
    permits: bundle.enrichment.permits?.items,
    majorItemConfig,
    visionLevelIndex: renovation.renovationLevelIndex,
    visionConfidence: renovation.confidence,
    visionRenovated: subjectCurbAppeal?.condition === 'renovated',
  })
  step(
    'major_items',
    'completed',
    `${derivedBuybox.majorItems.filter((m) => m.enabled).length} major items charged`
  )

  // ── 6. Valuation ────────────────────────────────────────────────────────────
  const buybox = params.buybox ?? {}
  const subjectSqft = bundle.property.squareFeet || 0
  const compAvgSqft =
    enabledComps.length > 0
      ? enabledComps.reduce((sum, c) => sum + (c.squareFeet || 0), 0) / enabledComps.length
      : subjectSqft

  const valuationService = createValuationService(params.customRehabTable, params.customTierRanges)
  const valuation = valuationService.calculateValuation({
    arv: finalArv,
    subjectSqft,
    compAvgSqft,
    rehabLevelIndex: derivedBuybox.rehabLevelIndex,
    skipBaseRehab: derivedBuybox.renovatedVerified === true,
    locationPenaltyAmount: computeLocationPenalty(bundle.enrichment.locationRisks, finalArv, params.proximityConfig),
    majorItems: derivedBuybox.majorItems,
    additionPlay: derivedBuybox.additionPlay ?? buybox.additionPlay ?? 0,
    closingCostsPercent: buybox.closingCostsPercent ?? 8,
    carryingCostsPercent: buybox.carryingCostsPercent ?? 2,
    wholesaleFee: buybox.wholesaleFee ?? 10000,
    desiredProfit: buybox.desiredProfit,
  })

  const rehabLevelEstimates = calculateAllRehabLevelEstimates(valuationService, {
    arv: finalArv,
    subjectSqft,
    compAvgSqft,
    selectedRehabLevelIndex: derivedBuybox.rehabLevelIndex,
    majorItems: derivedBuybox.majorItems,
    additionPlay: buybox.additionPlay ?? 0,
    closingCostsPercent: buybox.closingCostsPercent ?? 8,
    carryingCostsPercent: buybox.carryingCostsPercent ?? 2,
    wholesaleFee: buybox.wholesaleFee ?? 10000,
  })
  step('valuation', 'completed', `ARV ${formatUsd(finalArv)} · rehab ${formatUsd(valuation.totalRehabCost)}`)

  // ── 7. Group B as-is market intelligence ────────────────────────────────────
  const asIsThresholdPercent = params.asIsThresholdPercent ?? 70
  const groupACompIds = new Set(appraisalResult.selectedCompIds ?? [])
  // Jev's investment-truth picks are the investment set when available;
  // otherwise fall back to the price-threshold Group B.
  const groupBResult = jevInvestmentCompIds.length > 0
    ? summarizeGroupB(
        appraisalResult.comparables.filter(
          (c) => jevInvestmentCompIds.includes(c.id) && c.salePrice != null && c.salePrice > 0,
        ),
        bundle.property,
        finalArv,
        asIsThresholdPercent,
        Math.round((finalArv * asIsThresholdPercent) / 100),
        appraisalResult.comparables,
      )
    : selectGroupBComps(
        bundle.property,
        appraisalResult,
        finalArv,
        asIsThresholdPercent,
        groupACompIds
      )
  if (groupBResult && groupBResult.count > 0) {
    console.log(`[Evaluate] Group B: ${groupBResult.count} as-is comps (${jevInvestmentCompIds.length > 0 ? 'Jev investment-truth selected' : `≤${formatUsd(groupBResult.priceCeiling)}, ${asIsThresholdPercent}% of ARV`})`)
  }

  // ── 8. Best match + applied settings snapshot ───────────────────────────────
  const bestMatch = selectBestMatch(
    bundle.property,
    appraisalResult.comparables.filter((c) => groupACompIds.has(c.id)),
  )

  const appliedSettings = {
    filters: filters.map((f) => ({
      type: f.type,
      enabled: f.enabled,
      value: f.value,
      priority: f.priority ?? defaultFilterPriority(f.type),
    })),
    adjustments: adjustments.map((a) => ({
      type: a.type,
      enabled: a.enabled,
      // old_comp_discount carries its age threshold (days) in `amount`
      amount: a.type === 'old_comp_discount' ? (a.thresholdDays ?? a.amount) : a.amount,
      percent: a.percent,
    })),
    dealParams: {
      closingCostsPercent: buybox.closingCostsPercent ?? 8,
      carryingCostsPercent: buybox.carryingCostsPercent ?? 2,
      wholesaleFee: buybox.wholesaleFee ?? 10000,
    },
    rehabLevelIndex: derivedBuybox.rehabLevelIndex,
    rehabTable: valuationService.getRehabTable(),
    majorItems: derivedBuybox.majorItems,
    additionPlay: buybox.additionPlay ?? 0,
    arvThresholdPercent: arvThreshold.percent,
    asIsThresholdPercent,
  }

  // ── 9. Build response ───────────────────────────────────────────────────────
  const response = buildAnalysisResponse(
    bundle,
    appraisalResult,
    photoBundle,
    valuation,
    {
      arvSource: 'appraisal',
      finalArv,
      analysisId: jobId,
      subjectClassification: undefined,
      compClassifications,
      classificationSummary,
      subjectSupplementedFields: [],
      compSupplementedFields: new Map(),
      rehabLevelEstimates,
      appliedSettings,
      visionAnalysis: mapRenovationToVision(renovation),
      subjectCurbAppeal,
      subjectListingUrl: photoBundle?.subject?.sourceUrl ?? null,
      subjectListPrice: typeof photoBundle?.subject?.metadata?.listPrice === 'number'
        ? photoBundle.subject.metadata.listPrice
        : null,
      apiCallStats: params.apiCallStats,
      bestMatch,
      groupBResult,
      groupACompIds,
      groupBCompIds: new Set(groupBResult?.compIds ?? []),
    }
  )

  // ── 10. Justified evaluation report (additive) ──────────────────────────────
  step('response_build', 'completed', 'Response assembled')
  response.report = buildEvaluationReport({
    bundle,
    appraisalResult,
    subjectClassification: undefined,
    weightedARVResult: undefined,
    derivedBuybox,
    valuation,
    steps,
    fallbacksUsed,
    renovationAssessment: renovation,
    jev: jevSelection,
  })
  // Confidence gate on the comps that drive the ARV — surfaces onto the
  // valuation block. There is no human reviewer, so the formula call
  // always stands; confidence + reasons carry the reliability signal.
  response.valuation.confidence = response.report.confidence
  response.valuation.confidenceReasons = response.report.confidenceReasons
  response.valuation.requiresHumanReview = response.report.requiresHumanReview
  if (response.report.confidence === 'low') {
    response.valuation.recommendationReason =
      `${valuation.recommendationReason ?? ''} — LOW confidence: comp evidence is thin or stale`.trim()
  } else if (response.report.confidence === 'medium') {
    response.valuation.recommendationReason =
      `${valuation.recommendationReason ?? ''} — medium confidence: some dimensions unverified`.trim()
  }
  response.visionAssessment = renovation
  response.renovationLevelSource = derivedBuybox.rehabLevelSource
  response.evaluationEngine = 'ts-v5'
  if (photoBundle) response.photoProvider = photoBundle.provider

  // ── 11. Jev outcome classification (read-only; never affects the result) ──
  // Assesses the Jev-driven production outcome — the only scenario left.
  try {
    response.jevOutcome = await classifyOutcomeWithJev(response, env)
  } catch (jevError) {
    console.warn('[Evaluation] Jev outcome classification failed:', jevError instanceof Error ? jevError.message : jevError)
    response.jevOutcome = { status: 'unavailable', reason: 'classification_failed' }
  }
  if (hybridRun) response.jevHybrid = hybridRun

  return {
    response,
    appraisalResult,
    compClassifications,
    groupB: groupBResult,
  }
}

/**
 * Map the vision renovation assessment into the response's visionAnalysis shape.
 */
function mapRenovationToVision(
  assessment: RenovationAssessment | null
): NonNullable<ResponseContext['visionAnalysis']> | undefined {
  if (!assessment) return undefined

  const interiorParts = [
    assessment.kitchenCondition !== 'NA' && `kitchen: ${assessment.kitchenCondition}`,
    assessment.bathroomCondition !== 'NA' && `bath: ${assessment.bathroomCondition}`,
    assessment.flooringCondition !== 'NA' && `flooring: ${assessment.flooringCondition}`,
    assessment.wallCeilingCondition !== 'NA' && `walls: ${assessment.wallCeilingCondition}`,
  ].filter(Boolean) as string[]

  return {
    overallCondition: assessment.renovationLevel,
    confidence: assessment.confidence ?? 0,
    estimatedRehabNeeds: assessment.majorObservations.join('; ') || 'See report',
    summary: assessment.rationale ?? `Renovation level ${assessment.renovationLevel} at ${assessment.confidence ?? '?'}% confidence from ${assessment.photosExamined} photos`,
    interior: {
      condition: interiorParts.length ? interiorParts.join('; ') : 'NA',
      notes: assessment.evidenceForClassification,
    },
    exterior: {
      condition: assessment.exteriorCondition,
      notes: [...assessment.visibleMajorSystemConcerns, ...assessment.structuralConcerns],
    },
  }
}
