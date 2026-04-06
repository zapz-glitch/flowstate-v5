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
You are the PRIMARY decision-maker for comp selection. The system has pre-evaluated comps using rule-based filters — treat those results as advisory input, not final decisions. You may override any filter result based on your professional judgment.

## COMP SELECTION METHODOLOGY

### Phase 1: Physical Similarity Assessment (MANDATORY)
Every comp MUST be physically comparable to the subject. Evaluate strictly:

1. **SQUARE FOOTAGE** — #1 disqualifier. Must be within reasonable range. A 2,000 sqft subject cannot use a 900 sqft comp.
2. **BUILDING STYLE** — Same style strongly preferred (Ranch vs Ranch). Different styles have different $/sqft and buyer appeal. However, similar styles in the same era (e.g., Conventional vs Ranch for 1950s homes) may be acceptable.
3. **CONSTRUCTION TYPE** — Same construction preferred (Frame vs Frame).
4. **FOUNDATION TYPE** — Same foundation preferred.
5. **BEDROOM/BATHROOM COUNT** — Should be similar. 2bd/1ba is not comparable to 4bd/3ba.
6. **YEAR BUILT** — Within ~15 years for older homes, tighter for newer.
7. **LOT SIZE** — Should be in the same general range.

### Phase 2: ARV Quality Selection
From physically similar comps, select for After Repair Value quality:

1. **SALE RECENCY** — Last 6 months ideal, up to 12 months acceptable
2. **PROXIMITY** — Closer = more relevant market data
3. **SUBDIVISION MATCH** — Same subdivision is a strong market indicator
4. **PRICE LEVEL** — For ARV, prefer comps with higher $/sqft (indicates renovated condition)
5. **MINIMAL ADJUSTMENTS** — Fewer adjustments = more reliable comp

### Red Flags — EXCLUDE from ARV selection:
- Foreclosure sales (distressed pricing)
- Short sales (below market)
- Interfamily transfers (non-arm's-length)
- Cash purchases by LLCs at deep discounts (investor acquisitions, not market value)
- Properties with significantly different condition indicators

## CRITICAL RULES
- Physical similarity is NON-NEGOTIABLE. A comp failing sqft, style, or construction match should score below 50.
- Select ONLY genuinely comparable properties. 1 excellent comp > 5 mediocre ones.
- NEVER select a comp just for its high price if it fails physical similarity.
- Consider the USER'S PREFERENCES — they've set specific filter thresholds and parameters. Respect their intent.
- For as-is comps: identify comps that represent current (un-renovated) market value.

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

  // Web search market context (real-time market intelligence)
  const mc = ctx.marketContext
  if (mc) {
    if (mc.marketTrends.summary) marketLines.push(`Market Trend: ${mc.marketTrends.summary}`)
    if (mc.marketTrends.medianPriceDirection) marketLines.push(`Price Direction: ${mc.marketTrends.medianPriceDirection}${mc.marketTrends.yoyPriceChange ? ` (${mc.marketTrends.yoyPriceChange} YoY)` : ''}`)
    if (mc.marketTrends.avgDaysOnMarket) marketLines.push(`Avg Days on Market: ${mc.marketTrends.avgDaysOnMarket}`)
    if (mc.marketTrends.inventoryLevel) marketLines.push(`Inventory: ${mc.marketTrends.inventoryLevel}`)
    if (mc.recentSales.notableSales) marketLines.push(`Recent Sales: ${mc.recentSales.notableSales}`)
    if (mc.recentSales.foreclosureActivity) marketLines.push(`Foreclosures: ${mc.recentSales.foreclosureActivity}`)
    if (mc.neighborhoodFactors.recentDevelopment) marketLines.push(`Development: ${mc.neighborhoodFactors.recentDevelopment}`)
    if (mc.investorSentiment) marketLines.push(`Investor Sentiment: ${mc.investorSentiment}`)
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

    const lines = [
      `Comp ${i + 1} [ID: ${comp.id}]:`,
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
    ]

    return lines.filter(Boolean).join('\n')
  }).join('\n\n')

  // ── Algorithm pre-selection note ──────────────────────────────────
  const algoSelectedIds = evalContexts.filter((e) => e.isEnabled).map((e) => e.compId)
  const algoNote = algoSelectedIds.length > 0
    ? `\nALGORITHM PRE-SELECTION: Rule-based filters selected ${algoSelectedIds.length} comp(s): ${algoSelectedIds.join(', ')}. Validate or override based on your analysis.`
    : '\nALGORITHM PRE-SELECTION: No comps passed all rule-based filters. Use your professional judgment to select the best available matches.'

  // ── Task ──────────────────────────────────────────────────────────
  return `SUBJECT PROPERTY:
  ${subjectLines}

${userPrefs}
${marketContextStr}

COMPARABLE SALES (${comparables.length} total):

${compLines}
${algoNote}

YOUR TASK:
1. Evaluate each comp for physical similarity to the subject (Phase 1)
2. Select comps that best support an After Repair Value (ARV) estimate (Phase 2)
3. Identify comps suitable for as-is market value (lower-priced, un-renovated)
4. Score and rank ALL comps with reasoning

Return JSON:
{
  "selectedForArv": ["compId1", "compId2"],
  "asIsComps": ["compId3"],
  "rankings": [
    {
      "compId": "string",
      "score": 0-100,
      "reasoning": "Physical similarity assessment + ARV/as-is classification reasoning",
      "keyFeatures": ["matching features", "key differences"],
      "confidenceLevel": "high" | "medium" | "low"
    }
  ],
  "arvEstimate": 450000,
  "confidenceLevel": "high" | "medium" | "low",
  "summary": "1-3 sentence market analysis"
}

SCORING GUIDE:
85-100: Excellent physical match + strong ARV indicator → SELECTED for ARV
70-84: Good physical match, usable for ARV → SELECTED for ARV
50-69: Partial match or as-is indicator → consider for as-is classification
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

    // Parse JSON from response (strip markdown fences if present)
    let jsonStr = result.data.content.trim()
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
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
        return null
      }
    }

    if (!parsed.rankings || !Array.isArray(parsed.rankings)) {
      console.warn('[CompAnalysis] Invalid LLM response structure')
      return null
    }

    // Validate and normalize rankings
    const validCompIds = new Set(ctx.bundle.comparables.map((c) => c.id))
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

    // Extract selectedForArv
    const selectedForArv: string[] = Array.isArray(parsed.selectedForArv)
      ? parsed.selectedForArv.filter((id): id is string => typeof id === 'string' && validCompIds.has(id))
      : rankings.filter((r) => r.score >= 70).map((r) => r.compId)

    // Extract asIsComps
    const asIsComps: string[] = Array.isArray(parsed.asIsComps)
      ? parsed.asIsComps.filter((id): id is string => typeof id === 'string' && validCompIds.has(id))
      : []

    const latencyMs = Date.now() - startTime

    console.log(`[CompAnalysis] Analyzed ${rankings.length} comps, selected ${selectedForArv.length} for ARV, ${asIsComps.length} as-is in ${latencyMs}ms (${result.usage?.totalTokens ?? '?'} tokens)`)
    if (rankings.length > 0) {
      const selected = rankings.filter((r) => selectedForArv.includes(r.compId))
      const rejected = rankings.filter((r) => !selectedForArv.includes(r.compId) && !asIsComps.includes(r.compId))
      console.log(`[CompAnalysis] ARV: ${selected.map((r) => `${r.compId.slice(0, 20)}(${r.score})`).join(', ')}`)
      if (asIsComps.length > 0) {
        console.log(`[CompAnalysis] As-Is: ${asIsComps.join(', ')}`)
      }
      if (rejected.length > 0) {
        console.log(`[CompAnalysis] Rejected: ${rejected.map((r) => `${r.compId.slice(0, 20)}(${r.score})`).join(', ')}`)
      }
    }

    return {
      rankings,
      selectedForArv,
      asIsComps,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      arvEstimate: typeof parsed.arvEstimate === 'number' ? parsed.arvEstimate : undefined,
      confidenceLevel: (['high', 'medium', 'low'] as const).includes(parsed.confidenceLevel as 'high')
        ? parsed.confidenceLevel as 'high' | 'medium' | 'low'
        : undefined,
      reasoning: result.data.reasoning || undefined,
      model: env.COMP_SELECTION_MODEL || env.OPENROUTER_MODEL || 'google/gemini-3-flash-preview',
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
