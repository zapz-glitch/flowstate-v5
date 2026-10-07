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
import { bulkSaleIds, packageDeedIds, verifyCompEvidence } from '../appraisal/verification'
import { checksForFlags, type RuleCheck } from '../analysis/rule-registry'
import { arvEvidence, classifyCompsByEvidence, pocketPriceGroups } from './comp-classification'

/** Why a sale is switched off as transaction noise */
const TRANSACTION_NOISE_REASON: Record<string, string> = {
  extreme_outlier: 'Extreme price outlier — not market evidence',
  package_deed: 'Package deed — several parcels on one same-day, same-price deed',
  bulk_sale: 'Bulk sale — same-day sales sharing a buyer or seller',
  nominal_sale: 'Nominal sale — not an arm\'s-length price',
}
export { arvEvidence, classifyCompsByEvidence, pocketPriceGroups }
import { evaluateB, subdivisionsMatch, type BComp, type BSubject } from '@flowstate-api/shared/appraisal'
import { createValuationService, MAJOR_ITEMS, type MajorItem, type ValuationResult } from '../valuation'
import type { ClassificationResult } from '../classification'
import type { RehabTable, TierRangeDefinition } from '@flowstate-api/shared/valuation'
import {
  buildAnalysisResponse,
  calculateAllRehabLevelEstimates,
  type AnalysisResponse,
  type ApiCallStats,
  type ResponseContext,
  type RehabLevelEstimate,
} from '../analysis'
import { createPhotoService, type PhotoBundle, type PropertyIdentifier, type PropertyPhotos } from '../photo-provider'
import { gatherCompConditionEvidence, startCompEvidenceBatch, classifyCompBatchDecisions, type CompConditionEvidence } from '../comp-evidence'
import type { CompDigestStages } from '../comp-evidence/digest'
import { isClefAvailable } from '../clef'
import { fetchRedfinPropertyDetails, type RedfinDetailsResult } from '../redfin-details'
import { gradeVerdict } from './verdict-grade'
import { buildRenovationEvidence, priceAgentRenovation } from './renovation'
import { computeEvidenceBands, computeGeoTieredBands, bandForComp, type EvidenceBands, type GeoTieredBands, type BandName } from '@flowstate-api/shared/appraisal'
import { adjudicateBandMembership, type BandAdjudicationResult } from './band-adjudicate'
import type { PhysicalCharacteristicSourceData } from '../physical-characteristics'

import { persistReportAssets } from '../report-assets'
import { expansionRefetchRadius } from '../property-api/retrieval-policy'
import { assessRenovationFromPhotos, unavailableAssessment, type RenovationAssessment, type CurbAppealCheck } from '../vision/renovation'
import { PROXIMITY_DEFAULTS } from '../../routes/proximity-config'
import { isReasoningProviderAvailable } from '../llm'
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
  condition: 'renovated' | 'maintained' | 'dated' | 'distressed' | 'unknown'
  source: 'vision'
  confidence: number | null
  summary: string | null
  photosExamined: number
  /** Agent-assist digest — Clef's advisory price-sanity + anchor-quality
   *  reads for the Evaluation Agent. Advisory only, never a verdict. */
  hint?: { priceSanity: string | null; anchorQuality: string | null }
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
   * Comp-evidence batch started by the caller the moment comps landed —
   * evidence lanes run beside geo/enrich instead of waiting for the sorted
   * pool. Comps absent from the map (pool-expansion refetches) get a top-up
   * batch inside evaluate.
   */
  prefetchedCompEvidence?: Promise<Map<string, CompConditionEvidence | null> | null> | null
  /**
   * Clef agent-assist digests — stage A (comps-landed), B (post-geocode),
   * C (post-enrichment) advisory reads per comp. Serialized as
   * comp.clefDigest.{A,B,C} into the harness evidence bundle; the agent
   * weighs them beside the raw data — advisory only, never a verdict.
   */
  compDigests?: Promise<Map<string, CompDigestStages> | null> | null
  /**
   * Close CRM lead this eval belongs to — when present, realtor
   * conversation-log notes are fetched and folded into the rehab model
   * (additive items apply; removals become advisories only).
   */
  leadId?: string
  /** Explicit rerun — bypass photo/listing caches so the subject
   *  condition read and list price come back fresh. */
  skipCache?: boolean
  /** Ruleset-governed run (harness: 'agent' on POST /v1/analyze). The
   *  caller's appraisal overrides are verbatim — no DEFAULT_FILTERS /
   *  DEFAULT_ADJUSTMENTS injection — so enablement reflects only the hard
   *  data gates; the agent weighs the doctrine's geo/age/size preferences. */
  harness?: 'agent'
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

export interface EvaluationAttemptRecord {
  name: string
  subject: BSubject
  comps: BComp[]
  options: { rehabCost?: number | null }
  result: ReturnType<typeof evaluateB>
  checks: RuleCheck[]
  verificationFailures: string[]
  detail?: Record<string, unknown>
}

export interface EvaluationRunEvidence {
  /** The provider/evidence set handed to the appraisal pipeline. */
  compPool: NormalizedComparable[]
  subject: NormalizedProperty
  /** Effective appraisal grid + valuation inputs used for this run. */
  appliedSettings: unknown
  filters: AppraisalFilter[]
  adjustments: AppraisalAdjustment[]
  fallbackUsed: string | null
  expansionApplied: string[]
  compClassifications: Record<string, ClassificationResult>
  compCurbAppeal: CompCurbAppealMap | null
  bAttemptTrail: string[]
  attempts: EvaluationAttemptRecord[]
  /** Present when the agent drove comp selection — the posted verdict. */
  agentSelection?: AgentSelection
  /** Renovation engine record — the agent's posted scope and the
   *  deterministic pricing of it (audit trail + flags). */
  renovation?: { posted: import('./renovation').AgentRenovation; priced: import('./renovation').PricedRenovation }
  /** Decision-level grade of whoever posted the selection (agent or the
   *  deterministic fallback) — docs/BANDING-VERIFICATION-SPEC.md §4. */
  verdictGrade?: import('./verdict-grade').VerdictGrade
}

export interface EvaluationResult {
  response: AnalysisResponse
  appraisalResult: AppraisalResultWithFallback
  compClassifications: Map<string, ClassificationResult>
  /** Group B as-is market intelligence (display only) */
  groupB: GroupBResult | null
  /** Frozen inputs/outputs for every harness attempt in this run. */
  runEvidence: EvaluationRunEvidence
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
export async function performAnalysisPhase1(
  params: EvaluationParams,
  env: Env,
  onProgress?: (message: string, data?: Record<string, unknown>) => void
): Promise<Phase1Context> {
  const { jobId } = params
  let { bundle } = params
  const appraisalService = createAppraisalService()
  const rules = params.appraisalRules ?? {}
  let filters: AppraisalFilter[]
  let adjustments: AppraisalAdjustment[]

  if (params.harness === 'agent') {
    // Ruleset-governed run — the caller's overrides are the whole grid.
    // No default injection: an empty override means "no filters", so comps
    // stay enabled unless a hard data gate fails. The agent weighs geo /
    // age / size preferences itself under EVAL-AGENT-RULESET.md.
    filters = [...(rules.filters ?? [])]
    adjustments = [...(rules.adjustments ?? [])]
  } else {
    filters = [...(rules.filters ?? DEFAULT_FILTERS)]
    adjustments = rules.adjustments ?? DEFAULT_ADJUSTMENTS
    // Filters the preset doesn't define at all are injected with system defaults
    // so the audit trail always covers every rule. Filters the preset DOES define
    // keep the user's own enabled + required(preferred) choices — the preset is
    // authoritative for those.
    for (const defaultFilter of DEFAULT_FILTERS) {
      if (!filters.some((f) => f.type === defaultFilter.type)) {
        filters.push({ ...defaultFilter })
      }
    }
  }
  const preferredSaleAgeDays = filters.find((f) => f.type === 'sale_age')?.value ?? 180

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
  // Same-tract pool rate — the sanity check that keeps a stale subject AVM
  // from promoting below-pocket sales into ARV support.
  const initialTractPpsfs = appraisalResult.comparables
    .filter((c) => c.censusTract != null && c.censusTract === bundle.property.censusTract)
    .map((c) => c.pricePerSqft ?? (c.salePrice != null && c.squareFeet ? c.salePrice / c.squareFeet : null))
    .filter((v): v is number => v != null && v > 0)
    .sort((a, b) => a - b)
  const initialPoolRefPpsf = initialTractPpsfs.length >= 3
    ? initialTractPpsfs[Math.floor(initialTractPpsfs.length / 2)]
    : null
  // Price classes come from the pocket's own sales (docs/FILTER-LADDER.md)
  const initialPocket = pocketPriceGroups(appraisalResult.comparables, bundle.property)
  const arvComps = appraisalResult.comparables.filter(
    (c) => c.isEnabled && arvEvidence(c, initialPocket) != null,
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
  // Geo doctrine: block group > neighborhood/subdivision > tract (fallback tier).
  const geoPriority = (comp: AppraisedComparable): number | null => compGeoPriority(bundle.property, comp)
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

  const redfinDetailsEnabled = !!(env.FIRECRAWL_API_KEY && isReasoningProviderAvailable(env))
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

  // Clef comp-evidence batch. The caller normally started this the moment
  // comps landed (prefetchedCompEvidence — runs beside geo/enrich); when it
  // didn't, the batch launches here so the listing scrapes + classifications
  // still overlap vision and valuation. Awaited where the comp_curb_appeal
  // step records.
  const clefCompsSorted = appraisalResult.comparables
    .slice()
    .sort((a, b) =>
      Number(b.isEnabled && arvIds.has(b.id)) - Number(a.isEnabled && arvIds.has(a.id))
      || Number(b.isEnabled) - Number(a.isEnabled)
      || (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999))
    .slice(0, Number(env.CLEF_COMP_MAX) || Infinity)
  const clefInputs = clefCompsSorted.map((comp) => ({
    propertyId: comp.id,
    address: comp.address,
    city: comp.city,
    state: comp.state,
    zipCode: comp.zipCode,
    latitude: comp.latitude ?? null,
    longitude: comp.longitude ?? null,
    salePrice: comp.salePrice ?? undefined,
    saleDate: comp.saleDate ? String(comp.saleDate) : undefined,
    yearBuilt: comp.yearBuilt ?? undefined,
    squareFeet: comp.squareFeet ?? undefined,
    // Geo context for the batch classify — Decisions reads the pool's
    // geocode data when it bands/conditions each comp.
    sameBlockGroup: comp.sameBlockGroup ?? null,
    neighborhoodName: comp.neighborhoodName ?? null,
    subdivision: comp.subdivision ?? null,
    censusTract: comp.censusTract ?? null,
    distanceMiles: comp.distanceMiles ?? null,
  }))
  const clefCompPromise: Promise<(CompConditionEvidence | null)[]> | null =
    env.CLEF_COMP_CONDITION_ENABLED === 'true' && isClefAvailable(env)
      ? (async () => {
          const early = params.prefetchedCompEvidence ? await params.prefetchedCompEvidence.catch(() => null) : null
          const missing = early ? clefInputs.filter((c) => !early.has(c.propertyId)) : clefInputs
          const filled = missing.length
            ? await startCompEvidenceBatch(env, missing, {
                subject: { squareFeet: bundle.property.squareFeet ?? undefined, address: bundle.property.address ?? undefined },
              })
            : new Map<string, CompConditionEvidence | null>()
          // Decisions lane: the prefetch path gathers listings early but
          // defers classification until now — the batch call reads the
          // GATED pool's geo fields (BG / neighborhood / tract), which
          // didn't exist when the scrape started.
          if (env.CONDITION_READER === 'decisions' && env.OPENAI_API_KEY) {
            await classifyCompBatchDecisions(
              env,
              clefInputs
                .map((comp) => ({ evidence: early?.get(comp.propertyId) ?? filled.get(comp.propertyId), comp }))
                .filter((e): e is { evidence: CompConditionEvidence; comp: (typeof clefInputs)[number] } => e.evidence != null),
              { squareFeet: bundle.property.squareFeet ?? undefined, address: bundle.property.address ?? undefined },
            ).catch(() => null)
          }
          return clefInputs.map((c) => early?.get(c.propertyId) ?? filled.get(c.propertyId) ?? null)
        })()
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
  let compClassifications = classifyCompsByEvidence(appraisalResult.comparables, bundle.property)
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
  let subjectSqft = bundle.property.squareFeet || 0
  let compAvgSqft =
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
              : c.conditionLabel === 'Maintained'
                ? 'maintained' as const
                : 'dated' as const
        // Owner rule: investor-marketed listings are median/lower-tier sales —
        // the curb-appeal stamp can never claim 'renovated' for ARV candidacy
        // on an investor-tier comp no matter how updated it looks.
        if (ev.investorSignal && condition === 'renovated') condition = 'dated'
        map[ev.propertyId] = {
          condition,
          hint: ev.hint ? { priceSanity: ev.hint.priceSanity, anchorQuality: ev.hint.anchorQuality } : undefined,
          source: 'vision',
          confidence: c.confidence != null ? Math.round(c.confidence * 100) : Math.round(Math.max(c.renovatedProbability, c.asIsProbability, 0.5) * 100),
          summary: `${c.conditionLabel} (${c.conditionScore.toFixed(1)}/4) · tier:${c.tier} · renovated ${(c.renovatedProbability * 100).toFixed(0)}% · as-is ${(c.asIsProbability * 100).toFixed(0)}% · investor ${(c.investorLanguageProbability * 100).toFixed(0)}% · via ${ev.listing.source}${c.model && !c.model.startsWith('clef') ? ` · ${c.model}` : ''}${ev.listing.description ? ' · listing text available' : ''}`,
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
            raw.providerSqft ??= cc.squareFeet
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
    // for some parcels; the listing carries them. Sqft and year built fill
    // the same way: ATTOM stays authoritative when present, the MLS read
    // only lands where the provider has nothing (a missing subject GLA
    // breaks band scaling, so the fill matters here).
    if (subjectRes?.details) {
      bundle.property.bedrooms ??= subjectRes.details.beds ?? null
      bundle.property.bathrooms ??= subjectRes.details.bathsFull != null
        ? subjectRes.details.bathsFull + (subjectRes.details.bathsHalf ?? 0) * 0.5
        : null
      bundle.property.squareFeet ??= subjectRes.details.squareFeet ?? null
      bundle.property.yearBuilt ??= subjectRes.details.yearBuilt ?? null
      // The fill lands after the valuation capture — when the provider had
      // no area, rehab math ran on 0sf. Recompute so the report's buy/
      // wholesale numbers use the same sqft the bands now see.
      if (subjectSqft <= 0 && (bundle.property.squareFeet ?? 0) > 0) {
        subjectSqft = bundle.property.squareFeet as number
        compAvgSqft = enabledComps.length > 0
          ? enabledComps.reduce((sum, c) => sum + (c.squareFeet || 0), 0) / enabledComps.length
          : subjectSqft
        if (valuationAnchor != null) {
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
        }
      }
    }
    step(
      'listing_details',
      (subjectRes?.details || stamped > 0) ? 'completed' : 'skipped',
      `Redfin details — subject ${subjectRes?.details ? 'yes' : subjectRes?.skippedReason ?? 'no'} · ${stamped}/${redfinTargetsById.size} comp(s) enriched · ${geoMatchedRedfinTargets.length} geo-matched target(s) · ${extraRedfinTargetCount} extra request(s)`,
    )
  }

  // ── ARV evidence verification — shadow stamps on every comp ─────────────
  // Price cross-check (sale vs own AVM), sale age vs the preferred window,
  // and market fit vs current pocket $/sf. Flags evidence quality; never
  // gates comp selection.
  {
    // Pool-derived pocket reference: median $/sf of same-tract comps IS the
    // current pocket pricing — used when provider scope medians are absent.
    const tractPpsfs = appraisalResult.comparables
      .filter((c) => c.censusTract != null && c.censusTract === bundle.property.censusTract)
      .map((c) => c.pricePerSqft ?? (c.salePrice != null && c.squareFeet ? c.salePrice / c.squareFeet : null))
      .filter((v): v is number => v != null && v > 0)
      .sort((a, b) => a - b)
    const poolRefPpsf = tractPpsfs.length >= 3 ? tractPpsfs[Math.floor(tractPpsfs.length / 2)] : null
    const topBandRefPpsf = bandRefPpsf(appraisalResult.comparables, bundle.property.censusTract, compClassifications)
    const packageIds = packageDeedIds(appraisalResult.comparables)
    const bulkIds = bulkSaleIds(appraisalResult.comparables)
    let verified = 0, stale = 0, divergent = 0, noisy = 0
    for (const comp of appraisalResult.comparables) {
      comp.evidenceVerification = verifyCompEvidence(bundle.property, comp, poolRefPpsf, preferredSaleAgeDays, {
        packageDeed: packageIds.has(comp.id),
        bulkSale: bulkIds.has(comp.id),
        band: compClassifications.get(comp.id)?.classification,
        bandRefPpsf: topBandRefPpsf,
      })
      if (comp.evidenceVerification.priceCheck === 'corroborated') verified++
      if (comp.evidenceVerification.staleness === 'stale') stale++
      if (comp.evidenceVerification.priceCheck === 'divergent') divergent++
      if (comp.evidenceVerification.transactionCheck !== 'clean' && comp.evidenceVerification.transactionCheck !== 'unverified') noisy++
    }
    step(
      'evidence_verification',
      verified + stale + divergent > 0 ? 'completed' : 'skipped',
      `${verified} price-corroborated · ${stale} stale-evidence · ${divergent} price-divergent · ${noisy} transaction-noise`,
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
  // Clef digests settle inside the same window — stage A/B/C advisory
  // reads merged per comp for the harness evidence bundle.
  const compDigestMap = params.compDigests ? await params.compDigests.catch(() => null) : null
  const compDigests: Record<string, CompDigestStages> | undefined = compDigestMap ? Object.fromEntries(compDigestMap) : undefined
  // Re-classify with the vision reads now landed — the renovated-band
  // corroboration check only works once Clef/Luna stamps exist.
  if (compCurbAppeal && Object.keys(compCurbAppeal).length > 0) {
    compClassifications = classifyCompsByEvidence(appraisalResult.comparables, bundle.property, compCurbAppeal)
    classificationSummary = summarizeClassifications(
      appraisalResult.comparables,
      compClassifications,
      subjectAvm
    )
  }
  return freezePhase1Context({
    jobId, bundle, appraisalResult, subjectAvm, insufficient, preferredSaleAgeDays,
    filters, adjustments, steps, fallbacksUsed, compClassifications, classificationSummary,
    compCurbAppeal, compDigests, compListingPhysicalDetails, subjectListingDetails,
    redfinDetailsEnabled, redfinTargetsById, renovation, subjectCurbAppeal,
    sellerNotes, rehabAdditions, rehabAdvisories, derivedBuybox,
    subjectSqft, compAvgSqft, finalArv, valuation, valuationAnchor,
    avmAnchor, assessedAnchor, rehabLevelEstimates, groupBResult,
    groupACompIds, bestMatch, asIsThresholdPercent, photoBundlePromise,
    apiCallStats: params.apiCallStats,
  })
}

// ── Phase 2 — selection verdict + valuation tail ─────────────────────────────
// Re-enterable: the deterministic path runs it immediately after phase 1; an
// agent-harnessed job freezes the phase-1 context, waits for the agent's
// selection, then runs the SAME tail on a thawed context — every dollar
// downstream is identical no matter which path produced the selection.
export async function performAnalysisPhase2(
  ctx: Phase1Context,
  params: EvaluationParams,
  env: Env,
  onProgress?: (message: string, data?: Record<string, unknown>) => void,
  agentSelection?: AgentSelection,
): Promise<EvaluationResult> {
  const {
    jobId, bundle, appraisalResult, subjectAvm, insufficient, preferredSaleAgeDays,
    filters, adjustments, steps, fallbacksUsed, classificationSummary,
    compCurbAppeal, compListingPhysicalDetails, subjectListingDetails,
    redfinDetailsEnabled, renovation, subjectCurbAppeal,
    sellerNotes, rehabAdditions, rehabAdvisories, derivedBuybox,
    subjectSqft, compAvgSqft, avmAnchor, assessedAnchor, asIsThresholdPercent,
  } = ctx
  let {
    finalArv, valuation, valuationAnchor, rehabLevelEstimates, groupBResult, bestMatch,
  } = ctx
  let compClassifications = new Map(ctx.compClassifications)
  const compDigests = ctx.compDigests
  const groupACompIds = new Set(ctx.groupACompIds)
  const redfinTargetsById = new Map(
    ctx.redfinTargetIds
      .map((id) => [id, appraisalResult.comparables.find((c) => c.id === id)!] as const)
      .filter(([, comp]) => comp != null),
  )
  const appraisalService = createAppraisalService()
  const valuationService = createValuationService(params.customRehabTable, params.customTierRanges)
  const buybox = params.buybox ?? {}
  // Renovation engine — the agent's posted line-item scope is priced
  // deterministically against the same evidence it judged (fail-open:
  // omissions are appended, outlier costs clamped, all flagged). The priced
  // total replaces the flat tier × $/sf base rehab in valuation.
  const pricedReno = agentSelection?.renovation
    ? priceAgentRenovation(agentSelection.renovation, buildRenoEvidence(ctx, compClassifications))
    : null
  let prevStepAt = Date.now()
  const step = (name: string, status: ReportStep['status'], detail?: string) => {
    const now = Date.now()
    steps.push({ step: name, label: name, status, detail, durationMs: now - prevStepAt })
    prevStepAt = now
  }
  const geoPriority = (comp: AppraisedComparable): number | null => compGeoPriority(bundle.property, comp)

  // Agent-verdict application — the agent's picks replace the phase-1 evidence
  // selection before the tail reads them: selectedCompIds, arvStatus stamps,
  // group A membership, best match.
  if (agentSelection) {
    const picks = new Set(agentSelection.selectedCompIds)
    appraisalResult.selectedCompIds = [...picks]
    appraisalResult.comparables = appraisalResult.comparables.map((c) => ({
      ...c,
      arvStatus: picks.has(c.id)
        ? ('selected' as const)
        : c.arvStatus === 'selected' ? ('not_examined' as const) : c.arvStatus,
    }))
    groupACompIds.clear()
    for (const id of picks) groupACompIds.add(id)
    bestMatch = selectBestMatch(bundle.property, appraisalResult.comparables.filter((c) => groupACompIds.has(c.id)))
    onProgress?.('Agent selection applied')
  }

  let pipelineBResult: ReturnType<typeof evaluateB> | null = null
  let bAttemptTrail: string[] = []
  const bAttempts: EvaluationAttemptRecord[] = []
  {
    // Verify-and-retry — the harness ladder in-pipeline. Verification tests
    // answer-level invariants (evidence coherence, never outcome appeal);
    // retries add NEW evidence rather than re-rolling: A2 widens retrieval,
    // A3 deepens enrichment for comps lacking AVM/land. Bounded at 3
    // attempts — a persistently failing pool ships its honest fallback
    // tier, never a forced number.
    const bSubjectFields = buildBSubjectFields(bundle, valuation, subjectAvm)
    const toBComps = (): BComp[] => toBCompsOf(appraisalResult.comparables, compClassifications, compCurbAppeal, compDigests)

    const verifyB = (r: ReturnType<typeof evaluateB>): string[] => {
      const fails: string[] = []
      if (r.arv == null) fails.push('no ARV — evidence pool produced no defensible answer')
      if (r.drivers.length === 0) fails.push('no verified drivers')
      if (r.conf === 'none') fails.push('no-confidence result')
      return fails
    }
    const stampVerification = () =>
      stampPoolVerification(appraisalResult.comparables, bundle.property, preferredSaleAgeDays, compClassifications)

    bAttemptTrail = []
    const recordBAttempt = (
      name: string,
      result: ReturnType<typeof evaluateB>,
      verificationFailures: string[],
      detail?: Record<string, unknown>,
    ) => {
      bAttempts.push({
        name,
        subject: { ...bSubjectFields },
        comps: toBComps(),
        options: { rehabCost: valuation?.totalRehabCost ?? null },
        result,
        checks: checksForFlags(result.flags),
        verificationFailures: verificationFailures,
        ...(detail ? { detail } : {}),
      })
    }
    let bResult = agentSelection
      ? adaptAgentSelection(agentSelection, toBComps(), appraisalResult.comparables)
      : evaluateB(bSubjectFields, toBComps(), { rehabCost: valuation?.totalRehabCost ?? null })
    let fails = verifyB(bResult)
    recordBAttempt(agentSelection ? 'agent selection' : 'attempt 1', bResult, fails,
      agentSelection ? { source: 'agent', notes: agentSelection.notes ?? null } : undefined)

    // Attempt 2 — widen retrieval: fresh comps at a wider radius / longer
    // window merge in, get verification-stamped, then B re-evaluates.
    if (fails.length && params.expandComparablesPool) {
      const baseRadius = bundle.metadata?.comparablesParams?.radiusMiles ?? 1
      const widened = await params.expandComparablesPool(baseRadius + 1, (bundle.metadata?.comparablesParams?.monthsBack ?? 12) + 6)
        .catch(() => null)
      const existing = new Set(appraisalResult.comparables.map((c) => c.id))
      const added = (widened ?? []).filter((c) => !existing.has(c.id))
      if (added.length > 0) {
        // Widened comps go through the SAME grid as the first pass — geo
        // tiers, year bands, the size ladder, every hard rule. A comp that
        // can't verify at the current thresholds joins as disabled
        // evidence, never as a free anchor.
        const widenedResult = appraisalService.evaluate(bundle.property, added, { filters, adjustments })
        appraisalResult.comparables.push(...widenedResult.comparables)
        stampVerification()
        // Classify the widened set too — sale-type evidence (flip resale /
        // distressed) must stamp before B re-reads tiers, otherwise an
        // unclassified flip buy could read as upper-band evidence.
        // New sales change where the pocket's price groups break, so the
        // whole pool is re-read — a comp must never keep a group label it
        // earned in a smaller pool.
        for (const [id, cls] of classifyCompsByEvidence(appraisalResult.comparables, bundle.property, compCurbAppeal)) {
          compClassifications.set(id, cls)
        }
        bResult = evaluateB(bSubjectFields, toBComps(), { rehabCost: valuation?.totalRehabCost ?? null })
        fails = verifyB(bResult)
        recordBAttempt('attempt 2 widen', bResult, fails, {
          radiusMiles: baseRadius + 1,
          monthsBack: (bundle.metadata?.comparablesParams?.monthsBack ?? 12) + 6,
          addedCompIds: added.map((c) => c.id),
          addedCompCount: added.length,
        })
      }
      bAttemptTrail.push(`attempt 2 widen: +${added.length} comp(s) — ${fails.length ? fails.join('; ') : 'verified'}`)
    }

    // Attempt 3 — deepen enrichment: fetch AVM/land evidence for pool
    // members lacking it (the valuation + tax-history datasets), restamp,
    // re-evaluate.
    if (fails.length && params.enrichComparables) {
      const thin = appraisalResult.comparables
        .filter((c) => c.avmValue == null || c.landAssessedValue == null)
        .sort((a, b) =>
          Number((b.censusTract != null && b.censusTract === bundle.property.censusTract) || b.sameBlockGroup === true)
          - Number((a.censusTract != null && a.censusTract === bundle.property.censusTract) || a.sameBlockGroup === true)
          || (a.distanceMiles ?? 99) - (b.distanceMiles ?? 99))
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
        recordBAttempt('attempt 3 deepen', bResult, fails, {
          deepenedCompIds: thin.map((c) => c.id),
          deepenedFieldCount: deepened,
        })
      }
      bAttemptTrail.push(`attempt 3 deepen: +${deepened} field(s) — ${fails.length ? fails.join('; ') : 'verified'}`)
    }

    if (bAttemptTrail.length === 0 && fails.length === 0) bAttemptTrail.push('attempt 1 — verified')
    else if (fails.length) bAttemptTrail.push(`final — unverified (${fails.join('; ')})`)
    pipelineBResult = bResult
    // "insufficient" is the ladder's last word, not the grid's first.
    // When the grid enabled nothing but Set-B verified an answer on
    // rescued or geo-tiered evidence, that answer serves — labeled by
    // its source. Unverified B results still fall to the floor.
    if ((!insufficient || fails.length === 0) && bResult.arv != null && bResult.arv !== finalArv) {
      const prevArv = finalArv
      finalArv = bResult.arv
      valuationAnchor = finalArv
      valuation = valuationService.calculateValuation({
        arv: valuationAnchor,
        subjectSqft,
        compAvgSqft,
        rehabLevelIndex: derivedBuybox.rehabLevelIndex,
        skipBaseRehab: derivedBuybox.renovatedVerified === true,
        rehabBaseOverride: pricedReno?.total,
        locationPenaltyAmount: computeLocationPenalty(bundle.enrichment.locationRisks, valuationAnchor, params.proximityConfig),
        // A priced agent scope already includes mandatory items — pass an
        // empty set so permit adders don't double-count.
        majorItems: pricedReno ? [] : derivedBuybox.majorItems,
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

  // Renovation engine — when the agent posted a scope but the anchor didn't
  // move (agent ARV equals the pre-B anchor), the valuation above never
  // re-ran. Recompute it once with the priced scope as the base rehab.
  if (pricedReno != null && valuationAnchor != null && valuation?.totalRehabCost !== pricedReno.total) {
    valuation = valuationService.calculateValuation({
      arv: valuationAnchor,
      subjectSqft,
      compAvgSqft,
      rehabLevelIndex: derivedBuybox.rehabLevelIndex,
      skipBaseRehab: false,
      rehabBaseOverride: pricedReno.total,
      locationPenaltyAmount: computeLocationPenalty(bundle.enrichment.locationRisks, valuationAnchor, params.proximityConfig),
      majorItems: [],
      additionPlay: derivedBuybox.additionPlay ?? buybox.additionPlay ?? 0,
      closingCostsPercent: buybox.closingCostsPercent ?? 8,
      carryingCostsPercent: buybox.carryingCostsPercent ?? 2,
      wholesaleFee: buybox.wholesaleFee ?? 10000,
      desiredProfit: buybox.desiredProfit,
    })
    step('renovation_scope', 'completed', `Agent Path-${pricedReno.pathUsed} scope: $${pricedReno.total.toLocaleString()} (${pricedReno.audit[0] ?? ''})`)
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
  const photoBundle = ctx.photoBundle ?? (ctx.photoBundlePromise ? await ctx.photoBundlePromise : null)
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
    // valuation.confidence stays the harness truth (bResult.conf, wired at
    // build time) — report.confidence is a different rubric and no longer
    // overwrites it. Reasons + review flag still come from the report.
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
  if (agentSelection) {
    // The agent's pocket/deal-economics classification rides the report —
    // same persistence path as every other field on the response.
    response.harness = {
      source: 'agent',
      pocketScore: agentSelection.pocketScore ?? null,
      dealEconomics: agentSelection.dealEconomics ?? null,
      ...(pricedReno ? {
        renovation: {
          pathUsed: pricedReno.pathUsed,
          total: pricedReno.total,
          items: pricedReno.items.map((i) => ({ item: i.item, action: i.action, category: i.category, cost: i.resolvedCost, source: i.source })),
          flags: pricedReno.flags,
        },
      } : {}),
      ...(agentSelection.notes ? { notes: agentSelection.notes } : {}),
    }
  }

  return {
    response,
    appraisalResult,
    compClassifications,
    groupB: groupBResult,
    runEvidence: {
      compPool: appraisalResult.comparables,
      subject: bundle.property,
      appliedSettings,
      filters,
      adjustments,
      fallbackUsed: appraisalResult.fallbackUsed ?? null,
      expansionApplied: appraisalResult.expansionApplied ?? [],
      compClassifications: Object.fromEntries(compClassifications),
      compCurbAppeal: compCurbAppeal ?? null,
      bAttemptTrail,
      attempts: bAttempts,
      ...(agentSelection ? { agentSelection } : {}),
      ...(pricedReno && agentSelection?.renovation
        ? { renovation: { posted: agentSelection.renovation, priced: pricedReno } }
        : {}),
      // Fail-open verdict grade — agent selections grade on their posted
      // verdict; a deterministic-fallback run synthesizes the equivalent
      // selection from its own B result so it is graded the same way
      // (spec §4). Never blocks the response.
      ...(params.harness === 'agent' && pipelineBResult != null
        ? {
            verdictGrade: gradeVerdict(
              buildHarnessEvidence(ctx),
              agentSelection ?? {
                arv: pipelineBResult.arv ?? finalArv ?? 0,
                conf: (pipelineBResult.conf as AgentSelection['conf']) ?? 'low',
                selectedCompIds: appraisalResult.selectedCompIds ?? [],
              },
            ),
          }
        : {}),
      // 1-revision gate telemetry — the rejected attempt + the accepted
      // verdict, side by side (spec: attempt_1_result + attempt_2_result).
      ...(ctx.selectionAttempts?.length ? { selectionAttempts: ctx.selectionAttempts } : {}),
    },
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

// ─── Harness seam ────────────────────────────────────────────────────────────
// The Evaluation Agent is a comp-selection verdict rendered outside the Worker
// by a Devin session governed by docs/EVAL-AGENT-RULESET.md. Phase 1 freezes
// the evidence-complete context; the agent's selection re-enters phase 2 in
// place of evaluateB. Server-side validation bounds the verdict; the
// deterministic ladder (deepen) stays available between selection rounds.

/** Frozen, JSON-serializable state at the evidence-complete boundary.
 *  Everything phase 2 reads, and nothing it doesn't. */
export interface Phase1Context {
  jobId: string
  bundle: PropertyBundle
  appraisalResult: AppraisalResultWithFallback
  subjectAvm: number | null
  insufficient: boolean
  preferredSaleAgeDays: number
  filters: AppraisalFilter[]
  adjustments: AppraisalAdjustment[]
  steps: ReportStep[]
  fallbacksUsed: string[]
  compClassifications: Array<[string, ClassificationResult]>
  classificationSummary: ReturnType<typeof summarizeClassifications>
  compCurbAppeal?: CompCurbAppealMap
  /** Clef stage digests per comp — advisory agent-assist reads. */
  compDigests?: Record<string, CompDigestStages>
  compListingPhysicalDetails: Record<string, PhysicalCharacteristicSourceData>
  subjectListingDetails: RedfinDetailsResult | null
  redfinDetailsEnabled: boolean
  redfinTargetIds: string[]
  renovation: RenovationAssessment
  subjectCurbAppeal: CurbAppealCheck | null
  sellerNotes: Awaited<ReturnType<typeof fetchSellerNotes>>
  rehabAdditions: RehabAddition[]
  rehabAdvisories: RehabAdvisory[]
  derivedBuybox: ReturnType<typeof deriveBuybox>
  subjectSqft: number
  compAvgSqft: number
  finalArv: number | null
  valuation: ValuationResult | null
  valuationAnchor: number | null
  avmAnchor: number | null
  assessedAnchor: number | null
  rehabLevelEstimates: RehabLevelEstimate[]
  groupBResult: GroupBResult | null
  groupACompIds: string[]
  bestMatch: ReturnType<typeof selectBestMatch>
  asIsThresholdPercent: number
  /** Resolved bundle when the caller serialized the context for a resume. */
  photoBundle?: PhotoBundle | null
  /** Live in-process promise on the single-invocation path — stripped when
   *  the context is persisted for an agent resume. */
  photoBundlePromise?: Promise<PhotoBundle | null>
  apiCallStats?: ApiCallStats
  /** 1-revision gate telemetry — every selection attempt with its grade
   *  and gate decision (rejected | accepted | accepted_final). */
  selectionAttempts?: SelectionAttempt[]
  /** Reasoning-model band overrides persisted on the frozen context —
   *  buildHarnessEvidence applies them to band labels + evidenceBands
   *  identically at evidence-serve and selection-grade time. */
  bandOverrides?: Record<string, BandName | null>
  bandAdjudication?: { adjustments: import('./band-adjudicate').BandAdjustment[]; model: string; ambiguous?: string[]; confidence?: number }
}

/** Park-path helper — runs the reasoning-model adjudication over the
 *  DRAFT band membership (deterministic labels as input) and stamps the
 *  result onto the context so both the evidence payload and the gate
 *  verify the same adjudicated bands. No-op without a reasoning provider. */
export async function adjudicatePhase1Bands(ctx: Phase1Context, env: Env): Promise<void> {
  const compClassifications = new Map(ctx.compClassifications)
  const bcomps = toBCompsOf(ctx.appraisalResult.comparables, compClassifications, ctx.compCurbAppeal, ctx.compDigests)
  const rows = bcomps.map((b, i) => ({ id: ctx.appraisalResult.comparables[i]!.id, ...b, band: bandForComp({ id: ctx.appraisalResult.comparables[i]!.id, ...b }) }))
  const res = await adjudicateBandMembership(env, {
    subject: {
      address: ctx.bundle.property.address ?? null,
      squareFeet: ctx.bundle.property.squareFeet ?? null,
      censusTract: ctx.bundle.property.censusTract ?? null,
      neighborhoodName: ctx.bundle.property.neighborhoodName ?? null,
    },
    comps: rows,
  }).catch(() => null)
  if (!res) return
  ctx.bandOverrides = res.overrides
  ctx.bandAdjudication = { adjustments: res.adjustments, model: res.model, ambiguous: res.ambiguous, confidence: res.confidence }
}

export interface SelectionAttempt {
  selection: AgentSelection
  grade: import('./verdict-grade').VerdictGrade
  decision: 'rejected' | 'accepted' | 'accepted_final'
  at: string
}

function freezePhase1Context(l: Omit<Phase1Context, 'compClassifications' | 'groupACompIds' | 'redfinTargetIds'> & {
  compClassifications: Map<string, ClassificationResult>
  groupACompIds: Set<string>
  redfinTargetsById: Map<string, AppraisedComparable>
}): Phase1Context {
  const { compClassifications, groupACompIds, redfinTargetsById, ...rest } = l
  return {
    ...rest,
    compClassifications: [...compClassifications.entries()],
    groupACompIds: [...groupACompIds],
    redfinTargetIds: [...redfinTargetsById.keys()],
  }
}

/** Full deterministic path — phase 1 evidence → phase 2 selection + tail.
 *  Identical to the pre-split pipeline; the harness seam only adds the
 *  ability to pause at the boundary. */
export async function performAnalysis(
  params: EvaluationParams,
  env: Env,
  onProgress?: (message: string, data?: Record<string, unknown>) => void
): Promise<EvaluationResult> {
  const ctx = await performAnalysisPhase1(params, env, onProgress)
  return performAnalysisPhase2(ctx, params, env, onProgress)
}

/** Geo doctrine (EVAL-AGENT-RULESET §3): block group is the strongest
 *  enclosure, neighborhood/subdivision second, census tract the fallback. */
const normalizeGeoName = (value?: string | null) =>
  value?.toLowerCase().replace(/[^a-z0-9]/g, '') || null

function compGeoPriority(subject: NormalizedProperty, comp: AppraisedComparable): number | null {
  if (comp.sameBlockGroup === true) return 0
  const subjectNeighborhood = normalizeGeoName(subject.neighborhoodName)
  const neighborhoodMatch = subjectNeighborhood != null
    && normalizeGeoName(comp.neighborhoodName) === subjectNeighborhood
  const subdivisionMatch = subdivisionsMatch(subject.subdivision, comp.subdivision)
  if (neighborhoodMatch || subdivisionMatch) return 1
  if (subject.censusTract && comp.censusTract === subject.censusTract) return 2
  return null
}

function buildBSubjectFields(
  bundle: PropertyBundle,
  valuation: ValuationResult | null,
  subjectAvm: number | null,
) {
  return {
    squareFeet: bundle.property.squareFeet ?? null,
    yearBuilt: bundle.property.yearBuilt ?? null,
    censusTract: bundle.property.censusTract ?? null,
    neighborhoodName: bundle.property.neighborhoodName ?? null,
    subdivision: bundle.property.subdivision ?? null,
    landAssessedValue: bundle.property.landAssessedValue ?? null,
    taxAssessment: bundle.property.assessedValue ?? null,
    assessedValue: bundle.property.assessedValue ?? null,
    avmValue: subjectAvm ?? null,
    lotSizeAcres: bundle.property.lotSizeAcres ?? null,
    lotSizeSquareFeet: bundle.property.lotSizeSquareFeet ?? null,
    condition: valuation?.rehabLevel ?? null,
  }
}

function toBCompsOf(
  comparables: AppraisedComparable[],
  compClassifications: Map<string, ClassificationResult>,
  compCurbAppeal?: CompCurbAppealMap,
  compDigests?: Record<string, CompDigestStages>,
): BComp[] {
  return comparables.map((comp) => ({
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
    neighborhoodName: comp.neighborhoodName ?? null,
    subdivision: comp.subdivision ?? null,
    yearBuilt: comp.yearBuilt ?? null,
    lotSizeAcres: comp.lotSizeAcres ?? null,
    lotSizeSquareFeet: comp.lotSizeSquareFeet ?? null,
    landAssessedValue: comp.landAssessedValue ?? null,
    propertyType: comp.propertyType ?? null,
    crossesMajorRoad: comp.crossesMajorRoad ?? null,
    disableReasons: comp.evaluation?.disableReasons ?? null,
    verifiedFlip: compClassifications.get(comp.id)?.method === 'evidence_flip_chain',
    classification: compClassifications.get(comp.id)
      ? { type: compClassifications.get(comp.id)!.classification }
      : null,
    curbAppeal: compCurbAppeal?.[comp.id] ?? null,
    clefDigest: compDigests?.[String(comp.id)] ?? null,
    evidenceVerification: comp.evidenceVerification ?? null,
    appraisalRules: comp.evaluation ? { totalAdjustment: comp.evaluation.totalAdjustment } : null,
  }))
}

/** Re-stamp price/age/market-fit verification across the pool and switch off
 *  transaction-noise comps. Same body phase 2's ladder uses — shared so the
 *  agent's deepen round restamps identically. */
/** Median $/sf of the after_renovation cluster in the subject's tract —
 *  the band-relative reference for the outlier check. Needs ≥2 members;
 *  null falls back to the pool reference (old pool-relative behavior). */
function bandRefPpsf(
  comparables: AppraisedComparable[],
  censusTract: string | null | undefined,
  classifications: Map<string, ClassificationResult> | undefined,
): number | null {
  if (!classifications || censusTract == null) return null
  const ppsfs = comparables
    .filter((c) => c.censusTract != null && c.censusTract === censusTract &&
      classifications.get(c.id)?.classification === 'after_renovation')
    .map((c) => c.pricePerSqft ?? (c.salePrice != null && c.squareFeet ? c.salePrice / c.squareFeet : null))
    .filter((v): v is number => v != null && v > 0)
    .sort((a, b) => a - b)
  return ppsfs.length >= 2 ? ppsfs[Math.floor(ppsfs.length / 2)] : null
}

function stampPoolVerification(
  comparables: AppraisedComparable[],
  subject: NormalizedProperty,
  preferredSaleAgeDays: number,
  classifications?: Map<string, ClassificationResult>,
): void {
  const tractPpsfs = comparables
    .filter((c) => c.censusTract != null && c.censusTract === subject.censusTract)
    .map((c) => c.pricePerSqft ?? (c.salePrice != null && c.squareFeet ? c.salePrice / c.squareFeet : null))
    .filter((v): v is number => v != null && v > 0)
    .sort((a, b) => a - b)
  const ref = tractPpsfs.length >= 3 ? tractPpsfs[Math.floor(tractPpsfs.length / 2)] : null
  const topBandRefPpsf = bandRefPpsf(comparables, subject.censusTract, classifications)
  const packageIds = packageDeedIds(comparables)
  const bulkIds = bulkSaleIds(comparables)
  for (const comp of comparables) {
    comp.evidenceVerification = verifyCompEvidence(subject, comp, ref, preferredSaleAgeDays, {
      packageDeed: packageIds.has(comp.id),
      bulkSale: bulkIds.has(comp.id),
      band: classifications?.get(comp.id)?.classification,
      bandRefPpsf: topBandRefPpsf,
    })
    const noise = TRANSACTION_NOISE_REASON[comp.evidenceVerification?.transactionCheck ?? '']
    if (noise && comp.isEnabled) {
      comp.isEnabled = false
      if (comp.evaluation) comp.evaluation.disableReasons = [...(comp.evaluation.disableReasons ?? []), noise]
    }
  }
}

/** The agent's comp-selection verdict — posted to
 *  POST /v1/analyze/jobs/:jobId/harness/selection. */
export interface AgentSelection {
  /** The ARV the agent derives under the ruleset — becomes the valuation anchor. */
  arv: number
  conf: 'high' | 'medium' | 'low'
  /** Enabled-pool comp ids the agent selected — the only comps the client sees as selected. */
  selectedCompIds: string[]
  /** Subset of selectedCompIds that drove the ARV (defaults to all picks). */
  drivers?: string[]
  /** Per-comp band assignment for the report: arv | median | asis | outlier. */
  bands?: Record<string, 'arv' | 'median' | 'asis' | 'outlier'>
  /** Stated band edges for the verifier — docs/BANDING-VERIFICATION-SPEC.md §3.
   *  Each band carries its scaled-price edges + member compIds. A band that
   *  legitimately doesn't exist in the pool is omitted (INSUFFICIENT_DATA). */
  bandEdges?: Partial<Record<'as_is' | 'median' | 'arv',
    { low: number; high: number; mid: number; compIds: string[] }>>
  /** Per-comp adjustments applied by the agent (audit trail). */
  adjustments?: Record<string, Array<{ type: string; amount: number; note?: string }>>
  flags?: string[]
  /** Pocket value classification (0-10) — rides the report when present. */
  pocketScore?: number | null
  /** Deal-economics classification prose — rides the report when present. */
  dealEconomics?: string | null
  /** Renovation scope — the agent's posted line-item budget (renovation
   *  engine, docs/RENOVATION-ENGINE-RULESET.md). Priced deterministically
   *  against renovationEvidence at resume; absent = deterministic tier math. */
  renovation?: import('./renovation').AgentRenovation
  /** Free-text verdict summary for the run record. */
  notes?: string
}

/** Server-side bounds on the agent verdict — coherence checks, never an
 *  outcome appeal. Returns the list of failures; empty = accepted. */
export function validateAgentSelection(sel: AgentSelection, comps: AppraisedComparable[]): string[] {
  const fails: string[] = []
  const enabled = new Map(comps.filter((c) => c.isEnabled && c.id).map((c) => [c.id, c] as const))
  const picks = sel.selectedCompIds ?? []
  if (picks.length === 0) fails.push('empty selection — at least one comp is required')
  for (const id of picks) {
    if (!enabled.has(id)) fails.push(`selected comp ${id} is not an enabled pool member`)
  }
  // Hard floor — the valuation math needs a defensible $/sqft per pick, so
  // a selected comp must carry both a sale price and a living area no
  // matter which filters the run evaluated.
  for (const id of picks) {
    const c = enabled.get(id)
    if (!c) continue
    if (!(c.salePrice != null && c.salePrice > 0)) fails.push(`selected comp ${id} has no sale price`)
    if (!(c.squareFeet != null && c.squareFeet > 0)) fails.push(`selected comp ${id} has no square footage`)
  }
  for (const id of sel.drivers ?? []) {
    if (!picks.includes(id)) fails.push(`driver ${id} is not in selectedCompIds`)
  }
  if (typeof sel.arv !== 'number' || !Number.isFinite(sel.arv) || sel.arv <= 0) {
    fails.push('arv missing or not a positive number')
  } else {
    const pickPrices = picks
      .map((id) => enabled.get(id)?.salePrice)
      .filter((p): p is number => p != null && p > 0)
    if (pickPrices.length === 0) {
      fails.push('no selected comp carries a positive sale price — nothing anchors the ARV')
    } else {
      const lo = Math.min(...pickPrices) * 0.75
      const hi = Math.max(...pickPrices) * 1.25
      if (sel.arv < lo || sel.arv > hi) {
        fails.push(`arv ${sel.arv} outside the selected-evidence envelope ${Math.round(lo)}–${Math.round(hi)}`)
      }
    }
  }
  if (!['high', 'medium', 'low'].includes(sel.conf)) fails.push('conf must be high|medium|low')
  if (sel.renovation != null) {
    if (sel.renovation.pathUsed !== 'A' && sel.renovation.pathUsed !== 'B') fails.push('renovation.pathUsed must be A|B')
    const items = sel.renovation.lineItems
    if (!Array.isArray(items) || items.length === 0) fails.push('renovation.lineItems must be a non-empty array')
    else {
      if (items.length > 100) fails.push('renovation.lineItems exceeds 100 items')
      for (const li of items) {
        if (typeof li.item !== 'string' || !li.item) fails.push('renovation item missing item id')
        if (typeof li.cost !== 'number' || !Number.isFinite(li.cost) || li.cost < 0) fails.push(`renovation item ${li.item} has invalid cost`)
      }
    }
  }
  // Persisted verbatim into runEvidence — bound the fields the report keeps.
  if (typeof sel.notes === 'string' && sel.notes.length > 4_000) fails.push('notes exceeds 4000 chars')
  if (typeof sel.dealEconomics === 'string' && sel.dealEconomics.length > 1_000) fails.push('dealEconomics exceeds 1000 chars')
  return fails
}

/** Adapt the agent verdict into the BResult shape phase 2 consumes — the
 *  valuation tail is identical whether the verdict came from the agent or
 *  from evaluateB. */
export function adaptAgentSelection(
  sel: AgentSelection,
  bcomps: BComp[],
  comps: AppraisedComparable[],
): ReturnType<typeof evaluateB> {
  const byId = new Map(comps.map((c, i) => [c.id, bcomps[i]!] as const))
  const driverIds = sel.drivers ?? sel.selectedCompIds
  const drivers = driverIds
    .map((id) => byId.get(id))
    .filter((c): c is BComp => c != null)
    .map((comp) => ({ comp, contrib: comp.adjustedPrice ?? comp.salePrice ?? sel.arv, weight: 1, tier: 'arv' as const }))
  return {
    arv: Math.round(sel.arv),
    // Caller-supplied flags are namespaced so report checks never read them
    // as engine findings — they surface alongside, distinct from bResult's own.
    flags: (sel.flags ?? []).map((f) => `agent:${String(f).slice(0, 200)}`),
    drivers,
    contribs: [],
    bracket: 'ok',
    conf: sel.conf,
    source: 'agent harness',
    anchorAddress: drivers[0]?.comp.address ?? null,
    healed: false,
  }
}

/** The evidence bundle handed to the agent — exactly the inputs evaluateB
 *  would have seen, plus the resolved appraisal grid and the engine's own
 *  evidence-driven suggestion so the agent can accept, adjust, or reject. */
export interface HarnessEvidence {
  jobId: string
  subject: ReturnType<typeof buildBSubjectFields> & { address?: string | null; id?: string }
  /** Renovation evidence — zone grades, description claims, permit ledger,
   *  seller notes, finish parity, flip-delta + cost schedule (advisory). */
  renovationEvidence?: import('./renovation').RenovationEvidence
  comps: Array<BComp & { id: string; salePriceFormatted?: string; band?: BandName | null }>
  suggestedSelection: string[]
  classifications: Record<string, ClassificationResult>
  classificationSummary: ReturnType<typeof summarizeClassifications> | null
  insufficient: boolean
  /** Deterministic evidence bands — the verifier's side of the band contract.
   *  The agent states bandEdges against these (docs/BANDING-VERIFICATION-SPEC). */
  evidenceBands: EvidenceBands
  /** Geo-tightening band sets — block_group → neighborhood → tract. The agent
   *  prices off the tightest tier that formed a band; the gate verifies the
   *  same tier. Emitted whenever any tier differs from the flat pool view. */
  geoBands?: GeoTieredBands
  /** Reasoning-model adjudication applied to band membership — the arm's
   *  reasoning provider's include/exclude/move verdicts + which comps it
   *  changed. Present only when a provider is configured and it answered. */
  bandAdjudication?: { model: string; adjustments: import('./band-adjudicate').BandAdjustment[]; ambiguous?: string[]; confidence?: number }
  rules: {
    filters: AppraisalFilter[]
    adjustments: AppraisalAdjustment[]
    preferredSaleAgeDays: number
    asIsThresholdPercent: number
  }
  steps: ReportStep[]
}

/** Renovation evidence from the frozen phase-1 context — the four data
 *  points (subject listing claims, permit ledger, seller notes, vision zones)
 *  plus finish parity, flip-delta, and the effective cost schedule. */
export function buildRenoEvidence(
  ctx: Phase1Context,
  compClassifications: Map<string, ClassificationResult>,
): import('./renovation').RenovationEvidence {
  return buildRenovationEvidence({
    renovation: ctx.renovation,
    subjectDescription: ctx.photoBundle?.subject?.description ?? null,
    subjectFeatures: ctx.photoBundle?.subject?.features ?? [
      ...(ctx.subjectListingDetails?.details?.interiorFeatures ?? []),
      ...(ctx.subjectListingDetails?.details?.exteriorFeatures ?? []),
      ...(ctx.subjectListingDetails?.details?.flooring ?? []),
      ctx.subjectListingDetails?.details?.roof,
      ctx.subjectListingDetails?.details?.heating,
      ctx.subjectListingDetails?.details?.cooling,
      ctx.subjectListingDetails?.details?.foundation,
    ].filter((s): s is string => typeof s === 'string' && s.length > 0),
    permits: ctx.bundle.enrichment.permits?.items,
    yearBuilt: ctx.bundle.property.yearBuilt ?? null,
    subjectSqft: ctx.bundle.property.squareFeet ?? null,
    majorItems: ctx.derivedBuybox.majorItems,
    rehabAdditions: ctx.rehabAdditions,
    rehabAdvisories: ctx.rehabAdvisories,
    arvCompDescriptions: ctx.appraisalResult.comparables
      .filter((c) => {
        const cls = compClassifications.get(c.id)
        return cls?.classification === 'after_renovation' || ctx.compCurbAppeal?.[c.id]?.condition === 'renovated'
      })
      .map((c) => ({
        compId: c.id,
        description: [
          ...(c.listingDetails?.interiorFeatures ?? []),
          ...(c.listingDetails?.flooring ?? []),
          ...(c.listingDetails?.appliances ?? []),
          ...(c.listingDetails?.exteriorFeatures ?? []),
          c.listingDetails?.roof, c.listingDetails?.heating, c.listingDetails?.cooling,
        ].filter((s): s is string => typeof s === 'string').join('. ') || null,
      })),
    flipPairs: ctx.appraisalResult.comparables
      .filter((c) => c.flip?.priorSalePrice && c.salePrice && c.squareFeet)
      .map((c) => ({ compId: c.id, buy: c.flip!.priorSalePrice, resale: c.salePrice!, sqft: c.squareFeet! })),
  })
}

export function buildHarnessEvidence(ctx: Phase1Context): HarnessEvidence {
  const compClassifications = new Map(ctx.compClassifications)
  const bcomps = toBCompsOf(ctx.appraisalResult.comparables, compClassifications, ctx.compCurbAppeal, ctx.compDigests)
  const overrides = ctx.bandOverrides
  const bandLabel = (row: BComp & { id: string }): BandName | null => {
    const o = overrides?.[row.id]
    return o !== undefined ? o : bandForComp(row)
  }
  const rows = bcomps.map((b, i) => ({ id: ctx.appraisalResult.comparables[i]!.id, ...b }))
  return {
    jobId: ctx.jobId,
    subject: {
      ...buildBSubjectFields(ctx.bundle, ctx.valuation, ctx.subjectAvm),
      address: ctx.bundle.property.address,
      id: ctx.bundle.property.id,
    },
    comps: ctx.appraisalResult.comparables.map((comp, i) => {
      const row = { id: comp.id, ...bcomps[i]! }
      // Band-class label — what the band module assigns, which can differ
      // from the listing `classification.type` (e.g. transitional listing
      // landing in the as_is band). Surfaced so the agent reads the same
      // label the gate enforces. Reasoning-model adjudication wins when
      // the arm ran it.
      return { ...row, band: bandLabel(row) }
    }),
    renovationEvidence: buildRenoEvidence(ctx, compClassifications),
    suggestedSelection: ctx.appraisalResult.selectedCompIds ?? [],
    classifications: Object.fromEntries(compClassifications),
    classificationSummary: ctx.classificationSummary ?? null,
    insufficient: ctx.insufficient,
    evidenceBands: computeEvidenceBands(rows, ctx.bundle.property, { bandOverrides: overrides }),
    geoBands: computeGeoTieredBands(rows, ctx.bundle.property, { bandOverrides: overrides }),
    bandAdjudication: ctx.bandAdjudication
      ? { model: ctx.bandAdjudication.model, adjustments: ctx.bandAdjudication.adjustments, ambiguous: ctx.bandAdjudication.ambiguous, confidence: ctx.bandAdjudication.confidence }
      : undefined,
    rules: {
      filters: ctx.filters,
      adjustments: ctx.adjustments,
      preferredSaleAgeDays: ctx.preferredSaleAgeDays,
      asIsThresholdPercent: ctx.asIsThresholdPercent,
    },
    steps: ctx.steps,
  }
}

/** Agent retry round — deepen enrichment on thin IN-POCKET pool members
 *  (block group / neighborhood / same tract only — out-of-pocket comps are
 *  never deepened) and restamp verification, mirroring the B ladder's third
 *  attempt. `detailsFetcher` is the caller's listing-details lookup (Redfin
 *  MLS details); its sale history fills undated comps — a comp ATTOM
 *  included stays usable whether or not a date ever lands. Returns the
 *  number of fields filled so the caller can decide whether to re-offer
 *  the bundle. */
export async function harnessDeepen(
  ctx: Phase1Context,
  params: EvaluationParams,
  detailsFetcher?: (comp: NormalizedComparable) => Promise<{ saleDate?: string | null } | null>,
): Promise<number> {
  const subject = ctx.bundle.property
  const inPocket = (c: AppraisedComparable): boolean => compGeoPriority(subject, c) != null
  const thin = ctx.appraisalResult.comparables
    .filter((c) => inPocket(c) && (c.avmValue == null || c.landAssessedValue == null || (c.salePrice != null && c.saleDate == null)))
    .sort((a, b) =>
      (compGeoPriority(subject, a) ?? 9) - (compGeoPriority(subject, b) ?? 9)
      || (a.distanceMiles ?? 99) - (b.distanceMiles ?? 99))
    .slice(0, 8)
  let deepened = 0
  if (params.enrichComparables && thin.length > 0) {
    const enriched = await params.enrichComparables(thin).catch(() => null)
    const byId = new Map((enriched ?? []).map((c) => [c.id, c]))
    for (const comp of ctx.appraisalResult.comparables) {
      const e = byId.get(comp.id)
      if (!e) continue
      if (comp.avmValue == null && e.avmValue != null) { comp.avmValue = e.avmValue; deepened++ }
      if (comp.landAssessedValue == null && e.landAssessedValue != null) { comp.landAssessedValue = e.landAssessedValue; deepened++ }
    }
  }
  // Listing-history date fill — undated in-pocket comps only. Best-effort:
  // an undated comp is never dropped, the fill just upgrades its conf tier.
  if (detailsFetcher) {
    const undated = thin.filter((c) => c.saleDate == null && c.salePrice != null)
    const fills = await Promise.all(undated.map(async (c) => ({ c, d: await detailsFetcher(c).catch(() => null) })))
    for (const { c, d } of fills) {
      if (d?.saleDate) { c.saleDate = d.saleDate; deepened++ }
    }
  }
  if (deepened > 0) {
    stampPoolVerification(ctx.appraisalResult.comparables, ctx.bundle.property, ctx.preferredSaleAgeDays, new Map(ctx.compClassifications))
  }
  return deepened
}

/** Agent retry round — widen retrieval in TIME (never geography — see
 *  EVAL-AGENT-RULESET §8a). The caller refetches comparables at a longer
 *  sale window, geo-stamps and enriches new candidates through the same
 *  gates as the initial pool, and passes them here. They go through the
 *  same appraisal grid + verification + classification as the first pass;
 *  the whole pool is re-classified so group labels re-break on the bigger
 *  evidence set. Returns the count of comps added. */
export function harnessWiden(ctx: Phase1Context, widened: NormalizedComparable[]): number {
  const existing = new Set(ctx.appraisalResult.comparables.map((c) => c.id))
  const added = widened.filter((c) => !existing.has(c.id))
  if (added.length === 0) return 0
  const appraisalService = createAppraisalService()
  const widenedResult = appraisalService.evaluate(ctx.bundle.property, added, {
    filters: ctx.filters,
    adjustments: ctx.adjustments,
  })
  ctx.appraisalResult.comparables.push(...widenedResult.comparables)
  // The response builder reads bundle.comparables for comp source/listing
  // detail — widened comps must join it or a selected widened comp loses
  // its source evidence in the saved report.
  ctx.bundle.comparables.push(...added)
  // Re-classify first so widened comps' band labels inform the
  // band-relative noise reference on the same pass.
  const cls = new Map(ctx.compClassifications)
  for (const [id, c] of classifyCompsByEvidence(ctx.appraisalResult.comparables, ctx.bundle.property, ctx.compCurbAppeal)) {
    cls.set(id, c)
  }
  stampPoolVerification(ctx.appraisalResult.comparables, ctx.bundle.property, ctx.preferredSaleAgeDays, cls)
  ctx.compClassifications = [...cls.entries()]
  return widenedResult.comparables.length
}
