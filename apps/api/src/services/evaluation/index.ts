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
import { persistReportAssets } from '../report-assets'
import { assessRenovationFromPhotos, assessCompCurbAppeal, type RenovationAssessment, type CurbAppealCheck } from '../vision/renovation'
import { PROXIMITY_DEFAULTS } from '../../routes/proximity-config'
import { deriveBuybox } from './derivation'
import { buildEvaluationReport } from './report'
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
  apiCallStats?: ApiCallStats
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

  if (qualifying.length === 0) {
    return {
      compIds: [],
      asIsMarketPrice: null,
      avgPricePerSqft: null,
      count: 0,
      thresholdPercent,
      arvUsed: arv,
      priceCeiling,
      noDataReason: `No enabled comps sold at or below ${thresholdPercent}% of ARV (${formatUsd(priceCeiling)})`,
    }
  }

  // Sqft-scale each comp's sale price to the subject's sqft, then average
  const subjectSqft = subject.squareFeet ?? 0
  const scaledPrices: number[] = []
  const perSqftPrices: number[] = []

  for (const comp of qualifying) {
    if (comp.squareFeet && comp.squareFeet > 0) {
      const perSqft = comp.salePrice! / comp.squareFeet
      perSqftPrices.push(perSqft)
      scaledPrices.push(subjectSqft > 0 ? perSqft * subjectSqft : comp.salePrice!)
    } else {
      scaledPrices.push(comp.salePrice!)
    }
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
async function loadMajorItemConfig(
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
  onProgress?: (message: string) => void
): Promise<EvaluationResult> {
  const { jobId } = params
  let { bundle } = params
  const appraisalService = createAppraisalService()
  const rules = params.appraisalRules ?? {}
  const filters = [...(rules.filters ?? DEFAULT_FILTERS)]
  const adjustments = rules.adjustments ?? DEFAULT_ADJUSTMENTS

  // Evidence-critical rules always run — the apples-to-apples match set:
  // subdivision → neighborhood geography, then physical matches (style,
  // foundation, construction material, pool, garage, assessor condition).
  // They only bite when enriched data proves a mismatch — not_verified never
  // disqualifies — so enabling them is safe even where provider data is thin.
  const requiredMatches = DEFAULT_FILTERS.filter((f) =>
    ['subdivision_match', 'neighborhood_match', 'building_style_match',
     'foundation_match', 'construction_material_match', 'pool_match',
     'garage_match', 'condition_match', 'stories_match', 'roof_material_match'
    ].includes(f.type)
  )
  for (const required of requiredMatches) {
    const existing = filters.find((f) => f.type === required.type)
    if (existing) {
      existing.enabled = true
      existing.priority ??= required.priority
    } else {
      filters.push({ ...required })
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

  // ── 2. Photos: subject + comps via Zillow → Redfin → Realtor chain ─────────
  let photoBundle: PhotoBundle | null = null
  try {
    const photoService = createPhotoService(env)
    if (photoService.isAvailable()) {
      const subjectIdent: PropertyIdentifier = {
        propertyId: bundle.property.id,
        address: bundle.property.address,
        city: bundle.property.city,
        state: bundle.property.state,
        zipCode: bundle.property.zipCode,
      }
      // Prioritize photo spend: ARV-selected comps first, then nearest —
      // cards without listing photos fall back to Street View anyway
      const selectedSet = new Set(appraisalResult.selectedCompIds ?? [])
      const rankedComps = [...bundle.comparables].sort((a, b) => {
        const aSel = selectedSet.has(a.id) ? 1 : 0
        const bSel = selectedSet.has(b.id) ? 1 : 0
        if (aSel !== bSel) return bSel - aSel
        return (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999)
      })
      const compIdents: PropertyIdentifier[] = rankedComps.map((c) => ({
        propertyId: c.id,
        address: c.address,
        city: c.city,
        state: c.state,
        zipCode: c.zipCode,
      }))
      photoBundle = await photoService.fetchPhotoBundle(subjectIdent, compIdents, { maxComps: 6 })
      step(
        'photo_fetch',
        photoBundle.subject ? 'completed' : 'fallback',
        photoBundle.subject
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
    const mergeResult = mergeZillowDataIntoBundle(bundle, photoBundle)
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

  // ── 3. Vision: subject renovation+curb-appeal AND comp checks in parallel ──
  // One merged LLM call for the subject (renovation level + curb appeal).
  // Per-comp curb checks only run when the provider's assessor condition is
  // missing — assessor data replaces the LLM classification for comps and
  // saves a vision round-trip per comp.
  const compById = new Map(appraisalResult.comparables.map((c) => [c.id, c]))
  const subjectPhotos = photoBundle?.subject?.photos ?? []
  const compVisionPairs = (appraisalResult.selectedCompIds ?? [])
    .filter((id) => compById.get(id)?.buildingCondition == null)
    .map((id) => ({ id, photos: photoBundle?.comps[id]?.photos ?? [] }))
    .filter((p) => p.photos.length > 0)

  const [renovationResult, compChecks] = await Promise.all([
    (async () => {
      try {
        return await assessRenovationFromPhotos(env, subjectPhotos, {
          address: bundle.property.address,
          squareFeet: bundle.property.squareFeet,
          yearBuilt: bundle.property.yearBuilt,
        })
      } catch { return null }
    })(),
    Promise.all(
      compVisionPairs.map(async (p) => {
        try {
          return { id: p.id, check: await assessCompCurbAppeal(env, p.photos) }
        } catch {
          return { id: p.id, check: { condition: 'unknown', confidence: null, summary: 'Vision call failed', photosExamined: p.photos.length } as CurbAppealCheck }
        }
      })
    ),
  ])

  // ── Persist listing photos into private report storage ────────────────────
  // Copy image bytes to R2 and rewrite CDN URLs to /user/reports/{jobId}/
  // assets/{id} so saved reports keep working photos indefinitely — listing
  // CDN links rot or get hotlink-blocked. Runs after vision, which needs the
  // live CDN URLs. Non-fatal: failures keep the original URLs.
  if (photoBundle && env.REPORT_ASSETS) {
    const persistPhotos = async (propertyId: string, entry: PropertyPhotos | null) => {
      if (!entry || entry.photos.length === 0) return
      try {
        const src = entry.source
        const { assets } = await persistReportAssets(env, jobId, propertyId,
          entry.photos.map((url) => ({
            url,
            kind: 'photo' as const,
            sourcePageUrl: entry.sourceUrl,
            source: src === 'zillow' || src === 'redfin' || src === 'realtor' ? src : undefined,
          })))
        if (assets.length === 0) return
        const persisted = new Set(assets.map((a) => a.sourceUrl))
        entry.photos = [...assets.map((a) => a.url), ...entry.photos.filter((u) => !persisted.has(u))]
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

  const renovation: RenovationAssessment | null = renovationResult
  if (renovation) {
    step(
      'renovation_assessment',
      renovation.renovationLevelIndex != null ? 'completed' : 'fallback',
      renovation.renovationLevel != null
        ? `${renovation.renovationLevel} @ ${renovation.confidence ?? '?'}% (${renovation.photosExamined} photos)`
        : renovation.status
    )
    if (renovation.status !== 'ok' && renovation.status !== 'insufficient_photo_evidence') {
      fallbacksUsed.push(`vision:${renovation.status}`)
    }
  } else {
    step('renovation_assessment', 'fallback', 'vision call failed')
    fallbacksUsed.push('vision:error')
  }
  onProgress?.('Renovation level assessed')

  // Subject curb appeal comes from the merged vision pass (one LLM call for
  // both renovation level + curb-appeal condition); comp checks resolved in
  // the same parallel batch above.
  const subjectCurbAppeal: CurbAppealCheck | null = renovation?.curbAppeal ?? null
  let compCurbAppeal: Record<string, CurbAppealCheck> | undefined =
    compChecks.length > 0 ? Object.fromEntries(compChecks.map((c) => [c.id, c.check])) : undefined

  // ── ARV condition gate ────────────────────────────────────────────────────
  // ARV-comp-worthy = recently sold, arm's-length, physically similar, and
  // verified AR quality — renovated/updated/retail-ready, matching the
  // condition the subject will reach after repair. A high sale price alone
  // NEVER qualifies a comp: dated/distressed verification excludes it, and
  // unverifiable condition means its price cannot influence ARV.
  const isArvWorthy = (check: CurbAppealCheck | undefined): boolean =>
    !!check &&
    check.source === 'vision' &&
    (check.condition === 'renovated' || check.rehabLevelIndex === 0)

  // Assessor condition is the primary ARV-worthiness signal — comps rated
  // Good/Very Good/Excellent are treated as retail-ready without a vision
  // call. Vision curb-appeal remains the fallback when the provider has no
  // condition data for the comp.
  const ARV_WORTHY_CONDITIONS = new Set(['excellent', 'verygood', 'good'])
  const assessorArvWorthy = (compId: string): boolean | null => {
    const cond = compById.get(compId)?.buildingCondition?.toLowerCase().replace(/[^a-z]/g, '')
    if (!cond) return null
    return ARV_WORTHY_CONDITIONS.has(cond)
  }

  const unverifiable: string[] = []
  const prunedFromArv: string[] = []
  for (const id of appraisalResult.selectedCompIds ?? []) {
    const check = compCurbAppeal?.[id]
    const worthy = assessorArvWorthy(id) ?? isArvWorthy(check)
    if (!worthy) {
      prunedFromArv.push(id)
      const assessorCond = compById.get(id)?.buildingCondition
      if (!check && !assessorCond) unverifiable.push(id)
      else if (check?.condition === 'unknown') unverifiable.push(id)
      if (check && check.source !== 'price') {
        compCurbAppeal![id] = {
          ...check,
          summary: `${check.summary ?? check.condition} — excluded from ARV: not verified renovated/retail-ready`,
        }
      }
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
        `${prunedFromArv.length} comp(s) excluded — not verified renovated/retail-ready; ARV recomputed on ${remainingComps.length}`)
    } else {
      // Can't recompose a 3-comp ARV — keep the set but mark the evidence
      fallbacksUsed.push('arv_condition_thin')
      step('arv_condition_gate', 'fallback',
        `${prunedFromArv.length} comp(s) not verified AR-quality (${unverifiable.length} unverifiable) — ARV kept on ${remainingComps.length + prunedFromArv.length} comps, fewer than 3 verified`)
    }
  } else if (appraisalResult.selectedCompIds?.length) {
    step('arv_condition_gate', 'completed',
      `${appraisalResult.selectedCompIds.length} comp(s) verified AR-quality (renovated/retail-ready)`)
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
    visionLevelIndex: renovation?.renovationLevelIndex ?? null,
    visionConfidence: renovation?.confidence ?? null,
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
    // Proximity deduction — Evaluation Settings' Proximity Adjustments:
    // worst detected position wins (fronting > backing > siding);
    // flat $ below the ARV threshold, % of ARV at/above it.
    locationPenaltyAmount: (() => {
      const risks = bundle.enrichment.locationRisks ?? []
      if (risks.length === 0) return 0
      const cfg = params.proximityConfig ?? PROXIMITY_DEFAULTS
      const rank = { fronting: 3, backing: 2, siding: 1 } as const
      const worst = risks.reduce<keyof typeof rank | null>((w, r) => {
        const pos = r.position ?? 'siding'
        return !w || rank[pos] > rank[w] ? pos : w
      }, null)
      if (!worst) return 0
      const tier = cfg[worst]
      return finalArv >= cfg.arvThreshold ? Math.round(finalArv * (tier.percent / 100)) : tier.flat
    })(),
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
  const groupBResult = selectGroupBComps(
    bundle.property,
    appraisalResult,
    finalArv,
    asIsThresholdPercent,
    groupACompIds
  )
  if (groupBResult && groupBResult.count > 0) {
    console.log(`[Evaluate] Group B: ${groupBResult.count} as-is comps (≤${formatUsd(groupBResult.priceCeiling)}, ${asIsThresholdPercent}% of ARV)`)
  }

  // ── 8. Best match + applied settings snapshot ───────────────────────────────
  const bestMatch = selectBestMatch(bundle.property, enabledComps)

  const appliedSettings = {
    filters: filters.map((f) => ({ type: f.type, enabled: f.enabled, value: f.value })),
    adjustments: adjustments.map((a) => ({
      type: a.type,
      enabled: a.enabled,
      amount: a.amount,
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
      compCurbAppeal,
      subjectCurbAppeal,
      subjectListingUrl: photoBundle?.subject?.sourceUrl ?? null,
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
  })
  response.visionAssessment = renovation
  response.renovationLevelSource = derivedBuybox.rehabLevelSource
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
    summary: `Renovation level ${assessment.renovationLevel} at ${assessment.confidence ?? '?'}% confidence from ${assessment.photosExamined} photos`,
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
