/**
 * Analysis Workflow
 *
 * Cloudflare Workflow for processing property analysis with parallel execution.
 *
 * Pipeline:
 * 1. Fetch property bundle (property + comps + enrichment)
 * 2. Apply appraisal rules (3-pass filter with subdivision match)
 * 3. Fetch photos + classify (combined step, only for selected comps)
 * 4. Vision analysis (optional, skipped if keyword confidence >= 70)
 * 5. Calculate weighted ARV and build response
 *
 * Benefits over Queue-based approach:
 * - True parallel execution with fan-out
 * - Automatic retries with backoff per step
 * - Durable execution (survives restarts)
 * - Step-level caching
 *
 * @see https://developers.cloudflare.com/workflows/
 */

import {
  WorkflowEntrypoint,
  WorkflowStep,
  WorkflowEvent,
} from 'cloudflare:workers'
import type { Env } from '../types'
import type {
  AnalysisWorkflowParams,
  AnalysisWorkflowResult,
} from './types'

import { createPropertyApi, type PropertyBundle, type PropertyApiCallStats } from '../services/property-api'
import type { NormalizedComparable, NormalizedProperty } from '../services/property-api/types'
import {
  createAppraisalService,
  DEFAULT_FILTERS,
  DEFAULT_ADJUSTMENTS,
  type AppraisedComparable,
  type AppraisalResultWithFallback,
} from '../services/appraisal'
import { filtersToApiParams } from '../services/appraisal/types'
import { createValuationService, MAJOR_ITEMS } from '../services/valuation'
import { createPhotoService, type PhotoBundle } from '../services/photo-provider'
import { createClassificationService, type ClassificationResult } from '../services/classification'
import { createVisionService, type PropertyConditionAnalysis } from '../services/vision'
import { createLLMProviderFromEnv } from '../services/llm'
import {
  buildAnalysisResponse,
  mergeZillowDataIntoBundle,
  calculateAllRehabLevelEstimates,
  type AnalysisResponse,
  type SupplementedField,
  type ApiCallStats,
} from '../services/analysis'
import { generateZillowUrl } from '../services/photo-provider'
import type { AnalysisStep } from '../durable-objects/types'
import { drizzle } from 'drizzle-orm/d1'
import { savedReports } from '../db/schema'

// ─── Serialization Helpers ────────────────────────────────────────────────────
// Cloudflare Workflows require all step returns to be JSON-serializable
// We use JSON round-trip to strip non-serializable properties

function serialize<T>(data: T): T {
  return JSON.parse(JSON.stringify(data))
}

/**
 * Map vision estimatedRehabNeeds to rehab level index (0-4).
 * Rehab levels: 0=Lipstick, 1=Light Cosmetic, 2=Full Cosmetic, 3=Heavy Rehab, 4=Down to Stud
 */
function mapRehabNeedsToIndex(needs: string): number {
  switch (needs) {
    case 'none': return 0        // Lipstick
    case 'cosmetic': return 1    // Light Cosmetic
    case 'moderate': return 2    // Full Cosmetic
    case 'significant': return 3 // Heavy Rehab
    case 'full_renovation': return 4 // Down to Stud
    default: return 2            // Default to Full Cosmetic
  }
}

// ─── Workflow Definition ──────────────────────────────────────────────────────

export class AnalysisWorkflow extends WorkflowEntrypoint<Env, AnalysisWorkflowParams> {
  /**
   * Main workflow execution
   */
  async run(
    event: WorkflowEvent<AnalysisWorkflowParams>,
    step: WorkflowStep
  ): Promise<AnalysisWorkflowResult> {
    const params = event.payload
    const startedAt = new Date().toISOString()
    const stepTimings: Record<string, number> = {}

    console.log(`[AnalysisWorkflow] Starting job ${params.jobId}`)

    try {
      // ═══════════════════════════════════════════════════════════════════════
      // STEP 1: Fetch Property Bundle (skipped when preloaded from endpoint)
      // ═══════════════════════════════════════════════════════════════════════
      let bundle: PropertyBundle
      let propertyCallStats: PropertyApiCallStats | null = null

      if (params.preloadedPropertyBundle) {
        // Property already fetched by the POST /analyze endpoint — skip Step 1
        bundle = params.preloadedPropertyBundle
        console.log(`[AnalysisWorkflow] Using preloaded property bundle (${bundle.comparables.length} comps)`)
        await this.updateProgress(params.userId, params.propertyKey, 'property_fetch', 'completed')
      } else {
        // Original Step 1 logic (backward compat for API key users, GHL webhooks, etc.)
        await this.updateProgress(params.userId, params.propertyKey, 'property_fetch', 'in_progress')
        const bundleStart = Date.now()

        const bundleData = await step.do(
          'fetch-property-bundle',
          {
            retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
            timeout: '2 minutes',
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          async (): Promise<any> => {
            const result = await this.fetchPropertyBundle(params)
            // Ensure serializable via JSON round-trip
            return serialize(result)
          }
        )
        // Cast back to proper type after serialization
        const fetchResult = bundleData as { bundle: PropertyBundle; callStats: PropertyApiCallStats }
        bundle = fetchResult.bundle
        propertyCallStats = fetchResult.callStats

        stepTimings['property_fetch'] = Date.now() - bundleStart
        console.log(`[AnalysisWorkflow] Property bundle fetched: ${bundle.comparables.length} comps`)

        await this.updateProgress(params.userId, params.propertyKey, 'property_fetch', 'completed')

        // Broadcast subject property data for progressive rendering
        {
          const { property, enrichment } = bundle
          const riskFlags: string[] = []
          if (enrichment.floodZone?.isInFloodZone) riskFlags.push(`Flood Zone: ${enrichment.floodZone.floodZone}`)
          if (property.transaction?.isForeclosure) riskFlags.push('Foreclosure')
          if (property.transaction?.isShortSale) riskFlags.push('Short Sale')
          if (property.yearBuilt && property.yearBuilt < 1978) riskFlags.push('Pre-1978 (Lead Paint)')
          if (enrichment.permits?.items.some((p) => p.jobValue && p.jobValue > 50000)) riskFlags.push('Major Permits (>$50K)')

          await this.broadcastStepData(params.userId, params.propertyKey, 'property_fetch', serialize({
            subject: {
              address: `${property.address}, ${property.city}, ${property.state} ${property.zipCode}`,
              county: property.county ?? null,
              latitude: property.latitude ?? null,
              longitude: property.longitude ?? null,
              bedrooms: property.bedrooms ?? null,
              bathrooms: property.bathrooms ?? null,
              squareFeet: property.squareFeet ?? null,
              lotSizeAcres: property.lotSizeAcres ?? null,
              yearBuilt: property.yearBuilt ?? null,
              propertyType: property.propertyType ?? null,
              subdivision: property.subdivision ?? null,
              lastSale: property.lastSalePrice ? {
                price: property.lastSalePrice,
                date: property.lastSaleDate ?? null,
                pricePerSqft: property.pricePerSqft ?? null,
              } : null,
              taxAssessment: property.assessedValue ?? null,
              foundationType: property.construction?.foundationType ?? null,
              hoaFee: property.hoaFee ?? null,
              zillowUrl: generateZillowUrl({
                propertyId: property.id,
                address: property.address,
                city: property.city,
                state: property.state,
                zipCode: property.zipCode,
              }),
              photos: [],
              classification: null,
            },
            riskFlags: riskFlags.length > 0 ? riskFlags : null,
            floodZone: enrichment.floodZone ? {
              zone: enrichment.floodZone.floodZone,
              inFloodZone: enrichment.floodZone.isInFloodZone,
              description: enrichment.floodZone.floodZoneDescription,
            } : null,
            permits: enrichment.permits ? {
              count: enrichment.permits.count,
              totalValue: enrichment.permits.totalJobValue ?? null,
              recentTypes: (enrichment.permits.recentPermitTypes ?? []).slice(0, 5),
            } : null,
            meta: {
              analysisId: params.jobId,
              timestamp: new Date().toISOString(),
              dataProvider: property.provider,
            },
          }))
        }
      }

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 2: Apply Appraisal Rules
      // ═══════════════════════════════════════════════════════════════════════
      await this.updateProgress(params.userId, params.propertyKey, 'appraisal_rules', 'in_progress')
      const appraisalStart = Date.now()

      const appraisalData = await step.do(
        'apply-appraisal-rules',
        { timeout: '30 seconds' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (): Promise<any> => {
          const appraisalService = createAppraisalService()
          const rules = params.appraisalRules ?? {}
          const filters = rules.filters ?? DEFAULT_FILTERS
          const adjustments = rules.adjustments ?? DEFAULT_ADJUSTMENTS

          const result = appraisalService.evaluateWithFallback(
            bundle.property,
            bundle.comparables,
            { filters, adjustments, minComps: 3 }
          )
          if (result.fallbackUsed === 'no_comps') {
            throw new Error('BAD_DEAL: No comparable sales found even with relaxed criteria. Insufficient data to determine ARV.')
          }
          return serialize(result)
        }
      )
      const appraisalResult = appraisalData as AppraisalResultWithFallback

      stepTimings['appraisal'] = Date.now() - appraisalStart
      const enabledComps = appraisalResult.comparables.filter((c) => c.isEnabled)
      console.log(`[AnalysisWorkflow] Appraisal complete: ${enabledComps.length} comps enabled (fallback: ${appraisalResult.fallbackUsed})`)

      await this.updateProgress(params.userId, params.propertyKey, 'appraisal_rules', 'completed')

      // Broadcast comp data with appraisal results for progressive rendering
      {
        const disabledComps = appraisalResult.comparables.filter((c) => !c.isEnabled)
        const bySubdivisionThenDistance = (a: AppraisedComparable, b: AppraisedComparable) => {
          const aSubMatch = a.evaluation.filterResults.find((f) => f.type === 'subdivision_match')?.passed ?? false
          const bSubMatch = b.evaluation.filterResults.find((f) => f.type === 'subdivision_match')?.passed ?? false
          if (aSubMatch && !bSubMatch) return -1
          if (!aSubMatch && bSubMatch) return 1
          return (a.distanceMiles ?? 999) - (b.distanceMiles ?? 999)
        }
        const sortedComps = [
          ...enabledComps.sort(bySubdivisionThenDistance),
          ...disabledComps.sort(bySubdivisionThenDistance),
        ]

        await this.broadcastStepData(params.userId, params.propertyKey, 'appraisal_rules', serialize({
          comps: {
            total: appraisalResult.comparables.length,
            enabledCount: enabledComps.length,
            disabledCount: disabledComps.length,
            avgPricePerSqft: appraisalResult.avgPricePerSqft,
            medianPrice: appraisalResult.medianSalePrice,
            items: sortedComps.map((comp) => {
              const evaluation = comp.evaluation
              return {
                id: comp.id,
                address: `${comp.address}, ${comp.city}, ${comp.state}`,
                latitude: comp.latitude ?? null,
                longitude: comp.longitude ?? null,
                salePrice: comp.salePrice,
                saleDate: comp.saleDate ? new Date(comp.saleDate).toISOString().split('T')[0] : null,
                squareFeet: comp.squareFeet,
                pricePerSqft: comp.squareFeet && comp.squareFeet > 0 && (comp.adjustedSalePrice ?? comp.salePrice) != null
                  ? Math.round((comp.adjustedSalePrice ?? comp.salePrice)! / comp.squareFeet)
                  : comp.pricePerSqft,
                distanceMiles: comp.distanceMiles,
                bedrooms: comp.bedrooms ?? null,
                bathrooms: comp.bathrooms ?? null,
                yearBuilt: comp.yearBuilt,
                adjustedPrice: comp.adjustedSalePrice,
                photos: [],
                subdivision: comp.subdivision ?? null,
                foundationType: comp.construction?.foundationType ?? null,
                zillowUrl: generateZillowUrl({
                  propertyId: comp.id,
                  address: comp.address,
                  city: comp.city,
                  state: comp.state,
                  zipCode: comp.zipCode,
                }),
                isEnabled: comp.isEnabled,
                disableReasons: evaluation?.disableReasons ?? [],
                classification: null,
                appraisalRules: evaluation ? {
                  passedFilters: !evaluation.shouldDisable,
                  totalAdjustment: evaluation.totalAdjustment,
                  filters: evaluation.filterResults.map((f) => ({
                    type: f.type, passed: f.passed, reason: f.reason,
                    actualValue: f.actualValue ?? null, threshold: f.threshold ?? null,
                  })),
                  adjustments: evaluation.adjustmentResults.filter((a) => a.applied).map((a) => ({
                    type: a.type, applied: a.applied, amount: a.amount, reason: a.reason,
                  })),
                } : null,
              }
            }),
          },
        }))
      }

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 3: Fetch Photos + Merge Zillow + Classify (combined step)
      // Only fetches photos for subject + selected comps (not all comps)
      // ═══════════════════════════════════════════════════════════════════════
      await this.updateProgress(params.userId, params.propertyKey, 'photo_fetch', 'in_progress')
      const photoStart = Date.now()

      const shouldFetchPhotos = params.photoAnalysis?.enabled !== false

      let photoBundle: PhotoBundle | null = null
      let photoCallStats = { firecrawlCalls: 0, llmCalls: 0, cacheHits: 0 }
      let mergedBundle: PropertyBundle = bundle
      let subjectSupplementedFields: SupplementedField[] = []
      let compSupplementedFields = new Map<string, SupplementedField[]>()
      let subjectClassification: ClassificationResult | undefined
      let compClassifications = new Map<string, ClassificationResult>()

      const combinedData = await step.do(
        'fetch-photos-and-classify',
        {
          retries: { limit: 2, delay: '3 seconds', backoff: 'exponential' },
          timeout: '5 minutes',
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (): Promise<any> => {
          let stepPhotoBundle: PhotoBundle | null = null
          let stepPhotoCallStats = { firecrawlCalls: 0, llmCalls: 0, cacheHits: 0 }

          // 1. Fetch photos only for subject + selected comps (not all comps)
          if (shouldFetchPhotos) {
            const photoResult = await this.fetchPhotosParallel(bundle, enabledComps, params)
            stepPhotoBundle = photoResult.photoBundle
            stepPhotoCallStats = photoResult.photoCallStats
          }

          // 2. Merge Zillow data into bundle to supplement missing CoreLogic data
          const mergeResult = mergeZillowDataIntoBundle(bundle, stepPhotoBundle)

          // 3. Classify subject + ALL comps (not just enabled) using merged descriptions
          // We need classifications for all comps to implement renovated-first comp selection
          const classResult = await this.classifyAllParallel(
            mergeResult.bundle,
            mergeResult.bundle.comparables,
            stepPhotoBundle,
            params.visionClassification ?? false
          )

          // Convert Map to plain object for serialization
          const compClassificationsObj: Record<string, ClassificationResult> = {}
          for (const [key, value] of classResult.compClassifications) {
            compClassificationsObj[key] = value
          }

          return serialize({
            photoBundle: stepPhotoBundle,
            photoCallStats: stepPhotoCallStats,
            mergedBundle: mergeResult.bundle,
            subjectSupplementedFields: mergeResult.subjectSupplementedFields,
            compSupplementedFields: Object.fromEntries(mergeResult.compSupplementedFields),
            subjectClassification: classResult.subjectClassification ?? null,
            compClassifications: compClassificationsObj,
          })
        }
      )

      // Destructure combined step results
      const combinedResult = combinedData as {
        photoBundle: PhotoBundle | null
        photoCallStats: { firecrawlCalls: number; llmCalls: number; cacheHits: number }
        mergedBundle: PropertyBundle
        subjectSupplementedFields: SupplementedField[]
        compSupplementedFields: Record<string, SupplementedField[]>
        subjectClassification: ClassificationResult | null
        compClassifications: Record<string, ClassificationResult>
      }
      photoBundle = combinedResult.photoBundle
      photoCallStats = combinedResult.photoCallStats
      mergedBundle = combinedResult.mergedBundle
      subjectSupplementedFields = combinedResult.subjectSupplementedFields
      compSupplementedFields = new Map(Object.entries(combinedResult.compSupplementedFields))
      subjectClassification = combinedResult.subjectClassification ?? undefined
      compClassifications = new Map(Object.entries(combinedResult.compClassifications))

      stepTimings['photo_fetch'] = Date.now() - photoStart
      console.log(`[AnalysisWorkflow] Photos fetched: subject=${!!photoBundle?.subject}, comps=${Object.keys(photoBundle?.comps ?? {}).length} (selected only)`)
      console.log(`[AnalysisWorkflow] Zillow data merged: subject supplemented ${subjectSupplementedFields.length} fields, ${compSupplementedFields.size} comps supplemented`)
      console.log(`[AnalysisWorkflow] Classification complete: ${compClassifications.size} comps classified`)

      await this.updateProgress(params.userId, params.propertyKey, 'photo_fetch', 'completed')

      // Broadcast photos and supplemented data for progressive rendering
      {
        const subjectPhotos = photoBundle?.subject?.photos.slice(0, 5) ?? []
        const mergedCompMap = new Map(mergedBundle.comparables.map((c) => [c.id, c]))
        const compPhotoItems = appraisalResult.comparables.map((comp) => {
          const merged = mergedCompMap.get(comp.id)
          const item: Record<string, unknown> = {
            id: comp.id,
            photos: photoBundle?.comps[comp.id]?.photos.slice(0, 3) ?? [],
          }
          if (merged && merged.bedrooms !== comp.bedrooms) item.bedrooms = merged.bedrooms
          if (merged && merged.bathrooms !== comp.bathrooms) item.bathrooms = merged.bathrooms
          if (merged && merged.squareFeet !== comp.squareFeet) item.squareFeet = merged.squareFeet
          if (merged && merged.yearBuilt !== comp.yearBuilt) item.yearBuilt = merged.yearBuilt
          return item
        })
        const subjectUpdate: Record<string, unknown> = { photos: subjectPhotos }
        if (mergedBundle.property.bedrooms !== bundle.property.bedrooms) subjectUpdate.bedrooms = mergedBundle.property.bedrooms
        if (mergedBundle.property.bathrooms !== bundle.property.bathrooms) subjectUpdate.bathrooms = mergedBundle.property.bathrooms
        if (mergedBundle.property.squareFeet !== bundle.property.squareFeet) subjectUpdate.squareFeet = mergedBundle.property.squareFeet
        if (mergedBundle.property.yearBuilt !== bundle.property.yearBuilt) subjectUpdate.yearBuilt = mergedBundle.property.yearBuilt

        await this.broadcastStepData(params.userId, params.propertyKey, 'photo_fetch', serialize({
          subject: subjectUpdate,
          comps: { items: compPhotoItems },
        }))
      }

      // Broadcast classification data for progressive rendering
      await this.updateProgress(params.userId, params.propertyKey, 'comp_selection', 'in_progress')
      {
        const subjectCls = subjectClassification ? {
          type: subjectClassification.classification,
          confidence: subjectClassification.confidence,
          reasoning: subjectClassification.reasoning,
          method: subjectClassification.method,
        } : null

        const compClsItems = appraisalResult.comparables.map((comp) => {
          const cls = compClassifications.get(comp.id)
          return {
            id: comp.id,
            classification: cls ? {
              type: cls.classification,
              confidence: cls.confidence,
              reasoning: cls.reasoning,
              method: cls.method,
            } : null,
          }
        })

        await this.broadcastStepData(params.userId, params.propertyKey, 'comp_selection', serialize({
          subject: { classification: subjectCls },
          comps: { items: compClsItems },
        }))
      }
      await this.updateProgress(params.userId, params.propertyKey, 'comp_selection', 'completed')

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 4: Vision Analysis of Subject Property (determine rehab level)
      // Skipped when keyword classification confidence is high (>= 70)
      // ═══════════════════════════════════════════════════════════════════════
      let visionAnalysis: PropertyConditionAnalysis | null = null
      let visionCached = false

      const subjectKeywordConfidence = subjectClassification?.confidence ?? 0
      const shouldRunVision = params.visionClassification
        && photoBundle?.subject?.photos?.length
        && subjectKeywordConfidence < 70 // Skip if keywords are already confident

      if (shouldRunVision) {
        const visionStart = Date.now()
        console.log(`[AnalysisWorkflow] Running vision analysis on ${photoBundle!.subject!.photos.length} subject photos (keyword confidence ${subjectKeywordConfidence} < 70)`)

        try {
          const visionData = await step.do(
            'vision-analysis',
            {
              retries: { limit: 2, delay: '3 seconds', backoff: 'exponential' },
              timeout: '1 minute',
            },
            async () => {
              const visionService = createVisionService(this.env)
              if (!visionService.isAvailable()) {
                console.log('[AnalysisWorkflow] Vision service not available (no OPENROUTER_API_KEY)')
                return serialize({ success: false, data: null })
              }

              const result = await visionService.analyzePropertyCondition(
                photoBundle!.subject!.photos.slice(0, 10),
                {
                  address: `${mergedBundle.property.address}, ${mergedBundle.property.city}, ${mergedBundle.property.state}`,
                  squareFeet: mergedBundle.property.squareFeet ?? undefined,
                  yearBuilt: mergedBundle.property.yearBuilt ?? undefined,
                }
              )
              return serialize({ ...result, cached: result.success ? (result as { cached?: boolean }).cached ?? false : false })
            }
          )

          const visionResult = visionData as { success: boolean; data: PropertyConditionAnalysis | null; cached?: boolean }
          if (visionResult.success && visionResult.data) {
            visionAnalysis = visionResult.data
            visionCached = visionResult.cached ?? false
            console.log(`[AnalysisWorkflow] Vision analysis complete: condition=${visionAnalysis.overallCondition}, rehabNeeds=${visionAnalysis.estimatedRehabNeeds}`)
          }

          stepTimings['vision_analysis'] = Date.now() - visionStart
        } catch (error) {
          // Vision analysis failure is non-fatal
          console.warn(`[AnalysisWorkflow] Vision analysis failed (non-fatal):`, error instanceof Error ? error.message : error)
        }
      } else if (params.visionClassification && subjectKeywordConfidence >= 70) {
        console.log(`[AnalysisWorkflow] Skipping vision analysis: keyword confidence ${subjectKeywordConfidence} >= 70`)
      }

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 5: Calculate ARV and Build Response
      // ═══════════════════════════════════════════════════════════════════════
      await this.updateProgress(params.userId, params.propertyKey, 'valuation', 'in_progress')
      const arvStart = Date.now()

      // Build API call statistics
      // When preloaded, the route handler captured property API stats. Otherwise use workflow-local stats.
      const corelogicStats = params.preloadedApiCallStats?.corelogic ?? propertyCallStats ?? { total: 0, cached: 0, endpoints: [] }
      const visionLlmCalls = (visionAnalysis && !visionCached) ? 1 : 0
      const visionCacheHits = (visionAnalysis && visionCached) ? 1 : 0
      const apiCallStats: ApiCallStats = {
        corelogic: {
          total: corelogicStats.total,
          cached: corelogicStats.cached,
          endpoints: corelogicStats.endpoints,
        },
        firecrawl: {
          total: photoCallStats.firecrawlCalls,
          cached: photoCallStats.cacheHits,
        },
        llm: {
          total: photoCallStats.llmCalls + visionLlmCalls,
          cached: visionCacheHits,
          breakdown: [
            ...(photoCallStats.llmCalls > 0 ? [{ purpose: 'zillow_parsing', count: photoCallStats.llmCalls }] : []),
            ...(visionLlmCalls > 0 ? [{ purpose: 'vision_analysis', count: visionLlmCalls }] : []),
          ],
        },
        totalExternalCalls: corelogicStats.total + photoCallStats.firecrawlCalls + photoCallStats.llmCalls + visionLlmCalls,
      }

      console.log(`[AnalysisWorkflow] API call stats: CoreLogic=${corelogicStats.total} (${corelogicStats.cached} cached), Firecrawl=${photoCallStats.firecrawlCalls} (${photoCallStats.cacheHits} cached), LLM=${photoCallStats.llmCalls + visionLlmCalls}`)

      const responseData = await step.do(
        'build-response',
        { timeout: '30 seconds' },
        async () => {
          const result = await this.buildFinalResponse(
            params,
            mergedBundle,
            appraisalResult,
            photoBundle,
            subjectClassification,
            compClassifications,
            subjectSupplementedFields,
            compSupplementedFields,
            visionAnalysis,
            apiCallStats
          )
          return serialize(result)
        }
      )
      const response = responseData as unknown as AnalysisResponse

      stepTimings['arv_calculation'] = Date.now() - arvStart

      await this.updateProgress(params.userId, params.propertyKey, 'valuation', 'completed')

      // Broadcast result to SSE clients immediately (before storing)
      // This allows the dashboard to render results while storage completes
      await this.broadcastPartialResult(params.userId, params.propertyKey, response)

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 6: Store Result in Durable Object
      // ═══════════════════════════════════════════════════════════════════════
      await this.updateProgress(params.userId, params.propertyKey, 'response_build', 'in_progress')
      await step.do('store-result', { timeout: '10 seconds' }, async () => {
        await this.storeResult(params.userId, params.propertyKey, response)
        return { stored: true }
      })

      await this.updateProgress(params.userId, params.propertyKey, 'response_build', 'completed')

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 6.5: Save to savedReports for public report access
      // ═══════════════════════════════════════════════════════════════════════
      try {
        await step.do(
          'save-report',
          {
            retries: { limit: 2, delay: '1 second' },
            timeout: '10 seconds',
          },
          async () => {
            const db = drizzle(this.env.DB)
            await db.insert(savedReports).values({
              userId: params.userId,
              jobId: params.jobId,
              propertyAddress: response.subject.address,
              propertyCity: params.city || '',
              propertyState: params.state || '',
              propertyZip: params.zipCode || '',
              fullResponseJson: JSON.stringify(response),
              arv: response.valuation.arv,
              asIsValue: response.valuation.asIsValue ?? null,
              maxAllowableOffer: response.valuation.buyPrice,
              estimatedRepairs: response.valuation.rehabCost,
            })
            return { saved: true }
          }
        )
        console.log(`[AnalysisWorkflow] Report saved to DB for job ${params.jobId}`)
      } catch (error) {
        // Non-fatal — report page is nice-to-have
        console.warn(`[AnalysisWorkflow] Failed to save report (non-fatal):`, error instanceof Error ? error.message : error)
      }

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 7: Push Results to GoHighLevel (if triggered via GHL webhook)
      // ═══════════════════════════════════════════════════════════════════════
      if (params.ghl) {
        const ghlStart = Date.now()
        console.log(`[AnalysisWorkflow] Pushing results to GHL opportunity ${params.ghl.opportunityId}`)

        try {
          await step.do(
            'push-to-ghl',
            {
              retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
              timeout: '30 seconds',
            },
            async () => {
              const result = await this.pushToGHL(params.ghl!, response, params.jobId)
              return serialize(result)
            }
          )
          stepTimings['ghl_push'] = Date.now() - ghlStart
          console.log(`[AnalysisWorkflow] GHL push completed`)
        } catch (error) {
          // GHL push failure is non-fatal — analysis still succeeded
          stepTimings['ghl_push'] = Date.now() - ghlStart
          console.warn(`[AnalysisWorkflow] GHL push failed (non-fatal):`, error instanceof Error ? error.message : error)
        }
      }

      const completedAt = new Date().toISOString()
      const durationMs = Date.now() - new Date(startedAt).getTime()

      console.log(`[AnalysisWorkflow] Job ${params.jobId} completed in ${durationMs}ms`)

      return {
        success: true,
        jobId: params.jobId,
        result: response,
        timing: {
          startedAt,
          completedAt,
          durationMs,
          stepTimings,
        },
      }
    } catch (error) {
      const completedAt = new Date().toISOString()
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'

      console.error(`[AnalysisWorkflow] Job ${params.jobId} failed:`, errorMessage)

      // Store error in DO
      await this.storeError(params.userId, params.propertyKey, errorMessage)

      return {
        success: false,
        jobId: params.jobId,
        error: errorMessage,
        timing: {
          startedAt,
          completedAt,
          durationMs: Date.now() - new Date(startedAt).getTime(),
          stepTimings,
        },
      }
    }
  }

  // ─── Step Implementations ───────────────────────────────────────────────────

  /**
   * Fetch property bundle from CoreLogic
   */
  private async fetchPropertyBundle(
    params: AnalysisWorkflowParams
  ): Promise<{ bundle: PropertyBundle; callStats: PropertyApiCallStats }> {
    const propertyApi = createPropertyApi(this.env)
    propertyApi.resetCallStats()

    const searchOpts = params.searchOptions ?? {}
    const enrichOpts = params.enrichment ?? { permits: true, floodZone: true }
    const rules = params.appraisalRules ?? {}
    const filters = rules.filters ?? DEFAULT_FILTERS
    const apiFilterParams = filtersToApiParams(filters)

    const bundleResult = await propertyApi.getPropertyBundle({
      address: params.address,
      streetAddress: params.streetAddress,
      city: params.city,
      state: params.state,
      zipCode: params.zipCode,
      propertyId: params.propertyId,
      comparables: {
        radiusMiles: searchOpts.radiusMiles ?? apiFilterParams.radiusMiles ?? 1,
        maxComps: searchOpts.maxComps ?? 10,
        monthsBack: searchOpts.monthsBack ?? apiFilterParams.monthsBack ?? 12,
        sqftVariance: apiFilterParams.sqftVariance,
      },
      enrichment: {
        permits: enrichOpts.permits ?? true,
        floodZone: enrichOpts.floodZone ?? true,
        weatherRisk: enrichOpts.weatherRisk ?? false,
        neighbourhood: false,
      },
      skipCache: params.skipCache,
    })

    if (!bundleResult.success) {
      throw new Error(bundleResult.error || 'Failed to fetch property bundle')
    }

    return { bundle: bundleResult.data, callStats: propertyApi.getCallStats() }
  }

  /**
   * Fetch photos for subject + selected comps in parallel with rate limiting.
   * Only fetches for comps that passed appraisal rules (not all comps).
   */
  private async fetchPhotosParallel(
    bundle: PropertyBundle,
    comps: NormalizedComparable[],
    params: AnalysisWorkflowParams
  ): Promise<{ photoBundle: PhotoBundle | null; photoCallStats: { firecrawlCalls: number; llmCalls: number; cacheHits: number } }> {
    const photoService = createPhotoService(this.env)

    if (!photoService.isAvailable()) {
      return {
        photoBundle: {
          subject: null,
          comps: {},
          provider: 'none',
          fetchedAt: new Date().toISOString(),
        },
        photoCallStats: { firecrawlCalls: 0, llmCalls: 0, cacheHits: 0 },
      }
    }

    const maxComps = params.photoAnalysis?.maxComps ?? 10
    const compsForPhotos = comps.slice(0, maxComps)

    // Fetch subject and all comps in parallel
    // The photo service handles rate limiting internally
    const photoBundle = await photoService.fetchPhotoBundle(
      {
        propertyId: bundle.property.id,
        address: bundle.property.address,
        city: bundle.property.city,
        state: bundle.property.state,
        zipCode: bundle.property.zipCode,
      },
      compsForPhotos.map((comp) => ({
        propertyId: comp.id,
        address: comp.address,
        city: comp.city,
        state: comp.state,
        zipCode: comp.zipCode,
      })),
      { maxComps }
    )

    return {
      photoBundle,
      photoCallStats: photoService.getCallStats(),
    }
  }

  /**
   * Classify all properties in parallel (one LLM call per property, all concurrent)
   */
  private async classifyAllParallel(
    bundle: PropertyBundle,
    comps: NormalizedComparable[],
    photoBundle: PhotoBundle | null,
    visionClassification: boolean
  ): Promise<{
    subjectClassification: ClassificationResult | undefined
    compClassifications: Map<string, ClassificationResult>
  }> {
    const classificationService = createClassificationService()

    // Build classify input for each property
    const allProperties = [
      {
        id: bundle.property.id,
        isSubject: true,
        description: photoBundle?.subject?.description,
        features: photoBundle?.subject?.features,
      },
      ...comps.map((comp) => ({
        id: comp.id,
        isSubject: false,
        description: photoBundle?.comps[comp.id]?.description,
        features: photoBundle?.comps[comp.id]?.features,
      })),
    ]

    console.log(`[AnalysisWorkflow] Classifying ${allProperties.length} properties in parallel`)

    // Fire all classification requests concurrently
    const results = await Promise.allSettled(
      allProperties.map((prop) =>
        classificationService.classifyProperty({
          description: prop.description,
          features: prop.features,
        }).then((result) => ({ id: prop.id, result }))
      )
    )

    // Collect results
    let subjectClassification: ClassificationResult | undefined
    const compClassifications = new Map<string, ClassificationResult>()

    for (const settled of results) {
      if (settled.status === 'fulfilled') {
        const { id, result } = settled.value
        if (id === bundle.property.id) {
          subjectClassification = result
        } else {
          compClassifications.set(id, result)
        }
      } else {
        console.warn('[AnalysisWorkflow] A classification request failed:', settled.reason)
      }
    }

    return { subjectClassification, compClassifications }
  }

  /**
   * Build the final analysis response
   */
  private async buildFinalResponse(
    params: AnalysisWorkflowParams,
    bundle: PropertyBundle,
    appraisalResult: AppraisalResultWithFallback,
    photoBundle: PhotoBundle | null,
    subjectClassification: ClassificationResult | undefined,
    compClassifications: Map<string, ClassificationResult>,
    subjectSupplementedFields: SupplementedField[],
    compSupplementedFields: Map<string, SupplementedField[]>,
    visionAnalysis?: PropertyConditionAnalysis | null,
    apiCallStats?: ApiCallStats
  ): Promise<AnalysisResponse> {
    const valuationService = createValuationService(params.customRehabTable, params.customTierRanges)
    const appraisalService = createAppraisalService()

    const rules = params.appraisalRules ?? {}
    const filters = rules.filters ?? DEFAULT_FILTERS
    const adjustments = rules.adjustments ?? DEFAULT_ADJUSTMENTS

    // ══════════════════════════════════════════════════════════════════════════
    // RENOVATED-FIRST COMP SELECTION
    //
    // As a real estate underwriter, ARV must reflect what the subject will be
    // worth AFTER renovation. The most accurate ARV comes from comps that have
    // already been renovated (after_renovation classification).
    //
    // Strategy:
    // 1. Separate all comps into renovated vs non-renovated using classification
    // 2. Run appraisal rules on renovated comps FIRST (3-pass with fallback)
    // 3. If renovated comps pass rules → use those for ARV (highest accuracy)
    // 4. Only if NO renovated comps exist at all → fall back to all comps
    // ══════════════════════════════════════════════════════════════════════════

    // Identify renovated comps from ALL comps (classification ran on all comps)
    const allComparables = bundle.comparables
    const renovatedCompIds = new Set<string>()
    for (const [id, cls] of compClassifications) {
      if (cls.classification === 'after_renovation') {
        renovatedCompIds.add(id)
      }
    }
    const renovatedComps = allComparables.filter((c) => renovatedCompIds.has(c.id))
    const hasRenovatedComps = renovatedComps.length > 0

    console.log(`[AnalysisWorkflow] Classification: ${renovatedComps.length} renovated, ${allComparables.length - renovatedComps.length} as-is out of ${allComparables.length} total comps`)

    // Run appraisal on the appropriate comp pool
    let finalAppraisalResult: AppraisalResultWithFallback
    let arvCompsSource: 'renovated_only' | 'all_comps'

    if (hasRenovatedComps) {
      // PRIMARY PATH: Run appraisal rules on renovated comps only
      const renovatedAppraisal = appraisalService.evaluateWithFallback(
        bundle.property, renovatedComps, { filters, adjustments, minComps: 1 }
      )

      if (renovatedAppraisal.fallbackUsed !== 'no_comps') {
        // Renovated comps passed appraisal rules — use them for ARV
        arvCompsSource = 'renovated_only'
        const renovatedEnabledIds = new Set(
          renovatedAppraisal.comparables.filter((c) => c.isEnabled).map((c) => c.id)
        )

        // We still need evaluation data for ALL comps (for dashboard display)
        // Run appraisal on all comps to get filter/adjustment details
        const allCompsAppraisal = appraisalService.evaluateWithFallback(
          bundle.property, allComparables, { filters, adjustments, minComps: 3 }
        )

        // Build combined result: enabled = only renovated comps that passed rules
        // All other comps shown as disabled with reasons
        finalAppraisalResult = {
          ...allCompsAppraisal,
          comparables: allCompsAppraisal.comparables.map((c) => {
            if (renovatedEnabledIds.has(c.id)) {
              // Renovated comp that passed rules — enabled for ARV
              const renovatedComp = renovatedAppraisal.comparables.find((rc) => rc.id === c.id)
              return renovatedComp ? { ...renovatedComp, isEnabled: true } : { ...c, isEnabled: true }
            }
            // Non-renovated or didn't pass rules — disabled
            const isRenovated = renovatedCompIds.has(c.id)
            const disableReason = isRenovated
              ? 'Renovated comp excluded by appraisal rules'
              : 'Not a renovated comp (excluded from ARV)'
            return {
              ...c,
              isEnabled: false,
              evaluation: {
                ...c.evaluation,
                shouldDisable: true,
                disableReasons: [...(c.evaluation.disableReasons ?? []), disableReason],
              },
            }
          }),
          arv: renovatedAppraisal.arv,
          enabledCount: renovatedEnabledIds.size,
          disabledCount: allComparables.length - renovatedEnabledIds.size,
          fallbackUsed: renovatedAppraisal.fallbackUsed,
          confidence: renovatedAppraisal.confidence,
        }

        console.log(`[AnalysisWorkflow] Renovated-first: ${renovatedEnabledIds.size} renovated comps passed rules (fallback: ${renovatedAppraisal.fallbackUsed}), ARV=$${renovatedAppraisal.arv}`)
      } else {
        // No renovated comps passed even with relaxed rules — fall back to all comps
        arvCompsSource = 'all_comps'
        finalAppraisalResult = appraisalService.evaluateWithFallback(
          bundle.property, allComparables, { filters, adjustments, minComps: 3 }
        )
        console.log(`[AnalysisWorkflow] Renovated-first fallback: ${renovatedComps.length} renovated comps all failed rules, using all ${finalAppraisalResult.enabledCount} enabled comps, ARV=$${finalAppraisalResult.arv}`)
      }
    } else {
      // No renovated comps exist at all — use all comps with standard appraisal
      arvCompsSource = 'all_comps'
      finalAppraisalResult = appraisalResult
      console.log(`[AnalysisWorkflow] No renovated comps found, using all ${finalAppraisalResult.enabledCount} enabled comps, ARV=$${finalAppraisalResult.arv}`)
    }

    const enabledComps = finalAppraisalResult.comparables.filter((c) => c.isEnabled)
    const finalArv = finalAppraisalResult.arv

    // Summarize classifications for display
    const classificationSummary = appraisalService.summarizeClassifications(
      finalAppraisalResult.comparables,
      compClassifications
    )

    // ══════════════════════════════════════════════════════════════════════════
    // LLM BEST MATCH SELECTION
    //
    // As an underwriter, the "best match" is the comp that most closely
    // represents the subject property's post-renovation market value.
    // We use an LLM to weigh all factors holistically — physical similarity,
    // proximity, recency, renovation quality, and adjustment magnitude.
    // ══════════════════════════════════════════════════════════════════════════
    let bestMatch: { compId: string; reasoning: string } | undefined
    if (enabledComps.length >= 2) {
      try {
        bestMatch = await this.selectBestMatch(
          bundle.property, enabledComps, compClassifications, subjectClassification
        )
      } catch (error) {
        console.warn(`[AnalysisWorkflow] Best match selection failed (non-fatal):`, error instanceof Error ? error.message : error)
      }
    } else if (enabledComps.length === 1) {
      bestMatch = { compId: enabledComps[0].id, reasoning: 'Only comparable that passed all appraisal criteria.' }
    }

    // Calculate valuation
    const buybox = params.buybox ?? {}
    const subjectSqft = bundle.property.squareFeet || 0
    const compAvgSqft =
      enabledComps.length > 0
        ? enabledComps.reduce((sum, c) => sum + (c.squareFeet || 0), 0) / enabledComps.length
        : subjectSqft

    // Use vision-detected rehab level if available and user hasn't explicitly set one
    const visionRehabLevelIndex = visionAnalysis ? mapRehabNeedsToIndex(visionAnalysis.estimatedRehabNeeds) : null
    const selectedRehabLevelIndex = buybox.rehabLevelIndex ?? visionRehabLevelIndex ?? 2

    // Apply user's custom major item cost defaults (unless caller passed explicit majorItems)
    const resolvedMajorItems = buybox.majorItems ?? (
      params.customMajorItemCosts
        ? MAJOR_ITEMS.map((item) => ({
            id: item.id,
            enabled: false,
            cost: params.customMajorItemCosts![item.id] ?? item.defaultCost,
          }))
        : undefined
    )

    const valuation = valuationService.calculateValuation({
      arv: finalArv,
      subjectSqft,
      compAvgSqft,
      rehabLevelIndex: selectedRehabLevelIndex,
      majorItems: resolvedMajorItems,
      additionPlay: buybox.additionPlay ?? 0,
      closingCostsPercent: buybox.closingCostsPercent ?? 8,
      carryingCostsPercent: buybox.carryingCostsPercent ?? 2,
      wholesaleFee: buybox.wholesaleFee ?? 10000,
    })

    // Calculate all rehab level estimates for the current ARV
    const rehabLevelEstimates = calculateAllRehabLevelEstimates(valuationService, {
      arv: finalArv,
      subjectSqft,
      compAvgSqft,
      selectedRehabLevelIndex,
      majorItems: resolvedMajorItems,
      additionPlay: buybox.additionPlay ?? 0,
      closingCostsPercent: buybox.closingCostsPercent ?? 8,
      carryingCostsPercent: buybox.carryingCostsPercent ?? 2,
      wholesaleFee: buybox.wholesaleFee ?? 10000,
    })

    // Build applied settings snapshot for client-side recalculation
    const appliedSettings = {
      filters: filters.map((f) => ({
        type: f.type,
        enabled: f.enabled,
        value: f.value,
      })),
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
      rehabLevelIndex: selectedRehabLevelIndex,
      rehabTable: valuationService.getRehabTable(),
      majorItems: resolvedMajorItems,
      additionPlay: buybox.additionPlay ?? 0,
    }

    const arvSource: 'appraisal' | 'comp-selection' = arvCompsSource === 'renovated_only' ? 'comp-selection' : 'appraisal'

    // Build response
    return buildAnalysisResponse(
      bundle,
      finalAppraisalResult,
      photoBundle,
      valuation,
      {
        arvSource,
        finalArv,
        analysisId: params.jobId,
        subjectClassification,
        compClassifications,
        classificationSummary,
        subjectSupplementedFields,
        compSupplementedFields,
        rehabLevelEstimates,
        appliedSettings,
        visionAnalysis: visionAnalysis ?? undefined,
        apiCallStats,
        bestMatch,
      }
    )
  }

  /**
   * Use LLM to select the single best matching comp from enabled comps.
   * The best match is the comp that most accurately represents the subject's
   * post-renovation market value based on an underwriter's assessment.
   */
  private async selectBestMatch(
    subject: NormalizedProperty,
    enabledComps: AppraisedComparable[],
    compClassifications: Map<string, ClassificationResult>,
    subjectClassification?: ClassificationResult
  ): Promise<{ compId: string; reasoning: string }> {
    const llmProvider = createLLMProviderFromEnv(this.env)
    if (!llmProvider) {
      // No LLM available — fall back to rule-based selection
      return this.selectBestMatchByRules(subject, enabledComps, compClassifications)
    }

    const compDetails = enabledComps.map((comp, i) => {
      const cls = compClassifications.get(comp.id)
      const adj = comp.evaluation
      const filtersPassed = adj.filterResults.filter((f) => f.passed).length
      const filtersTotal = adj.filterResults.length
      const subMatch = adj.filterResults.find((f) => f.type === 'subdivision_match')?.passed ? 'Yes' : 'No'
      return `COMP ${i + 1} (ID: ${comp.id}):
  Address: ${comp.address}, ${comp.city}, ${comp.state}
  Sale Price: $${(comp.salePrice ?? 0).toLocaleString()} | Adjusted: $${(comp.adjustedSalePrice ?? comp.salePrice ?? 0).toLocaleString()}
  Sale Date: ${comp.saleDate ? new Date(comp.saleDate).toISOString().split('T')[0] : 'Unknown'}
  Sqft: ${comp.squareFeet ?? 'Unknown'} | Beds: ${comp.bedrooms ?? '?'} | Baths: ${comp.bathrooms ?? '?'}
  Year Built: ${comp.yearBuilt ?? 'Unknown'}
  Distance: ${comp.distanceMiles?.toFixed(2) ?? 'Unknown'} miles
  Subdivision: ${comp.subdivision ?? 'N/A'} | Same as subject: ${subMatch}
  Classification: ${cls?.classification ?? 'unknown'} (confidence: ${cls?.confidence ?? 0}%)
  Appraisal: ${filtersPassed}/${filtersTotal} filters passed, total adjustment: $${adj.totalAdjustment.toLocaleString()}
  Adjustment details: ${adj.adjustmentResults.filter((a) => a.applied).map((a) => `${a.type}: $${a.amount.toLocaleString()}`).join(', ') || 'None'}`
    }).join('\n\n')

    const prompt = `You are an expert real estate appraiser and underwriter selecting the BEST comparable sale for After Repair Value (ARV) calculation.

SUBJECT PROPERTY:
  Address: ${subject.address}, ${subject.city}, ${subject.state} ${subject.zipCode}
  Sqft: ${subject.squareFeet ?? 'Unknown'} | Beds: ${subject.bedrooms ?? '?'} | Baths: ${subject.bathrooms ?? '?'}
  Year Built: ${subject.yearBuilt ?? 'Unknown'}
  Subdivision: ${subject.subdivision ?? 'N/A'}
  Property Type: ${subject.propertyType ?? 'Unknown'}
  Classification: ${subjectClassification?.classification ?? 'unknown'}

COMPARABLE SALES (all passed appraisal filters):
${compDetails}

SELECTION CRITERIA (in priority order):
1. RENOVATION STATUS: After-renovation comps are strongly preferred — they represent the subject's target end-state
2. PHYSICAL SIMILARITY: Closest match in sqft (within 20%), bed/bath count, and year built
3. PROXIMITY: Closer comps reflect the same micro-market (same subdivision is ideal)
4. RECENCY: More recent sales better reflect current market conditions
5. MINIMAL ADJUSTMENTS: Fewer/smaller adjustments = more reliable price indicator
6. SALE PRICE RELIABILITY: Arm's-length transactions at market value

Select the ONE best comp. Your choice should be the comp that an FHA/VA certified appraiser would weight most heavily in determining the subject's ARV.

Respond ONLY with valid JSON (no markdown): {"bestCompId": "<comp_id>", "reasoning": "<1-2 sentences explaining why>"}`

    const result = await llmProvider.execute({
      prompt,
      responseFormat: 'json',
      temperature: 0.1,
      maxTokens: 200,
    })

    if (!result.success || !result.data?.content) {
      return this.selectBestMatchByRules(subject, enabledComps, compClassifications)
    }

    try {
      // Strip markdown code fences if present
      const content = result.data.content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
      const parsed = JSON.parse(content) as { bestCompId: string; reasoning: string }
      // Validate the comp ID actually exists
      if (enabledComps.some((c) => c.id === parsed.bestCompId)) {
        console.log(`[AnalysisWorkflow] LLM best match: ${parsed.bestCompId} — ${parsed.reasoning}`)
        return { compId: parsed.bestCompId, reasoning: parsed.reasoning }
      }
      console.warn(`[AnalysisWorkflow] LLM returned unknown comp ID: ${parsed.bestCompId}, falling back to rules`)
    } catch {
      console.warn(`[AnalysisWorkflow] Failed to parse LLM best match response, falling back to rules`)
    }

    return this.selectBestMatchByRules(subject, enabledComps, compClassifications)
  }

  /**
   * Rule-based best match fallback (when LLM is unavailable or fails).
   * Scores comps by: renovation status, subdivision match, filter pass rate, proximity.
   */
  private selectBestMatchByRules(
    subject: NormalizedProperty,
    enabledComps: AppraisedComparable[],
    compClassifications: Map<string, ClassificationResult>
  ): { compId: string; reasoning: string } {
    const scored = enabledComps.map((comp) => {
      let score = 0
      const reasons: string[] = []

      // Renovation status (highest priority)
      const cls = compClassifications.get(comp.id)?.classification ?? 'as_is'
      if (cls === 'after_renovation') {
        score += 100
        reasons.push('renovated')
      }

      // Subdivision match
      const subMatch = comp.evaluation.filterResults.find((f) => f.type === 'subdivision_match')?.passed
      if (subMatch) {
        score += 50
        reasons.push('same subdivision')
      }

      // Sqft similarity (closer = better, max 30 points)
      if (subject.squareFeet && comp.squareFeet) {
        const sqftDiff = Math.abs(subject.squareFeet - comp.squareFeet) / subject.squareFeet
        score += Math.max(0, 30 - Math.round(sqftDiff * 100))
      }

      // Proximity (closer = better, max 20 points)
      if (comp.distanceMiles != null) {
        score += Math.max(0, 20 - Math.round(comp.distanceMiles * 20))
      }

      // Fewer adjustments = more reliable (max 10 points)
      const adjCount = comp.evaluation.adjustmentResults.filter((a) => a.applied).length
      score += Math.max(0, 10 - adjCount * 3)

      return { comp, score, reasons }
    })

    scored.sort((a, b) => b.score - a.score)
    const best = scored[0]

    return {
      compId: best.comp.id,
      reasoning: `Best rule-based match: ${best.reasons.join(', ')}. Score: ${best.score}.`,
    }
  }

  /**
   * Get the DO ID for a job (format: userId:propertyKey)
   */
  private getDoId(userId: string, propertyKey: string) {
    return this.env.ANALYSIS_JOB.idFromName(`${userId}:${propertyKey}`)
  }

  /**
   * Update progress in Durable Object
   */
  private async updateProgress(
    userId: string,
    propertyKey: string,
    stepName: string,
    status: 'in_progress' | 'completed' | 'failed'
  ): Promise<void> {
    const doId = this.getDoId(userId, propertyKey)
    const stub = this.env.ANALYSIS_JOB.get(doId)

    try {
      const resp = await stub.fetch(
        new Request('http://internal/step', {
          method: 'POST',
          body: JSON.stringify({ step: stepName, status }),
        })
      )
      await resp.text() // Consume body to dispose RPC result
    } catch (error) {
      // Non-critical, just log
      console.warn(`[AnalysisWorkflow] Failed to update progress: ${error}`)
    }
  }

  /**
   * Broadcast step data fragment to SSE clients for progressive rendering
   */
  private async broadcastStepData(
    userId: string,
    propertyKey: string,
    step: AnalysisStep,
    data: Record<string, unknown>
  ): Promise<void> {
    const doId = this.getDoId(userId, propertyKey)
    const stub = this.env.ANALYSIS_JOB.get(doId)

    try {
      const resp = await stub.fetch(
        new Request('http://internal/step-data', {
          method: 'POST',
          body: JSON.stringify({ step, data }),
        })
      )
      await resp.text() // Consume body to dispose RPC result
    } catch (error) {
      // Non-critical — progressive rendering is a nice-to-have
      console.warn(`[AnalysisWorkflow] Failed to broadcast step data for ${step}: ${error}`)
    }
  }

  /**
   * Broadcast partial result to SSE clients via Durable Object
   */
  private async broadcastPartialResult(userId: string, propertyKey: string, result: AnalysisResponse): Promise<void> {
    const doId = this.getDoId(userId, propertyKey)
    const stub = this.env.ANALYSIS_JOB.get(doId)

    try {
      const resp = await stub.fetch(
        new Request('http://internal/partial-result', {
          method: 'POST',
          body: JSON.stringify({ result }),
        })
      )
      await resp.text() // Consume body to dispose RPC result
    } catch (error) {
      // Non-critical — result will still be available via polling
      console.warn(`[AnalysisWorkflow] Failed to broadcast partial result: ${error}`)
    }
  }

  /**
   * Store result in Durable Object
   */
  private async storeResult(userId: string, propertyKey: string, result: AnalysisResponse): Promise<void> {
    const doId = this.getDoId(userId, propertyKey)
    const stub = this.env.ANALYSIS_JOB.get(doId)

    try {
      const resp = await stub.fetch(
        new Request('http://internal/result', {
          method: 'POST',
          body: JSON.stringify({ result }),
        })
      )
      await resp.text() // Consume body to dispose RPC result
    } catch (error) {
      console.error(`[AnalysisWorkflow] Failed to store result: ${error}`)
    }
  }

  /**
   * Store error in Durable Object
   */
  private async storeError(userId: string, propertyKey: string, errorMessage: string): Promise<void> {
    const doId = this.getDoId(userId, propertyKey)
    const stub = this.env.ANALYSIS_JOB.get(doId)

    try {
      const resp = await stub.fetch(
        new Request('http://internal/error', {
          method: 'POST',
          body: JSON.stringify({
            error: {
              code: 'WORKFLOW_ERROR',
              message: errorMessage,
              retryable: true,
            },
          }),
        })
      )
      await resp.text() // Consume body to dispose RPC result
    } catch (error) {
      console.error(`[AnalysisWorkflow] Failed to store error: ${error}`)
    }
  }

  /**
   * Push analysis results to GoHighLevel opportunity
   */
  private async pushToGHL(
    ghlParams: NonNullable<AnalysisWorkflowParams['ghl']>,
    response: AnalysisResponse,
    jobId: string
  ) {
    const {
      buildGHLCustomFields,
      updateGHLOpportunity,
      extractAnalysisFieldValue,
    } = await import('../services/ghl')

    const customFields = buildGHLCustomFields(response, ghlParams.fieldMappings, jobId)

    let monetaryValue: number | undefined
    if (ghlParams.monetaryValueField) {
      const val = extractAnalysisFieldValue(response, ghlParams.monetaryValueField)
      if (typeof val === 'number') monetaryValue = val
    }

    return updateGHLOpportunity({
      apiToken: ghlParams.apiToken,
      opportunityId: ghlParams.opportunityId,
      customFields,
      monetaryValue,
    })
  }
}
