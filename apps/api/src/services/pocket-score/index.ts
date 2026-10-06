/**
 * Pocket presence — score pockets once, reuse across evals.
 *
 * Spec: docs/POCKET-PRESENCE-SPEC.md
 * - Pocket = census tract + block group + neighborhood trio (zip fallback).
 * - Score 0-10 = alpha delta (40%) + band discipline (25%) + desirability (35%).
 * - Deterministic inputs come from the run_records payload; desirability is
 *   a once-per-pocket Serper + Luna classify cached for ~90 days.
 */

import type { Env } from '../../types'

const REFRESH_DAYS = 90

/** Synchronous metro guess — used for display before the classified
 *  metro_map row exists; the scoring job overwrites with the LLM result. */
export function metroGuess(state: string | null | undefined): string {
  return KNOWN_METROS[norm(state)] ?? 'Other'
}
const KNOWN_METROS: Record<string, string> = {
  'ga': 'Atlanta',
  'tx': 'Dallas-Fort Worth',
  'fl': 'Tampa Bay',
}

export interface PocketIdentity {
  pocketKey: string
  displayName: string
  tract: string | null
  blockGroup: string | null
  neighborhood: string | null
  city: string | null
  state: string | null
  zip: string | null
}

export interface DeterministicInputs {
  alphaDelta: number | null      // (median band mid − list price) / mid
  bandCoherence: number          // enabled comps / examined comps
  outlierShare: number           // disqualified share of pool
  samePocketShare: number        // comps in the subject's tract/block group
  medianLo: number | null
  medianHi: number | null
  arv: number | null
}

export interface PocketScoreRow {
  pocket_key: string
  display_name: string
  metro: string | null
  city: string | null
  state: string | null
  zip: string | null
  census_tract: string | null
  block_group: string | null
  score: number | null
  median_lo: number | null
  median_hi: number | null
  inputs_json: string | null
  evidence_json: string | null
  scored_by: string | null
  eval_count: number
  scored_at: string | null
  refresh_due_at: string | null
}

function norm(s?: string | null): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Derive pocket identity from a run_records payload_json. */
export function pocketFromPayload(payload: unknown): PocketIdentity | null {
  const p = payload as {
    evidence?: {
      subject?: {
        censusTract?: string; censusBlockGroup?: string
        neighborhoodName?: string; subdivision?: string
        city?: string; state?: string; zipCode?: string
      }
    }
  } | null
  const s = p?.evidence?.subject
  if (!s) return null
  const name = s.neighborhoodName ?? s.subdivision ?? s.zipCode ?? null
  const tract = s.censusTract ?? null
  const blockGroup = s.censusBlockGroup ?? null
  const zip = s.zipCode ?? null
  if (!name && !tract && !zip) return null
  const pocketKey = [
    tract ? `t${tract}` : null,
    blockGroup ? `b${blockGroup}` : null,
    norm(name),
    norm(s.city),
    norm(s.state),
    norm(zip),
  ].filter(Boolean).join('|') || `zip|${norm(zip)}`
  return {
    pocketKey,
    displayName: name ?? `ZIP ${zip ?? '?'}`,
    tract, blockGroup,
    neighborhood: name,
    city: s.city ?? null,
    state: s.state ?? null,
    zip,
  }
}

/** Deterministic inputs from the eval payload + queue list price. */
export function deterministicInputs(payload: unknown, listPrice: number | null): DeterministicInputs {
  const p = payload as {
    evidence?: {
      subject?: { censusTract?: string; censusBlockGroup?: string }
      compPool?: Array<{
        salePrice?: number; arvStatus?: string; isEnabled?: boolean
        sameBlockGroup?: boolean; censusTract?: string
      }>
    }
    result?: { response?: { report?: { arv?: { value?: number; compPool?: { enabled?: number; total?: number } } } } }
  } | null

  const pool = p?.evidence?.compPool ?? []
  const subjectTract = p?.evidence?.subject?.censusTract
  const subjectBg = p?.evidence?.subject?.censusBlockGroup

  const enabled = pool.filter((c) => c.isEnabled)
  const examined = pool.filter((c) => c.arvStatus && c.arvStatus !== 'not_examined')
  const disqualified = pool.filter((c) => c.arvStatus === 'disqualified')
  const inPocket = pool.filter((c) =>
    (subjectBg && c.sameBlockGroup) || (subjectTract && c.censusTract === subjectTract))

  const prices = enabled.map((c) => c.salePrice).filter((x): x is number => typeof x === 'number' && x > 0).sort((a, b) => a - b)
  const median = prices.length ? prices[Math.floor(prices.length / 2)] : null
  const medianLo = prices.length ? prices[Math.floor(prices.length * 0.25)] : null
  const medianHi = prices.length ? prices[Math.min(prices.length - 1, Math.floor(prices.length * 0.75))] : null

  const arv = p?.result?.response?.report?.arv?.value ?? null
  const alphaDelta = (median && listPrice && listPrice > 0)
    ? (median - listPrice) / median
    : null

  return {
    alphaDelta,
    bandCoherence: examined.length ? enabled.length / examined.length : 0,
    outlierShare: pool.length ? disqualified.length / pool.length : 0,
    samePocketShare: pool.length ? inPocket.length / pool.length : 0,
    medianLo,
    medianHi,
    arv,
  }
}

/** Alpha + band-discipline → provisional 0-10 without external calls. */
export function provisionalScore(inputs: DeterministicInputs): number {
  // Alpha: +20% below band = full marks; at band = 0.5; +20% over = 0
  const alpha = inputs.alphaDelta == null ? 0.5 : Math.max(0, Math.min(1, 0.5 + inputs.alphaDelta * 2.5))
  const band = Math.max(0, Math.min(1, inputs.bandCoherence - inputs.outlierShare * 0.5))
  const pocket = Math.max(0, Math.min(1, inputs.samePocketShare * 1.5))
  const combined = alpha * 0.5 + band * 0.25 + pocket * 0.25
  return Math.round(combined * 100) / 10
}

/** City → metro umbrella, cached in metro_map; LLM classify on miss. */
export async function resolveMetro(env: Env, city: string | null, state: string | null): Promise<string> {
  if (!city && !state) return 'Other'
  const cityKey = `${norm(city)}|${norm(state)}`
  const hit = await env.DB.prepare('SELECT metro FROM metro_map WHERE city_key = ?').bind(cityKey)
    .first<{ metro: string }>().catch(() => null)
  if (hit?.metro) return hit.metro

  // Fast path: the three published markets by state when city unrecognized.
  const guess = KNOWN_METROS[norm(state)] ?? 'Other'
  const metro = await classifyMetro(env, city, state).catch(() => null) ?? guess
  await env.DB.prepare(
    'INSERT OR IGNORE INTO metro_map (city_key, metro) VALUES (?, ?)',
  ).bind(cityKey, metro).run().catch(() => {})
  return metro
}

const METRO_PROMPT = `Name the major US metro area this city belongs to. Reply with ONLY the metro name (e.g. "Atlanta", "Dallas-Fort Worth", "Tampa Bay"). If it belongs to no major metro, reply "Other".`

async function classifyMetro(env: Env, city: string | null, state: string | null): Promise<string | null> {
  const key = env.OPENROUTER_API_KEY
  if (!key) return null
  const model = env.OPENROUTER_MODEL || 'openai/gpt-6-luna'
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: METRO_PROMPT },
        { role: 'user', content: `${city ?? ''}, ${state ?? ''}`.trim() || 'unknown' },
      ],
      max_tokens: 12,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) return null
  const data = await res.json<{ choices?: Array<{ message?: { content?: string } }> }>()
  const out = data.choices?.[0]?.message?.content?.trim()
  return out && out.length < 40 ? out : null
}

/** Desirability classify — Serper gather → Luna verdict, cached per pocket. */
async function classifyDesirability(env: Env, id: PocketIdentity): Promise<{ score: number; evidence: unknown } | null> {
  const serper = (env as Env & { SERPER_API_KEY?: string }).SERPER_API_KEY


  let snippets: string[] = []
  const q = `${id.neighborhood ?? id.city} ${id.state} real estate market demand neighborhood`
  if (serper) {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': serper, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, num: 6 }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => null)
    if (res?.ok) {
      const data = await res.json<{ organic?: Array<{ title?: string; snippet?: string }> }>()
      snippets = (data.organic ?? []).map((o) => `${o.title ?? ''}: ${o.snippet ?? ''}`).filter(Boolean).slice(0, 6)
    }
  } else {
    // Scrapfly MCP fallback — web_scrape a Google SERP for the same evidence.
    const mcpUrl = (env as Env & { SCRAPFLY_MCP_URL?: string }).SCRAPFLY_MCP_URL
    if (mcpUrl) {
      const res = await fetch(mcpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'web_scrape', arguments: { url: `https://www.google.com/search?q=${encodeURIComponent(q)}` } },
        }),
        signal: AbortSignal.timeout(20000),
      }).catch(() => null)
      if (res?.ok) {
        const raw = await res.text()
        const m = raw.match(/data: (\{.*\})/)
        try {
          const data = m ? JSON.parse(m[1]) : null
          const text = data?.result?.content?.[0]?.text ?? ''
          // Strip tags + chunk lines — Luna picks signal from the SERP text.
          const clean = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
          snippets = [clean.slice(0, 2500)]
        } catch { /* malformed SSE — skip evidence */ }
      }
    }
  }

  // Clef (Workers AI) — a native score question returns a probability-
  // weighted 0..4, scaled to 0-10. Same System One shape as TypeSafe.
  const acct = (env as Env & { CLOUDFLARE_ACCOUNT_ID?: string }).CLOUDFLARE_ACCOUNT_ID
  const cfKey = (env as Env & { CLOUDFLARE_API_TOKEN?: string }).CLOUDFLARE_API_TOKEN
  if (!acct || !cfKey) return null
  const model = (env as Env & { CLEF_MODEL?: string }).CLEF_MODEL === 'clef' ? 'clef' : 'clef-flash'
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/@cf/cloudflare/${model}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      state: {
        pocket: { neighborhood: id.displayName, city: id.city, state: id.state, zip: id.zip, tract: id.tract, blockGroup: id.blockGroup },
        webEvidence: snippets.join('\n').slice(0, 4000) || '(none — judge from the name and market alone)',
      },
      questions: {
        desirability: {
          type: 'score',
          instructions: 'Investment desirability + market activity for a wholesaler deciding where deals pencil fast: demand depth, turnover speed, resale strength.',
          criteria: ['WEAK — distressed/low-demand area, deals sit', 'SOFT — thin demand, slow turnover', 'MIXED — uneven demand', 'GOOD — healthy demand, steady activity', 'STRONG — high demand, fast turnover, deep buyer pool'],
        },
      },
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) return null
  const raw = await res.json<{ success?: boolean; result?: { answers?: Record<string, { score?: number; confidence?: number }> } }>()
  const ans = raw.result?.answers?.desirability
  if (typeof ans?.score !== 'number') return null
  // score is probability-weighted over 5 criteria (0-4) → scale to 0-10.
  return { score: Math.max(0, Math.min(10, ans.score * 2.5)), evidence: { raw: ans.score, confidence: ans.confidence, snippets: snippets.length, model } }
}

/** Full score for a pocket — writes/upserts the pocket_scores row. */
export async function scorePocket(env: Env, id: PocketIdentity, inputs: DeterministicInputs, listPrice: number | null): Promise<PocketScoreRow> {
  const prov = provisionalScore(inputs)
  const desir = await classifyDesirability(env, id)
  const metro = await resolveMetro(env, id.city, id.state)

  // Blend: provisional covers alpha+band (65%); desirability replaces its share.
  const score = desir
    ? Math.round((prov * 0.65 + desir.score * 0.35) * 10) / 10
    : prov

  const now = new Date().toISOString()
  const due = new Date(Date.now() + REFRESH_DAYS * 86400e3).toISOString()
  await env.DB.prepare(
    `INSERT INTO pocket_scores (pocket_key, display_name, metro, city, state, zip, census_tract, block_group,
       score, median_lo, median_hi, inputs_json, evidence_json, scored_by, eval_count, scored_at, refresh_due_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(pocket_key) DO UPDATE SET
       score = excluded.score, median_lo = excluded.median_lo, median_hi = excluded.median_hi,
       inputs_json = excluded.inputs_json, evidence_json = excluded.evidence_json,
       scored_by = excluded.scored_by, eval_count = pocket_scores.eval_count + 1,
       scored_at = excluded.scored_at, refresh_due_at = excluded.refresh_due_at, updated_at = datetime('now')`,
  ).bind(
    id.pocketKey, id.displayName, metro, id.city, id.state, id.zip, id.tract, id.blockGroup,
    score, inputs.medianLo, inputs.medianHi,
    JSON.stringify(inputs), JSON.stringify(desir?.evidence ?? null),
    desir ? 'clef' : 'deterministic', now, due,
  ).run().catch((e) => console.error('[PocketScore] upsert failed:', e))

  return {
    pocket_key: id.pocketKey, display_name: id.displayName, metro,
    city: id.city, state: id.state, zip: id.zip, census_tract: id.tract, block_group: id.blockGroup,
    score, median_lo: inputs.medianLo, median_hi: inputs.medianHi,
    inputs_json: JSON.stringify(inputs), evidence_json: JSON.stringify(desir?.evidence ?? null),
    scored_by: desir ? 'clef' : 'deterministic', eval_count: 1, scored_at: now, refresh_due_at: due,
  }
}

export interface ListingSignals {
  daysOnMarket: number | null
  priceDrops: number
  contractFallouts: number
  listingEvents: string[]
  listPrice: number | null
  schools: string[]
  zillowUrl: string | null
}

/** Pull the listing signals + cost stack the economics score needs. */
interface PayloadShape {
  result?: {
    response?: {
      subject?: {
        listPrice?: number
        listingDetails?: {
          daysOnRedfin?: number | null
          listPrice?: number | null
          saleHistory?: Array<{ date?: string; event?: string; price?: number | null }>
          schools?: Array<{ name?: string; rating?: number | string }>
        }
        zillowUrl?: string
        listingUrl?: string
      }
      valuation?: {
        buyPrice?: number; rehabCost?: number; carryingCosts?: number
        closingCosts?: number; wholesaleFee?: number; projectedProfit?: number
        wholesalePrice?: number
      }
    }
  }
}

export interface ValuationStack {
  buyPrice?: number; rehabCost?: number; carryingCosts?: number
  closingCosts?: number; wholesaleFee?: number; projectedProfit?: number
  wholesalePrice?: number
}

export function listingSignals(payload: unknown): ListingSignals & { valuation: ValuationStack } {
  const subj = (payload as PayloadShape).result?.response
  const ld = subj?.subject?.listingDetails
  const hist = ld?.saleHistory ?? []
  const events = hist.map((e) => `${e.date ?? ''}: ${e.event ?? ''}${e.price ? ` $${e.price.toLocaleString()}` : ''}`)
  let drops = 0, fallouts = 0, lastList: number | null = null
  for (const e of [...hist].reverse()) {
    const ev = (e.event ?? '').toLowerCase()
    if ((ev === 'listed' || ev === 'relisted' || ev.includes('price')) && e.price != null) {
      if (lastList != null && e.price < lastList) drops++
      lastList = e.price
    }
    if (ev === 'pending' || ev === 'contingent' || ev.includes('contract')) fallouts++
  }
  const schools = (ld?.schools ?? []).map((s) => `${s.name ?? ''}(${s.rating ?? '?'})`).filter(Boolean)
  return {
    daysOnMarket: ld?.daysOnRedfin ?? null,
    priceDrops: drops,
    contractFallouts: fallouts,
    listingEvents: events.slice(-10),
    listPrice: subj?.subject?.listPrice ?? ld?.listPrice ?? null,
    schools,
    zillowUrl: subj?.subject?.zillowUrl ?? null,
    valuation: subj?.valuation ?? {},
  }
}
