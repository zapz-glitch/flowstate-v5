/**
 * LLM Comp Analysis Service
 *
 * AI-first comparable selection. The LLM is the PRIMARY comp selection authority.
 * It receives all property data, user preferences, market context, and evaluation
 * results to make an informed selection decision.
 *
 * The deterministic appraisal rules still run as advisory data (filter pass/fail,
 * adjustments) and as fallback when the LLM is unavailable.
 *
 * ALL valuation math remains deterministic — the AI only selects WHICH comps to use.
 */

import type { NormalizedProperty, NormalizedComparable } from '../property-api/types'
import type { Env } from '../../types'
import { createLLMProviderFromEnv } from '../llm'
import type {
  CompAnalysisOptions,
  CompAnalysisResult,
  CompRanking,
  CompEvalContext,
  CompAnalysisContext,
} from './types'

export type { CompAnalysisOptions, CompAnalysisResult, CompRanking, CompEvalContext, CompAnalysisContext }

// ─── System Prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a licensed real estate appraiser and investment analyst performing a comparable sales analysis. Your job is to select the best comparable sales (comps) for determining the After Repair Value (ARV) of an investment property.

## YOUR ROLE
You are the PRIMARY decision-maker for comp selection. The system has pre-evaluated comps using rule-based filters, but those filters may be too strict and may have excluded good comps. You MUST evaluate ALL comps independently — including those the algorithm excluded. You may override any filter result based on your professional judgment.

## GOAL
Find the best comps with the HIGHEST sale value that are physically comparable to the subject. High-value comps from the same market represent what the property could sell for after renovation (ARV). Prefer higher-priced comps when physical similarity is adequate.

## COMP SELECTION METHODOLOGY

### Phase 1: Physical Similarity Assessment
Every comp MUST be physically comparable to the subject. Evaluate these factors in order of importance:

1. **SQUARE FOOTAGE** — Most important. Must be within reasonable range (~20-25% tolerance). A 2,000 sqft subject cannot use a 900 sqft comp.
2. **BEDROOM/BATHROOM COUNT** — Should be similar. 2bd/1ba is not comparable to 4bd/3ba.
3. **BUILDING STYLE** — Same style preferred (Ranch vs Ranch). Similar styles in the same era may be acceptable (e.g., Conventional vs Ranch for 1950s homes).
4. **YEAR BUILT** — Within ~15 years for older homes, tighter for newer.
5. **CONSTRUCTION TYPE** — Same preferred (Frame vs Frame), but not a hard disqualifier.
6. **FOUNDATION TYPE** — Same preferred, but not a hard disqualifier.
7. **LOT SIZE** — Should be in the same general range.

### Phase 2: ARV Selection — Prioritize High Value
From physically similar comps, select for After Repair Value:

1. **PRICE LEVEL** — MOST IMPORTANT for ARV. Prefer comps with HIGHER sale prices and $/sqft. These represent renovated/after-repair market value.
2. **SALE RECENCY** — Last 6 months ideal, up to 12 months acceptable.
3. **PROXIMITY** — Closer = more relevant market data.
4. **SUBDIVISION MATCH** — Same subdivision is a strong indicator.

### Phase 3: Filter Relaxation
The algorithm pre-filters comps using user-defined thresholds (distance, sqft difference, year built, etc.). These filters may be TOO STRICT and may have excluded excellent high-value comps. When evaluating:

1. **LOOK AT ALL COMPS** — Do NOT skip comps just because the algorithm marked them as "EXCLUDED". Evaluate every comp on its own merits.
2. **RELAX FILTERS WHEN JUSTIFIED** — If a comp failed a filter by a small margin but has a high sale price and good physical similarity, it may still be an excellent ARV comp. For example:
   - A comp 0.6 miles away when the filter is 0.5 miles — still very close
   - A comp with 280 sqft difference when the filter is 250 — negligible difference
   - A comp 12 years apart when the filter is 10 — acceptable for older homes
3. **EXPLAIN OVERRIDES** — When you select a comp that the algorithm excluded, explain why in your reasoning.

### As-Is Classification
Comps with sale price ≤ the as-is threshold percentage of ARV represent current un-renovated market value. These are lower-priced sales useful for understanding the distressed/as-is market.

### Red Flags — EXCLUDE from ARV:
- Foreclosure sales, short sales (distressed pricing)
- Interfamily transfers (non-arm's-length)
- Cash purchases by LLCs at deep discounts (investor acquisitions)

## CRITICAL RULES
- Evaluate ALL comps — do not blindly trust the algorithm's filter results.
- Prioritize HIGH SALE VALUE comps for ARV when physical similarity is adequate.
- Physical similarity matters but use judgment — a comp that fails one filter by a small margin but has excellent price data is often better than a comp that passes all filters but has a low sale price.
- 2-3 excellent high-value comps > 5 mediocre ones.
- NEVER select a comp just for its high price if it fundamentally differs from the subject (wrong size, wrong type).
- Consider the USER'S PREFERENCES — their filter thresholds indicate intent, but interpret them as guidelines not hard cutoffs.

## OUTPUT FORMAT
Respond ONLY with valid JSON. No markdown, no code fences, no explanation outside the JSON.`

// ─── Prompt Builder ─────────────────────────────────────────────────────────

function buildMegaPrompt(ctx: CompAnalysisContext): string {
  const { bundle, evalContexts } = ctx
  const subject = bundle.property
  const comparables = bundle.comparables
  const evalMap = new Map(evalContexts.map((e) => [e.compId, e]))

  // ── Subject Property ──────────────────────────────────────────────
  const subjectLines = [
    `Address: ${subject.address}, ${subject.city}, ${subject.state} ${subject.zipCode}`,
    `County: ${subject.county ?? 'unknown'}`,
    `Beds/Baths: ${subject.bedrooms ?? '-'}/${subject.bathrooms ?? '-'}`,
    `SqFt: ${subject.squareFeet?.toLocaleString() ?? 'unknown'}`,
    `Year Built: ${subject.yearBuilt ?? 'unknown'}`,
    `Lot: ${subject.lotSizeAcres ? `${subject.lotSizeAcres.toFixed(3)} acres` : 'unknown'}`,
    `Property Type: ${subject.propertyType ?? 'unknown'}`,
    `Subdivision: ${subject.subdivision ?? 'none'}`,
    // Construction
    `Building Style: ${subject.construction?.buildingStyle ?? 'unknown'}`,
    `Construction Type: ${subject.construction?.type ?? 'unknown'}`,
    `Foundation: ${subject.construction?.foundationType ?? 'unknown'}`,
    `Quality: ${subject.construction?.qualityCode ?? 'unknown'}`,
    `Roof: ${subject.construction?.roofType ?? 'unknown'}`,
    `Exterior Walls: ${subject.construction?.exteriorWalls ?? 'unknown'}`,
    `Stories: ${subject.stories ?? subject.construction?.storiesType ?? 'unknown'}`,
    // Features
    subject.features?.heating ? `Heating: ${subject.features.heating}` : null,
    subject.features?.cooling ? `Cooling: ${subject.features.cooling}` : null,
    subject.features?.poolType ? `Pool: Yes (${subject.features.poolType})` : `Pool: No`,
    subject.features?.garageType ? `Garage: Yes (${subject.features.garageType})` : `Garage: No`,
    subject.features?.carportType ? `Carport: Yes` : `Carport: No`,
    subject.features?.fireplacesCount ? `Fireplaces: ${subject.features.fireplacesCount}` : null,
    // Financials
    subject.lastSalePrice ? `Last Sale: $${subject.lastSalePrice.toLocaleString()} (${subject.lastSaleDate ?? 'unknown'})` : null,
    subject.assessedValue ? `Tax Assessment: $${subject.assessedValue.toLocaleString()}` : null,
    subject.marketValue ? `Market Value: $${subject.marketValue.toLocaleString()}` : null,
    subject.avmValue ? `AVM Estimate: $${subject.avmValue.toLocaleString()} (confidence: ${subject.avmConfidence ?? 'unknown'})` : null,
    // Ownership
    subject.ownership?.ownerOccupied != null ? `Owner Occupied: ${subject.ownership.ownerOccupied ? 'Yes' : 'No (absentee)'}` : null,
  ].filter(Boolean).join('\n  ')

  // ── User Preferences ──────────────────────────────────────────────
  const filterLines = ctx.filters
    .map((f) => `  ${f.type}: ${f.enabled ? `enabled (threshold: ${f.value})` : 'disabled'}`)
    .join('\n')
  const adjLines = ctx.adjustments
    .map((a) => `  ${a.type}: ${a.enabled ? `enabled ($${a.amount.toLocaleString()}${a.percent ? `, ${a.percent}%` : ''})` : 'disabled'}`)
    .join('\n')
  const rehabLevels = ['Lipstick', 'Light Cosmetic', 'Full Cosmetic', 'Heavy Rehab', 'Down to Stud']

  const userPrefs = `USER'S EVALUATION PREFERENCES:
  ARV Threshold: Top ${ctx.arvThresholdPercent}% of comps by sale price
  As-Is Threshold: ${ctx.asIsThresholdPercent}% of ARV
  Rehab Level: ${rehabLevels[ctx.rehabLevelIndex] ?? 'Full Cosmetic'} (level ${ctx.rehabLevelIndex})
  Deal Params: ${ctx.dealParams.closingCostsPercent}% closing, ${ctx.dealParams.carryingCostsPercent}% carrying, $${ctx.dealParams.wholesaleFee.toLocaleString()} wholesale fee

  Appraisal Filters (user's thresholds):
${filterLines}

  Price Adjustments (user's amounts):
${adjLines}`

  // ── Market Context ────────────────────────────────────────────────
  const marketLines: string[] = []

  // Flood zone
  const flood = bundle.enrichment?.floodZone
  if (flood) {
    marketLines.push(flood.isInFloodZone
      ? `⚠ FLOOD ZONE: ${flood.floodZone ?? 'Yes'} — ${flood.floodZoneDescription ?? ''}`
      : `Flood Zone: No`)
  }

  // Risk flags
  if (ctx.riskFlags?.length) {
    marketLines.push(`⚠ LOCATION RISKS: ${ctx.riskFlags.join(', ')}`)
  }

  // Permits
  const permits = bundle.enrichment?.permits
  if (permits && permits.count > 0) {
    marketLines.push(`Recent Permits: ${permits.count} permits, total value $${(permits.totalJobValue ?? 0).toLocaleString()}`)
    if (permits.recentPermitTypes?.length) {
      marketLines.push(`  Permit Types: ${permits.recentPermitTypes.join(', ')}`)
    }
  }

  // Neighbourhood
  const community = bundle.enrichment?.neighbourhood?.community
  if (community) {
    if (community.demographics?.medianIncome) marketLines.push(`Median Income: $${community.demographics.medianIncome.toLocaleString()}`)
    if (community.demographics?.medianHomeValue) marketLines.push(`Median Home Value: $${community.demographics.medianHomeValue.toLocaleString()}`)
    if (community.crime?.crimeRisk) marketLines.push(`Crime Risk: ${community.crime.crimeRisk}`)
  }

  const marketContextStr = marketLines.length > 0
    ? `\nMARKET CONTEXT:\n  ${marketLines.join('\n  ')}`
    : ''

  // ── Comparable Sales ──────────────────────────────────────────────
  const compLines = comparables.map((comp, i) => {
    const ctx = evalMap.get(comp.id)

    // Calculate differences from subject
    const sqftDiff = subject.squareFeet && comp.squareFeet
      ? Math.round(((comp.squareFeet - subject.squareFeet) / subject.squareFeet) * 100)
      : null
    const yearDiff = subject.yearBuilt && comp.yearBuilt
      ? Math.abs(comp.yearBuilt - subject.yearBuilt)
      : null
    const subdivMatch = subject.subdivision && comp.subdivision
      && subject.subdivision.toLowerCase() === comp.subdivision.toLowerCase()
    const styleMatch = subject.construction?.buildingStyle && comp.construction?.buildingStyle
      && subject.construction.buildingStyle.toLowerCase() === comp.construction.buildingStyle.toLowerCase()
    const foundationMatch = subject.construction?.foundationType && comp.construction?.foundationType
      && subject.construction.foundationType.toLowerCase() === comp.construction.foundationType.toLowerCase()
    const constructionMatch = subject.construction?.type && comp.construction?.type
      && subject.construction.type.toLowerCase() === comp.construction.type.toLowerCase()

    // Filter summary
    const filterSummary = ctx?.filterResults
      .map((f) => `${f.type}: ${f.passed ? 'PASS' : 'FAIL'}${f.reason ? ` (${f.reason})` : ''}`)
      .join('; ') ?? 'not evaluated'

    // Adjustment summary
    const adjSummary = ctx?.adjustmentResults
      .filter((a) => a.applied)
      .map((a) => `${a.type}: ${a.amount >= 0 ? '+' : ''}$${a.amount.toLocaleString()}`)
      .join('; ') || 'none'

    // Transaction flags
    const txFlags: string[] = []
    if (comp.transaction?.buyerIsCorporate) txFlags.push('CORPORATE BUYER')
    if (comp.transaction?.buyerNames?.some((n) => /llc|inc|corp|trust|properties|holdings/i.test(n))) txFlags.push('ENTITY BUYER')

    // Algorithm classification
    const algoClass = ctx?.compGroup === 'arv' ? '→ ARV (top price tier, passed filters)'
      : ctx?.compGroup === 'as_is' ? '→ AS-IS (below ARV threshold)'
      : ctx?.isEnabled ? '→ ENABLED (passed filters)'
      : '→ EXCLUDED (failed filters)'

    const lines = [
      `Comp ${i + 1}:`,
      `  Address: ${comp.address}, ${comp.city}, ${comp.state}`,
      `  Sale: $${comp.salePrice?.toLocaleString() ?? '?'} on ${comp.saleDate ?? '?'} ($${comp.pricePerSqft ?? '?'}/sf)`,
      `  Distance: ${comp.distanceMiles?.toFixed(2) ?? '?'} mi`,
      `  Beds/Baths: ${comp.bedrooms ?? '-'}/${comp.bathrooms ?? '-'}`,
      `  SqFt: ${comp.squareFeet?.toLocaleString() ?? '?'}${sqftDiff != null ? ` (${sqftDiff > 0 ? '+' : ''}${sqftDiff}% vs subject)` : ''}`,
      `  Year Built: ${comp.yearBuilt ?? '?'}${yearDiff != null ? ` (${yearDiff}yr diff)` : ''}`,
      `  Lot: ${comp.lotSizeAcres ? `${comp.lotSizeAcres.toFixed(3)} ac` : '?'}`,
      `  Subdivision: ${comp.subdivision ?? 'none'}${subdivMatch ? ' ✓ MATCH' : ''}`,
      `  Style: ${comp.construction?.buildingStyle ?? '?'}${styleMatch ? ' ✓ MATCH' : ''}`,
      `  Construction: ${comp.construction?.type ?? '?'}${constructionMatch ? ' ✓ MATCH' : ''}`,
      `  Foundation: ${comp.construction?.foundationType ?? '?'}${foundationMatch ? ' ✓ MATCH' : ''}`,
      `  Quality: ${comp.construction?.qualityCode ?? '?'}`,
      comp.features?.poolType ? `  Pool: Yes` : null,
      comp.features?.garageType ? `  Garage: Yes` : null,
      comp.features?.carportType ? `  Carport: Yes` : null,
      txFlags.length > 0 ? `  ⚠ Transaction: ${txFlags.join(', ')}` : null,
      `  Rule Filters: ${filterSummary}`,
      `  Adjustments: ${adjSummary}`,
      ctx?.adjustedPrice ? `  Adjusted Price: $${ctx.adjustedPrice.toLocaleString()}` : null,
      `  Algorithm Classification: ${algoClass}`,
    ]

    return lines.filter(Boolean).join('\n')
  }).join('\n\n')

  // ── Algorithm pre-selection note ──────────────────────────────────
  const idToIdx = new Map(comparables.map((c, i) => [c.id, i + 1]))
  const compNum = (id: string) => `Comp ${idToIdx.get(id) ?? '?'}`
  const arvComps = evalContexts.filter((e) => e.compGroup === 'arv')
  const asIsAlgoComps = evalContexts.filter((e) => e.compGroup === 'as_is')
  const enabledComps = evalContexts.filter((e) => e.isEnabled)
  const excludedComps = evalContexts.filter((e) => !e.isEnabled)
  const algoNote = [
    `\nALGORITHM PRE-FILTER RESULTS (advisory only — you may override):`,
    `  ARV threshold: top ${ctx.arvThresholdPercent}% by sale price | As-Is threshold: ≤${ctx.asIsThresholdPercent}% of ARV`,
    `  ${enabledComps.length} passed filters, ${excludedComps.length} excluded by filters`,
    `  ARV: ${arvComps.map((e) => compNum(e.compId)).join(', ') || 'none'}`,
    `  As-Is: ${asIsAlgoComps.map((e) => compNum(e.compId)).join(', ') || 'none'}`,
    `  Excluded: ${excludedComps.map((e) => compNum(e.compId)).join(', ') || 'none'}`,
    ``,
    `⚠ IMPORTANT: The algorithm's filters may be too strict. Review ALL ${comparables.length} comps (including excluded ones).`,
    `If a high-value comp was excluded for marginally failing a filter, consider selecting it for ARV anyway.`,
  ].join('\n')

  // ── Task ──────────────────────────────────────────────────────────
  return `SUBJECT PROPERTY:
  ${subjectLines}

${userPrefs}
${marketContextStr}

COMPARABLE SALES (${comparables.length} total):

${compLines}
${algoNote}

YOUR TASK:
1. Evaluate ALL ${comparables.length} comps for physical similarity — including those the algorithm excluded
2. Select the best HIGH-VALUE comps for ARV calculation:
   - Prioritize comps with the highest sale prices that are physically similar
   - If the algorithm excluded a good high-value comp for marginally failing a filter, override and select it
   - Target the top ${ctx.arvThresholdPercent}% by sale price among physically similar comps
3. Classify remaining lower-priced comps as As-Is (sale price ≤ ${ctx.asIsThresholdPercent}% of ARV)
4. Score and rank ALL comps with reasoning — explain any overrides of algorithm decisions

IMPORTANT: Use comp NUMBERS (1, 2, 3...) not IDs in your response.

Return JSON:
{
  "selectedForArv": [1, 2],
  "asIsComps": [3],
  "rankings": [
    {
      "compNumber": 1,
      "score": 0-100,
      "reasoning": "Physical similarity + classification reasoning",
      "keyFeatures": ["matching features", "key differences"],
      "confidenceLevel": "high" | "medium" | "low"
    }
  ],
  "confidenceLevel": "high" | "medium" | "low",
  "summary": "1-3 sentence analysis referencing comps by number (e.g. Comp 1, Comp 2)"
}

SCORING GUIDE:
85-100: Excellent physical match + in top price tier → ARV comp
70-84: Good physical match, passes filters → ARV comp
50-69: Partial match or below ARV threshold → As-Is comp
30-49: Significant differences → NOT selected
0-29: Poor match → NOT selected`
}

// ─── Main Service ───────────────────────────────────────────────────────────

/**
 * Analyze comps using LLM for selection, scoring, and reasoning.
 * The LLM is the PRIMARY selection authority.
 * Returns null if LLM is unavailable or the call fails (fallback to rule-based).
 */
export async function analyzeComps(
  ctx: CompAnalysisContext,
  env: Env,
  options?: CompAnalysisOptions & { modelOverride?: string },
): Promise<CompAnalysisResult | null> {
  const provider = options?.modelOverride
    ? createLLMProviderFromEnv({ ...env, COMP_SELECTION_MODEL: options.modelOverride }, 'comp_selection')
    : createLLMProviderFromEnv(env, 'comp_selection')
  if (!provider) {
    console.log('[CompAnalysis] LLM provider not available (no OPENROUTER_API_KEY)')
    return null
  }

  if (ctx.bundle.comparables.length === 0) return null

  const startTime = Date.now()

  try {
    const prompt = buildMegaPrompt(ctx)

    const result = await provider.execute({
      prompt,
      systemPrompt: SYSTEM_PROMPT,
      temperature: options?.temperature ?? 0.2,
      maxTokens: options?.maxTokens ?? 4096,
      reasoning: options?.reasoning ? { enabled: true, effort: 'medium' } : undefined,
    })

    if (!result.success || !result.data?.content) {
      console.warn('[CompAnalysis] LLM call failed:', result.error?.message ?? 'no content')
      return null
    }

    // Parse JSON from response — handle markdown fences, thinking content, etc.
    let jsonStr = result.data.content.trim()

    // Strip markdown fences (handle both closed and unclosed fences)
    if (jsonStr.includes('```')) {
      const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (fenceMatch) {
        jsonStr = fenceMatch[1].trim()
      } else {
        // Unclosed fence — strip the opening fence and take the rest
        jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').trim()
      }
    }

    // If response doesn't start with { or [, try to find the JSON object
    if (!jsonStr.startsWith('{') && !jsonStr.startsWith('[')) {
      const jsonStart = jsonStr.indexOf('{')
      if (jsonStart !== -1) {
        jsonStr = jsonStr.slice(jsonStart)
      }
    }

    // Trim any trailing text after the JSON
    if (jsonStr.startsWith('{')) {
      let depth = 0
      let inString = false
      let escape = false
      let endIdx = -1
      for (let i = 0; i < jsonStr.length; i++) {
        const ch = jsonStr[i]
        if (escape) { escape = false; continue }
        if (ch === '\\') { escape = true; continue }
        if (ch === '"') { inString = !inString; continue }
        if (inString) continue
        if (ch === '{') depth++
        else if (ch === '}') { depth--; if (depth === 0) { endIdx = i; break } }
      }
      if (endIdx !== -1 && endIdx < jsonStr.length - 1) {
        jsonStr = jsonStr.slice(0, endIdx + 1)
      }
    }

    let parsed: {
      rankings?: unknown[]
      selectedForArv?: unknown[]
      asIsComps?: unknown[]
      summary?: string
      arvEstimate?: number
      confidenceLevel?: string
    }
    try {
      parsed = JSON.parse(jsonStr)
    } catch {
      console.warn('[CompAnalysis] JSON parse failed, attempting repair...')
      try {
        let repaired = jsonStr
        const quoteCount = (repaired.match(/(?<!\\)"/g) || []).length
        if (quoteCount % 2 !== 0) repaired += '"'
        const opens = (repaired.match(/[{[]/g) || []).length
        const closes = (repaired.match(/[}\]]/g) || []).length
        for (let i = 0; i < opens - closes; i++) {
          const lastOpen = Math.max(repaired.lastIndexOf('{'), repaired.lastIndexOf('['))
          repaired += repaired[lastOpen] === '{' ? '}' : ']'
        }
        parsed = JSON.parse(repaired)
        console.log('[CompAnalysis] JSON repair successful')
      } catch {
        console.warn('[CompAnalysis] JSON repair failed, skipping LLM analysis')
        console.warn('[CompAnalysis] Raw response (first 500 chars):', result.data.content.slice(0, 500))
        return null
      }
    }

    if (!parsed.rankings || !Array.isArray(parsed.rankings)) {
      console.warn('[CompAnalysis] Invalid LLM response structure')
      return null
    }

    // Map comp numbers (1-based) back to comp IDs
    const numToId = (n: unknown): string | null => {
      const num = typeof n === 'number' ? n : typeof n === 'string' ? parseInt(n, 10) : NaN
      if (isNaN(num) || num < 1 || num > ctx.bundle.comparables.length) return null
      return ctx.bundle.comparables[num - 1].id
    }
    const validCompIds = new Set(ctx.bundle.comparables.map((c) => c.id))

    // Validate and normalize rankings — accept both compNumber (new) and compId (legacy)
    const rankings: CompRanking[] = parsed.rankings
      .filter((r: unknown): r is Record<string, unknown> =>
        typeof r === 'object' && r !== null && ((r as Record<string, unknown>).compNumber != null || typeof (r as Record<string, unknown>).compId === 'string')
      )
      .reduce<CompRanking[]>((acc, r) => {
        const id = numToId(r.compNumber) ?? (typeof r.compId === 'string' && validCompIds.has(r.compId) ? r.compId : null)
        if (!id) return acc
        acc.push({
          compId: id,
          score: Math.max(0, Math.min(100, typeof r.score === 'number' ? r.score : 50)),
          reasoning: typeof r.reasoning === 'string' ? r.reasoning : '',
          keyFeatures: Array.isArray(r.keyFeatures) ? r.keyFeatures.filter((f): f is string => typeof f === 'string') : [],
          condition: typeof r.condition === 'string' ? r.condition : undefined,
          confidenceLevel: (['high', 'medium', 'low'] as const).includes(r.confidenceLevel as 'high') ? r.confidenceLevel as 'high' | 'medium' | 'low' : 'medium',
        })
        return acc
      }, [])

    // Extract selectedForArv — accept numbers or IDs
    const selectedForArv: string[] = Array.isArray(parsed.selectedForArv)
      ? parsed.selectedForArv
          .map((v) => numToId(v) ?? (typeof v === 'string' && validCompIds.has(v) ? v : null))
          .filter((id): id is string => id != null)
      : rankings.filter((r) => r.score >= 70).map((r) => r.compId)

    // Extract asIsComps — accept numbers or IDs
    const asIsComps: string[] = Array.isArray(parsed.asIsComps)
      ? parsed.asIsComps
          .map((v) => numToId(v) ?? (typeof v === 'string' && validCompIds.has(v) ? v : null))
          .filter((id): id is string => id != null)
      : []

    const latencyMs = Date.now() - startTime

    console.log(`[CompAnalysis] Analyzed ${rankings.length} comps, selected ${selectedForArv.length} for ARV, ${asIsComps.length} as-is in ${latencyMs}ms (${result.usage?.totalTokens ?? '?'} tokens)`)
    if (rankings.length > 0) {
      const selected = rankings.filter((r) => selectedForArv.includes(r.compId))
      const rejected = rankings.filter((r) => !selectedForArv.includes(r.compId) && !asIsComps.includes(r.compId))
      console.log(`[CompAnalysis] ARV: ${selected.map((r) => `Comp ${ctx.bundle.comparables.findIndex((c) => c.id === r.compId) + 1}(${r.score})`).join(', ')}`)
      if (asIsComps.length > 0) {
        console.log(`[CompAnalysis] As-Is: ${asIsComps.map((id) => `Comp ${ctx.bundle.comparables.findIndex((c) => c.id === id) + 1}`).join(', ')}`)
      }
      if (rejected.length > 0) {
        console.log(`[CompAnalysis] Rejected: ${rejected.map((r) => `Comp ${ctx.bundle.comparables.findIndex((c) => c.id === r.compId) + 1}(${r.score})`).join(', ')}`)
      }
    }

    // Summary already uses comp numbers from the LLM
    const summaryText = typeof parsed.summary === 'string' ? parsed.summary : ''

    return {
      rankings,
      selectedForArv,
      asIsComps,
      summary: summaryText,
      arvEstimate: typeof parsed.arvEstimate === 'number' ? parsed.arvEstimate : undefined,
      confidenceLevel: (['high', 'medium', 'low'] as const).includes(parsed.confidenceLevel as 'high')
        ? parsed.confidenceLevel as 'high' | 'medium' | 'low'
        : undefined,
      reasoning: result.data.reasoning || undefined,
      model: provider.model || 'unknown',
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

  response.llmAnalysis = {
    model: llmResult.model,
    latencyMs: llmResult.latencyMs,
    tokenUsage: llmResult.tokenUsage,
    compCount: llmResult.rankings.length,
    summary: llmResult.summary,
    arvEstimate: llmResult.arvEstimate,
    confidenceLevel: llmResult.confidenceLevel,
  }

  return response
}
