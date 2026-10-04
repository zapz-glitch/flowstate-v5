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
import type { NormalizedComparable, NormalizedPermit, NormalizedProperty } from '../property-api/types'
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
import { verifyCompEvidence } from '../appraisal/verification'
import { arvEvidence, classifyCompsByEvidence } from './comp-classification'
export { arvEvidence, classifyCompsByEvidence }
import { evaluateB, subdivisionsMatch, type BComp } from '@flowstate-api/shared/appraisal'
import { createValuationService, MAJOR_ITEMS, type MajorItem } from '../valuation'
import type { ClassificationResult } from '../classification'
import type { RehabTable, TierRangeDefinition } from '@flowstate-api/shared/valuation'
import {
  buildAnalysisResponse,
  calculateAllRehabLevelEstimates,
  type AnalysisResponse,
  type ApiCallStats,
  type ResponseContext,
} from '../analysis'
import { createPhotoService, type PhotoBundle, type PropertyIdentifier, type PropertyPhotos } from '../photo-provider'
import { gatherCompConditionEvidence, type CompConditionEvidence } from '../comp-evidence'
import { isClefAvailable } from '../clef'
import { fetchRedfinPropertyDetails, type RedfinDetailsResult } from '../redfin-details'
import type { PhysicalCharacteristicSourceData } from '../physical-characteristics'

import { persistReportAssets } from '../report-assets'
import { expansionRefetchRadius } from '../property-api/retrieval-policy'
import { assessRenovationFromPhotos, unavailableAssessment, type RenovationAssessment, type CurbAppealCheck } from '../vision/renovation'
import { PROXIMITY_DEFAULTS } from '../../routes/proximity-config'
import { deriveBuybox } from './derivation'
import { buildEvaluationReport } from './report'
import {
  fetchSellerNotes,
  classifyRehabIntel,
  additionToMajorItem,
  type RehabAddition,
  type RehabAdvisory,
} from '../seller-notes'
import type { ReportStep } from './types'

function formatUsd(amount: number): string {
  return `$${Math.round(amount).toLocaleString()}`
}

// ─── Types ───────────────────────────────────────────────────────────────────

/** Clef comp curb-appeal stamps — the map keys on comp/property id.
 *  Serialized onto `comps.items[].curbAppeal` when it lands in time; the
 *  onCurbAppeal callback carries it for late persistence writebacks. */
export type CompCurbAppealMap = Record<string, {
  condition: 'renovated' | 'dated' | 'distressed' | 'unknown'
  source: 'vision'
  confidence: number | null
  summary: string | null
  photosExamined: number
}>

export interface EvaluationParams {
  jobId: string
  userId?: string
  bundle: PropertyBundle
  /**
   * Fires when the Clef comp-evidence batch resolves — which may be after
   * the response is built and persisted. The caller uses this to patch the
   * stored result so curb-appeal stamps reach saved reports.
   */
  onCurbAppeal?: (map: CompCurbAppealMap) => void
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
   * Deepen seam — re-fetch comp details (valuation + tax-history for the
   * ATTOM provider) for pool members lacking AVM/land evidence. Used by
   * the B verify-and-retry ladder's third attempt.
   */
  enrichComparables?: (comps: NormalizedComparable[]) => Promise<NormalizedComparable[] | null>
  /**
   * Sqft-conflict permit check — provider permits for one comp (ATTOM
   * permits dataset). Resolves marketed-vs-tax sqft divergences: a
   * permitted addition/basement finish validates the marketed size; no
   * matching permit → the tax record stands. Missing = conflicts stay
   * bound-only.
   */
  getCompPermits?: (compId: string) => Promise<NormalizedPermit[] | null>
  /**
   * Subject photo bundle prefetched by the caller so the scrape overlaps the
   * comparables fetch. `undefined` = not prefetched — fetch inline.
   * `null` = prefetch ran and found nothing / provider unavailable — don't
   * refetch.
   */
  prefetchedPhotoBundle?: PhotoBundle | null
  /**
   * Close CRM lead this eval belongs to — when present, realtor
   * conversation-log notes are fetched and folded into the rehab model
   * (additive items apply; removals become advisories only).
   */
  leadId?: string
  /** Explicit rerun — bypass photo/listing caches so the subject
   *  condition read and list price come back fresh. */
  skipCache?: boolean
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

/** Sold ≥15% over the comp's own scope median $/sf → premium sale = ARV evidence */
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
/**
 * Sqft-scale each comp's sale price to the subject's sqft, then average —
 * shared by the evidence Group B path.
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
 *   comps degrades to a valuation:null report (never a fabricated ARV) so
 *   the comp pool and its per-rule evidence stay viewable.
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
  let prevStepAt = Date.now()
  const step = (name: string, status: ReportStep['status'], detail?: string) => {
    const now = Date.now()
    steps.push({ step: name, label: name, status, detail, durationMs: now - prevStepAt })
    prevStepAt = now
  }

  // Realtor conversation-log notes — fetched in parallel with the eval so a
  // Rerun always re-reads the CRM. Never blocks: failure resolves to [].
  const sellerNotesPromise = fetchSellerNotes(env.CLOSE_API_KEY, params.leadId)

  // ── Photos + vision start immediately ────────────────────────────────────
  // Step 1 work: the subject listing scrape needs only the subject's
  // identity, and vision needs only the photos — both overlap the entire
  // appraisal path below. Resolved at the points the pipeline actually
  // consumes them (photo stamps near comp selection, renovation level at
  // deriveBuybox).
  const photoService = createPhotoService(env)
  const photoBundlePromise: Promise<PhotoBundle | null> = (async () => {
    let photoBundle: PhotoBundle | null = null
    try {
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
        // Firecrawl/Zillow calls are spent on comparables.
        photoBundle = await photoService.fetchPhotoBundle(subjectIdent, [], { maxComps: 0, skipCache: params.skipCache })
      }
      if (params.prefetchedPhotoBundle !== undefined || photoService.isAvailable()) {
        step(
          'photo_fetch',
          photoBundle?.subject ? 'completed' : 'fallback',
          photoBundle?.subject
            ? photoBundle.subject.photos.length > 0
              ? `${photoBundle.subject.photos.length} subject photos via ${photoBundle.subject.source}`
              : `Listing metadata via ${photoBundle.subject.source} (no photos${
                  typeof photoBundle.subject.metadata?.listPrice === 'number'
                    ? `; list price $${photoBundle.subject.metadata.listPrice.toLocaleString()}`
                    : ''
                })`
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

    // Flood signal from the listing scrape — the subject photo fetch already
    // resolves the Redfin/Realtor page, which embeds First Street "Flood
    // Factor" data. Free, so it replaces the paid flood-zone call. Provider
    // data wins when present.
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
    return photoBundle
  })()

  // Vision + photo persistence chain — begins the moment subject photos
  // land, long before the appraisal path finishes.
  const visionAndPersist: Promise<RenovationAssessment> = photoBundlePromise.then(async (photoBundle) => {
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
  })

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

  // ── Comp selection — evidence-driven ──────────────────────────────────────
  // The ARV set is every enabled comp carrying ARV evidence — verified flip
  // resale, premium over its scope median $/sf, or sale above its own AVM.
  // The three signals cooperate: multiple qualifying comps average into the
  // ARV. Flip acquisitions fold into the investor floor via summarizeGroupB.
  // Zero evidence → ARV withheld; the run degrades to report-only.
  const subjectAvm = bundle.enrichment?.avm?.value ?? bundle.property.avmValue ?? null
  const arvComps = appraisalResult.comparables.filter(
    (c) => c.isEnabled && arvEvidence(c, subjectAvm) != null,
  )
  const arvIds = new Set(arvComps.map((c) => c.id))
  appraisalResult.comparables = appraisalResult.comparables.map((comp) => ({
    ...comp,
    arvStatus: arvIds.has(comp.id)
      ? 'selected' as const
      : comp.arvStatus === 'selected' ? 'not_examined' as const : comp.arvStatus,
  }))
  appraisalResult.selectedCompIds = [...arvIds]

  // Redfin MLS details run in parallel with vision/valuation. Construction
  // evidence covers every geo match; the original top-15 cohort remains a
  // separate set because only those comps may supplement appraisal inputs.
  const legacyRedfinCompTargets = appraisalResult.comparables
    .slice()
    .sort((a, b) =>
      Number(b.isEnabled && arvIds.has(b.id)) - Number(a.isEnabled && arvIds.has(a.id))
      || Number(b.isEnabled) - Number(a.isEnabled)
      || (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999))
    .slice(0, 15)
  const legacyRedfinCompIds = new Set(legacyRedfinCompTargets.map((comp) => comp.id))
  const normalizeGeoName = (value?: string | null) =>
    value?.toLowerCase().replace(/[^a-z0-9]/g, '') || null
  const subjectNeighborhood = normalizeGeoName(bundle.property.neighborhoodName)
  const geoPriority = (comp: AppraisedComparable): number | null => {
    if (bundle.property.censusTract && comp.censusTract === bundle.property.censusTract) return 0
    if (comp.sameBlockGroup === true) return 1
    const neighborhoodMatch = subjectNeighborhood != null
      && normalizeGeoName(comp.neighborhoodName) === subjectNeighborhood
    const subdivisionMatch = subdivisionsMatch(bundle.property.subdivision, comp.subdivision)
    return neighborhoodMatch || subdivisionMatch ? 2 : null
  }
  const geoMatchedRedfinTargets = appraisalResult.comparables
    .map((comp) => ({ comp, priority: geoPriority(comp) }))
    .filter((entry): entry is { comp: AppraisedComparable; priority: number } => entry.priority != null)
    .sort((a, b) => a.priority - b.priority
      || (a.comp.distanceMiles ?? 999) - (b.comp.distanceMiles ?? 999))
    .map(({ comp }) => comp)
  const geoMatchedRedfinIds = new Set(geoMatchedRedfinTargets.map((comp) => comp.id))
  const constructionFillTargets = appraisalResult.comparables
    .filter((comp) => !geoMatchedRedfinIds.has(comp.id))
    .sort((a, b) => (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999))
    .slice(0, Math.max(0, 15 - geoMatchedRedfinTargets.length))
  const constructionRedfinTargets = [...geoMatchedRedfinTargets, ...constructionFillTargets]
  const redfinTargetsById = new Map(
    [...legacyRedfinCompTargets, ...constructionRedfinTargets].map((comp) => [comp.id, comp]),
  )
  const extraRedfinTargetCount = Math.max(0, redfinTargetsById.size - legacyRedfinCompTargets.length)

  const redfinDetailsEnabled = !!(env.FIRECRAWL_API_KEY && env.OPENROUTER_API_KEY)
  const redfinSubjectPromise = redfinDetailsEnabled
    ? fetchRedfinPropertyDetails(env, bundle.property, env.API_CACHE).catch(
        (): RedfinDetailsResult => ({ details: null, skippedReason: 'fetch_failed' }),
      )
    : null
  const redfinCompPromise = redfinDetailsEnabled
    ? Promise.all(
        [...redfinTargetsById.values()].map((comp) =>
          fetchRedfinPropertyDetails(env, comp, env.API_CACHE)
            .then((r): { id: string; r: RedfinDetailsResult } => ({ id: comp.id, r }))
            .catch(() => ({ id: comp.id, r: { details: null, skippedReason: 'fetch_failed' } as RedfinDetailsResult })),
        ),
      )
    : null

  // Clef comp-evidence batch — kicked off here so the listing scrapes +
  // classifications (the pipeline's longest wall-clock segment, up to ~45s)
  // overlap the vision assessment and valuation instead of serializing at
  // step 8b. Awaited where the comp_curb_appeal step records.
  const clefCompPromise: Promise<(CompConditionEvidence | null)[]> | null =
    env.CLEF_COMP_CONDITION_ENABLED === 'true' && isClefAvailable(env)
      ? Promise.all(
          appraisalResult.comparables
            .slice()
            .sort((a, b) =>
              Number(b.isEnabled && arvIds.has(b.id)) - Number(a.isEnabled && arvIds.has(a.id))
              || Number(b.isEnabled) - Number(a.isEnabled)
              || (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999))
            .slice(0, Number(env.CLEF_COMP_MAX) || Infinity)
            .map((comp) =>
              Promise.race([
                gatherCompConditionEvidence(env, {
                  propertyId: comp.id,
                  address: comp.address,
                  city: comp.city,
                  state: comp.state,
                  zipCode: comp.zipCode,
                  salePrice: comp.salePrice ?? undefined,
                  saleDate: comp.saleDate ? String(comp.saleDate) : undefined,
                  yearBuilt: comp.yearBuilt ?? undefined,
                  squareFeet: comp.squareFeet ?? undefined,
                }),
                new Promise<null>((r) => setTimeout(() => r(null), 45_000)),
              ]).catch(() => null),
            ),
        )
      : null
  if (arvComps.length > 0) {
    appraisalResult.insufficientComps = false
    step('appraisal_rules', 'completed',
      `Evidence selection — ${arvComps.length} evidence comp(s) staged for Set-B`)
  } else {
    // finalArv reads `insufficient`, so the ladder's banded number is dead
    // weight — withholding it is what makes the run report-only.
    appraisalResult.insufficientComps = true
    step('appraisal_rules', 'completed',
      'Evidence selection — no ARV evidence found; ARV withheld (report-only)')
  }

  const enabledComps = appraisalResult.comparables.filter((c) => c.isEnabled)
  // Insufficient comps degrades to a report-only result — the run completes
  // with valuation null so the subject, the evaluated comp pool, and the
  // geo stamps are saved and viewable instead of erroring the search.
  const insufficient = appraisalResult.insufficientComps === true || enabledComps.length === 0
  if (insufficient) {
    step('appraisal_rules', 'failed', appraisalResult.fallbackReason ?? 'insufficient comps')
    fallbacksUsed.push('insufficient_comps')
  } else {
    step(
      'appraisal_rules',
      appraisalResult.fallbackUsed === 'none' ? 'completed' : 'fallback',
      `${enabledComps.length}/${bundle.comparables.length} comps passed` +
        (appraisalResult.fallbackUsed !== 'none' ? ` (${appraisalResult.fallbackUsed})` : '')
    )
  }
  // Set-B is the only ARV path — it fills finalArv below; there is no
  // legacy blend.
  let finalArv: number | null = null

  // ── 3. Vision: subject renovation + curb appeal (one merged LLM call) ─────
  // Subject-only — comps are never photo-scraped, so there is no per-comp
  // vision pass. The renovation level drives the rehab tier; the curb-appeal
  // condition is the subject's detected condition.
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

  // ── 4. Classifications — transaction evidence, not condition guessing ────
  // flip resale → after_renovation; distressed sale → as_is; ordinary sale
  // → transitional (market tier).
  let compClassifications = classifyCompsByEvidence(bundle.comparables, subjectAvm)
  let classificationSummary = summarizeClassifications(
    appraisalResult.comparables,
    compClassifications,
    subjectAvm
  )

  // ── 5. Derive buybox: vision level → rehab tier, permits → major items ──────
  const majorItemConfig = await loadMajorItemConfig(env, params.userId)
  const derivedBuybox = deriveBuybox(bundle.property, undefined, params.buybox, {
    permits: bundle.enrichment.permits?.items,
    majorItemConfig,
    visionLevelIndex: renovation.renovationLevelIndex,
    visionConfidence: renovation.confidence,
    // "Verified renovated" requires the vision level itself to say no real
    // work is needed (Lipstick = 0). A renovated-looking exterior alone must
    // not zero the rehab when the interior verdict assigned a real level.
    visionRenovated:
      subjectCurbAppeal?.condition === 'renovated' && renovation.renovationLevelIndex === 0,
  })
  step(
    'major_items',
    'completed',
    `${derivedBuybox.majorItems.filter((m) => m.enabled).length} major items charged`
  )

  // ── 5b. Seller notes → rehab intel ─────────────────────────────────────────
  // Notes can only ADD to the renovation ledger — a realtor mentioning work
  // the permit engine missed gets charged in. Removal signals become
  // advisory-only callouts; a human decides whether to drop the item.
  const sellerNotes = await sellerNotesPromise
  let rehabAdditions: RehabAddition[] = []
  let rehabAdvisories: RehabAdvisory[] = []
  if (sellerNotes.length > 0) {
    const intel = await classifyRehabIntel(
      env,
      sellerNotes,
      derivedBuybox.majorItems
        .filter((m) => m.enabled)
        .map((m) => ({ id: m.id, name: m.id, cost: m.cost, reason: m.reason })),
    )
    rehabAdditions = intel.additions
    rehabAdvisories = intel.advisories
    for (const a of rehabAdditions) {
      const item = additionToMajorItem(a)
      if (!item) continue
      derivedBuybox.majorItems.push(item)
      derivedBuybox.notes.push(
        `Realtor note added ${item.id} (+$${item.cost}): ${a.evidence}`,
      )
    }
    if (rehabAdditions.length > 0) {
      fallbacksUsed.push(`seller_note_additions:${rehabAdditions.length}`)
    }
    step(
      'seller_notes',
      'completed',
      `${sellerNotes.length} note(s) — ${rehabAdditions.length} item(s) added, ${rehabAdvisories.length} advisory(ies)`,
    )
  }

  // ── 6. Valuation ────────────────────────────────────────────────────────────
  const buybox = params.buybox ?? {}
  const subjectSqft = bundle.property.squareFeet || 0
  const compAvgSqft =
    enabledComps.length > 0
      ? enabledComps.reduce((sum, c) => sum + (c.squareFeet || 0), 0) / enabledComps.length
      : subjectSqft

  const valuationService = createValuationService(params.customRehabTable, params.customTierRanges)
  // Anchor ladder — when the comp pool yields no ARV evidence, a modeled
  // value still supports a conservative valuation: the eval box stays
  // interactive (renovation tier, manual ARV, rehab math) instead of hiding.
  // AVM first, county assessment second (both run below ARV = conservative).
  // insufficientComps stays true — the report marks the anchor, never calls
  // it comp-verified. Neither present → valuation stays null (report-only).
  const avmAnchor = finalArv == null && subjectAvm != null && subjectAvm > 0 ? Math.round(subjectAvm) : null
  const assessedAnchor = finalArv == null && avmAnchor == null && (bundle.property.assessedValue ?? 0) > 0
    ? Math.round(bundle.property.assessedValue!) : null
  let valuationAnchor = finalArv ?? avmAnchor ?? assessedAnchor
  let valuation = valuationAnchor != null ? valuationService.calculateValuation({
    arv: valuationAnchor,
    subjectSqft,
    compAvgSqft,
    rehabLevelIndex: derivedBuybox.rehabLevelIndex,
    skipBaseRehab: derivedBuybox.renovatedVerified === true,
    locationPenaltyAmount: computeLocationPenalty(bundle.enrichment.locationRisks, valuationAnchor, params.proximityConfig),
    majorItems: derivedBuybox.majorItems,
    additionPlay: derivedBuybox.additionPlay ?? buybox.additionPlay ?? 0,
    closingCostsPercent: buybox.closingCostsPercent ?? 8,
    carryingCostsPercent: buybox.carryingCostsPercent ?? 2,
    wholesaleFee: buybox.wholesaleFee ?? 10000,
    desiredProfit: buybox.desiredProfit,
  }) : null

  let rehabLevelEstimates = valuationAnchor != null ? calculateAllRehabLevelEstimates(valuationService, {
    arv: valuationAnchor,
    subjectSqft,
    compAvgSqft,
    selectedRehabLevelIndex: derivedBuybox.rehabLevelIndex,
    majorItems: derivedBuybox.majorItems,
    additionPlay: buybox.additionPlay ?? 0,
    closingCostsPercent: buybox.closingCostsPercent ?? 8,
    carryingCostsPercent: buybox.carryingCostsPercent ?? 2,
    wholesaleFee: buybox.wholesaleFee ?? 10000,
  }) : []
  step('valuation', valuation ? 'completed' : 'skipped',
    valuation
      ? avmAnchor != null
        ? `AVM-anchored ${formatUsd(valuation.arv)} · rehab ${formatUsd(valuation.totalRehabCost)} (no ARV evidence)`
        : assessedAnchor != null
          ? `Assessment-anchored ${formatUsd(valuation.arv)} · rehab ${formatUsd(valuation.totalRehabCost)} (no ARV evidence)`
          : `ARV ${formatUsd(valuation.arv)} · rehab ${formatUsd(valuation.totalRehabCost)}`
      : 'Skipped — insufficient comps for an ARV')

  // ── 7. Group B as-is market intelligence — evidence-driven ────────────────
  // The as-is set is evidence, not a price ceiling: distressed-transaction
  // comps qualify; verified flip acquisitions fold in via summarizeGroupB.
  // Runs whether or not an ARV exists — the investor floor is meaningful
  // on its own.
  const asIsThresholdPercent = params.asIsThresholdPercent ?? 70
  const groupACompIds = new Set(appraisalResult.selectedCompIds ?? [])
  // Investor-priced evidence only — a distressed deed at a market-level
  // price (estate sale priced at retail) is not an investor purchase; the
  // floor is built from distressed sales at or below the subject's AVM.
  let groupBResult = summarizeGroupB(
    appraisalResult.comparables.filter(
      (c) => (c.distressedSale === true || c.transaction?.isForeclosure === true)
        && c.salePrice != null && c.salePrice > 0
        && (subjectAvm == null || c.salePrice <= subjectAvm),
    ),
    bundle.property,
    finalArv ?? 0,
    asIsThresholdPercent,
    finalArv != null ? Math.round((finalArv * asIsThresholdPercent) / 100) : 0,
    appraisalResult.comparables,
  )
  if (groupBResult && groupBResult.count + groupBResult.flipSaleCount > 0) {
    console.log(`[Evaluate] Group B: ${groupBResult.count} distressed + ${groupBResult.flipSaleCount} flip acquisitions`)
  }

  // ── 8. Best match + applied settings snapshot ───────────────────────────────
  const bestMatch = selectBestMatch(
    bundle.property,
    appraisalResult.comparables.filter((c) => groupACompIds.has(c.id)),
  )

  // ── 8b. Clef comp curb-appeal (flag-gated, input-side evidence) ─────────────
  // For every comp the provider returned, fetch the listing (Zillow→Redfin→
  // Realtor: photos + description persist post-sale) and classify condition
  // with Clef. Shadow evidence only — stamped on comp.curbAppeal for the
  // report/UI, never fed to classifyCompsByEvidence or the appraisal math
  // until live-verified.
  // Clef resolve — fire-and-forget: stamps land in compCurbAppeal whenever
  // the batch settles. If it lands before the response serializes the
  // stamps ride the response; if it lands late, onCurbAppeal lets the
  // caller patch the persisted result (cards populate on next fetch).
  let compCurbAppeal: CompCurbAppealMap | undefined
  const compListingPhysicalDetails: Record<string, PhysicalCharacteristicSourceData> = {}
  // Permit types that validate added living area — county-dependent free
  // text; a match means the marketed sqft is a permitted product.
  const PERMIT_AREA_RE =
    /addition|expand|extend|enlarg|basement|interior finish|finish(?:ed)? (?:basement|area|attic)|room add|second stor|2nd stor|conversion|garage conv|livable area|living area/i
  // Clef resolve — the derived promise carries stamps + permit resolution;
  // the await below targets IT (not the raw fetch) so B sees every stamp.
  let clefResolvePromise: Promise<void> | null = null
  if (clefCompPromise) {
    clefResolvePromise = clefCompPromise.then(async (settled) => {
      const map: CompCurbAppealMap = {}
      for (const ev of settled) {
        const details = ev?.listing?.details
        if (details) {
          compListingPhysicalDetails[ev.propertyId] = {
            style: details.style,
            stories: details.stories,
            constructionType: details.construction,
            exterior: details.construction,
            roof: details.roof,
            foundation: details.foundationType,
            garage: details.parking,
            pool: details.pool,
          }
        }
        if (!ev?.condition || !ev.listing) continue
        const c = ev.condition
        let condition =
          c.asIs || c.conditionLabel === 'Poor'
            ? 'distressed' as const
            : c.renovated || c.conditionLabel === 'Renovated' || c.conditionLabel === 'Updated'
              ? 'renovated' as const
              : 'dated' as const
        // Owner rule: investor-marketed listings are median/lower-tier sales —
        // the curb-appeal stamp can never claim 'renovated' for ARV candidacy
        // on an investor-tier comp no matter how updated it looks.
        if (ev.investorSignal && condition === 'renovated') condition = 'dated'
        map[ev.propertyId] = {
          condition,
          source: 'vision',
          confidence: c.confidence != null ? Math.round(c.confidence * 100) : Math.round(Math.max(c.renovatedProbability, c.asIsProbability, 0.5) * 100),
          summary: `${c.conditionLabel} (${c.conditionScore.toFixed(1)}/4) · tier:${c.tier} · renovated ${(c.renovatedProbability * 100).toFixed(0)}% · as-is ${(c.asIsProbability * 100).toFixed(0)}% · investor ${(c.investorLanguageProbability * 100).toFixed(0)}% · via ${ev.listing.source}${c.model === 'openai/gpt-6-luna' ? ' · luna' : ''}${ev.listing.description ? ' · listing text available' : ''}`,
          photosExamined: ev.listing.photoCount,
        }
        // Sqft cross-check — Zillow counts finished basement/upper floors
        // tax records miss. A >33% divergence means the comp's size math
        // is unreliable: record the conflict; B treats it as unanchorable
        // (bound-only) rather than trusting either figure.
        const lsSf = ev.listing.details?.marketedSqft ?? ev.listing.details?.squareFeet
        const compFor = appraisalResult.comparables.find((cc) => cc.id === ev.propertyId)
        if (lsSf != null && compFor?.squareFeet != null) {
          const ratio = lsSf / compFor.squareFeet
          // >3× is a different field (lot sqft leaks into the extraction),
          // not a living-area conflict — real basement/floor divergences
          // run 1.4–3×.
          if (lsSf >= 400 && ((ratio > 1.33 && ratio <= 3) || (ratio < 0.75 && ratio >= 0.33))) {
            compFor.raw = {
              ...(compFor.raw as Record<string, unknown> ?? {}),
              providerSqft: compFor.squareFeet,
              listingSqft: lsSf,
              sqftConflict: `provider ${compFor.squareFeet}sf vs listing ${lsSf}sf`,
            }
          }
        }
      }

      // Permit-verify sqft conflicts — tax record is authoritative unless a
      // permitted addition/finish validates the marketed figure.
      //   permitted   → marketed sqft is the real product → adopt it
      //   unpermitted → tax sqft stands → comp competes on provider size
      //   no coverage → conflict stays → bound-only
      if (params.getCompPermits) {
        const conflicted = appraisalResult.comparables.filter(
          (cc) => (cc.raw as Record<string, unknown> | undefined)?.sqftConflict && cc.id)
        await Promise.all(conflicted.slice(0, 8).map(async (cc) => {
          const raw = cc.raw as Record<string, unknown>
          const permits = await params.getCompPermits!(cc.id!).catch(() => null)
          if (!permits?.length) { raw.sqftResolution = 'unknown'; return }
          const addition = permits.find((p) =>
            PERMIT_AREA_RE.test(`${p.projectType ?? ''} ${p.description ?? ''}`))
          if (addition) {
            raw.sqftResolution = 'permitted'
            raw.permitNote = `marketed ${raw.listingSqft}sf validated by permit ${addition.permitNumber ?? 'record'}`
            cc.squareFeet = raw.listingSqft as number
            cc.pricePerSqft = cc.salePrice != null && cc.squareFeet ? cc.salePrice / cc.squareFeet : cc.pricePerSqft
            delete raw.sqftConflict
          } else {
            // Unpermitted add — an appraiser throws this comp OUT of ARV:
            // buyers priced the marketed product, so neither the tax sqft
            // nor the listing sqft normalizes the sale. The denominator is
            // unverifiable — excluded from ARV evidence entirely.
            raw.sqftResolution = 'unpermitted'
            raw.sqftExcluded = true
            raw.permitNote = `marketed ${raw.listingSqft}sf vs tax ${cc.squareFeet}sf, no addition permit — denominator unverifiable, excluded from ARV`
            delete raw.sqftConflict
          }
        }))
      }

      step(
        'comp_curb_appeal',
        Object.keys(map).length > 0 ? 'completed' : 'skipped',
        settled.length === 0
          ? 'Clef enabled but no comps to classify'
          : `${Object.keys(map).length}/${settled.length} comps condition-classified via Clef`,
      )
      compCurbAppeal = map
      if (Object.keys(map).length > 0) params.onCurbAppeal?.(map)
    }).catch(() => undefined)
  }

  // Redfin MLS details — awaited here; the fetches started at evidence
  // selection and ran parallel to vision/valuation.
  let subjectListingDetails: RedfinDetailsResult | null = null
  if (redfinSubjectPromise || redfinCompPromise) {
    const [subjectRes, compRes] = await Promise.all([
      redfinSubjectPromise ?? Promise.resolve(null),
      redfinCompPromise ?? Promise.resolve([]),
    ])
    subjectListingDetails = subjectRes
    let stamped = 0
    if (compRes.length > 0) {
      const detailsById = new Map(compRes.map((x) => [x.id, x.r.details]))
      for (const comp of appraisalResult.comparables) {
        const d = detailsById.get(comp.id)
        if (d) {
          comp.listingDetails = d
          if (legacyRedfinCompIds.has(comp.id)) {
            // Keep every appraisal-input supplement on the exact pre-existing
            // top-15 cohort; widened geo coverage is construction-only.
            comp.bedrooms ??= d.beds ?? null
            comp.bathrooms ??= (d.bathsFull != null ? d.bathsFull + (d.bathsHalf ?? 0) * 0.5 : null)
            if (d.squareFeet != null && comp.squareFeet != null) {
              const ratio = d.squareFeet / comp.squareFeet
              if (ratio > 1.33 || ratio < 0.75) {
                comp.raw = {
                  ...(comp.raw as Record<string, unknown> ?? {}),
                  providerSqft: comp.squareFeet,
                  listingSqft: d.squareFeet,
                  sqftConflict: `provider ${comp.squareFeet}sf vs listing ${d.squareFeet}sf — listing used`,
                }
                comp.squareFeet = d.squareFeet
                comp.pricePerSqft = comp.salePrice != null ? comp.salePrice / d.squareFeet : comp.pricePerSqft
              }
            }
          }
          stamped++
        }
      }
    }
    // Same supplement on the subject — the provider misses beds entirely
    // for some parcels; the listing carries them.
    if (subjectRes?.details) {
      bundle.property.bedrooms ??= subjectRes.details.beds ?? null
      bundle.property.bathrooms ??= subjectRes.details.bathsFull != null
        ? subjectRes.details.bathsFull + (subjectRes.details.bathsHalf ?? 0) * 0.5
        : null
    }
    step(
      'listing_details',
      (subjectRes?.details || stamped > 0) ? 'completed' : 'skipped',
      `Redfin details — subject ${subjectRes?.details ? 'yes' : subjectRes?.skippedReason ?? 'no'} · ${stamped}/${redfinTargetsById.size} comp(s) enriched · ${geoMatchedRedfinTargets.length} geo-matched target(s) · ${extraRedfinTargetCount} extra request(s)`,
    )
  }

  // ── ARV evidence verification — shadow stamps on every comp ─────────────
  // Price cross-check (sale vs own AVM) + staleness (sale $/sf vs current
  // pocket median). Flags evidence quality; never gates comp selection.
  {
    // Pool-derived pocket reference: median $/sf of same-tract comps IS the
    // current pocket pricing — used when provider scope medians are absent.
    const tractPpsfs = appraisalResult.comparables
      .filter((c) => c.censusTract != null && c.censusTract === bundle.property.censusTract)
      .map((c) => c.pricePerSqft ?? (c.salePrice != null && c.squareFeet ? c.salePrice / c.squareFeet : null))
      .filter((v): v is number => v != null && v > 0)
      .sort((a, b) => a - b)
    const poolRefPpsf = tractPpsfs.length >= 3 ? tractPpsfs[Math.floor(tractPpsfs.length / 2)] : null
    let verified = 0, stale = 0, divergent = 0
    for (const comp of appraisalResult.comparables) {
      comp.evidenceVerification = verifyCompEvidence(bundle.property, comp, poolRefPpsf)
      if (comp.evidenceVerification.priceCheck === 'corroborated') verified++
      if (comp.evidenceVerification.staleness === 'stale') stale++
      if (comp.evidenceVerification.priceCheck === 'divergent') divergent++
    }
    step(
      'evidence_verification',
      verified + stale + divergent > 0 ? 'completed' : 'skipped',
      `${verified} price-corroborated · ${stale} stale-evidence · ${divergent} price-divergent`,
    )
  }

  // ── Set-B ARV — the calibrated trade-tricks methodology IS the ARV ──────
  // Runs after the evidence lands: Clef curb-appeal stamps (driver tiering)
  // + evidenceVerification (stale/divergent exclusion). When B produces an
  // ARV it replaces the legacy appraisal blend; valuation/groupB recompute
  // on the B anchor so every downstream dollar is priced off verified
  // evidence, not the blend.
  // Await the DERIVED promise — stamps + permit resolution must land
  // before B evaluates.
  if (clefResolvePromise) await clefResolvePromise
  // Re-classify with the vision reads now landed — the renovated-band
  // corroboration check only works once Clef/Luna stamps exist.
  if (compCurbAppeal && Object.keys(compCurbAppeal).length > 0) {
    compClassifications = classifyCompsByEvidence(appraisalResult.comparables, subjectAvm, compCurbAppeal)
    classificationSummary = summarizeClassifications(
      appraisalResult.comparables,
      compClassifications,
      subjectAvm
    )
  }
  let pipelineBResult: ReturnType<typeof evaluateB> | null = null
  let bAttemptTrail: string[] = []
  {
    // Verify-and-retry — the harness ladder in-pipeline. Verification tests
    // answer-level invariants (evidence coherence, never outcome appeal);
    // retries add NEW evidence rather than re-rolling: A2 widens retrieval,
    // A3 deepens enrichment for comps lacking AVM/land. Bounded at 3
    // attempts — a persistently failing pool ships its honest fallback
    // tier, never a forced number.
    const bSubjectFields = {
      squareFeet: bundle.property.squareFeet ?? null,
      yearBuilt: bundle.property.yearBuilt ?? null,
      censusTract: bundle.property.censusTract ?? null,
      subdivision: bundle.property.subdivision ?? null,
      landAssessedValue: bundle.property.landAssessedValue ?? null,
      taxAssessment: bundle.property.assessedValue ?? null,
      assessedValue: bundle.property.assessedValue ?? null,
      avmValue: subjectAvm ?? null,
      lotSizeAcres: bundle.property.lotSizeAcres ?? null,
      lotSizeSquareFeet: bundle.property.lotSizeSquareFeet ?? null,
      condition: valuation?.rehabLevel ?? null,
    }
    const toBComps = (): BComp[] => appraisalResult.comparables.map((comp) => ({
      address: comp.address ?? null,
      isEnabled: comp.isEnabled,
      salePrice: comp.salePrice ?? null,
      saleDate: comp.saleDate ?? null,
      squareFeet: comp.squareFeet ?? null,
      pricePerSqft: comp.pricePerSqft ?? null,
      adjustedPrice: comp.adjustedSalePrice ?? null,
      distanceMiles: comp.distanceMiles ?? null,
      sameBlockGroup: comp.sameBlockGroup ?? null,
      censusTract: comp.censusTract ?? null,
      subdivision: comp.subdivision ?? null,
      yearBuilt: comp.yearBuilt ?? null,
      lotSizeAcres: comp.lotSizeAcres ?? null,
      lotSizeSquareFeet: comp.lotSizeSquareFeet ?? null,
      landAssessedValue: comp.landAssessedValue ?? null,
      propertyType: comp.propertyType ?? null,
      crossesMajorRoad: comp.crossesMajorRoad ?? null,
      disableReasons: comp.evaluation?.disableReasons ?? null,
      classification: compClassifications.get(comp.id)
        ? { type: compClassifications.get(comp.id)!.classification }
        : null,
      curbAppeal: compCurbAppeal?.[comp.id] ?? null,
      evidenceVerification: comp.evidenceVerification ?? null,
      appraisalRules: comp.evaluation ? { totalAdjustment: comp.evaluation.totalAdjustment } : null,
    }))

    const verifyB = (r: ReturnType<typeof evaluateB>): string[] => {
      const fails: string[] = []
      if (r.arv == null) fails.push('no ARV — evidence pool produced no defensible answer')
      else if (subjectAvm != null && r.arv < subjectAvm) fails.push('below as-is AVM')
      if (r.drivers.length === 0) fails.push('no verified drivers')
      if (r.conf === 'none') fails.push('no-confidence result')
      return fails
    }
    const stampVerification = () => {
      const tractPpsfs = appraisalResult.comparables
        .filter((c) => c.censusTract != null && c.censusTract === bundle.property.censusTract)
        .map((c) => c.pricePerSqft ?? (c.salePrice != null && c.squareFeet ? c.salePrice / c.squareFeet : null))
        .filter((v): v is number => v != null && v > 0)
        .sort((a, b) => a - b)
      const ref = tractPpsfs.length >= 3 ? tractPpsfs[Math.floor(tractPpsfs.length / 2)] : null
      for (const comp of appraisalResult.comparables) {
        comp.evidenceVerification = verifyCompEvidence(bundle.property, comp, ref)
      }
    }

    bAttemptTrail = []
    let bResult = evaluateB(bSubjectFields, toBComps(), { rehabCost: valuation?.totalRehabCost ?? null })
    let fails = verifyB(bResult)

    // Attempt 2 — widen retrieval: fresh comps at a wider radius / longer
    // window merge in, get verification-stamped, then B re-evaluates.
    if (fails.length && params.expandComparablesPool) {
      const baseRadius = bundle.metadata?.comparablesParams?.radiusMiles ?? 1
      const widened = await params.expandComparablesPool(baseRadius + 1, (bundle.metadata?.comparablesParams?.monthsBack ?? 12) + 6)
        .catch(() => null)
      const existing = new Set(appraisalResult.comparables.map((c) => c.id))
      const added = (widened ?? []).filter((c) => !existing.has(c.id))
      if (added.length > 0) {
        // Widened comps arrive un-appraised — stamp a pass-through
        // evaluation so they join the pool as enabled evidence.
        for (const c of added) {
          appraisalResult.comparables.push({
            ...c,
            isEnabled: true,
            adjustedSalePrice: c.salePrice ?? null,
            evaluation: {
              comparableId: c.id,
              shouldDisable: false,
              filterResults: [],
              disableReasons: [],
              totalAdjustment: 0,
              adjustmentResults: [],
              originalPrice: c.salePrice ?? null,
              adjustedPrice: c.salePrice ?? null,
            },
          })
        }
        stampVerification()
        // Classify the widened set too — sale-type evidence (flip resale /
        // distressed) must stamp before B re-reads tiers, otherwise an
        // unclassified flip buy could read as upper-band evidence.
        for (const [id, cls] of classifyCompsByEvidence(added, subjectAvm, compCurbAppeal)) {
          compClassifications.set(id, cls)
        }
        bResult = evaluateB(bSubjectFields, toBComps(), { rehabCost: valuation?.totalRehabCost ?? null })
        fails = verifyB(bResult)
      }
      bAttemptTrail.push(`attempt 2 widen: +${added.length} comp(s) — ${fails.length ? fails.join('; ') : 'verified'}`)
    }

    // Attempt 3 — deepen enrichment: fetch AVM/land evidence for pool
    // members lacking it (the valuation + tax-history datasets), restamp,
    // re-evaluate.
    if (fails.length && params.enrichComparables) {
      const thin = appraisalResult.comparables
        .filter((c) => c.avmValue == null || c.landAssessedValue == null)
        .sort((a, b) => (a.distanceMiles ?? 99) - (b.distanceMiles ?? 99))
        .slice(0, 8)
      const enriched = await params.enrichComparables(thin).catch(() => null)
      const byId = new Map((enriched ?? []).map((c) => [c.id, c]))
      let deepened = 0
      for (const comp of appraisalResult.comparables) {
        const e = byId.get(comp.id)
        if (!e) continue
        if (comp.avmValue == null && e.avmValue != null) { comp.avmValue = e.avmValue; deepened++ }
        if (comp.landAssessedValue == null && e.landAssessedValue != null) { comp.landAssessedValue = e.landAssessedValue; deepened++ }
      }
      if (deepened > 0) {
        stampVerification()
        bResult = evaluateB(bSubjectFields, toBComps(), { rehabCost: valuation?.totalRehabCost ?? null })
        fails = verifyB(bResult)
      }
      bAttemptTrail.push(`attempt 3 deepen: +${deepened} field(s) — ${fails.length ? fails.join('; ') : 'verified'}`)
    }

    if (bAttemptTrail.length === 0 && fails.length === 0) bAttemptTrail.push('attempt 1 — verified')
    else if (fails.length) bAttemptTrail.push(`final — unverified (${fails.join('; ')})`)
    pipelineBResult = bResult
    if (!insufficient && bResult.arv != null && bResult.arv !== finalArv) {
      const prevArv = finalArv
      finalArv = bResult.arv
      valuationAnchor = finalArv
      valuation = valuationService.calculateValuation({
        arv: valuationAnchor,
        subjectSqft,
        compAvgSqft,
        rehabLevelIndex: derivedBuybox.rehabLevelIndex,
        skipBaseRehab: derivedBuybox.renovatedVerified === true,
        locationPenaltyAmount: computeLocationPenalty(bundle.enrichment.locationRisks, valuationAnchor, params.proximityConfig),
        majorItems: derivedBuybox.majorItems,
        additionPlay: derivedBuybox.additionPlay ?? buybox.additionPlay ?? 0,
        closingCostsPercent: buybox.closingCostsPercent ?? 8,
        carryingCostsPercent: buybox.carryingCostsPercent ?? 2,
        wholesaleFee: buybox.wholesaleFee ?? 10000,
        desiredProfit: buybox.desiredProfit,
      })
      rehabLevelEstimates = calculateAllRehabLevelEstimates(valuationService, {
        arv: valuationAnchor,
        subjectSqft,
        compAvgSqft,
        selectedRehabLevelIndex: derivedBuybox.rehabLevelIndex,
        majorItems: derivedBuybox.majorItems,
        additionPlay: buybox.additionPlay ?? 0,
        closingCostsPercent: buybox.closingCostsPercent ?? 8,
        carryingCostsPercent: buybox.carryingCostsPercent ?? 2,
        wholesaleFee: buybox.wholesaleFee ?? 10000,
      })
      groupBResult = summarizeGroupB(
        appraisalResult.comparables.filter(
          (c) => (c.distressedSale === true || c.transaction?.isForeclosure === true)
            && c.salePrice != null && c.salePrice > 0
            && (subjectAvm == null || c.salePrice <= subjectAvm),
        ),
        bundle.property,
        finalArv,
        asIsThresholdPercent,
        Math.round((finalArv * asIsThresholdPercent) / 100),
        appraisalResult.comparables,
      )
      step(
        'set_b_arv',
        'completed',
        `Set-B ARV ${formatUsd(bResult.arv)} (${bResult.source}${bResult.healed ? ', self-healed' : ''})` +
          (prevArv != null && prevArv !== bResult.arv ? ` — replaces pre-B anchor ${formatUsd(prevArv)}` : ''),
      )
    } else if (bResult.arv == null && !insufficient) {
      step('set_b_arv', 'skipped', 'Set-B produced no ARV — no anchor produced')
    }
  }

  // A Set-B widen can append comps after the overlapping Redfin batch began.
  // Catch up construction evidence only; no appraisal-input fields are changed.
  if (redfinDetailsEnabled) {
    const lateGeoTargets = appraisalResult.comparables.filter(
      (comp) => geoPriority(comp) != null && !redfinTargetsById.has(comp.id),
    )
    if (lateGeoTargets.length > 0) {
      const lateResults = await Promise.all(lateGeoTargets.map((comp) =>
        fetchRedfinPropertyDetails(env, comp, env.API_CACHE)
          .then((r): { id: string; r: RedfinDetailsResult } => ({ id: comp.id, r }))
          .catch(() => ({ id: comp.id, r: { details: null, skippedReason: 'fetch_failed' } as RedfinDetailsResult })),
      ))
      const lateById = new Map(lateResults.map(({ id, r }) => [id, r.details]))
      let lateStamped = 0
      for (const comp of appraisalResult.comparables) {
        const details = lateById.get(comp.id)
        if (!details) continue
        comp.listingDetails = details
        lateStamped++
      }
      console.log(`[Evaluate] Redfin geo catch-up: ${lateStamped}/${lateGeoTargets.length} widened comp(s) enriched`)
    }
  }

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
    arvThresholdPercent: (params.arvThreshold ?? { percent: 15 }).percent,
    asIsThresholdPercent,
  }

  // ── 9. Build response ───────────────────────────────────────────────────────
  const photoBundle = await photoBundlePromise
  const response = buildAnalysisResponse(
    bundle,
    appraisalResult,
    photoBundle,
    valuation,
    {
      arvSource: finalArv != null ? 'appraisal' : avmAnchor != null ? 'avm' : assessedAnchor != null ? 'assessed' : 'appraisal',
      finalArv,
      pipelineBResult,
      bAttemptTrail,
      valuationAnchor,
      analysisId: jobId,
      // Subject condition tier — vision-derived (subject only; comps are
      // evidence-classified, never condition-guessed).
      subjectClassification: renovation.renovationLevelIndex != null ? {
        classification:
          renovation.renovationLevelIndex <= 1 ? 'after_renovation' as const
          : renovation.renovationLevelIndex === 2 ? 'transitional' as const
          : 'as_is' as const,
        confidence: renovation.confidence ?? 60,
        method: 'batch_photo_analysis' as const,
        reasoning: `Vision renovation assessment: ${renovation.renovationLevel}`,
        indicators: {},
      } : undefined,
      compClassifications,
      classificationSummary,
      subjectSupplementedFields: [],
      compSupplementedFields: new Map(),
      rehabLevelEstimates,
      appliedSettings,
      visionAnalysis: mapRenovationToVision(renovation),
      subjectCurbAppeal,
      subjectListingUrl: photoBundle?.subject?.sourceUrl ?? null,
      subjectListingDetails: subjectListingDetails?.details ?? null,
      compListingPhysicalDetails,
      subjectListPrice: typeof photoBundle?.subject?.metadata?.listPrice === 'number'
        ? photoBundle.subject.metadata.listPrice
        : null,
      apiCallStats: params.apiCallStats,
      bestMatch,
      groupBResult,
      groupACompIds,
      groupBCompIds: new Set(groupBResult?.compIds ?? []),
      compCurbAppeal,
    }
  )

  // ── 10. Justified evaluation report (additive) ──────────────────────────────
  step('response_build', 'completed', 'Response assembled')
  response.report = buildEvaluationReport({
    bundle,
    appraisalResult,
    subjectClassification: renovation.renovationLevelIndex != null ? {
      classification:
        renovation.renovationLevelIndex <= 1 ? 'after_renovation' as const
        : renovation.renovationLevelIndex === 2 ? 'transitional' as const
        : 'as_is' as const,
      confidence: renovation.confidence ?? 60,
      method: 'batch_photo_analysis' as const,
      reasoning: `Vision renovation assessment: ${renovation.renovationLevel}`,
      indicators: {},
    } : undefined,
    weightedARVResult: undefined,
    derivedBuybox,
    valuation,
    steps,
    fallbacksUsed,
    renovationAssessment: renovation,
  })
  // Confidence gate on the comps that drive the ARV — surfaces onto the
  // valuation block. There is no human reviewer, so the formula call
  // always stands; confidence + reasons carry the reliability signal.
  if (response.valuation && valuation) {
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
  }
  response.visionAssessment = renovation
  response.renovationLevelSource = derivedBuybox.rehabLevelSource
  if (sellerNotes.length > 0) {
    response.sellerNotes = { fetchedAt: new Date().toISOString(), notes: sellerNotes }
    if (rehabAdditions.length > 0) response.rehabAdditions = rehabAdditions
    if (rehabAdvisories.length > 0) response.rehabAdvisories = rehabAdvisories
  }
  response.evaluationEngine = 'ts-v5'
  if (photoBundle) response.photoProvider = photoBundle.provider

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
