/**
 * LLM Comp Analysis Service
 *
 * Uses AI to analyze and rank comparable sales for underwriting evaluation.
 * Runs as a post-process enrichment step — rule-based selection is authoritative,
 * LLM adds reasoning, quality scores, and key features.
 *
 * Graceful degradation: returns null if LLM is unavailable or fails.
 */

import type { NormalizedProperty, NormalizedComparable } from '../property-api/types'
import type { Env } from '../../types'
import { createLLMProviderFromEnv } from '../llm'
import type {
  CompAnalysisOptions,
  CompAnalysisResult,
  CompRanking,
  CompEvalContext,
} from './types'

export type { CompAnalysisOptions, CompAnalysisResult, CompRanking, CompEvalContext }

// ─── Prompt Builder ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert real estate underwriter selecting the best comparable sales (comps) to determine the After Repair Value (ARV) of an investment property.

Your task:
1. Evaluate each comp's relevance to the subject property
2. SELECT the best 3-5 comps for ARV calculation — these should be the most similar properties that an appraiser would use

Selection criteria (in priority order):
- Same subdivision or immediate neighborhood
- Same building style/house type (Ranch vs Ranch, not Ranch vs Two-Story)
- Similar square footage (within 20% of subject)
- Similar age/year built (within 10 years)
- Recent sale date (prefer last 6 months)
- Close distance (prefer under 0.5 miles)
- Minimal price adjustments needed
- Foundation and construction similarity

If a comp matches most criteria but fails one (e.g. slightly outside distance), it can still be selected if it's the best available.

IMPORTANT: Respond ONLY with valid JSON. No markdown, no code fences, no explanation outside the JSON.`

function buildPrompt(
  subject: NormalizedProperty,
  comparables: NormalizedComparable[],
  evalContexts: CompEvalContext[],
): string {
  const evalMap = new Map(evalContexts.map((e) => [e.compId, e]))

  const subjectInfo = [
    `Address: ${subject.address}, ${subject.city}, ${subject.state} ${subject.zipCode}`,
    `Beds/Baths: ${subject.bedrooms ?? '-'}/${subject.bathrooms ?? '-'}`,
    `SqFt: ${subject.squareFeet?.toLocaleString() ?? 'unknown'}`,
    `Year Built: ${subject.yearBuilt ?? 'unknown'}`,
    `Lot: ${subject.lotSizeAcres ? `${subject.lotSizeAcres} acres` : 'unknown'}`,
    `Property Type: ${subject.propertyType ?? 'unknown'}`,
    `Subdivision: ${subject.subdivision ?? 'none'}`,
    `Foundation: ${subject.construction?.foundationType ?? 'unknown'}`,
    `Building Style: ${subject.construction?.buildingStyle ?? 'unknown'}`,
    `Stories: ${subject.stories ?? 'unknown'}`,
    subject.construction?.roofType ? `Roof: ${subject.construction.roofType}` : null,
    subject.construction?.exteriorWalls ? `Exterior: ${subject.construction.exteriorWalls}` : null,
    subject.features?.heating ? `Heating: ${subject.features.heating}` : null,
    subject.features?.cooling ? `Cooling: ${subject.features.cooling}` : null,
    subject.features?.poolType ? `Pool: ${subject.features.poolType}` : null,
    subject.features?.garageType ? `Garage: ${subject.features.garageType}` : null,
    subject.lastSalePrice ? `Last Sale: $${subject.lastSalePrice.toLocaleString()} (${subject.lastSaleDate ?? 'unknown'})` : null,
    subject.assessedValue ? `Tax Assessment: $${subject.assessedValue.toLocaleString()}` : null,
  ].filter(Boolean).join('\n  ')

  const compLines = comparables.map((comp, i) => {
    const ctx = evalMap.get(comp.id)
    const filterSummary = ctx?.filterResults
      .map((f) => `${f.type}: ${f.passed ? 'PASS' : 'FAIL'}${f.reason ? ` (${f.reason})` : ''}`)
      .join(', ') ?? 'not evaluated'
    const adjSummary = ctx?.adjustmentResults
      .filter((a) => a.applied)
      .map((a) => `${a.type}: ${a.amount >= 0 ? '+' : ''}$${a.amount.toLocaleString()}`)
      .join(', ') || 'none'

    return `
Comp ${i + 1} [ID: ${comp.id}]:
  Address: ${comp.address}, ${comp.city}, ${comp.state}
  Sale Price: $${comp.salePrice?.toLocaleString() ?? 'unknown'} on ${comp.saleDate ?? 'unknown'}
  $/SqFt: $${comp.pricePerSqft ?? 'unknown'}
  Distance: ${comp.distanceMiles?.toFixed(2) ?? 'unknown'} miles
  Beds/Baths: ${comp.bedrooms ?? '-'}/${comp.bathrooms ?? '-'}
  SqFt: ${comp.squareFeet?.toLocaleString() ?? 'unknown'}
  Year Built: ${comp.yearBuilt ?? 'unknown'}
  Lot: ${comp.lotSizeAcres ? `${comp.lotSizeAcres} acres` : 'unknown'}
  Subdivision: ${comp.subdivision ?? 'none'}
  Foundation: ${comp.construction?.foundationType ?? 'unknown'}
  Building Style: ${comp.construction?.buildingStyle ?? 'unknown'}
  Status: ${ctx?.isEnabled ? 'ENABLED for ARV' : 'EXCLUDED'} (Group: ${ctx?.compGroup ?? 'none'})
  Filters: ${filterSummary}
  Adjustments: ${adjSummary}
  Adjusted Price: ${ctx?.adjustedPrice ? `$${ctx.adjustedPrice.toLocaleString()}` : 'N/A'}`
  }).join('\n')

  return `SUBJECT PROPERTY:
  ${subjectInfo}

COMPARABLE SALES (${comparables.length} total):${compLines}

Select the best 3-5 comps for ARV calculation and rank ALL comps. Return JSON:
{
  "selectedForArv": ["compId1", "compId2", "compId3"],
  "rankings": [
    {
      "compId": "the comp ID string",
      "score": 0-100,
      "reasoning": "1-3 sentence analysis of why this comp is/isn't selected for ARV",
      "keyFeatures": ["feature1", "feature2"],
      "confidenceLevel": "high" | "medium" | "low"
    }
  ],
  "summary": "1-2 sentence explanation of your comp selection strategy and market context"
}

RULES:
- selectedForArv: list the comp IDs of your best 3-5 picks (minimum 3, maximum 5)
- Include ALL comps in rankings (both selected and rejected)
- Selected comps should score 60+
- Explain WHY each comp was selected or rejected in the reasoning

SCORING GUIDE:
80-100: Excellent match — selected for ARV (same subdivision/style, similar size/age, recent sale)
60-79: Good match — selected for ARV (close proximity, reasonable differences)
40-59: Fair — NOT selected (notable differences but could be backup)
20-39: Weak — NOT selected (significant differences)
0-19: Poor — NOT selected (not useful for ARV)`
}

// ─── Main Service ───────────────────────────────────────────────────────────

/**
 * Analyze comps using LLM for quality scoring and reasoning.
 * Returns null if LLM is unavailable or the call fails.
 */
export async function analyzeComps(
  subject: NormalizedProperty,
  comparables: NormalizedComparable[],
  evalContexts: CompEvalContext[],
  env: Env,
  options?: CompAnalysisOptions,
): Promise<CompAnalysisResult | null> {
  const provider = createLLMProviderFromEnv(env)
  if (!provider) {
    console.log('[CompAnalysis] LLM provider not available (no OPENROUTER_API_KEY)')
    return null
  }

  if (comparables.length === 0) return null

  const startTime = Date.now()

  try {
    const prompt = buildPrompt(subject, comparables, evalContexts)

    const result = await provider.execute({
      prompt,
      systemPrompt: SYSTEM_PROMPT,
      temperature: options?.temperature ?? 0.3,
      maxTokens: options?.maxTokens ?? 2048,
    })

    if (!result.success || !result.data?.content) {
      console.warn('[CompAnalysis] LLM call failed:', result.error?.message ?? 'no content')
      return null
    }

    // Parse JSON from response (strip markdown fences if present)
    let jsonStr = result.data.content.trim()
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
    }

    const parsed = JSON.parse(jsonStr) as { rankings?: unknown[]; selectedForArv?: unknown[]; summary?: string }

    if (!parsed.rankings || !Array.isArray(parsed.rankings)) {
      console.warn('[CompAnalysis] Invalid LLM response structure')
      return null
    }

    // Validate and normalize rankings
    const validCompIds = new Set(comparables.map((c) => c.id))
    const rankings: CompRanking[] = parsed.rankings
      .filter((r: unknown): r is Record<string, unknown> =>
        typeof r === 'object' && r !== null && typeof (r as Record<string, unknown>).compId === 'string'
      )
      .filter((r) => validCompIds.has(r.compId as string))
      .map((r) => ({
        compId: r.compId as string,
        score: Math.max(0, Math.min(100, typeof r.score === 'number' ? r.score : 50)),
        reasoning: typeof r.reasoning === 'string' ? r.reasoning : '',
        keyFeatures: Array.isArray(r.keyFeatures) ? r.keyFeatures.filter((f): f is string => typeof f === 'string') : [],
        condition: typeof r.condition === 'string' ? r.condition : undefined,
        confidenceLevel: (['high', 'medium', 'low'] as const).includes(r.confidenceLevel as 'high') ? r.confidenceLevel as 'high' | 'medium' | 'low' : 'medium',
      }))

    // Extract selectedForArv — validate that all IDs are valid comp IDs
    const selectedForArv: string[] = Array.isArray(parsed.selectedForArv)
      ? parsed.selectedForArv.filter((id): id is string => typeof id === 'string' && validCompIds.has(id))
      : rankings.filter((r) => r.score >= 60).map((r) => r.compId).slice(0, 5) // fallback: top scored

    const latencyMs = Date.now() - startTime

    console.log(`[CompAnalysis] Analyzed ${rankings.length} comps, selected ${selectedForArv.length} for ARV in ${latencyMs}ms (${result.usage?.totalTokens ?? '?'} tokens)`)

    return {
      rankings,
      selectedForArv,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      model: env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001',
      latencyMs,
      tokenUsage: result.usage ? {
        prompt: result.usage.promptTokens ?? 0,
        completion: result.usage.completionTokens ?? 0,
        estimatedCostUsd: result.usage.estimatedCostUsd ?? 0,
      } : undefined,
    }
  } catch (error) {
    console.warn('[CompAnalysis] Error:', error instanceof Error ? error.message : error)
    return null
  }
}

// ─── Response Merger ────────────────────────────────────────────────────────

/**
 * Merge LLM analysis results into an existing analysis response.
 * Populates selectionReason, qualityScore, keyFeatures, condition on each comp.
 * Returns the response unchanged if llmResult is null.
 */
export function mergeLLMIntoResponse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: Record<string, any>,
  llmResult: CompAnalysisResult | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  if (!llmResult) return response

  const rankingMap = new Map(llmResult.rankings.map((r) => [r.compId, r]))

  // Enrich each comp item
  if (response.comps?.items && Array.isArray(response.comps.items)) {
    response.comps.items = response.comps.items.map((comp: Record<string, unknown>) => {
      const ranking = rankingMap.get(comp.id as string)
      if (!ranking) return comp

      return {
        ...comp,
        selectionReason: ranking.reasoning || null,
        qualityScore: ranking.score,
        keyFeatures: ranking.keyFeatures.length > 0 ? ranking.keyFeatures : null,
        condition: ranking.condition ?? null,
      }
    })
  }

  // Add LLM metadata to response
  response.llmAnalysis = {
    model: llmResult.model,
    latencyMs: llmResult.latencyMs,
    tokenUsage: llmResult.tokenUsage,
    compCount: llmResult.rankings.length,
    summary: llmResult.summary,
  }

  return response
}
