/**
 * Batch Classification Service
 *
 * Classifies multiple properties in a single LLM call for efficiency.
 * Reduces 11 separate LLM calls to 1-2 batched calls.
 *
 * Strategy:
 * 1. Group properties by whether they have photos
 * 2. For properties with photos: Use vision LLM (batch up to 5 at a time)
 * 3. For properties without photos: Use text-only classification
 * 4. Combine results
 */

import type { Env } from '../../types'
import type { LLMProvider } from '../llm'
import { createLLMProvider } from '../llm'
import type {
  PropertyClassification,
  ClassificationResult,
} from '../vision/types'
import { analyzeDescriptionKeywords } from './keywords'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BatchClassificationInput {
  id: string
  isSubject: boolean
  photos?: string[]
  description?: string
  salePrice?: number
  squareFeet?: number
}

export interface BatchClassificationOptions {
  areaAvgPricePerSqft: number
  /** Maximum photos per property in batch (default: 3) */
  maxPhotosPerProperty?: number
  /** Maximum properties per vision batch (default: 5) */
  maxPropertiesPerBatch?: number
}

export interface BatchClassificationResult {
  classifications: Map<string, ClassificationResult>
  timing: {
    totalMs: number
    llmCallsCount: number
    photoBatchCount: number
    textOnlyCount: number
  }
}

// ─── Batch Classification Prompt ──────────────────────────────────────────────

const BATCH_CLASSIFICATION_PROMPT = `You are a real estate property condition analyst. Analyze the provided properties and classify each one.

For each property, determine its classification (MUST be one of these two):
- **as_is**: Needs work. Signs: outdated fixtures, visible damage, deferred maintenance, investor-focused keywords, priced below market, partial updates but mostly dated
- **after_renovation**: Move-in ready. Signs: modern finishes, updated kitchens/baths, premium materials, retail-ready keywords, priced at/above market, turnkey condition

Return a JSON array with classifications for each property in the same order provided:

\`\`\`json
[
  {
    "id": "property_id",
    "classification": "as_is" | "after_renovation",
    "confidence": 0-100,
    "reasoning": "Brief explanation of classification"
  }
]
\`\`\`

IMPORTANT:
- Analyze EACH property independently
- Return results in the EXACT same order as input
- You MUST choose either "as_is" or "after_renovation" - no other values allowed
- If uncertain, lean toward "as_is" for properties with ANY dated elements
- Confidence should reflect certainty (photos = higher confidence)
- Return ONLY the JSON array, no other text`

// ─── Service Implementation ───────────────────────────────────────────────────

export class BatchClassificationService {
  private provider: LLMProvider | null

  constructor(env: Env) {
    if (env.OPENROUTER_API_KEY) {
      this.provider = createLLMProvider({
        provider: 'openrouter',
        apiKey: env.OPENROUTER_API_KEY,
        model: env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001',
      })
    } else {
      this.provider = null
    }
  }

  /**
   * Check if LLM is available for vision classification
   */
  isLLMAvailable(): boolean {
    return this.provider !== null
  }

  /**
   * Classify multiple properties in batched LLM calls
   */
  async classifyBatch(
    properties: BatchClassificationInput[],
    options: BatchClassificationOptions
  ): Promise<BatchClassificationResult> {
    const startTime = Date.now()
    const classifications = new Map<string, ClassificationResult>()
    let llmCallsCount = 0
    let photoBatchCount = 0
    let textOnlyCount = 0

    const maxPhotos = options.maxPhotosPerProperty ?? 3
    const maxPerBatch = options.maxPropertiesPerBatch ?? 5

    // Separate properties with and without photos
    const withPhotos: BatchClassificationInput[] = []
    const withoutPhotos: BatchClassificationInput[] = []

    for (const prop of properties) {
      if (prop.photos && prop.photos.length > 0 && this.provider) {
        withPhotos.push(prop)
      } else {
        withoutPhotos.push(prop)
      }
    }

    // Process properties WITH photos in batches (vision LLM)
    if (withPhotos.length > 0 && this.provider) {
      for (let i = 0; i < withPhotos.length; i += maxPerBatch) {
        const batch = withPhotos.slice(i, i + maxPerBatch)
        photoBatchCount++

        try {
          const batchResults = await this.classifyPhotoBatch(
            batch,
            options.areaAvgPricePerSqft,
            maxPhotos
          )
          llmCallsCount++

          for (const [id, result] of batchResults) {
            classifications.set(id, result)
          }
        } catch (error) {
          console.error('[BatchClassification] Photo batch failed:', error)
          // Fall back to text-only for failed batch
          for (const prop of batch) {
            const fallback = this.classifyByDataOnly(prop, options.areaAvgPricePerSqft)
            classifications.set(prop.id, fallback)
            textOnlyCount++
          }
        }
      }
    }

    // Process properties WITHOUT photos (text/data only)
    for (const prop of withoutPhotos) {
      const result = this.classifyByDataOnly(prop, options.areaAvgPricePerSqft)
      classifications.set(prop.id, result)
      textOnlyCount++
    }

    return {
      classifications,
      timing: {
        totalMs: Date.now() - startTime,
        llmCallsCount,
        photoBatchCount,
        textOnlyCount,
      },
    }
  }

  /**
   * Classify a batch of properties with photos using vision LLM
   */
  private async classifyPhotoBatch(
    properties: BatchClassificationInput[],
    areaAvgPricePerSqft: number,
    maxPhotosPerProperty: number
  ): Promise<Map<string, ClassificationResult>> {
    if (!this.provider) {
      throw new Error('LLM provider not available')
    }

    // Build prompt with property info
    const propertyDescriptions = properties.map((prop, index) => {
      const priceInfo = prop.salePrice && prop.squareFeet
        ? `Price: $${prop.salePrice.toLocaleString()} ($${Math.round(prop.salePrice / prop.squareFeet)}/sqft vs area avg $${Math.round(areaAvgPricePerSqft)}/sqft)`
        : ''

      return `Property ${index + 1} (ID: ${prop.id}):
${prop.description ? `Description: ${prop.description.slice(0, 500)}` : 'No description'}
${priceInfo}
Photos: ${prop.photos?.length ?? 0} provided (showing first ${Math.min(prop.photos?.length ?? 0, maxPhotosPerProperty)})`
    }).join('\n\n')

    const prompt = `${BATCH_CLASSIFICATION_PROMPT}

Properties to analyze:

${propertyDescriptions}`

    // Collect all images (limited per property)
    const allImages: Array<{ url: string }> = []
    for (const prop of properties) {
      const photos = prop.photos?.slice(0, maxPhotosPerProperty) ?? []
      for (const url of photos) {
        allImages.push({ url })
      }
    }

    console.log(`[BatchClassification] Classifying ${properties.length} properties with ${allImages.length} total photos`)

    // Call LLM
    const result = await this.provider.execute({
      prompt,
      images: allImages,
      maxTokens: 2000,
      temperature: 0.1,
    })

    if (!result.success || !result.data?.content) {
      throw new Error(result.error?.message || 'LLM classification failed')
    }

    // Parse response
    return this.parseBatchResponse(result.data.content, properties)
  }

  /**
   * Parse LLM batch response
   */
  private parseBatchResponse(
    response: string,
    properties: BatchClassificationInput[]
  ): Map<string, ClassificationResult> {
    const results = new Map<string, ClassificationResult>()

    try {
      // Clean up response - remove markdown code blocks if present
      let cleanResponse = response
        .replace(/```json\s*/gi, '')
        .replace(/```\s*/g, '')
        .trim()

      // Try parsing the cleaned response directly first (most reliable)
      let parsed: Array<{
        id: string
        classification: string
        confidence: number
        reasoning: string
      }>

      try {
        const directParse = JSON.parse(cleanResponse)
        if (Array.isArray(directParse)) {
          parsed = directParse
        } else {
          throw new Error('Response is not an array')
        }
      } catch {
        // Fallback: Extract JSON array using greedy regex
        // Match from first [ to last ]
        const jsonMatch = cleanResponse.match(/\[[\s\S]*\]/)
        if (!jsonMatch) {
          console.error('[BatchClassification] No JSON array found. Response preview:', cleanResponse.slice(0, 500))
          throw new Error('No JSON array found in response')
        }
        parsed = JSON.parse(jsonMatch[0])
      }

      console.log(`[BatchClassification] Successfully parsed ${parsed.length} classifications`)

      // Map results back to property IDs
      for (let i = 0; i < parsed.length && i < properties.length; i++) {
        const item = parsed[i]
        const prop = properties[i]

        // Use the ID from the response if it matches, otherwise use position
        const propId = item.id === prop.id ? prop.id : prop.id

        results.set(propId, {
          classification: this.normalizeClassification(item.classification),
          confidence: Math.min(100, Math.max(0, item.confidence || 50)),
          method: 'batch_photo_analysis',
          indicators: {},
          reasoning: item.reasoning || 'Classified via batch analysis',
        })
      }

      // Handle any properties that weren't in the response
      for (const prop of properties) {
        if (!results.has(prop.id)) {
          console.warn(`[BatchClassification] Property ${prop.id} missing from LLM response, using fallback`)
          results.set(prop.id, {
            classification: 'as_is',
            confidence: 30,
            method: 'fallback',
            indicators: {},
            reasoning: 'Property was not classified by LLM batch - defaulting to as_is',
          })
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('[BatchClassification] Failed to parse response:', errorMessage)
      console.error('[BatchClassification] Raw response length:', response.length)
      console.error('[BatchClassification] Response preview:', response.slice(0, 800))

      // Return as_is for all properties on parse failure (conservative approach)
      for (const prop of properties) {
        results.set(prop.id, {
          classification: 'as_is',
          confidence: 20,
          method: 'parse_error_fallback',
          indicators: {},
          reasoning: `Failed to parse LLM batch response (${errorMessage}) - defaulting to as_is`,
        })
      }
    }

    return results
  }

  /**
   * Classify property using only data (no LLM)
   * Defaults to as_is when uncertain (conservative approach)
   */
  private classifyByDataOnly(
    prop: BatchClassificationInput,
    areaAvgPricePerSqft: number
  ): ClassificationResult {
    let classification: PropertyClassification = 'as_is' // Default to as_is
    let confidence = 40
    let reasoning = ''

    // Try description keywords first
    if (prop.description && prop.description.length > 10) {
      const analysis = analyzeDescriptionKeywords(prop.description)

      if (analysis.score <= -20) {
        classification = 'as_is'
        confidence = Math.min(80, 50 + Math.abs(analysis.score) / 2)
        reasoning = `Description keywords indicate As-Is: ${analysis.asIsKeywords.slice(0, 3).join(', ')}`
      } else if (analysis.score >= 40) {
        // Higher threshold for after_renovation
        classification = 'after_renovation'
        confidence = Math.min(80, 50 + analysis.score / 2)
        reasoning = `Description keywords indicate renovated: ${analysis.afterRenovationKeywords.slice(0, 3).join(', ')}`
      } else {
        reasoning = 'Description keywords inconclusive - defaulting to as_is'
      }
    }

    // Price analysis as secondary signal
    if (prop.salePrice && prop.squareFeet && areaAvgPricePerSqft > 0) {
      const pricePerSqft = prop.salePrice / prop.squareFeet
      const ratio = pricePerSqft / areaAvgPricePerSqft

      if (ratio <= 0.85) {
        // Below market - confirms as_is
        classification = 'as_is'
        confidence = Math.min(85, confidence + 15)
        reasoning += ` Price ${Math.round(ratio * 100)}% of market avg suggests distress.`
      } else if (ratio >= 1.15) {
        // Significantly above market - suggests after_renovation
        classification = 'after_renovation'
        confidence = Math.min(80, 50 + (ratio - 1.0) * 50)
        reasoning += ` Price ${Math.round(ratio * 100)}% of market avg suggests updated.`
      }
    }

    if (!reasoning) {
      reasoning = 'Insufficient data for confident classification - defaulting to as_is'
    }

    return {
      classification,
      confidence: Math.round(confidence),
      method: 'data_only',
      indicators: {},
      reasoning,
    }
  }

  /**
   * Normalize classification value
   * Defaults to as_is for any unrecognized value
   */
  private normalizeClassification(value: string | undefined): PropertyClassification {
    const normalized = value?.toLowerCase()
    if (normalized === 'as_is' || normalized === 'after_renovation') {
      return normalized
    }
    if (normalized === 'as-is' || normalized === 'asis') {
      return 'as_is'
    }
    if (normalized === 'after-renovation' || normalized === 'afterrenovation' || normalized === 'arv' || normalized === 'renovated') {
      return 'after_renovation'
    }
    // Default to as_is for any unrecognized value (including transitional)
    return 'as_is'
  }
}

// ─── Factory Function ─────────────────────────────────────────────────────────

/**
 * Create a batch classification service
 */
export function createBatchClassificationService(env: Env): BatchClassificationService {
  return new BatchClassificationService(env)
}
