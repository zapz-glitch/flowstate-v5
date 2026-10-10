/**
 * Type-selector seat — the typescript lane's pick step. TypeScript labels
 * every data point (runDeterministicSelector's audits, labels, groups,
 * price bands) and stamps each comp's match tier; the reasoning model then
 * picks the identical or closest defensible data sets and posts the ARV.
 * A malformed/missing model answer keeps the deterministic selection —
 * honest degrade, never invented data.
 */
import { OpenAICompatibleProvider } from '../llm/openai-compatible'
import type { Phase1Context, HarnessEvidence } from './index'
import type { AppraiserResult } from './appraiser'
import { runDeterministicSelector, type RankedComp } from './selector'

const TYPE_SELECTOR_MODEL = 'deepseek/deepseek-v4.1-flash'
const TYPE_SELECTOR_BASE_URL = 'https://openrouter.ai/api/v1/chat/completions'

interface TypeSelectorEnv {
  OPENROUTER_API_KEY?: string
  TYPE_SELECTOR_API_KEY?: string
  TYPE_SELECTOR_BASE_URL?: string
  TYPE_SELECTOR_MODEL?: string
}

/** Any OpenAI-compatible chat-completions endpoint (OpenRouter, Inception). */
class SeatProvider extends OpenAICompatibleProvider {
  readonly name = 'openrouter' as const
  constructor(config: { apiKey: string; model: string; baseUrl: string; maxTokens?: number }) {
    super({ apiKey: config.apiKey, model: config.model, maxTokens: config.maxTokens, baseUrl: config.baseUrl })
  }
}

interface ModelPick {
  selectedCompIds: string[]
  arv: number
  conf: 'high' | 'medium' | 'low'
  note: string
}

/**
 * Match tiers — what every comp ID *is* to the model. Tier 1 is a critical
 * match: in-pocket geography, every physical label exact/close, fresh sale,
 * ARV price evidence. Tier 2 drops one recoverable physical difference OR
 * keeps clean physicals but prices at median instead of ARV. Tier 3 allows
 * two recoverable differences — still inside every hard rule. Anything
 * worse is already excluded by code and never reaches the model.
 */
function tierOf(r: RankedComp): 1 | 2 | 3 {
  const inPocket = r.profile.geoTier !== 'OFF_POCKET'
  const l = r.labels
  const physExact = l ? [l.sqft, l.year, l.lot].filter((d) => d === 'exact' || d === 'close').length : 0
  const diffs = l?.diffs ?? r.audit.recoverable.length
  const fresh = l?.saleAge === 'fresh'
  const arv = l?.priceEvidence === 'arv'
  if (inPocket && physExact === 3 && diffs === 0 && fresh && arv) return 1
  if (inPocket && diffs <= 1 && (arv || physExact === 3) && l?.saleAge !== 'aged_out' && l?.sanity === 'clean') return 2
  return 3
}

export async function runTypeSelector(
  env: TypeSelectorEnv,
  ctx: Phase1Context,
  evidence: HarnessEvidence,
  opts?: { priceBand?: { upper: number; lower: number } },
): Promise<AppraiserResult> {
  let ranked: RankedComp[] = []
  const base = runDeterministicSelector(ctx, evidence, {
    priceBand: opts?.priceBand,
    onRanked: (r) => { ranked = r },
  })

  const model = env.TYPE_SELECTOR_MODEL ?? TYPE_SELECTOR_MODEL
  const apiKey = env.TYPE_SELECTOR_API_KEY ?? env.OPENROUTER_API_KEY
  // Reasoning models burn the whole token budget in the reasoning trace
  // before writing content — the budget must cover both or content comes
  // back empty (observed: 2000 tokens → 2000 reasoning → no answer).
  const provider = apiKey
    ? new SeatProvider({ apiKey, model, baseUrl: env.TYPE_SELECTOR_BASE_URL ?? TYPE_SELECTOR_BASE_URL, maxTokens: 8000 })
    : null
  if (!provider) {
    base.debugNotes.push('type-selector: no seat API key — deterministic seat')
    return base
  }

  // The reasoning model burns its whole budget thinking per-row — 30 rows
  // starved an 8k answer to zero content (finish_reason length, all
  // reasoning tokens). The top-12 by tier/diffs/geo is the candidate set
  // that answers in seconds.
  const MODEL_CAP = 12
  const GEO_RANK: Record<string, number> = { BLOCK_GROUP: 0, NEIGHBORHOOD: 1, SUBDIVISION: 2, TRACT: 3, OFF_POCKET: 4 }
  const eligible = ranked
    .filter((r) => r.audit.verdict === 'eligible')
    .sort((a, b) =>
      tierOf(a) - tierOf(b)
      || (a.labels?.diffs ?? 9) - (b.labels?.diffs ?? 9)
      || (GEO_RANK[a.profile.geoTier] ?? 9) - (GEO_RANK[b.profile.geoTier] ?? 9)
      || String(b.comp.saleDate ?? '').localeCompare(String(a.comp.saleDate ?? '')))
    .slice(0, MODEL_CAP)
  if (eligible.length === 0) return base

  const subject = evidence.subject
  const rows = eligible.map((r) => {
    const l = r.labels
    return {
      id: r.id,
      tier: tierOf(r),
      salePrice: r.comp.salePrice,
      ppsf: Math.round(r.ppsf),
      sqft: r.comp.squareFeet,
      beds: r.comp.bedrooms,
      baths: r.comp.bathrooms,
      yearBuilt: r.comp.yearBuilt,
      lotSqft: r.comp.lotSizeSquareFeet,
      saleDate: r.comp.saleDate,
      distMi: r.comp.distanceMiles != null ? Math.round(r.comp.distanceMiles * 10) / 10 : null,
      geo: l?.geo ?? r.profile.geoTier,
      lbl: l ? `sqft:${l.sqft}|yr:${l.year}|lot:${l.lot}|style:${l.style}|sale:${l.saleAge}|${l.pricePosition}→${l.priceEvidence}|${l.sanity}|diffs:${l.diffs}` : '',
      group: r.group,
    }
  })

  const sys =
    'You are the comp-selection seat of a supervised appraisal lane. ' +
    'TypeScript already labeled every data set — you only judge which are ' +
    'the identical or closest defensible matches to the subject. ARV ' +
    'accuracy is the goal. Reply with STRICT JSON only: ' +
    '{"selectedCompIds":[...],"arv":<number>,"conf":"high|medium|low","note":"<one sentence>"}.'
  const user = JSON.stringify({
    task: 'Pick 1-3 comps. Prefer the most tier-1 matches (critical matches). ' +
      'When no tier-1 exists, pick the closest tier-2; tier-3 is the floor — ' +
      'the tier field tells you exactly how close each data set is. Only pick ' +
      'ids from eligible. ARV = the price your picks justify for the subject, ' +
      'weighted toward ARV-priced picks in the best geo tier.',
    tiers: {
      '1': 'in-pocket geo, all physical labels exact/close, fresh sale, ARV price — identical data set',
      '2': 'in-pocket geo, at most one recoverable difference, OR clean physicals priced median — closest data set',
      '3': 'in-pocket geo, up to two recoverable differences — defensible fallback',
    },
    subject: {
      address: subject.address, sqft: subject.squareFeet, beds: subject.bedrooms,
      baths: subject.bathrooms, yearBuilt: subject.yearBuilt, lotSqft: subject.lotSizeSquareFeet,
    },
    band: opts?.priceBand ?? null,
    eligible: rows,
  })

  try {
    // One retry — the reasoning provider intermittently returns an empty
    // completion; a second call is cheap against the deterministic seat.
    // The reasoning flag only goes to models that accept it (deepseek);
    // Mercury and other non-reasoning seats would 400 on it.
    const req = {
      prompt: user,
      systemPrompt: sys,
      responseFormat: 'json' as const,
      maxTokens: 8000,
      ...(model.includes('deepseek') ? { reasoning: { enabled: true, effort: 'low' as const } } : {}),
    }
    let res = await provider.execute(req)
    if ((!res.success || !res.data?.content)) {
      res = await provider.execute(req)
    }
    if (!res.success) throw new Error(res.error?.message ?? 'provider error')
    const text = res.data?.content ?? ''
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
    const pick = JSON.parse(json) as ModelPick
    const eligIds = new Set(eligible.map((r) => r.id))
    const ids = (pick.selectedCompIds ?? []).filter((id) => eligIds.has(id)).slice(0, 3)
    const arv = typeof pick.arv === 'number' && Number.isFinite(pick.arv) && pick.arv > 0 ? Math.round(pick.arv) : null
    if (ids.length === 0 || arv == null) {
      base.debugNotes.push('type-selector: model answer failed validation — deterministic seat')
      return base
    }
    // ARV sanity: must sit inside the picks' own ppsf evidence envelope —
    // a model number beyond ±50% of its picks' median $/sf × subject sqft
    // is hallucinated, not reasoned. Deterministic seat keeps its pick.
    const pickPpsfs = ids.map((id) => eligible.find((r) => r.id === id)!.ppsf).sort((a, b) => a - b)
    const pickMedian = pickPpsfs[Math.floor((pickPpsfs.length - 1) / 2)]
    const implied = pickMedian * (subject.squareFeet ?? 0)
    if (subject.squareFeet != null && subject.squareFeet > 0 &&
        (arv > implied * 1.5 || arv < implied * 0.6)) {
      base.debugNotes.push(`type-selector: ARV $${arv} outside picks' envelope ($${Math.round(implied)}) — deterministic seat`)
      return base
    }
    const conf = pick.conf === 'high' || pick.conf === 'medium' || pick.conf === 'low' ? pick.conf : 'low'
    return {
      ...base,
      model,
      selection: {
        ...(base.selection ?? {}),
        selectedCompIds: ids,
        drivers: ids,
        arv,
        arvEvidence: arv,
        conf,
        notes: `Type-selector (${model}): ${pick.note ?? 'picked ' + ids.length + ' comps'}`,
        flags: [...(base.selection?.flags ?? []), `type_seat:${model}`],
      },
    }
  } catch (e) {
    base.debugNotes.push(`type-selector: ${e instanceof Error ? e.message : 'call failed'} — deterministic seat`)
    return base
  }
}
