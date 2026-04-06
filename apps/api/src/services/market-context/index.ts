/**
 * Market Context Service
 *
 * Uses LLM with web search to gather real-time market intelligence
 * for a specific property's area. Runs as a single call that the model
 * uses to search the web and synthesize market data.
 *
 * This data feeds into the comp selection prompt to give the AI
 * better context for making appraisal decisions.
 */

import type { Env } from '../../types'
import { createLLMProviderFromEnv } from '../llm'

export interface MarketContext {
  marketTrends: {
    medianPriceDirection: 'rising' | 'stable' | 'declining' | null
    yoyPriceChange: string | null
    avgDaysOnMarket: number | null
    inventoryLevel: 'low' | 'balanced' | 'high' | null
    summary: string | null
  }
  neighborhoodFactors: {
    recentDevelopment: string | null
    schoolDistrictRating: string | null
    majorEmployers: string | null
  }
  recentSales: {
    notableSales: string | null
    foreclosureActivity: string | null
  }
  investorSentiment: string | null
  sources: string[]
  latencyMs: number
  model: string
}

interface MarketContextParams {
  address: string
  city: string
  state: string
  zipCode: string
  propertyType?: string | null
  subdivision?: string | null
}

/**
 * Fetch market context using LLM web search.
 * Returns null if LLM is unavailable or the call fails.
 */
export async function fetchMarketContext(
  params: MarketContextParams,
  env: Env,
  modelOverride?: string,
): Promise<MarketContext | null> {
  const provider = modelOverride
    ? createLLMProviderFromEnv({ ...env, MARKET_SEARCH_MODEL: modelOverride }, 'market_search')
    : createLLMProviderFromEnv(env, 'market_search')
  if (!provider) {
    console.log('[MarketContext] LLM provider not available')
    return null
  }

  const startTime = Date.now()
  const { address, city, state, zipCode, propertyType, subdivision } = params

  const prompt = `Research the current real estate market conditions for the area around ${address}, ${city}, ${state} ${zipCode}.
${subdivision ? `Subdivision: ${subdivision}` : ''}
${propertyType ? `Property type: ${propertyType}` : ''}

Search for recent data and return a JSON object:
{
  "marketTrends": {
    "medianPriceDirection": "rising" | "stable" | "declining" | null,
    "yoyPriceChange": "percentage change year-over-year or null",
    "avgDaysOnMarket": number or null,
    "inventoryLevel": "low" | "balanced" | "high" | null,
    "summary": "1-2 sentence market trend summary for ${city}, ${state} ${zipCode}"
  },
  "neighborhoodFactors": {
    "recentDevelopment": "any new construction, rezoning, or major projects nearby, or null",
    "schoolDistrictRating": "current school district quality/rating, or null",
    "majorEmployers": "any recent employer moves affecting the area, or null"
  },
  "recentSales": {
    "notableSales": "any recent notable sales in the ${zipCode} area, or null",
    "foreclosureActivity": "foreclosure or distressed sale trends, or null"
  },
  "investorSentiment": "overall assessment for fix-and-flip or wholesale investment in this area, or null",
  "sources": ["URLs referenced"]
}

Focus on data from the last 6 months. Be factual — set fields to null if data is not found. Return ONLY valid JSON.`

  try {
    const result = await provider.execute({
      prompt,
      systemPrompt: 'You are a real estate market analyst. Search the web for current market data and return structured JSON. Be concise and factual.',
      temperature: 0.1,
      maxTokens: 2048,
      webSearch: {
        engine: 'exa',
        maxResults: 10,
        searchContextSize: 'high',
        excludedDomains: ['pinterest.com', 'facebook.com', 'instagram.com', 'tiktok.com'],
        userLocation: {
          type: 'approximate',
          city,
          region: state,
          country: 'US',
        },
      },
    })

    if (!result.success || !result.data?.content) {
      console.warn('[MarketContext] LLM call failed:', result.error?.message ?? 'no content')
      return null
    }

    // Parse JSON response
    let jsonStr = result.data.content.trim()
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
    }

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(jsonStr)
    } catch {
      console.warn('[MarketContext] JSON parse failed, skipping')
      return null
    }

    const latencyMs = Date.now() - startTime
    const model = env.MARKET_SEARCH_MODEL || env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-001'

    console.log(`[MarketContext] Market data fetched for ${city}, ${state} ${zipCode} in ${latencyMs}ms`)

    return {
      marketTrends: {
        medianPriceDirection: (parsed.marketTrends as Record<string, unknown>)?.medianPriceDirection as MarketContext['marketTrends']['medianPriceDirection'] ?? null,
        yoyPriceChange: (parsed.marketTrends as Record<string, unknown>)?.yoyPriceChange as string ?? null,
        avgDaysOnMarket: (parsed.marketTrends as Record<string, unknown>)?.avgDaysOnMarket as number ?? null,
        inventoryLevel: (parsed.marketTrends as Record<string, unknown>)?.inventoryLevel as MarketContext['marketTrends']['inventoryLevel'] ?? null,
        summary: (parsed.marketTrends as Record<string, unknown>)?.summary as string ?? null,
      },
      neighborhoodFactors: {
        recentDevelopment: (parsed.neighborhoodFactors as Record<string, unknown>)?.recentDevelopment as string ?? null,
        schoolDistrictRating: (parsed.neighborhoodFactors as Record<string, unknown>)?.schoolDistrictRating as string ?? null,
        majorEmployers: (parsed.neighborhoodFactors as Record<string, unknown>)?.majorEmployers as string ?? null,
      },
      recentSales: {
        notableSales: (parsed.recentSales as Record<string, unknown>)?.notableSales as string ?? null,
        foreclosureActivity: (parsed.recentSales as Record<string, unknown>)?.foreclosureActivity as string ?? null,
      },
      investorSentiment: parsed.investorSentiment as string ?? null,
      sources: Array.isArray(parsed.sources) ? parsed.sources.filter((s): s is string => typeof s === 'string') : [],
      latencyMs,
      model,
    }
  } catch (error) {
    console.warn('[MarketContext] Error:', error instanceof Error ? error.message : error)
    return null
  }
}
