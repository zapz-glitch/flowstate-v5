/**
 * Dual classification — pocket + economics (spec v2).
 *
 * Pocket: Serper/Scrapfly evidence → Clef score + Luna reasoning in
 * parallel → final Luna call merges both verdicts + band inputs → score/10.
 *
 * Economics: Luna reasons over the solidified bands (list price, median
 * band, ARV band, as-is) → score/10 for alpha capture.
 *
 * Everything is post-eval — these read solidified payloads, never block
 * the eval path.
 */

import type { Env } from '../../types'
import type { DeterministicInputs, PocketIdentity } from './index'

export interface ClassifyResult {
  score: number               // 0-10
  rationale: string
  clefScore: number | null
  confidence: number | null
  model: string
}

type Env2 = Env & {
  SERPER_API_KEY?: string
  SCRAPFLY_MCP_URL?: string
  CLOUDFLARE_ACCOUNT_ID?: string
  CLOUDFLARE_API_TOKEN?: string
  CLEF_MODEL?: string
  OPENROUTER_API_KEY?: string
  OPENROUTER_MODEL?: string
}

// ── Evidence gather (Serper → Scrapfly fallback) ──────────────────────────

async function gatherEvidence(env: Env2, query: string): Promise<string[]> {
  if (env.SERPER_API_KEY) {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': env.SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 6 }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => null)
    if (res?.ok) {
      const data = await res.json<{ organic?: Array<{ title?: string; snippet?: string }> }>()
      return (data.organic ?? []).map((o) => `${o.title ?? ''}: ${o.snippet ?? ''}`).filter(Boolean).slice(0, 6)
    }
  }
  if (env.SCRAPFLY_MCP_URL) {
    const res = await fetch(env.SCRAPFLY_MCP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'web_scrape', arguments: { url: `https://www.google.com/search?q=${encodeURIComponent(query)}` } },
      }),
      signal: AbortSignal.timeout(20000),
    }).catch(() => null)
    if (res?.ok) {
      const raw = await res.text()
      const m = raw.match(/data: (\{.*\})/)
      try {
        const text = JSON.parse(m?.[1] ?? 'null')?.result?.content?.[0]?.text ?? ''
        return [text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 2500)].filter(Boolean)
      } catch { /* malformed */ }
    }
  }
  return []
}

// ── Clef score question ────────────────────────────────────────────────────

async function clefVerdict(env: Env2, id: PocketIdentity, snippets: string[]): Promise<{ score: number; confidence: number | null } | null> {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) return null
  const model = env.CLEF_MODEL === 'clef' ? 'clef' : 'clef-flash'
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/cloudflare/${model}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      state: {
        pocket: { neighborhood: id.displayName, city: id.city, state: id.state, zip: id.zip, tract: id.tract, blockGroup: id.blockGroup },
        webEvidence: snippets.join('\n').slice(0, 4000) || '(none — judge from name and market alone)',
      },
      questions: {
        desirability: {
          type: 'score',
          instructions: 'Would people want to move here, and do investors want to buy here? School district quality, buyer demand, turnover speed, resale depth.',
          criteria: ['WEAK — distressed/low-demand, deals sit', 'SOFT — thin demand, slow turnover', 'MIXED — uneven demand', 'GOOD — healthy demand, steady activity', 'STRONG — high demand, fast turnover, deep buyer pool'],
        },
      },
    }),
    signal: AbortSignal.timeout(15000),
  }).catch(() => null)
  if (!res?.ok) return null
  const raw = await res.json<{ result?: { answers?: Record<string, { score?: number; confidence?: number }> } }>()
  const ans = raw.result?.answers?.desirability
  return typeof ans?.score === 'number'
    ? { score: Math.max(0, Math.min(10, ans.score * 2.5)), confidence: ans.confidence ?? null }
    : null
}

// ── GPT-6 Luna (OpenRouter chat) ───────────────────────────────────────────

async function luna(env: Env2, messages: Array<{ role: string; content: string }>, maxTokens = 300): Promise<string | null> {
  if (!env.OPENROUTER_API_KEY) return null
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: env.OPENROUTER_MODEL || 'openai/gpt-6-luna', messages, max_tokens: maxTokens, temperature: 0.2 }),
    signal: AbortSignal.timeout(30000),
  }).catch(() => null)
  if (!res?.ok) return null
  const data = await res.json<{ choices?: Array<{ message?: { content?: string } }> }>()
  return data.choices?.[0]?.message?.content?.trim() ?? null
}

function parseScore(text: string | null): { score: number; rationale: string } | null {
  if (!text) return null
  const json = text.match(/\{[\s\S]*"score"[\s\S]*\}/)
  if (json) {
    try {
      const body = JSON.parse(json[0]) as { score?: number; rationale?: string }
      if (typeof body.score === 'number') {
        return { score: Math.max(0, Math.min(10, body.score)), rationale: String(body.rationale ?? '').slice(0, 240) || text.slice(0, 200) }
      }
    } catch { /* fall through to regex */ }
  }
  const m = text.match(/score[:\s]+([\d.]+)/i)
  if (!m) return null
  return { score: Math.max(0, Math.min(10, parseFloat(m[1]))), rationale: text.slice(0, 200) }
}

// ── Public: pocket classification (Clef ∥ Luna → Luna final) ───────────────

export async function classifyPocket(env: Env2, id: PocketIdentity, inputs: DeterministicInputs): Promise<ClassifyResult | null> {
  const q = `${id.neighborhood ?? id.city} ${id.state} school district desirability buyers demand real estate`
  const snippets = await gatherEvidence(env, q)

  const [clef, lunaRead] = await Promise.all([
    clefVerdict(env, id, snippets),
    luna(env, [
      { role: 'system', content: 'You evaluate residential pockets for a wholesale investor. Reply ONLY JSON: {"score": <0-10>, "rationale": "<one sentence>"}. Score = pocket desirability + market activity.' },
      { role: 'user', content: `Pocket: ${id.displayName}, ${id.city ?? ''}, ${id.state} ${id.zip ?? ''}\nEvidence:\n${snippets.join('\n') || '(none)'}` },
    ]),
  ])

  if (!clef && !lunaRead) return null

  // Final Luna determination over both verdicts + deterministic inputs.
  const merged = await luna(env, [
    { role: 'system', content: 'You are the final arbiter on pocket desirability for wholesale underwriting. Weigh Clef\'s structured verdict, the independent read, and the comp-band evidence. Reply ONLY JSON: {"score": <0-10>, "rationale": "<one sentence>"}.' },
    { role: 'user', content: [
      `Pocket: ${id.displayName}, ${id.city ?? ''}, ${id.state} ${id.zip ?? ''} (tract ${id.tract ?? '?'}, block group ${id.blockGroup ?? '?'})`,
      `Clef score: ${clef ? `${clef.score.toFixed(1)}/10 (conf ${clef.confidence ?? '?'})` : 'unavailable'}`,
      `Independent read: ${lunaRead ?? 'unavailable'}`,
      `Band inputs: median $${inputs.medianLo ?? '?'}-$${inputs.medianHi ?? '?'}, coherence ${(inputs.bandCoherence * 100).toFixed(0)}%, outlier share ${(inputs.outlierShare * 100).toFixed(0)}%, in-pocket comps ${(inputs.samePocketShare * 100).toFixed(0)}%`,
      `Evidence:\n${snippets.join('\n') || '(none)'}`,
    ].join('\n') },
  ])

  const parsed = parseScore(merged)
  if (parsed) return { score: parsed.score, rationale: parsed.rationale, clefScore: clef?.score ?? null, confidence: clef?.confidence ?? null, model: 'clef+luna' }
  // Luna merge failed — fall back to whichever verdict exists.
  const fallback = clef ? clef.score : parseScore(lunaRead)?.score
  return fallback != null
    ? { score: fallback, rationale: parseScore(lunaRead)?.rationale ?? 'single-verdict fallback', clefScore: clef?.score ?? null, confidence: clef?.confidence ?? null, model: clef ? 'clef' : 'luna' }
    : null
}

// ── Public: economics classification (Luna over solidified bands) ──────────

export interface EconomicsInput {
  wholesalePrice: number | null
  listPrice: number | null
  medianLo: number | null
  medianHi: number | null
  arv: number | null
  asIsValue: number | null
  /** Achievability signals — from subject.listingDetails */
  daysOnMarket: number | null
  priceDrops: number            // count of downward price events
  contractFallouts: number      // pending→relisted cycles
  listingEvents: string[]       // compact "Oct 2: Listed $279k" lines
  zillowViews: number | null    // scraped from subject's Zillow page
  zillowSaves: number | null
  /** The real cost stack from valuation — the number where everything fits */
  rehabCost: number | null
  carryingCosts: number | null
  closingCosts: number | null
  wholesaleFee: number | null
  buyPrice: number | null       // MAO — the eval's own max allowable offer
  projectedProfit: number | null
}

export async function classifyEconomics(env: Env2, id: PocketIdentity, econ: EconomicsInput): Promise<ClassifyResult | null> {
  const out = await luna(env, [
    { role: 'system', content: [
      'You score acquisition likelihood for a wholesaler, 0-10 — can we buy at our wholesale number? Two sub-scores, merged:',
      'MARGIN FIT — does ARV minus list hold the whole cost stack (rehab + carrying + closing + wholesale fee + investor profit)? No fixed dollar target — judge fit from the actual numbers.',
      'ACHIEVABILITY — will the seller take it? DOM + price-drop cadence + contract fallout are the reads. A discount off list is EXPECTED — list is usually rich.',
      'Motivated: long DOM with regular price drops (~every 30d), or pending→relisted cycles. Fishing: long DOM, zero drops, never under contract.',
      'Fresh listing with strong demand = priced right; wholesale near list is still achievable there.',
      'Reply ONLY JSON: {"score": <0-10>, "rationale": "<one sentence — cite the deltas and the signals you weighed>"}.',
    ].join('\n') },
    { role: 'user', content: [
      `Property in ${id.displayName}, ${id.city ?? ''}, ${id.state}`,
      `ARV: ${econ.arv ? '$' + econ.arv.toLocaleString() : 'unknown'}${econ.asIsValue ? `, as-is $${econ.asIsValue.toLocaleString()}` : ''}`,
      `List price: ${econ.listPrice ? '$' + econ.listPrice.toLocaleString() : 'unknown'}`,
      `Our wholesale number: ${econ.wholesalePrice ? '$' + econ.wholesalePrice.toLocaleString() : 'unknown'}`,
      `Pocket median band: ${econ.medianLo && econ.medianHi ? `$${econ.medianLo.toLocaleString()}-$${econ.medianHi.toLocaleString()}` : 'unknown'}`,
      `Cost stack (eval's own math): rehab ${econ.rehabCost ? '$'+econ.rehabCost.toLocaleString() : '?'}, closing ${econ.closingCosts ? '$'+econ.closingCosts.toLocaleString() : '?'}, carrying ${econ.carryingCosts ? '$'+econ.carryingCosts.toLocaleString() : '?'}, wholesale fee ${econ.wholesaleFee ? '$'+econ.wholesaleFee.toLocaleString() : '?'}`,
      `MAO (number where all costs fit): ${econ.buyPrice ? '$' + econ.buyPrice.toLocaleString() : 'unknown'}${econ.projectedProfit ? ` | projected profit $${econ.projectedProfit.toLocaleString()}` : ''}`,
      `Days on market: ${econ.daysOnMarket ?? 'unknown'} | price drops: ${econ.priceDrops} | contract fallouts: ${econ.contractFallouts}`,
      `Zillow engagement: ${econ.zillowViews != null ? `${econ.zillowViews} views / ${econ.zillowSaves ?? '?'} saves` : 'not captured'}`,
      econ.listingEvents.length ? `Listing history:\n${econ.listingEvents.join('\n')}` : 'Listing history: none',
    ].join('\n') },
  ])
  const parsed = parseScore(out)
  return parsed ? { score: parsed.score, rationale: parsed.rationale, clefScore: null, confidence: null, model: 'luna' } : null
}

// ── Zillow engagement — views + saves via Scrapfly scrape ──────────────────

export async function zillowEngagement(env: Env2, zillowUrl: string): Promise<{ views: number | null; saves: number | null; days: number | null }> {
  if (!env.SCRAPFLY_MCP_URL) return { views: null, saves: null, days: null }
  const res = await fetch(env.SCRAPFLY_MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'web_scrape', arguments: { url: zillowUrl } },
    }),
    signal: AbortSignal.timeout(25000),
  }).catch(() => null)
  if (!res?.ok) return { views: null, saves: null, days: null }
  try {
    const raw = await res.text()
    const m = raw.match(/data: (\{.*\})/)
    // Scrape text carries literal "\n" sequences — normalize before parsing.
    const text = (JSON.parse(m?.[1] ?? 'null')?.result?.content?.[0]?.text ?? '')
      .replace(/<[^>]+>/g, ' ').replace(/\\n/g, ' ')
    // Zillow renders "**24 days** **753** **58**" — DOM / views / saves.
    const strip = text.match(/\*\*(\d[\d,]*)\s*days?\*\*[^*]*\*\*(\d[\d,]*)\*\*[^*]*\*\*(\d[\d,]*)\*\*/)
      ?? text.match(/(\d[\d,]*)\s*days?\s*on\s*zillow[^0-9]*(\d[\d,]*)\s*views?[^0-9]*(\d[\d,]*)\s*saves?/i)
    if (strip) return { days: Number(strip[1].replace(/,/g, '')), views: Number(strip[2].replace(/,/g, '')), saves: Number(strip[3].replace(/,/g, '')) }
    const views = text.match(/(\d[\d,]*)\s*views?/i)
    const saves = text.match(/(\d[\d,]*)\s*saves?/i)
    return {
      views: views ? Number(views[1].replace(/,/g, '')) : null,
      saves: saves ? Number(saves[1].replace(/,/g, '')) : null,
      days: null,
    }
  } catch { return { views: null, saves: null, days: null } }
}
