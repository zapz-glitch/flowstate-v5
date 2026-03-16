/**
 * Analysis Workflow
 *
 * Cloudflare Workflow for processing property analysis with parallel execution.
 *
 * Pipeline:
 * 1. Fetch property bundle (property + comps + enrichment) — preloaded by route handler
 * 2. Fetch photos + Zillow merge + classify (ALL comps, enriches data before appraisal)
 * 3. Appraisal rules + valuation (combined — runs on enriched data, one checkpoint)
 * 4. Store result + save report
 * 5. Push to GHL (optional, non-fatal)
 * 6. Vision analysis (background, non-blocking)
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
    const workflowStart = Date.now()

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
      // STEP 2: Fetch Photos + Merge Zillow Data + Classify
      // Runs BEFORE appraisal so rules operate on Zillow-enriched data
      // (supplemented bedrooms, bathrooms, sqft, yearBuilt).
      // Fetches for subject + ALL comps (appraisal hasn't filtered yet).
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
          timeout: '45 seconds',
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (): Promise<any> => {
          let stepPhotoBundle: PhotoBundle | null = null
          let stepPhotoCallStats = { firecrawlCalls: 0, llmCalls: 0, cacheHits: 0 }

          // 1. Fetch photos for subject + ALL comps (appraisal hasn't run yet)
          const photoFetchStart = Date.now()
          if (shouldFetchPhotos) {
            const photoResult = await this.fetchPhotosParallel(bundle, bundle.comparables, params)
            stepPhotoBundle = photoResult.photoBundle
            stepPhotoCallStats = photoResult.photoCallStats
          }
          console.log(`[AnalysisWorkflow][Timing] Step 2a (photo fetch): ${Date.now() - photoFetchStart}ms, firecrawl=${stepPhotoCallStats.firecrawlCalls}, llm=${stepPhotoCallStats.llmCalls}, cached=${stepPhotoCallStats.cacheHits}`)

          // 2. Merge Zillow data into bundle to supplement missing CoreLogic fields
          const mergeStart = Date.now()
          const mergeResult = mergeZillowDataIntoBundle(bundle, stepPhotoBundle)
          console.log(`[AnalysisWorkflow][Timing] Step 2b (zillow merge): ${Date.now() - mergeStart}ms`)

          // 3. Classify subject + ALL comps using enriched descriptions + Zillow features
          const classifyStart = Date.now()
          const classResult = await this.classifyAllParallel(
            mergeResult.bundle,
            mergeResult.bundle.comparables,
            stepPhotoBundle,
            params.visionClassification ?? false
          )
          console.log(`[AnalysisWorkflow][Timing] Step 2c (classify all): ${Date.now() - classifyStart}ms`)

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
      console.log(`[AnalysisWorkflow][Timing] Step 2 total (photos+merge+classify): ${stepTimings['photo_fetch']}ms (elapsed: ${Date.now() - workflowStart}ms)`)
      console.log(`[AnalysisWorkflow] Photos fetched: subject=${!!photoBundle?.subject}, comps=${Object.keys(photoBundle?.comps ?? {}).length}`)
      console.log(`[AnalysisWorkflow] Zillow data merged: subject supplemented ${subjectSupplementedFields.length} fields, ${compSupplementedFields.size} comps supplemented`)
      console.log(`[AnalysisWorkflow] Classification complete: ${compClassifications.size} comps classified`)

      await this.updateProgress(params.userId, params.propertyKey, 'photo_fetch', 'completed')

      // Broadcast photos + supplemented data for progressive rendering
      {
        const subjectPhotos = photoBundle?.subject?.photos.slice(0, 5) ?? []
        const mergedCompMap = new Map(mergedBundle.comparables.map((c) => [c.id, c]))
        const compPhotoItems = bundle.comparables.map((comp) => {
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

        const compClsItems = bundle.comparables.map((comp) => {
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
      // STEP 3: Appraisal Rules + Valuation (combined — both CPU-bound)
      // Runs on Zillow-enriched data for better filter accuracy.
      // Combining saves one workflow checkpoint (~300ms).
      // ═══════════════════════════════════════════════════════════════════════
      await this.updateProgress(params.userId, params.propertyKey, 'appraisal_rules', 'in_progress')
      const appraisalValuationStart = Date.now()

      // Build API call statistics
      const corelogicStats = params.preloadedApiCallStats?.corelogic ?? propertyCallStats ?? { total: 0, cached: 0, endpoints: [] }
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
          total: photoCallStats.llmCalls,
          cached: 0,
          breakdown: [
            ...(photoCallStats.llmCalls > 0 ? [{ purpose: 'zillow_parsing', count: photoCallStats.llmCalls }] : []),
          ],
        },
        totalExternalCalls: corelogicStats.total + photoCallStats.firecrawlCalls + photoCallStats.llmCalls,
      }

      console.log(`[AnalysisWorkflow] API call stats: CoreLogic=${corelogicStats.total} (${corelogicStats.cached} cached), Firecrawl=${photoCallStats.firecrawlCalls} (${photoCallStats.cacheHits} cached), LLM=${photoCallStats.llmCalls}`)

      const combinedAppraisalData = await step.do(
        'appraisal-and-valuation',
        { timeout: '30 seconds' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (): Promise<any> => {
          // --- Apply appraisal rules on Zillow-enriched data ---
          const appraisalService = createAppraisalService()
          const rules = params.appraisalRules ?? {}
          const filters = rules.filters ?? DEFAULT_FILTERS
          const adjustments = rules.adjustments ?? DEFAULT_ADJUSTMENTS

          const appraisalResult = appraisalService.evaluateWithFallback(
            mergedBundle.property,
            mergedBundle.comparables,
            { filters, adjustments, minComps: 3 }
          )
          if (appraisalResult.fallbackUsed === 'no_comps') {
            throw new Error('BAD_DEAL: No comparable sales found even with relaxed criteria. Insufficient data to determine ARV.')
          }

          // --- Build response (renovated-first logic + valuation) ---
          const response = await this.buildFinalResponse(
            params,
            mergedBundle,
            appraisalResult,
            photoBundle,
            subjectClassification,
            compClassifications,
            subjectSupplementedFields,
            compSupplementedFields,
            null, // vision runs after broadcast
            apiCallStats
          )

          return serialize({ response, appraisalResult })
        }
      )
      const { response, appraisalResult } = combinedAppraisalData as unknown as {
        response: AnalysisResponse
        appraisalResult: AppraisalResultWithFallback
      }

      stepTimings['appraisal_valuation'] = Date.now() - appraisalValuationStart
      const enabledComps = appraisalResult.comparables.filter((c) => c.isEnabled)
      console.log(`[AnalysisWorkflow][Timing] Step 3 (appraisal + valuation): ${stepTimings['appraisal_valuation']}ms (elapsed: ${Date.now() - workflowStart}ms)`)
      console.log(`[AnalysisWorkflow] Appraisal complete: ${enabledComps.length} comps enabled (fallback: ${appraisalResult.fallbackUsed})`)

      await this.updateProgress(params.userId, params.propertyKey, 'appraisal_rules', 'completed')

      // Broadcast appraisal results (now includes photos + classifications from Step 2)
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
              const cls = compClassifications.get(comp.id)
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
                photos: photoBundle?.comps[comp.id]?.photos.slice(0, 3) ?? [],
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
                classification: cls ? {
                  type: cls.classification,
                  confidence: cls.confidence,
                } : null,
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

      await this.updateProgress(params.userId, params.propertyKey, 'valuation', 'in_progress')
      await this.updateProgress(params.userId, params.propertyKey, 'valuation', 'completed')

      // Broadcast result to SSE clients immediately (before storing/vision)
      // This allows the dashboard to render results while background tasks complete
      await this.broadcastPartialResult(params.userId, params.propertyKey, response)

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 6: Store Result + Save Report (combined to reduce checkpoint overhead)
      // ═══════════════════════════════════════════════════════════════════════
      const storeStart = Date.now()
      await this.updateProgress(params.userId, params.propertyKey, 'response_build', 'in_progress')
      await step.do(
        'store-and-save',
        {
          retries: { limit: 2, delay: '1 second' },
          timeout: '15 seconds',
        },
        async () => {
          // Store in Durable Object (for SSE clients)
          await this.storeResult(params.userId, params.propertyKey, response)

          // Save to DB (for report page) — non-fatal if it fails
          try {
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
            console.log(`[AnalysisWorkflow] Report saved to DB for job ${params.jobId}`)
          } catch (error) {
            console.warn(`[AnalysisWorkflow] Failed to save report (non-fatal):`, error instanceof Error ? error.message : error)
          }

          return { stored: true }
        }
      )
      console.log(`[AnalysisWorkflow][Timing] Step 6 (store + save): ${Date.now() - storeStart}ms (elapsed: ${Date.now() - workflowStart}ms)`)

      await this.updateProgress(params.userId, params.propertyKey, 'response_build', 'completed')

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

      // ═══════════════════════════════════════════════════════════════════════
      // BACKGROUND: Vision Analysis (runs after result is already delivered)
      // Non-blocking — user sees results immediately, vision updates via SSE
      // ═══════════════════════════════════════════════════════════════════════
      const subjectKeywordConfidence = subjectClassification?.confidence ?? 0
      const shouldRunVision = params.visionClassification
        && photoBundle?.subject?.photos?.length
        && subjectKeywordConfidence < 70

      if (shouldRunVision) {
        const visionStart = Date.now()
        console.log(`[AnalysisWorkflow] Running background vision analysis on ${photoBundle!.subject!.photos.length} subject photos`)

        try {
          const visionData = await step.do(
            'vision-analysis-background',
            {
              retries: { limit: 2, delay: '3 seconds', backoff: 'exponential' },
              timeout: '1 minute',
            },
            async () => {
              const visionService = createVisionService(this.env)
              if (!visionService.isAvailable()) {
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
            // Push vision update to SSE clients via partial result
            await this.broadcastStepData(params.userId, params.propertyKey, 'vision_analysis', serialize({
              visionAnalysis: {
                overallCondition: visionResult.data.overallCondition,
                confidence: visionResult.data.confidence,
                estimatedRehabNeeds: visionResult.data.estimatedRehabNeeds,
                summary: visionResult.data.summary,
                exterior: visionResult.data.exterior,
                interior: visionResult.data.interior,
              },
            }))
            console.log(`[AnalysisWorkflow] Background vision complete: ${visionResult.data.overallCondition} (${Date.now() - visionStart}ms)`)
          }

          stepTimings['vision_analysis'] = Date.now() - visionStart
        } catch (error) {
          console.warn(`[AnalysisWorkflow] Background vision failed (non-fatal):`, error instanceof Error ? error.message : error)
        }
      }

      const completedAt = new Date().toISOString()
      const durationMs = Date.now() - new Date(startedAt).getTime()

      console.log(`[AnalysisWorkflow][Timing] Job ${params.jobId} completed in ${durationMs}ms`)
      console.log(`[AnalysisWorkflow][Timing] Step breakdown: ${JSON.stringify(stepTimings)}`)

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

    const maxComps = params.photoAnalysis?.maxComps ?? 5
    const compsForPhotos = comps.slice(0, maxComps)

    console.log(`[AnalysisWorkflow][Timing] fetchPhotosParallel: fetching subject + ${compsForPhotos.length} comps (max ${maxComps})`)
    const fetchStart = Date.now()

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

    const callStats = photoService.getCallStats()
    console.log(`[AnalysisWorkflow][Timing] fetchPhotosParallel completed: ${Date.now() - fetchStart}ms, firecrawl=${callStats.firecrawlCalls}, llm=${callStats.llmCalls}, cached=${callStats.cacheHits}`)

    return {
      photoBundle,
      photoCallStats: callStats,
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

    // Build classify input for each property, including rich Zillow data
    const subjectPhotos = photoBundle?.subject
    const allProperties = [
      {
        id: bundle.property.id,
        isSubject: true,
        description: subjectPhotos?.description,
        features: subjectPhotos?.features,
        whatsSpecial: subjectPhotos?.whatsSpecial,
        flooring: subjectPhotos?.flooring,
        appliances: subjectPhotos?.appliances,
        exteriorFeatures: subjectPhotos?.exteriorFeatures,
        roof: subjectPhotos?.roof,
        construction: subjectPhotos?.construction,
        heating: subjectPhotos?.heating,
        cooling: subjectPhotos?.cooling,
        pool: subjectPhotos?.pool,
        propertyType: subjectPhotos?.propertyType,
      },
      ...comps.map((comp) => {
        const compPhotos = photoBundle?.comps[comp.id]
        return {
          id: comp.id,
          isSubject: false,
          description: compPhotos?.description,
          features: compPhotos?.features,
          whatsSpecial: compPhotos?.whatsSpecial,
          flooring: compPhotos?.flooring,
          appliances: compPhotos?.appliances,
          exteriorFeatures: compPhotos?.exteriorFeatures,
          roof: compPhotos?.roof,
          construction: compPhotos?.construction,
          heating: compPhotos?.heating,
          cooling: compPhotos?.cooling,
          pool: compPhotos?.pool,
          propertyType: compPhotos?.propertyType,
        }
      }),
    ]

    console.log(`[AnalysisWorkflow] Classifying ${allProperties.length} properties in parallel (with rich Zillow data)`)

    // Fire all classification requests concurrently
    const results = await Promise.allSettled(
      allProperties.map((prop) =>
        classificationService.classifyProperty(prop).then((result) => ({ id: prop.id, result }))
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

        // Reuse Step 2 appraisal result for all-comp evaluation data (dashboard display)
        // instead of re-running appraisal on all comps
        // Build combined result: enabled = only renovated comps that passed rules
        // All other comps shown as disabled with reasons
        finalAppraisalResult = {
          ...appraisalResult,
          comparables: appraisalResult.comparables.map((c) => {
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
        // No renovated comps passed even with relaxed rules — reuse Step 2 all-comps result
        arvCompsSource = 'all_comps'
        finalAppraisalResult = appraisalResult
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
    // BEST MATCH SELECTION (rule-based for speed)
    // ══════════════════════════════════════════════════════════════════════════
    console.log(`[AnalysisWorkflow][Timing] buildFinalResponse: appraisal re-evaluation done (elapsed in step)`)
    let bestMatch: { compId: string; reasoning: string } | undefined
    if (enabledComps.length >= 2) {
      bestMatch = this.selectBestMatchByRules(bundle.property, enabledComps, compClassifications)
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
   * Rule-based best match selection.
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
