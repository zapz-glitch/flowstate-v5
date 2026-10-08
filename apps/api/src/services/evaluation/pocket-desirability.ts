/**
 * Pocket desirability — one haiku call, one job: rate how desirable the
 * SUBJECT'S LOCATION is for a wholesale acquisition on a 0-10 scale.
 *
 * Contract: docs/HAIKU-POCKET-DESIRABILITY.md. Serper gathers web signal
 * on the neighborhood/city (demand, turnover, livability); haiku reads
 * the evidence and returns a score + rationale. Classification only —
 * no decision authority; the result rides the evidence bundle for the
 * Opus appraiser and lands in the run trace.
 *
 * Separate call by design: it does not share state with the subject
 * condition call or the per-comp classify calls. Cached downstream only
 * via the report itself — every eval re-rates.
 */

import type { Env } from '../../types'
import type { NormalizedProperty } from '../property-api/types'
import { createReasoningProvider } from '../llm'

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
  const serper = env.SERPER_API_KEY
  if (!serper) return []
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': serper, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: 6 }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => null)
  if (!res?.ok) return []
  const data = await res.json<{ organic?: Array<{ title?: string; snippet?: string }> }>().catch(() => null)
  return (data?.organic ?? [])
    .map((o) => `${o.title ?? ''}: ${o.snippet ?? ''}`.trim())
    .filter(Boolean)
    .slice(0, 6)
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
  const snippets = await gatherWebSignal(env, `${anchor} real estate market demand homes for sale neighborhood`)

  const started = Date.now()
  const res = await provider.execute({
    prompt: `${DESIRABILITY_PROMPT}\n\nLOCATION:\n${JSON.stringify(location)}\n\nWEB EVIDENCE:\n${snippets.join('\n') || '(no web evidence gathered — weigh the location identity and say so)'}`,
    responseFormat: 'json',
    jsonSchema: { name: 'pocket_desirability', schema: DESIRABILITY_SCHEMA },
    maxTokens: 768,
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
