/**
 * Renovation evidence + pricing — the renovation engine seam.
 *
 * `buildRenovationEvidence` assembles the four data points the Evaluation
 * Agent reads for the rehab scope (subject listing description claims,
 * permit-age ledger, seller/realtor notes, vision zone grades) plus the
 * pricing context (cost schedule, flip-delta rate, finish parity). All of it
 * is advisory evidence — the agent posts a `renovation` object with its
 * verdict, and `priceAgentRenovation` deterministically prices the posted
 * scope against the same schedule (fail-open: gaps are flagged and priced,
 * never invented).
 */

import type { RenovationAssessment } from '../vision/renovation'
import { MAJOR_ITEMS, type MajorItem } from '../valuation'
import type { RehabAddition, RehabAdvisory } from '../seller-notes'
import type { NormalizedPermit } from '../property-api/types'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DescriptionClaim {
  /** Major-item id the claim maps to (roof, hvac, ...) */
  item: string
  /** The year the work is claimed to have happened, if dated */
  year: number | null
  /** What was claimed — replaced/new/updated/repaired */
  action: 'replaced' | 'repaired' | 'updated'
  /** The sentence fragment it came from */
  evidence: string
}

/** 4-tier evidence hierarchy per docs/renovation-crediting-rules.md:
 *  credited       — Tier 1: verified permit in window → $0 replacement
 *  claimed_dated  — Tier 2: dated text claim → soft-repair tier (≤20% of schedule)
 *  past_threshold — permit on record but older than threshold → mandatory replace
 *  assumed_past   — Tier 3: no verification and home age exceeds design life
 *                 → mandatory replace (age baseline)
 *  unknown        — no evidence and home within design life → advisory */
export type LedgerStatus =
  | 'credited'
  | 'claimed_dated'
  | 'past_threshold'
  | 'assumed_past'
  | 'unknown'

export interface PermitLedgerEntry {
  item: string
  /** Design life in years used for the RUL / age-baseline computation. */
  designLife: number | null
  /** Newest matching permit year, if any */
  latestPermitYear: number | null
  /** Claimed year from listing text when status is claimed_dated */
  claimedYear: number | null
  status: LedgerStatus
  /** Effective replacement cost after user overrides */
  cost: number
  /** Tier-2 soft-repair allowance (≈8% of cost, capped at 20%) */
  softRepairCost: number
}

export interface RenovationEvidence {
  zoneGrades: {
    kitchen: string
    bathrooms: string
    flooring: string
    wallsCeilings: string
    exterior: string
    systemConcerns: string[]
    structuralConcerns: string[]
    observations: string[]
    limitations: string[]
  } | null
  /** Path-A gate: confidence + readable-zone count per the ruleset. */
  pathGate: {
    photoConfidence: number | null
    readableZones: number
    recommendedPath: 'A' | 'B'
  }
  descriptionClaims: DescriptionClaim[]
  permitLedger: PermitLedgerEntry[]
  sellerNoteClaims: { additions: RehabAddition[]; advisories: RehabAdvisory[] }
  /** Finish keywords found on ARV-evidence comps vs the subject. */
  finishParity: {
    arvStandard: string[]
    subjectHas: string[]
    missingOnSubject: string[]
  }
  /** Local $/sf flip delta from verified flip pairs in the pool. */
  flipDelta: {
    pairs: Array<{ compId: string; buy: number; resale: number; sqft: number; rate: number }>
    medianRate: number | null
  }
  /** Effective per-item cost schedule (user overrides applied). */
  costSchedule: Record<string, number>
  /** Path-B rates: flip-delta first, caller table second, defaults last. */
  pathBRates: {
    flipDeltaPerSqft: number | null
    defaultPerSqft: Record<string, number>
  }
}

export interface AgentRenovationItem {
  item: string
  action: 'replace' | 'recondition' | 'repair' | 'upgrade' | 'add' | 'base_scope'
  category: 'capex' | 'cosmetic'
  uadFrom?: string
  uadTo?: string
  spec?: string
  cost: number
  source: 'permit' | 'description' | 'notes' | 'vision' | 'parity' | 'override' | 'base'
}

export interface AgentRenovation {
  pathUsed: 'A' | 'B'
  zoneGrades?: Record<string, string>
  lineItems: AgentRenovationItem[]
  contingencyPct?: number
  totalEstimate?: number
  notes?: string
}

export interface PricedRenovation {
  pathUsed: 'A' | 'B'
  items: Array<AgentRenovationItem & { resolvedCost: number; resolution: string }>
  contingencyPct: number
  /** Itemized scope total INCLUDING contingency — the base rehab cost. */
  total: number
  audit: string[]
  flags: string[]
}

// ─── Description claim extraction ────────────────────────────────────────────

const CLAIM_ITEMS: Array<{ item: string; re: RegExp }> = [
  { item: 'roof', re: /roofs?|shingles?/ },
  { item: 'hvac', re: /hvac|a\/c|ac unit|air condition(?:er|ing)?|heat pump|furnace/ },
  { item: 'water_heater', re: /water\s*heat(?:er|ing)|hot water/ },
  { item: 'electric_panel', re: /electric(?:al)?\s*panel|breaker box|rewired|new wiring/ },
  { item: 'replumb', re: /repiped|replumb|new plumbing|pex/ },
  { item: 'pool_plaster', re: /pool\s*(?:replaster|resurfac|pump|equip)/ },
  { item: 'foundation', re: /foundation/ },
  { item: 'windows', re: /windows?/ },
  { item: 'kitchen', re: /kitchen|countertops?|cabinets?/ },
  { item: 'bathroom', re: /bath(?:room|s)?|shower|vanity/ },
  { item: 'flooring', re: /floors?|flooring|carpet|lvp|hardwood|tile/ },
  { item: 'paint', re: /paint(?:ed|ing)?/ },
]

const YEAR_RE = /(?:in\s+)?(19|20)(\d{2})\b/

/**
 * Extract year-anchored replacement/repair claims from free text — the
 * "roof replaced in 2019" reads a human underwriter pulls from remarks.
 * Splits on sentence boundaries, keeps fragments that name a system.
 */
export function extractDescriptionClaims(text: string | null | undefined): DescriptionClaim[] {
  if (!text) return []
  const claims: DescriptionClaim[] = []
  const fragments = text.split(/[.\n;]+/)
  for (const fragRaw of fragments) {
    const frag = fragRaw.trim()
    if (!frag || frag.length < 8) continue
    const lower = frag.toLowerCase()
    if (!/(?:new|replaced?|replac|install|updated?|upgrade|repair|recondition|redone|resurfac)/.test(lower)) continue
    for (const { item, re } of CLAIM_ITEMS) {
      if (!re.test(lower)) continue
      const yearMatch = frag.match(YEAR_RE)
      const action: DescriptionClaim['action'] =
        /repair|recondition|service/.test(lower) ? 'repaired'
        : /updated?|upgrade|remodel/.test(lower) ? 'updated'
        : 'replaced'
      claims.push({
        item,
        year: yearMatch ? Number(`${yearMatch[1]}${yearMatch[2]}`) : null,
        action,
        evidence: frag.slice(0, 180),
      })
      break // first matching item wins per fragment
    }
  }
  return claims
}

// ─── Permit ledger ───────────────────────────────────────────────────────────

const PERMIT_ITEM_KEYWORDS: Record<string, RegExp> = {
  roof: /roof/i,
  hvac: /hvac|a\/c|air cond|mechanical|furnace|heat/i,
  water_heater: /water heat|waterheat/i,
  electric_panel: /electr|panel|rewire/i,
  replumb: /plumb|repip|sewer|water line/i,
  rewire: /electr|rewire/i,
  pool_plaster: /pool/i,
  foundation: /foundation|structural/i,
  septic: /septic/i,
}

function latestPermitYear(permits: NormalizedPermit[] | null | undefined, re: RegExp): number | null {
  let best: number | null = null
  for (const p of permits ?? []) {
    const hay = `${p.projectType ?? ''} ${p.description ?? ''} ${p.classificationTypes?.join(' ') ?? ''}`
    if (!re.test(hay)) continue
    const d = p.effectiveDate ?? p.expirationDate ?? p.statusHistory?.[0]?.effectiveDate ?? null
    const y = d ? new Date(d).getFullYear() : null
    if (y != null && !Number.isNaN(y) && (best == null || y > best)) best = y
  }
  return best
}

// ─── Finish parity ───────────────────────────────────────────────────────────

const FINISH_KEYWORDS: Array<{ label: string; re: RegExp }> = [
  { label: 'quartz/granite counters', re: /quartz|granite|stone counters?/i },
  { label: 'LVP/hardwood floors', re: /\blvp\b|luxury vinyl|hardwood|engineered wood/i },
  { label: 'tile showers', re: /tile (?:surround|shower)|frameless glass/i },
  { label: 'shaker/soft-close cabinets', re: /shaker|soft.?close|custom cabinets/i },
  { label: 'stainless appliances', re: /stainless|gas range|farmhouse sink/i },
  { label: 'new roof/systems', re: /new roof|new hvac|new a\/c/i },
]

// ─── Build ───────────────────────────────────────────────────────────────────

/** Design-life benchmarks for the age baseline (appraiser standard per
 *  docs/renovation-crediting-rules.md §2) — items not listed fall back to
 *  the configured age threshold. */
const DESIGN_LIFE: Record<string, number> = {
  roof: 25,
  hvac: 15,
  water_heater: 10,
  electric_panel: 30,
}

/** Systems every house has — only these get the Tier-3 age baseline.
 *  Conditional systems (pool, septic, foundation) stay advisory without
 *  evidence: an unverified pool is not a chargeable pool. */
const UNIVERSAL_SYSTEMS = new Set([
  'roof', 'hvac', 'water_heater', 'electric_panel', 'replumb', 'rewire',
])

export function buildRenovationEvidence(input: {
  renovation: RenovationAssessment | null | undefined
  subjectDescription?: string | null
  subjectFeatures?: string[] | null
  /** Subject year built — drives the Tier-3 age baseline. */
  yearBuilt?: number | null
  permits?: NormalizedPermit[] | null
  /** derivedBuybox.majorItems — already permit-assessed + override-priced */
  majorItems: Array<MajorItem & { reason?: string }>
  /** Per-user major_item_setting overrides (enabled/cost/ageThreshold) */
  majorItemConfig?: Record<string, { enabled?: boolean; cost?: number; ageThreshold?: number | null }> | null
  rehabAdditions: RehabAddition[]
  rehabAdvisories: RehabAdvisory[]
  /** ARV-evidence comp listing descriptions for finish parity */
  arvCompDescriptions: Array<{ compId: string; description: string | null }>
  /** Verified flip pairs: {compId, purchasePrice, resalePrice, sqft} */
  flipPairs: Array<{ compId: string; buy: number; resale: number; sqft: number }>
}): RenovationEvidence {
  const r = input.renovation

  // ── Zone grades + path gate ──────────────────────────────────────────────
  const zoneGrades = r
    ? {
        kitchen: r.kitchenCondition,
        bathrooms: r.bathroomCondition,
        flooring: r.flooringCondition,
        wallsCeilings: r.wallCeilingCondition,
        exterior: r.exteriorCondition,
        systemConcerns: r.visibleMajorSystemConcerns,
        structuralConcerns: r.structuralConcerns,
        observations: r.majorObservations,
        limitations: r.limitations,
      }
    : null
  const readableZones = zoneGrades
    ? [zoneGrades.kitchen, zoneGrades.bathrooms, zoneGrades.flooring, zoneGrades.wallsCeilings, zoneGrades.exterior]
        .filter((z) => z && z !== 'not_visible' && z !== 'NA').length
    : 0
  const photoConfidence = r?.confidence ?? null
  const recommendedPath: 'A' | 'B' =
    photoConfidence != null && photoConfidence >= 70 && readableZones >= 4 ? 'A' : 'B'

  // ── Description claims (subject listing text + features) ─────────────────
  const subjectText = [input.subjectDescription ?? '', ...(input.subjectFeatures ?? [])].join('. ')
  const descriptionClaims = extractDescriptionClaims(subjectText)

  // ── Permit ledger — 4-tier evidence hierarchy ────────────────────────────
  const defaultsById = new Map(MAJOR_ITEMS.map((m) => [m.id, m]))
  const itemsById = new Map(input.majorItems.map((m) => [m.id, m]))
  const now = new Date().getFullYear()
  const homeAge = input.yearBuilt != null ? now - input.yearBuilt : null
  const datedClaims = new Map(
    descriptionClaims.filter((c) => c.year != null).map((c) => [c.item, c.year!] as const),
  )
  const permitLedger: PermitLedgerEntry[] = []
  for (const [item, re] of Object.entries(PERMIT_ITEM_KEYWORDS)) {
    const cfg = input.majorItemConfig?.[item]
    if (cfg?.enabled === false) continue // user disabled
    const threshold = cfg?.ageThreshold ?? defaultsById.get(item as MajorItem['id'])?.ageThreshold ?? null
    const designLife = DESIGN_LIFE[item] ?? threshold
    const year = latestPermitYear(input.permits, re)
    const claimedYear = datedClaims.get(item) ?? null
    const cost = itemsById.get(item as MajorItem['id'])?.cost ?? cfg?.cost ?? defaultsById.get(item as MajorItem['id'])?.defaultCost ?? 0
    const status: LedgerStatus =
      // Tier 1 — verified permit inside the service window
      year != null && threshold != null && now - year <= threshold
        ? 'credited'
        // permit on record but older than the window → replace
        : year != null && threshold != null
          ? 'past_threshold'
          // Tier 2 — dated text claim → soft-repair tier
          : claimedYear != null
            ? 'claimed_dated'
            // Tier 3 — universal system, no verification, home older than
            // its design life → age baseline charges full replacement
            : UNIVERSAL_SYSTEMS.has(item) && homeAge != null && designLife != null && homeAge > designLife
              ? 'assumed_past'
              : 'unknown'
    permitLedger.push({
      item,
      designLife,
      latestPermitYear: year,
      claimedYear,
      status,
      cost,
      softRepairCost: Math.round(cost * 0.08),
    })
  }

  // ── Finish parity — ARV comps vs subject ──────────────────────────────────
  const arvText = input.arvCompDescriptions.map((c) => c.description ?? '').join(' ')
  const arvStandard = FINISH_KEYWORDS.filter((k) => k.re.test(arvText)).map((k) => k.label)
  const subjectHas = FINISH_KEYWORDS.filter((k) => k.re.test(subjectText)).map((k) => k.label)
  const missingOnSubject = arvStandard.filter((k) => !subjectHas.includes(k))

  // ── Flip-delta rate — local rehab $/sf from verified flips ────────────────
  const pairs = input.flipPairs
    .filter((p) => p.buy > 0 && p.resale > p.buy && p.sqft > 0)
    .map((p) => ({
      ...p,
      // (resale − purchase − 15% profit/soft costs) / GLA = rehab $/sf
      rate: Math.round((p.resale - p.buy - p.resale * 0.15) / p.sqft),
    }))
    .filter((p) => p.rate > 0 && p.rate < 200)
  const medianRate =
    pairs.length > 0
      ? pairs.map((p) => p.rate).sort((a, b) => a - b)[Math.floor(pairs.length / 2)]
      : null

  // ── Cost schedule — effective per-item cost (user override applied) ───────
  const costSchedule: Record<string, number> = {}
  for (const m of input.majorItems) costSchedule[m.id] = m.cost

  return {
    zoneGrades,
    pathGate: { photoConfidence, readableZones, recommendedPath },
    descriptionClaims,
    permitLedger,
    sellerNoteClaims: { additions: input.rehabAdditions, advisories: input.rehabAdvisories },
    finishParity: { arvStandard, subjectHas, missingOnSubject },
    flipDelta: { pairs, medianRate },
    costSchedule,
    pathBRates: {
      flipDeltaPerSqft: medianRate,
      defaultPerSqft: { cosmetic_light: 25, cosmetic_moderate: 35, heavy: 45, gut: 60 },
    },
  }
}

// ─── Deterministic pricing of the agent's posted scope ───────────────────────

/**
 * Price a posted renovation scope against the evidence's cost schedule and
 * the 4-tier crediting rules (docs/renovation-crediting-rules.md §4).
 * Fail-open — flag, never fabricate:
 *  - Tier 1 (credited): posted cost >10% of schedule → flag t1_overcharge
 *  - Tier 2 (claimed_dated): full schedule → t2_overbudget; $0 →
 *    t2_underbudget; >20% → t2_partial_outside; ≤20% passes
 *  - Tier 3 (assumed_past) / past_threshold / Tier 4: posted < schedule →
 *    flag + resolve to schedule; omitted → auto-append at schedule
 *  - Schedule clamp 0.4×–2.5× for everything else (typo guard)
 *  - total = Σ resolved costs × (1 + contingency)
 */
export function priceAgentRenovation(
  posted: AgentRenovation,
  evidence: RenovationEvidence,
): PricedRenovation {
  const audit: string[] = []
  const flags: string[] = []
  const items: PricedRenovation['items'] = []

  const scheduleCost = (itemId: string): number | null =>
    evidence.costSchedule[itemId] ?? evidence.permitLedger.find((p) => p.item === itemId)?.cost ?? null
  const ledgerById = new Map(evidence.permitLedger.map((p) => [p.item, p]))

  for (const li of posted.lineItems) {
    const sched = scheduleCost(li.item)
    const ledger = ledgerById.get(li.item)
    let resolved = li.cost
    let resolution = 'posted'
    if (ledger?.status === 'credited' && sched != null && sched > 0 && li.cost > sched * 0.10) {
      flags.push(`t1_overcharge:${li.item}`)
      resolved = Math.round(sched * 0.10)
      resolution = 'clamped to Tier-1 inspection allowance'
    } else if (ledger?.status === 'claimed_dated' && sched != null && sched > 0) {
      if (li.cost === 0) {
        flags.push(`t2_underbudget:${li.item}`)
        resolved = ledger.softRepairCost
        resolution = 'raised to Tier-2 soft-repair allowance'
      } else if (li.cost >= sched) {
        flags.push(`t2_overbudget:${li.item}`)
        resolved = ledger.softRepairCost
        resolution = 'reduced to Tier-2 soft-repair allowance'
      } else if (li.cost > sched * 0.20) {
        flags.push(`t2_partial_outside:${li.item}`)
      }
    } else if (
      (ledger?.status === 'assumed_past' || ledger?.status === 'past_threshold') &&
      sched != null && sched > 0 && li.cost < sched
    ) {
      flags.push(`t3_underbudget:${li.item}`)
      resolved = sched
      resolution = 'raised to schedule — unverified past design life'
    } else if (sched != null && sched > 0) {
      const lo = sched * 0.4
      const hi = sched * 2.5
      if (li.cost < lo || li.cost > hi) {
        resolved = Math.round(sched)
        resolution = `clamped to schedule $${sched}`
        flags.push(`cost_clamped:${li.item}`)
      }
    }
    items.push({ ...li, resolvedCost: Math.round(resolved), resolution })
  }

  // Mandatory items the agent omitted — Tier 3/4 charges append at schedule;
  // Tier 2 dated claims append at the soft-repair allowance.
  const postedItems = new Set(posted.lineItems.map((l) => l.item))
  for (const entry of evidence.permitLedger) {
    if (postedItems.has(entry.item)) continue
    if (entry.status === 'past_threshold' || entry.status === 'assumed_past') {
      if (entry.cost <= 0) continue
      items.push({
        item: entry.item, action: 'replace', category: 'capex', cost: entry.cost,
        resolvedCost: entry.cost,
        resolution: entry.status === 'past_threshold'
          ? 'appended — permit past threshold'
          : 'appended — unverified, past design life (age baseline)',
        source: 'permit',
      })
      flags.push(`mandatory_item_auto_added:${entry.item}:${entry.status}`)
    } else if (entry.status === 'claimed_dated') {
      items.push({
        item: entry.item, action: 'repair', category: 'capex', cost: entry.softRepairCost,
        resolvedCost: entry.softRepairCost,
        resolution: `appended — Tier-2 soft repair (claimed ${entry.claimedYear})`,
        source: 'description',
      })
      flags.push(`dated_claim_auto_added:${entry.item}:${entry.claimedYear}`)
    }
  }
  for (const claim of evidence.descriptionClaims) {
    if (postedItems.has(claim.item) || claim.year != null) continue
    // Undated claims are advisory only — surfaced so a human sees the agent
    // left a stated-but-unverified system at age baseline.
    flags.push(`undated_claim_advisory:${claim.item}`)
  }

  const contingencyPct = posted.contingencyPct ?? 15
  const subtotal = items.reduce((s, i) => s + i.resolvedCost, 0)
  const total = Math.round(subtotal * (1 + contingencyPct / 100))
  audit.push(`${items.length} line items, subtotal $${subtotal.toLocaleString()}, +${contingencyPct}% contingency → $${total.toLocaleString()}`)
  if (posted.totalEstimate != null && Math.abs(posted.totalEstimate - total) > total * 0.15) {
    flags.push(`total_divergence:${Math.round(((posted.totalEstimate - total) / total) * 100)}%`)
    audit.push(`agent total $${posted.totalEstimate.toLocaleString()} diverged >15% from priced $${total.toLocaleString()} — priced wins`)
  }

  return {
    pathUsed: posted.pathUsed,
    items,
    contingencyPct,
    total,
    audit,
    flags,
  }
}
