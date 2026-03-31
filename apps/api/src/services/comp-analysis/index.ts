/**
 * LLM Comp Analysis Service
 *
 * Uses AI to select the best comparable sales for ARV calculation.
 * Two-phase approach matching real appraisal methodology:
 *   Phase 1: Filter by physical similarity (appraisal rules)
 *   Phase 2: Among qualifying comps, select highest-value for ARV
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

const SYSTEM_PROMPT = `You are a licensed real estate appraiser performing a comparable sales analysis to determine the After Repair Value (ARV) of an investment property.

You MUST follow the standard appraisal methodology used by banks and FHA/VA appraisers:

PHASE 1 — PHYSICAL SIMILARITY (mandatory, non-negotiable):
Only comps that are physically comparable to the subject should be considered. Evaluate in this strict order:

1. SQUARE FOOTAGE — Must be within reasonable range of subject. A 2,000 sqft subject cannot use a 900 sqft comp. This is the #1 disqualifier.
2. BUILDING STYLE — Same style is strongly preferred (Ranch vs Ranch, not Ranch vs Two-Story). Different styles have fundamentally different $/sqft and buyer appeal.
3. CONSTRUCTION TYPE — Same construction preferred (Frame vs Frame, not Frame vs Concrete Block). Construction type affects rehab costs and value.
4. FOUNDATION TYPE — Same foundation preferred (Slab vs Slab, not Slab vs Basement). Foundation differences significantly affect value.
5. BEDROOM/BATHROOM COUNT — Should be similar. 2bd/1ba is not comparable to 4bd/3ba.
6. YEAR BUILT — Within ~15 years. A 1960 home is not comparable to a 2010 build.
7. LOT SIZE — Should be in the same general range.

PHASE 2 — AMONG PHYSICALLY SIMILAR COMPS, select for ARV quality:
From comps that pass Phase 1, select ONLY the ones that truly support an ARV estimate:

1. SALE RECENCY — Prefer most recent sales (last 6 months ideal)
2. PROXIMITY — Closer to subject = more relevant market data
3. SUBDIVISION MATCH — Same subdivision is a strong indicator of market value
4. SALE PRICE LEVEL — For ARV, prefer comps that represent post-renovation value (higher $/sqft indicates renovated condition)
5. MINIMAL ADJUSTMENTS — Comps needing fewer adjustments are more reliable

CRITICAL RULES:
- Select ONLY comps that genuinely match. If only 1 comp is truly comparable, select 1. If 5 are excellent matches, select 5.
- Do NOT force a specific count. Quality over quantity.
- NEVER select a comp just because it has a high sale price if it fails physical similarity
- A nearby 900 sqft comp selling for $300K does NOT support ARV for a 2,000 sqft subject
- Physical match FIRST, then value level among matches
- Do NOT pad with dissimilar comps to reach a target count

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
      .map((f: Record<string, unknown>) => `${f.type}: ${f.passed ? 'PASS' : 'FAIL'}${f.reason ? ` (${f.reason})` : ''}`)
      .join(', ') ?? 'not evaluated'
    const adjSummary = ctx?.adjustmentResults
      .filter((a: Record<string, unknown>) => a.applied)
      .map((a: Record<string, unknown>) => `${a.type}: ${(a.amount as number) >= 0 ? '+' : ''}$${(a.amount as number).toLocaleString()}`)
      .join(', ') || 'none'

    // Calculate sqft difference for clarity
    const sqftDiff = subject.squareFeet && comp.squareFeet
      ? Math.abs(comp.squareFeet - subject.squareFeet)
      : null
    const sqftPct = subject.squareFeet && comp.squareFeet
      ? Math.round((sqftDiff! / subject.squareFeet) * 100)
      : null

    return `
Comp ${i + 1} [ID: ${comp.id}]:
  Address: ${comp.address}, ${comp.city}, ${comp.state}
  Sale Price: $${comp.salePrice?.toLocaleString() ?? 'unknown'} on ${comp.saleDate ?? 'unknown'}
  $/SqFt: $${comp.pricePerSqft ?? 'unknown'}
  Distance: ${comp.distanceMiles?.toFixed(2) ?? 'unknown'} miles
  Beds/Baths: ${comp.bedrooms ?? '-'}/${comp.bathrooms ?? '-'}
  SqFt: ${comp.squareFeet?.toLocaleString() ?? 'unknown'}${sqftDiff != null ? ` (${sqftDiff > 0 ? '+' : ''}${(comp.squareFeet! - subject.squareFeet!).toLocaleString()} sqft, ${sqftPct}% diff)` : ''}
  Year Built: ${comp.yearBuilt ?? 'unknown'}${subject.yearBuilt && comp.yearBuilt ? ` (${Math.abs(comp.yearBuilt - subject.yearBuilt)} yr diff)` : ''}
  Lot: ${comp.lotSizeAcres ? `${comp.lotSizeAcres} acres` : 'unknown'}
  Subdivision: ${comp.subdivision ?? 'none'}${subject.subdivision && comp.subdivision && subject.subdivision.toLowerCase() === comp.subdivision.toLowerCase() ? ' ✓ MATCH' : ''}
  Foundation: ${comp.construction?.foundationType ?? 'unknown'}${subject.construction?.foundationType && comp.construction?.foundationType && subject.construction.foundationType.toLowerCase() === comp.construction.foundationType.toLowerCase() ? ' ✓ MATCH' : ''}
  Building Style: ${comp.construction?.buildingStyle ?? 'unknown'}${subject.construction?.buildingStyle && comp.construction?.buildingStyle && subject.construction.buildingStyle.toLowerCase() === comp.construction.buildingStyle.toLowerCase() ? ' ✓ MATCH' : ''}
  Construction: ${comp.construction?.type ?? 'unknown'}${subject.construction?.type && comp.construction?.type && subject.construction.type.toLowerCase() === comp.construction.type.toLowerCase() ? ' ✓ MATCH' : ''}
  Exterior Walls: ${comp.construction?.exteriorWalls ?? 'unknown'}
  Roof: ${comp.construction?.roofType ?? 'unknown'}
  Appraisal Filter Results: ${filterSummary}
  Price Adjustments: ${adjSummary}
  Adjusted Price: ${ctx?.adjustedPrice ? `$${ctx.adjustedPrice.toLocaleString()}` : 'N/A'}`
  }).join('\n')

  // Identify algorithm-selected comps
  const algoSelectedIds = evalContexts.filter(e => e.isEnabled).map(e => e.compId)
  const algoSelectedNote = algoSelectedIds.length > 0
    ? `\nALGORITHM PRE-SELECTION: The appraisal rules algorithm selected these ${algoSelectedIds.length} comp(s): ${algoSelectedIds.join(', ')}. Validate or override this selection based on your analysis.`
    : '\nALGORITHM PRE-SELECTION: No comps passed all appraisal filters. Use your judgment to select the best available matches.'

  return `SUBJECT PROPERTY:
  ${subjectInfo}

COMPARABLE SALES (${comparables.length} total):${compLines}
${algoSelectedNote}

YOUR TASK:
1. First, identify which comps are PHYSICALLY SIMILAR to the subject (Phase 1)
2. From those, select ONLY the best matches that support an ARV (After Repair Value) estimate
3. ARV comps should represent what the subject would sell for AFTER full renovation — prefer comps with higher $/sqft that indicate renovated/updated condition
4. Rank ALL comps

Return JSON:
{
  "selectedForArv": ["compId1", "compId2"],
  "rankings": [
    {
      "compId": "the comp ID string",
      "score": 0-100,
      "reasoning": "Explain physical similarity assessment AND why selected/rejected for ARV",
      "keyFeatures": ["matching features or key differences"],
      "confidenceLevel": "high" | "medium" | "low"
    }
  ],
  "summary": "1-2 sentence market analysis and comp selection rationale"
}

SCORING:
85-100: Excellent physical match + strong ARV indicator (high $/sqft, recent, nearby) → SELECTED
70-84: Good physical match, usable for ARV → SELECTED
50-69: Partial match, some differences → may be selected if best available
30-49: Significant physical differences → NOT selected
0-29: Poor match, not comparable → NOT selected

REMEMBER:
- Physical similarity is non-negotiable. A comp that fails sqft, building style, construction type, or foundation match should score below 50 regardless of sale price.
- Only include comps in selectedForArv that you would defend in front of an underwriter. Quality over quantity.
- It is perfectly acceptable to select just 1 or 2 comps if those are the only true matches.
- Prefer comps with higher $/sqft among physically similar matches — they better represent ARV (post-renovation value).
- Do NOT select comps that are clearly distressed sales or as-is deals for ARV.`
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
      temperature: options?.temperature ?? 0.2,
      maxTokens: options?.maxTokens ?? 4096,
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

    let parsed: { rankings?: unknown[]; selectedForArv?: unknown[]; summary?: string }
    try {
      parsed = JSON.parse(jsonStr)
    } catch {
      // LLM response may be truncated (hit token limit) — try to repair
      console.warn('[CompAnalysis] JSON parse failed, attempting repair...')
      try {
        // Close any open strings, arrays, objects
        let repaired = jsonStr
        // Count unmatched quotes — if odd, close the string
        const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length
        if (quoteCount % 2 !== 0) repaired += '"'
        // Close unclosed brackets/braces
        const opens = (repaired.match(/[{[]/g) || []).length
        const closes = (repaired.match(/[}\]]/g) || []).length
        for (let i = 0; i < opens - closes; i++) {
          // Determine which to close by finding the last unmatched opener
          const lastOpen = Math.max(repaired.lastIndexOf('{'), repaired.lastIndexOf('['))
          repaired += repaired[lastOpen] === '{' ? '}' : ']'
        }
        parsed = JSON.parse(repaired)
        console.log('[CompAnalysis] JSON repair successful')
      } catch {
        console.warn('[CompAnalysis] JSON repair failed, skipping LLM analysis')
        return null
      }
    }

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
      : rankings.filter((r) => r.score >= 70).map((r) => r.compId)

    const latencyMs = Date.now() - startTime

    console.log(`[CompAnalysis] Analyzed ${rankings.length} comps, selected ${selectedForArv.length} for ARV in ${latencyMs}ms (${result.usage?.totalTokens ?? '?'} tokens)`)
    if (rankings.length > 0) {
      const selected = rankings.filter((r) => selectedForArv.includes(r.compId))
      const rejected = rankings.filter((r) => !selectedForArv.includes(r.compId))
      console.log(`[CompAnalysis] Selected: ${selected.map((r) => `${r.compId.slice(0, 20)}(${r.score})`).join(', ')}`)
      if (rejected.length > 0) {
        console.log(`[CompAnalysis] Rejected: ${rejected.map((r) => `${r.compId.slice(0, 20)}(${r.score})`).join(', ')}`)
      }
    }

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
