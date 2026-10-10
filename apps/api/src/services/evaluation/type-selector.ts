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
 * Match tiers — what every comp ID *is* to the model, on the appraisal-rule
 * tolerances (docs/B-HARNESS + APPRAISER-RULESET):
 *   T1 — in-pocket + sqft within ±250 + era year (±10yr) + fresh sale +
 *        ARV price evidence = the identical data set
 *   T2 — in-pocket + sqft within 20% + year within ±20 = closest data set
 *   T3 — in-pocket + era year built (±30) + sqft within 35% = defensible
 *   Anything worse is already excluded by code and never reaches the model.
 */
function tierOf(r: RankedComp, subjectSqft: number | null, subjectYear: number | null): 1 | 2 | 3 {
  const inPocket = r.profile.geoTier !== 'OFF_POCKET'
  if (!inPocket) return 3
  const l = r.labels
  const sqftGap = subjectSqft && r.comp.squareFeet ? Math.abs(r.comp.squareFeet - subjectSqft) : null
  const sqftPct = sqftGap != null && subjectSqft ? sqftGap / subjectSqft : null
  const yrGap = subjectYear && r.comp.yearBuilt ? Math.abs(r.comp.yearBuilt - subjectYear) : null
  const fresh = l?.saleAge === 'fresh'
  const arv = l?.priceEvidence === 'arv'
  const clean = l?.sanity !== 'anomalous'
  if (sqftGap != null && sqftGap <= 250 && yrGap != null && yrGap <= 10 && fresh && arv && clean) return 1
  if (sqftPct != null && sqftPct <= 0.20 && (yrGap == null || yrGap <= 20) && clean && l?.saleAge !== 'aged_out') return 2
  return 3
}

/**
 * Excess-sqft contributory value — the appraiser rule that a comp too big or
 * too small only contributes a *percent* of its extra/missing size. Marginal
 * taper from the B harness: the marginal foot is priced at 50% of the comp's
 * $/sf for gaps <=10%, 40% <=25%, 30% beyond. Implied = what this comp's sale
 * is worth at the subject's size — the number the model should price on.
 */
function impliedValue(r: RankedComp, subjectSqft: number | null): number | null {
  if (!subjectSqft || !r.comp.squareFeet || !r.comp.salePrice || r.ppsf <= 0) return null
  const gap = subjectSqft - r.comp.squareFeet
  const gapPct = Math.abs(gap) / r.comp.squareFeet
  const rate = gapPct <= 0.10 ? 0.5 : gapPct <= 0.25 ? 0.4 : 0.3
  return Math.round(r.comp.salePrice + gap * r.ppsf * rate)
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
  // 'picked' verdicts are stamped inside the same call before it returns —
  // the ranked array we captured is post-mutation, so eligible membership is
  // "not ruled out", not "still stamped eligible".
  const subject = evidence.subject
  const subjSqft = subject.squareFeet ?? null
  const eligible = ranked
    .filter((r) => r.audit.verdict === 'eligible' || r.audit.verdict === 'picked')
    .sort((a, b) =>
      tierOf(a, subject.squareFeet ?? null, subject.yearBuilt ?? null) - tierOf(b, subject.squareFeet ?? null, subject.yearBuilt ?? null)
      || (a.labels?.diffs ?? 9) - (b.labels?.diffs ?? 9)
      || (GEO_RANK[a.profile.geoTier] ?? 9) - (GEO_RANK[b.profile.geoTier] ?? 9)
      || String(b.comp.saleDate ?? '').localeCompare(String(a.comp.saleDate ?? '')))
    .slice(0, MODEL_CAP)
  if (eligible.length === 0) {
    base.debugNotes.push(`type-selector: 0 eligible comps (ranked=${ranked.length} verdicts=${ranked.map((r) => r.audit.verdict).join(',')}) — deterministic seat`)
    return base
  }
  base.debugNotes.push(`type-selector: seat call → ${eligible.length} eligible (ranked=${ranked.length})`)

  const rows = eligible.map((r) => {
    const l = r.labels
    return {
      id: r.id,
      tier: tierOf(r, subjSqft, subject.yearBuilt ?? null),
      salePrice: r.comp.salePrice,
      implied: impliedValue(r, subjSqft),
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
      'Anchor on the most-similar pick; supporters bound the range. ARV ' +
      'should be priced on each pick\'s "implied" value — its sale repriced ' +
      'at the subject\'s size with the appraiser marginal-rate taper (excess ' +
      'or missing sqft contributes only a percent of value: 50%/40%/30% of ' +
      '$/sf by gap size). ARV-priced picks weight most; the pocket median ' +
      'bounds you.',
    tiers: {
      '1': 'in-pocket geo, sqft within ±250, era year built, fresh sale, ARV price — identical data set',
      '2': 'in-pocket geo, sqft within 20%, year within ±20 — closest data set',
      '3': 'in-pocket geo, era year built, sqft within ~35% — defensible fallback',
    },
    subject: {
      address: subject.address, sqft: subject.squareFeet, beds: subject.bedrooms,
      baths: subject.bathrooms, yearBuilt: subject.yearBuilt, lotSqft: subject.lotSizeSquareFeet,
    },
    band: opts?.priceBand ?? null,
    pocketMedian: (() => {
      const xs = eligible
        .filter((r) => r.profile.geoTier === 'BLOCK_GROUP' || r.profile.geoTier === 'SUBDIVISION')
        .map((r) => r.ppsf).filter((v) => v > 0).sort((a, b) => a - b)
      return xs.length ? Math.round(xs[Math.floor((xs.length - 1) / 2)]) : null
    })(),
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
    const pickImplied = ids.map((id) => {
      const r = eligible.find((x) => x.id === id)!
      return impliedValue(r, subjSqft) ?? (r.ppsf * (subjSqft ?? r.comp.squareFeet ?? 0))
    }).filter((v) => v > 0).sort((a, b) => a - b)
    const implied = pickImplied.length ? pickImplied[Math.floor((pickImplied.length - 1) / 2)] : 0
    if (implied > 0 && (arv > implied * 1.5 || arv < implied * 0.6)) {
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
