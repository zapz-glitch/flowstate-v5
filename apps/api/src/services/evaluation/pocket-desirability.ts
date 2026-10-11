/**
 * Pocket desirability — one haiku call, one job: rate how desirable the
 * SUBJECT'S LOCATION is for a wholesale acquisition on a 0-10 scale.
 *
 * Contract: docs/HAIKU-POCKET-DESIRABILITY.md. Haiku gathers its own web
 * signal via Anthropic's server-side web_search tool when the reasoning
 * lane is Anthropic (the model searches, reads, and scores in one call).
 * When the lane is not Anthropic or the tool call fails, a Scrapfly web
 * search gathers evidence and haiku scores what it is given.
 * Classification only — no decision authority; the result rides the
 * evidence bundle for the Opus appraiser and lands in the run trace.
 *
 * Separate call by design: it does not share state with the subject
 * condition call or the per-comp classify calls. Cached downstream only
 * via the report itself — every eval re-rates.
 */

import type { Env } from '../../types'
import type { NormalizedProperty } from '../property-api/types'
import { createReasoningProvider } from '../llm'
import { webSearch } from '../web-search'

export interface PocketDesirability {
  /** 0-10 desirability rating — 10 = deepest demand, fastest resale. */
  score: number
  /** 1-3 sentence rationale citing the gathered evidence. */
  summary: string
  /** The concrete signals the score rests on (demand, turnover, schools,
   *  crime, price trend, buyer-pool depth). */
  signals: string[]
  model: string | null
  durationMs: number
}

/** Anthropic server-side web-search tool — haiku does its own searching
 *  (max 2 searches per eval keeps latency + spend bounded). */
const WEB_SEARCH_TOOLS = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }]

const DESIRABILITY_PROMPT = `You are the pocket-desirability classifier for a wholesale real-estate acquisition engine. Your ONLY job: rate how desirable the subject property's location is for a wholesale deal on a 0-10 scale.

Judge the pocket the way an investor pricing fast resale would:
- Demand depth — do homes here sell quickly to retail buyers?
- Turnover speed — days-on-market character of the area
- Resale strength — is the ARV product easy to move after rehab?
- Buyer-pool depth — first-time buyers, move-up families, landlords
- Livability signals that drive those: schools, crime, employment access, amenities, price trend

Use the web evidence when present; where it is thin, weigh the location identity (neighborhood/city/zip + price context) honestly and say so in the summary rather than inventing confidence. A 10 means the location makes the deal nearly sell itself; a 0 means buyers will not come at any price.

Return STRICT JSON:
{
  "score": <0-10 number, one decimal allowed>,
  "summary": "<1-3 sentences citing what the evidence actually showed>",
  "signals": ["<concrete signal>", ...]
}`

const DESIRABILITY_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'number' },
    summary: { type: 'string' },
    signals: { type: 'array', items: { type: 'string' } },
  },
  required: ['score', 'summary', 'signals'],
  additionalProperties: false,
} as const

async function gatherWebSignal(env: Env, query: string): Promise<string[]> {
  const results = await webSearch(env, query, { limit: 6, timeoutMs: 10_000 })
  return results.map((o) => `${o.title}: ${o.snippet}`.trim()).filter((s) => s !== ':')
}

async function executeDesirability(
  provider: NonNullable<ReturnType<typeof createReasoningProvider>>,
  prompt: string,
  tools?: unknown[],
): Promise<{ score: number; summary: string; signals: string[]; model: string | null; durationMs: number } | null> {
  const started = Date.now()
  const res = await provider.execute({
    prompt,
    responseFormat: 'json',
    jsonSchema: { name: 'pocket_desirability', schema: DESIRABILITY_SCHEMA },
    maxTokens: 1500,
    tools,
  }).catch(() => null)
  const raw = res?.data?.content
  let parsed: { score?: unknown; summary?: unknown; signals?: unknown } | null = null
  try {
    parsed = raw ? JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()) : null
  } catch { parsed = null }
  const score = typeof parsed?.score === 'number' && Number.isFinite(parsed.score)
    ? Math.max(0, Math.min(10, parsed.score))
    : null
  if (score == null) return null
  return {
    score,
    summary: typeof parsed?.summary === 'string' ? parsed.summary.slice(0, 1000) : '',
    signals: Array.isArray(parsed?.signals)
      ? (parsed.signals as unknown[]).filter((s): s is string => typeof s === 'string').slice(0, 8)
      : [],
    model: provider.model,
    durationMs: Date.now() - started,
  }
}

export async function ratePocketDesirability(env: Env, property: NormalizedProperty): Promise<PocketDesirability | null> {
  const provider = createReasoningProvider(env, 'openai/gpt-6-luna')
  if (!provider) return null

  const location = {
    neighborhood: property.neighborhoodName ?? property.subdivision ?? null,
    city: property.city ?? null,
    state: property.state ?? null,
    zip: property.zipCode ?? null,
    censusTract: property.censusTract ?? null,
    blockGroup: property.censusBlockGroup ?? null,
    address: property.address ?? null,
  }
  const anchor = [location.neighborhood, location.city, location.state].filter(Boolean).join(' ')
    || location.address || 'unknown location'

  // Primary path — haiku searches the web itself via Anthropic's
  // server-side web_search tool. No Scrapfly search needed.
  if (provider.name === 'claude') {
    const found = await executeDesirability(
      provider,
      `${DESIRABILITY_PROMPT}\n\nYou have a web_search tool. Run 1-2 searches for "${anchor} real estate market / neighborhood desirability" (e.g. demand, days on market, schools, crime) and rate from what you actually find.\n\nLOCATION:\n${JSON.stringify(location)}`,
      WEB_SEARCH_TOOLS,
    )
    if (found) return found
  }

  // Fallback — gather SERP evidence ourselves (Scrapfly web search)
  // and let haiku score what it is given.
  const snippets = await gatherWebSignal(env, `${anchor} real estate market demand homes for sale neighborhood`)
  return executeDesirability(
    provider,
    `${DESIRABILITY_PROMPT}\n\nLOCATION:\n${JSON.stringify(location)}\n\nWEB EVIDENCE:\n${snippets.join('\n') || '(no web evidence gathered — weigh the location identity and say so)'}`,
  )
}
