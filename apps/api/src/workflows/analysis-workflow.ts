/**
 * Analysis Workflow
 *
 * Cloudflare Workflow for processing property analysis with parallel execution.
 *
 * Pipeline:
 * 1. Fetch property bundle (property + comps + enrichment)
 * 2. Parallel fan-out: Fetch photos for all properties (rate-limited)
 * 3. Parallel classification (one LLM call per property, all concurrent)
 * 4. Calculate weighted ARV and build response
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

import { createPropertyApi, type PropertyBundle } from '../services/property-api'
import type { NormalizedComparable } from '../services/property-api/types'
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
import {
  buildAnalysisResponse,
  mergeZillowDataIntoBundle,
  calculateAllRehabLevelEstimates,
  type AnalysisResponse,
  type SupplementedField,
  type ApiCallStats,
} from '../services/analysis'
import {
  resetCoreLogicCallLog,
  getCoreLogicCallLog,
  getCoreLogicCallCount,
} from '../services/property-api/providers/corelogic'
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

    // Reset API call tracking for this analysis run
    resetCoreLogicCallLog()

    try {
      // ═══════════════════════════════════════════════════════════════════════
      // STEP 1: Fetch Property Bundle (skipped when preloaded from endpoint)
      // ═══════════════════════════════════════════════════════════════════════
      let bundle: PropertyBundle

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
        bundle = bundleData as PropertyBundle

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
      // STEP 3: Parallel Photo Fetch (Fan-Out)
      // ═══════════════════════════════════════════════════════════════════════
      await this.updateProgress(params.userId, params.propertyKey, 'photo_fetch', 'in_progress')
      const photoStart = Date.now()
      let photoBundle: PhotoBundle | null = null

      const shouldFetchPhotos = params.photoAnalysis?.enabled !== false

      let photoCallStats = { firecrawlCalls: 0, llmCalls: 0, cacheHits: 0 }

      if (shouldFetchPhotos) {
        const photoData = await step.do(
          'fetch-photos-parallel',
          {
            retries: { limit: 2, delay: '3 seconds', backoff: 'exponential' },
            timeout: '3 minutes',
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          async (): Promise<any> => {
            const result = await this.fetchPhotosParallel(bundle, bundle.comparables, params)
            return serialize(result)
          }
        )
        const photoResult = photoData as { photoBundle: PhotoBundle | null; photoCallStats: { firecrawlCalls: number; llmCalls: number; cacheHits: number } }
        photoBundle = photoResult.photoBundle
        photoCallStats = photoResult.photoCallStats
      }

      stepTimings['photo_fetch'] = Date.now() - photoStart
      console.log(`[AnalysisWorkflow] Photos fetched: subject=${!!photoBundle?.subject}, comps=${Object.keys(photoBundle?.comps ?? {}).length}`)

      // Merge Zillow data into bundle to supplement missing CoreLogic data
      // This fills in null bedrooms, bathrooms, sqft, etc. from Zillow listings
      const mergeResult = mergeZillowDataIntoBundle(bundle, photoBundle)
      const mergedBundle = mergeResult.bundle
      const subjectSupplementedFields = mergeResult.subjectSupplementedFields
      const compSupplementedFields = mergeResult.compSupplementedFields
      console.log(`[AnalysisWorkflow] Zillow data merged: subject supplemented ${subjectSupplementedFields.length} fields, ${compSupplementedFields.size} comps supplemented`)

      await this.updateProgress(params.userId, params.propertyKey, 'photo_fetch', 'completed')

      // Broadcast photos and supplemented data for progressive rendering
      {
        const subjectPhotos = photoBundle?.subject?.photos.slice(0, 5) ?? []
        // Build comp updates: photos + any Zillow-supplemented fields
        const mergedCompMap = new Map(mergedBundle.comparables.map((c) => [c.id, c]))
        const compPhotoItems = appraisalResult.comparables.map((comp) => {
          const merged = mergedCompMap.get(comp.id)
          const item: Record<string, unknown> = {
            id: comp.id,
            photos: photoBundle?.comps[comp.id]?.photos.slice(0, 3) ?? [],
          }
          // Include supplemented fields if they differ from original
          if (merged && merged.bedrooms !== comp.bedrooms) item.bedrooms = merged.bedrooms
          if (merged && merged.bathrooms !== comp.bathrooms) item.bathrooms = merged.bathrooms
          if (merged && merged.squareFeet !== comp.squareFeet) item.squareFeet = merged.squareFeet
          if (merged && merged.yearBuilt !== comp.yearBuilt) item.yearBuilt = merged.yearBuilt
          return item
        })
        // Also send updated subject fields if supplemented from Zillow
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

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 4: Parallel Classification (one LLM call per property, concurrent)
      // ═══════════════════════════════════════════════════════════════════════
      await this.updateProgress(params.userId, params.propertyKey, 'comp_selection', 'in_progress')
      const classifyStart = Date.now()

      const classificationData = await step.do(
        'classify-properties',
        {
          retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' },
          timeout: '3 minutes',
        },
        async () => {
          const result = await this.classifyAllParallel(
            mergedBundle,
            mergedBundle.comparables,
            photoBundle,
            params.visionClassification ?? false
          )
          // Convert Map to plain object for serialization
          const compClassificationsObj: Record<string, ClassificationResult> = {}
          for (const [key, value] of result.compClassifications) {
            compClassificationsObj[key] = value
          }
          return serialize({
            subjectClassification: result.subjectClassification ?? null,
            compClassifications: compClassificationsObj,
          })
        }
      )
      const classificationResult = classificationData as {
        subjectClassification: ClassificationResult | null
        compClassifications: Record<string, ClassificationResult>
      }

      // Convert back to Map for internal use
      const compClassifications = new Map<string, ClassificationResult>(
        Object.entries(classificationResult.compClassifications)
      )
      const subjectClassification = classificationResult.subjectClassification ?? undefined

      stepTimings['classification'] = Date.now() - classifyStart
      console.log(`[AnalysisWorkflow] Classification complete: ${compClassifications.size} comps classified in parallel`)

      await this.updateProgress(params.userId, params.propertyKey, 'comp_selection', 'completed')

      // Broadcast classification data for progressive rendering
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

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 4.5: Vision Analysis of Subject Property (determine rehab level)
      // ═══════════════════════════════════════════════════════════════════════
      let visionAnalysis: PropertyConditionAnalysis | null = null

      if (params.visionClassification && photoBundle?.subject?.photos?.length) {
        const visionStart = Date.now()
        console.log(`[AnalysisWorkflow] Running vision analysis on ${photoBundle.subject.photos.length} subject photos`)

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
              return serialize(result)
            }
          )

          const visionResult = visionData as { success: boolean; data: PropertyConditionAnalysis | null }
          if (visionResult.success && visionResult.data) {
            visionAnalysis = visionResult.data
            console.log(`[AnalysisWorkflow] Vision analysis complete: condition=${visionAnalysis.overallCondition}, rehabNeeds=${visionAnalysis.estimatedRehabNeeds}`)
          }

          stepTimings['vision_analysis'] = Date.now() - visionStart
        } catch (error) {
          // Vision analysis failure is non-fatal
          console.warn(`[AnalysisWorkflow] Vision analysis failed (non-fatal):`, error instanceof Error ? error.message : error)
        }
      }

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 5: Calculate ARV and Build Response
      // ═══════════════════════════════════════════════════════════════════════
      await this.updateProgress(params.userId, params.propertyKey, 'valuation', 'in_progress')
      const arvStart = Date.now()

      // Build API call statistics
      // Merge preloaded stats (from route handler) with any calls made during workflow
      const workflowEndpoints = getCoreLogicCallLog()
      const workflowTotal = getCoreLogicCallCount()
      const preloaded = params.preloadedApiCallStats?.corelogic
      const corelogicTotal = (preloaded?.total ?? 0) + workflowTotal
      const corelogicEndpoints = [
        ...(preloaded?.endpoints ?? []),
        ...workflowEndpoints,
      ]
      const visionLlmCalls = visionAnalysis ? 1 : 0
      const apiCallStats: ApiCallStats = {
        corelogic: {
          total: corelogicTotal,
          endpoints: corelogicEndpoints,
        },
        firecrawl: {
          total: photoCallStats.firecrawlCalls,
          cached: photoCallStats.cacheHits,
        },
        llm: {
          total: photoCallStats.llmCalls + visionLlmCalls,
          breakdown: [
            ...(photoCallStats.llmCalls > 0 ? [{ purpose: 'zillow_parsing', count: photoCallStats.llmCalls }] : []),
            ...(visionLlmCalls > 0 ? [{ purpose: 'vision_analysis', count: visionLlmCalls }] : []),
          ],
        },
        totalExternalCalls: corelogicTotal + photoCallStats.firecrawlCalls + photoCallStats.llmCalls + visionLlmCalls,
      }

      console.log(`[AnalysisWorkflow] API call stats: CoreLogic=${corelogicTotal}, Firecrawl=${photoCallStats.firecrawlCalls} (${photoCallStats.cacheHits} cached), LLM=${photoCallStats.llmCalls + visionLlmCalls}`)

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
  ): Promise<PropertyBundle> {
    const propertyApi = createPropertyApi(this.env)

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
      },
      skipCache: params.skipCache,
    })

    if (!bundleResult.success) {
      throw new Error(bundleResult.error || 'Failed to fetch property bundle')
    }

    return bundleResult.data
  }

  /**
   * Fetch photos for all properties in parallel with rate limiting
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

    const enabledComps = appraisalResult.comparables.filter((c) => c.isEnabled)

    // Summarize classifications for display (labels comps, computes group averages)
    const classificationSummary = appraisalService.summarizeClassifications(
      appraisalResult.comparables,
      compClassifications
    )

    // ARV: prefer after_renovation comps; fall back to all enabled comps if none exist
    const afterRenovationComps = enabledComps.filter(
      (c) => (compClassifications.get(c.id)?.classification ?? 'as_is') === 'after_renovation'
    )
    const compsForArv = afterRenovationComps.length > 0 ? afterRenovationComps : enabledComps
    const arvSource: 'appraisal' | 'comp-selection' = 'appraisal'
    const finalArv = afterRenovationComps.length > 0
      ? appraisalService.calculateARV(afterRenovationComps, bundle.property.squareFeet)
      : appraisalResult.arv

    console.log(`[AnalysisWorkflow] ARV computed from ${compsForArv.length} comp(s) (${afterRenovationComps.length > 0 ? 'after_renovation only' : 'all enabled — no renovated comps found'}): $${finalArv}`)

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
      desiredProfit: buybox.desiredProfit ?? undefined,
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
      desiredProfit: buybox.desiredProfit ?? undefined,
    })

    // If we have after_renovation comps, mark as_is enabled comps as excluded
    // so the dashboard correctly shows them in the "Excluded from ARV" section
    const finalAppraisalResult = afterRenovationComps.length > 0
      ? {
          ...appraisalResult,
          comparables: appraisalResult.comparables.map((c) => {
            if (!c.isEnabled) return c
            const cls = compClassifications.get(c.id)?.classification ?? 'as_is'
            if (cls !== 'after_renovation') {
              return { ...c, isEnabled: false, evaluation: { ...c.evaluation, shouldDisable: true, disableReasons: [...(c.evaluation.disableReasons ?? []), 'Not a renovated comp (excluded from ARV)'] } }
            }
            return c
          }),
          enabledCount: afterRenovationComps.length,
          disabledCount: appraisalResult.comparables.length - afterRenovationComps.length,
          arv: finalArv,
        }
      : appraisalResult

    // Build applied settings snapshot for client-side recalculation
    const rules = params.appraisalRules ?? {}
    const appliedFilters = rules.filters ?? DEFAULT_FILTERS
    const appliedAdjustments = rules.adjustments ?? DEFAULT_ADJUSTMENTS

    const appliedSettings = {
      filters: appliedFilters.map((f) => ({
        type: f.type,
        enabled: f.enabled,
        value: f.value,
      })),
      adjustments: appliedAdjustments.map((a) => ({
        type: a.type,
        enabled: a.enabled,
        amount: a.amount,
        percent: a.percent,
      })),
      dealParams: {
        closingCostsPercent: buybox.closingCostsPercent ?? 8,
        carryingCostsPercent: buybox.carryingCostsPercent ?? 2,
        wholesaleFee: buybox.wholesaleFee ?? 10000,
        desiredProfit: buybox.desiredProfit ?? null,
      },
      rehabLevelIndex: selectedRehabLevelIndex,
      rehabTable: valuationService.getRehabTable(),
      majorItems: resolvedMajorItems,
      additionPlay: buybox.additionPlay ?? 0,
    }

    // Build response
    return buildAnalysisResponse(
      bundle,
      finalAppraisalResult,
      photoBundle,
      null, // No LLM comp selection in workflow (using batch classification instead)
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
      }
    )
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
