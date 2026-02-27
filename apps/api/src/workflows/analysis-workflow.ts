/**
 * Analysis Workflow
 *
 * Cloudflare Workflow for processing property analysis with parallel execution.
 *
 * Pipeline:
 * 1. Fetch property bundle (property + comps + enrichment)
 * 2. Parallel fan-out: Fetch photos for all properties (rate-limited)
 * 3. Batch classification (1-2 LLM calls instead of 11)
 * 4. Calculate weighted ARV and build response
 *
 * Benefits over Queue-based approach:
 * - True parallel execution with fan-out
 * - Automatic retries with backoff per step
 * - Durable execution (survives restarts)
 * - Step-level caching
 * - 10-15 seconds vs 60-120 seconds
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
import {
  createAppraisalService,
  DEFAULT_FILTERS,
  DEFAULT_ADJUSTMENTS,
  type AppraisedComparable,
  type AppraisalResultWithFallback,
} from '../services/appraisal'
import { filtersToApiParams } from '../services/appraisal/types'
import { createValuationService } from '../services/valuation'
import { createPhotoService, type PhotoBundle } from '../services/photo-provider'
import { createBatchClassificationService } from '../services/classification/batch'
import type { ClassificationResult } from '../services/classification'
import {
  selectBestCompFromData,
  buildAnalysisResponse,
  mergeZillowDataIntoBundle,
  calculateAllRehabLevelEstimates,
  type AnalysisResponse,
  type SupplementedField,
} from '../services/analysis'

// ─── Serialization Helpers ────────────────────────────────────────────────────
// Cloudflare Workflows require all step returns to be JSON-serializable
// We use JSON round-trip to strip non-serializable properties

function serialize<T>(data: T): T {
  return JSON.parse(JSON.stringify(data))
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
      // STEP 1: Fetch Property Bundle
      // ═══════════════════════════════════════════════════════════════════════
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
      const bundle = bundleData as PropertyBundle

      stepTimings['property_fetch'] = Date.now() - bundleStart
      console.log(`[AnalysisWorkflow] Property bundle fetched: ${bundle.comparables.length} comps`)

      await this.updateProgress(params.userId, params.propertyKey, 'property_fetch', 'completed')

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
            { filters, adjustments, minComps: 3, maxNearestComps: 5 }
          )
          return serialize(result)
        }
      )
      const appraisalResult = appraisalData as AppraisalResultWithFallback

      stepTimings['appraisal'] = Date.now() - appraisalStart
      const enabledComps = appraisalResult.comparables.filter((c) => c.isEnabled)
      console.log(`[AnalysisWorkflow] Appraisal complete: ${enabledComps.length} comps enabled`)

      await this.updateProgress(params.userId, params.propertyKey, 'appraisal_rules', 'completed')

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 3: Parallel Photo Fetch (Fan-Out)
      // ═══════════════════════════════════════════════════════════════════════
      await this.updateProgress(params.userId, params.propertyKey, 'photo_fetch', 'in_progress')
      const photoStart = Date.now()
      let photoBundle: PhotoBundle | null = null

      const shouldFetchPhotos = params.photoAnalysis?.enabled !== false

      if (shouldFetchPhotos) {
        const photoData = await step.do(
          'fetch-photos-parallel',
          {
            retries: { limit: 2, delay: '3 seconds', backoff: 'exponential' },
            timeout: '3 minutes',
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          async (): Promise<any> => {
            const result = await this.fetchPhotosParallel(bundle, enabledComps, params)
            return serialize(result)
          }
        )
        photoBundle = photoData as PhotoBundle | null
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

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 4: Batch Classification (1-2 LLM calls instead of 11)
      // ═══════════════════════════════════════════════════════════════════════
      await this.updateProgress(params.userId, params.propertyKey, 'comp_selection', 'in_progress')
      const classifyStart = Date.now()

      const classificationData = await step.do(
        'batch-classification',
        {
          retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' },
          timeout: '2 minutes',
        },
        async () => {
          const result = await this.batchClassifyAll(
            mergedBundle,
            enabledComps,
            photoBundle,
            appraisalResult.avgPricePerSqft ?? 0
          )
          // Convert Map to plain object for serialization
          const compClassificationsObj: Record<string, ClassificationResult> = {}
          for (const [key, value] of result.compClassifications) {
            compClassificationsObj[key] = value
          }
          return serialize({
            subjectClassification: result.subjectClassification ?? null,
            compClassifications: compClassificationsObj,
            llmCalls: result.llmCalls,
          })
        }
      )
      const classificationResult = classificationData as {
        subjectClassification: ClassificationResult | null
        compClassifications: Record<string, ClassificationResult>
        llmCalls: number
      }

      // Convert back to Map for internal use
      const compClassifications = new Map<string, ClassificationResult>(
        Object.entries(classificationResult.compClassifications)
      )
      const subjectClassification = classificationResult.subjectClassification ?? undefined

      stepTimings['classification'] = Date.now() - classifyStart
      console.log(`[AnalysisWorkflow] Classification complete: ${compClassifications.size} comps classified in ${classificationResult.llmCalls} LLM calls`)

      await this.updateProgress(params.userId, params.propertyKey, 'comp_selection', 'completed')

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 5: Calculate ARV and Build Response
      // ═══════════════════════════════════════════════════════════════════════
      await this.updateProgress(params.userId, params.propertyKey, 'valuation', 'in_progress')
      const arvStart = Date.now()

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
            compSupplementedFields
          )
          return serialize(result)
        }
      )
      const response = responseData as unknown as AnalysisResponse

      stepTimings['arv_calculation'] = Date.now() - arvStart

      await this.updateProgress(params.userId, params.propertyKey, 'valuation', 'completed')

      // ═══════════════════════════════════════════════════════════════════════
      // STEP 6: Store Result in Durable Object
      // ═══════════════════════════════════════════════════════════════════════
      await this.updateProgress(params.userId, params.propertyKey, 'response_build', 'in_progress')
      await step.do('store-result', { timeout: '10 seconds' }, async () => {
        await this.storeResult(params.userId, params.propertyKey, response)
        return { stored: true }
      })

      await this.updateProgress(params.userId, params.propertyKey, 'response_build', 'completed')

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
    enabledComps: AppraisedComparable[],
    params: AnalysisWorkflowParams
  ): Promise<PhotoBundle | null> {
    const photoService = createPhotoService(this.env)

    if (!photoService.isAvailable()) {
      return {
        subject: null,
        comps: {},
        provider: 'none',
        fetchedAt: new Date().toISOString(),
      }
    }

    const maxComps = params.photoAnalysis?.maxComps ?? 10
    const compsForPhotos = enabledComps.slice(0, maxComps)

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

    return photoBundle
  }

  /**
   * Batch classify all properties in 1-2 LLM calls
   */
  private async batchClassifyAll(
    bundle: PropertyBundle,
    enabledComps: AppraisedComparable[],
    photoBundle: PhotoBundle | null,
    areaAvgPricePerSqft: number
  ): Promise<{
    subjectClassification: ClassificationResult | undefined
    compClassifications: Map<string, ClassificationResult>
    llmCalls: number
  }> {
    const classificationService = createBatchClassificationService(this.env)

    // Build batch input for all properties
    const batchInput = [
      // Subject property
      {
        id: bundle.property.id,
        isSubject: true,
        photos: photoBundle?.subject?.photos,
        description: photoBundle?.subject?.description,
        salePrice: bundle.property.lastSalePrice ?? undefined,
        squareFeet: bundle.property.squareFeet ?? undefined,
      },
      // Enabled comps
      ...enabledComps.map((comp) => ({
        id: comp.id,
        isSubject: false,
        photos: photoBundle?.comps[comp.id]?.photos,
        description: photoBundle?.comps[comp.id]?.description,
        salePrice: comp.salePrice ?? undefined,
        squareFeet: comp.squareFeet ?? undefined,
      })),
    ]

    const result = await classificationService.classifyBatch(batchInput, {
      areaAvgPricePerSqft,
      maxPhotosPerProperty: 3,
      maxPropertiesPerBatch: 6,
    })

    // Extract subject and comp classifications
    const subjectClassification = result.classifications.get(bundle.property.id)
    const compClassifications = new Map<string, ClassificationResult>()

    for (const comp of enabledComps) {
      const classification = result.classifications.get(comp.id)
      if (classification) {
        compClassifications.set(comp.id, classification)
      }
    }

    return {
      subjectClassification,
      compClassifications,
      llmCalls: result.timing.llmCallsCount,
    }
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
    compSupplementedFields: Map<string, SupplementedField[]>
  ): Promise<AnalysisResponse> {
    const valuationService = createValuationService()
    const appraisalService = createAppraisalService()

    const enabledComps = appraisalResult.comparables.filter((c) => c.isEnabled)

    // Calculate weighted ARV if we have classifications
    let finalArv = appraisalResult.arv
    const arvSource: 'appraisal' | 'comp-selection' = 'appraisal'
    let weightedARVResult = undefined

    if (subjectClassification && compClassifications.size > 0) {
      weightedARVResult = appraisalService.calculateWeightedARV(
        bundle.property,
        appraisalResult.comparables,
        subjectClassification,
        compClassifications
      )
      finalArv = weightedARVResult.arv
    }

    // Data-based best comp selection - prioritize after_renovation comps for ARV
    const afterRenovationCompIds = weightedARVResult?.afterRenovationCompIds ?? []
    const { bestCompId, scores: dataBasedScores } = selectBestCompFromData(
      enabledComps,
      bundle.property.squareFeet,
      bundle.property.yearBuilt,
      afterRenovationCompIds
    )

    // Calculate valuation
    const buybox = params.buybox ?? {}
    const subjectSqft = bundle.property.squareFeet || 0
    const compAvgSqft =
      enabledComps.length > 0
        ? enabledComps.reduce((sum, c) => sum + (c.squareFeet || 0), 0) / enabledComps.length
        : subjectSqft

    const selectedRehabLevelIndex = buybox.rehabLevelIndex ?? 2

    const valuation = valuationService.calculateValuation({
      arv: finalArv,
      subjectSqft,
      compAvgSqft,
      rehabLevelIndex: selectedRehabLevelIndex,
      majorItems: buybox.majorItems,
      additionPlay: buybox.additionPlay ?? 0,
      closingCostsPercent: buybox.closingCostsPercent ?? 10,
      carryingCostsPercent: buybox.carryingCostsPercent ?? 5,
      wholesaleFee: buybox.wholesaleFee ?? 10000,
      desiredProfit: buybox.desiredProfit,
    })

    // Calculate all rehab level estimates for the current ARV
    const rehabLevelEstimates = calculateAllRehabLevelEstimates(valuationService, {
      arv: finalArv,
      subjectSqft,
      compAvgSqft,
      selectedRehabLevelIndex,
      majorItems: buybox.majorItems,
      additionPlay: buybox.additionPlay ?? 0,
      closingCostsPercent: buybox.closingCostsPercent ?? 10,
      carryingCostsPercent: buybox.carryingCostsPercent ?? 5,
      wholesaleFee: buybox.wholesaleFee ?? 10000,
      desiredProfit: buybox.desiredProfit,
    })

    // Build response
    return buildAnalysisResponse(
      bundle,
      appraisalResult,
      photoBundle,
      null, // No LLM comp selection in workflow (using batch classification instead)
      valuation,
      {
        arvSource,
        finalArv,
        bestCompId,
        selectedCompIds: enabledComps.map((c) => c.id),
        dataBasedScores,
        analysisId: params.jobId,
        subjectClassification,
        compClassifications,
        weightedARVResult,
        subjectSupplementedFields,
        compSupplementedFields,
        rehabLevelEstimates,
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
      await stub.fetch(
        new Request('http://internal/step', {
          method: 'POST',
          body: JSON.stringify({ step: stepName, status }),
        })
      )
    } catch (error) {
      // Non-critical, just log
      console.warn(`[AnalysisWorkflow] Failed to update progress: ${error}`)
    } finally {
      // Dispose stub to prevent RPC stub disposal warnings
      // @ts-expect-error - dispose may not be in types but exists at runtime
      stub.dispose?.()
    }
  }

  /**
   * Store result in Durable Object
   */
  private async storeResult(userId: string, propertyKey: string, result: AnalysisResponse): Promise<void> {
    const doId = this.getDoId(userId, propertyKey)
    const stub = this.env.ANALYSIS_JOB.get(doId)

    try {
      await stub.fetch(
        new Request('http://internal/result', {
          method: 'POST',
          body: JSON.stringify({ result }),
        })
      )
    } finally {
      // Dispose stub to prevent RPC stub disposal warnings
      // @ts-expect-error - dispose may not be in types but exists at runtime
      stub.dispose?.()
    }
  }

  /**
   * Store error in Durable Object
   */
  private async storeError(userId: string, propertyKey: string, errorMessage: string): Promise<void> {
    const doId = this.getDoId(userId, propertyKey)
    const stub = this.env.ANALYSIS_JOB.get(doId)

    try {
      await stub.fetch(
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
    } catch (error) {
      console.error(`[AnalysisWorkflow] Failed to store error: ${error}`)
    } finally {
      // Dispose stub to prevent RPC stub disposal warnings
      // @ts-expect-error - dispose may not be in types but exists at runtime
      stub.dispose?.()
    }
  }
}
