/**
 * Filter ladder — the one way the server loosens comp rules.
 *
 * Product rule (docs/FILTER-LADDER.md): the user's evaluation settings are
 * the ideal. When no comp with ARV evidence passes them, the server widens
 * exactly three rules — square feet, year built, sale age — one small step
 * at a time, and stops at the first step that admits an ARV comp. Geography
 * loosens last and is handled by the caller (tract → block group →
 * neighborhood). Nothing else ever loosens here.
 *
 * Each step widens one rule by its own fixed amount, so the first comp
 * admitted is the one closest to the strict settings:
 *   square feet  +25% of the SUBJECT's square feet
 *   year built   +3 years
 *   sale age     +30 days
 */
import type { AppraisalFilter } from './types'

/** Square feet widens by this share of the subject's own size per step. */
export const LADDER_SQFT_STEP_PCT = 0.25
/** Year built widens by this many years per step. */
export const LADDER_YEAR_STEP = 3
/** Sale age widens by this many days per step. */
export const LADDER_SALE_AGE_STEP_DAYS = 30

/** Per-step amounts for one subject. With no subject size on file, square
 *  feet steps by the configured tolerance itself. */
export function ladderStepSizes(filters: AppraisalFilter[], subjectSqft: number | null | undefined) {
  const baseSqft = enabledValue(filters, 'sqft_diff')
  return {
    sqft: subjectSqft != null && subjectSqft > 0 ? subjectSqft * LADDER_SQFT_STEP_PCT : baseSqft ?? 0,
    year: LADDER_YEAR_STEP,
    saleAge: LADDER_SALE_AGE_STEP_DAYS,
  }
}

export interface LadderTiers {
  /** Steps taken on square feet */
  sqft: number
  /** Steps taken on year built */
  year: number
  /** Steps taken on sale age */
  saleAge: number
}

export interface LadderLimits {
  sqft: number | null
  year: number | null
  saleAge: number | null
}

/**
 * Which rules have given, and how many times, at ladder step `n`.
 *   0 strict · 1 sale age alone · then square feet, year, sale age in turn.
 * Sale age leads by one because going back in time is cheaper than giving
 * up size or year. Every step is a superset of the one before.
 */
export function ladderTiersAt(step: number): LadderTiers {
  const n = Math.max(0, Math.floor(step))
  if (n === 0) return { sqft: 0, year: 0, saleAge: 0 }
  const m = n - 1
  return {
    sqft: Math.floor((m + 2) / 3),
    year: Math.floor((m + 1) / 3),
    saleAge: Math.floor(m / 3) + 1,
  }
}

const widen = (base: number, tiers: number, stepSize: number) =>
  Math.round((base + stepSize * tiers) * 100) / 100

function enabledValue(filters: AppraisalFilter[], type: AppraisalFilter['type']): number | null {
  const f = filters.find((x) => x.type === type)
  return f && f.enabled && typeof f.value === 'number' && f.value > 0 ? f.value : null
}

/** The square-feet, year and sale-age limits in force at ladder step `n`. */
export function ladderLimitsAt(
  filters: AppraisalFilter[],
  step: number,
  subjectSqft?: number | null,
): LadderLimits {
  const tiers = ladderTiersAt(step)
  const size = ladderStepSizes(filters, subjectSqft)
  const sqft = enabledValue(filters, 'sqft_diff')
  const year = enabledValue(filters, 'year_built_diff')
  const saleAge = enabledValue(filters, 'sale_age')
  return {
    sqft: sqft == null ? null : widen(sqft, tiers.sqft, size.sqft),
    year: year == null ? null : widen(year, tiers.year, size.year),
    saleAge: saleAge == null ? null : widen(saleAge, tiers.saleAge, size.saleAge),
  }
}

/** The user's filters with only the three ladder rules widened to step `n`. */
export function filtersAtLadderStep(
  filters: AppraisalFilter[],
  step: number,
  subjectSqft?: number | null,
): AppraisalFilter[] {
  if (step <= 0) return filters
  const limits = ladderLimitsAt(filters, step, subjectSqft)
  return filters.map((f) => {
    if (!f.enabled) return f
    if (f.type === 'sqft_diff' && limits.sqft != null) return { ...f, value: limits.sqft }
    if (f.type === 'year_built_diff' && limits.year != null) return { ...f, value: limits.year }
    if (f.type === 'sale_age' && limits.saleAge != null) return { ...f, value: limits.saleAge }
    return f
  })
}

export interface LadderCandidate {
  squareFeet?: number | null
  yearBuilt?: number | null
  saleDate?: string | null
}

/**
 * The last step worth trying for a candidate set: the first step whose
 * limits cover every candidate's size gap, year gap and sale age. Past it
 * nothing more can be admitted, so the data — not a fixed cap — ends the
 * ladder. Bounded so bad data can never spin it.
 */
export function lastUsefulLadderStep(
  filters: AppraisalFilter[],
  subject: { squareFeet?: number | null; yearBuilt?: number | null },
  candidates: LadderCandidate[],
  nowMs = Date.now(),
): number {
  const MAX_STEP = 600
  const base = ladderLimitsAt(filters, 0)
  const size = ladderStepSizes(filters, subject.squareFeet)
  const tiersNeeded = (worst: number, start: number | null, stepSize: number) =>
    start == null || worst <= start || stepSize <= 0 ? 0 : Math.ceil((worst - start) / stepSize)
  let sqft = 0, year = 0, age = 0
  for (const c of candidates) {
    if (c.squareFeet != null && subject.squareFeet != null) sqft = Math.max(sqft, Math.abs(c.squareFeet - subject.squareFeet))
    if (c.yearBuilt != null && subject.yearBuilt != null) year = Math.max(year, Math.abs(c.yearBuilt - subject.yearBuilt))
    if (c.saleDate) {
      const t = new Date(c.saleDate).getTime()
      if (Number.isFinite(t)) age = Math.max(age, (nowMs - t) / 86_400_000)
    }
  }
  const need: LadderTiers = {
    sqft: tiersNeeded(sqft, base.sqft, size.sqft),
    year: tiersNeeded(year, base.year, size.year),
    saleAge: tiersNeeded(age, base.saleAge, size.saleAge),
  }
  for (let n = 0; n <= MAX_STEP; n++) {
    const t = ladderTiersAt(n)
    if (t.sqft >= need.sqft && t.year >= need.year && t.saleAge >= need.saleAge) return n
  }
  return MAX_STEP
}

/** Plain-words list of what the winning step moved — only rules that gave. */
export function describeLadderConcessions(
  filters: AppraisalFilter[],
  step: number,
  subjectSqft?: number | null,
): string[] {
  if (step <= 0) return []
  const base = ladderLimitsAt(filters, 0)
  const at = ladderLimitsAt(filters, step, subjectSqft)
  const out: string[] = []
  if (base.saleAge != null && at.saleAge != null && at.saleAge > base.saleAge)
    out.push(`sale age to ${Math.round(at.saleAge)} days (was sale age to ${Math.round(base.saleAge)} days)`)
  if (base.sqft != null && at.sqft != null && at.sqft > base.sqft)
    out.push(`sqft tolerance to ±${Math.round(at.sqft)} (was sqft tolerance to ±${Math.round(base.sqft)})`)
  if (base.year != null && at.year != null && at.year > base.year)
    out.push(`year built to ±${Math.round(at.year)} yrs (was year built to ±${Math.round(base.year)} yrs)`)
  return out
}

/** Largest single-rule widening ratio at step `n` (1 = strict). */
export function ladderFactorAt(filters: AppraisalFilter[], step: number, subjectSqft?: number | null): number {
  const base = ladderLimitsAt(filters, 0)
  const at = ladderLimitsAt(filters, step, subjectSqft)
  const ratio = (a: number | null, b: number | null) => (a != null && b != null && b > 0 ? a / b : 1)
  return Math.round(Math.max(1, ratio(at.sqft, base.sqft), ratio(at.year, base.year), ratio(at.saleAge, base.saleAge)) * 100) / 100
}

export type LadderScope = 'tract' | 'block_group' | 'neighborhood' | 'value_equivalent'

/** The same-area rule's level for each area the ladder can widen to. */
export function geoLevelForScope(scope: LadderScope | null | undefined): number {
  return scope === 'neighborhood' ? 2 : scope === 'value_equivalent' ? 3 : 1
}

/** The user's filters at one ladder step AND one area — the only two ways
 *  the server ever loosens them. */
export function filtersForLadder(
  filters: AppraisalFilter[],
  step: number,
  scope: LadderScope | null | undefined,
  subjectSqft?: number | null,
): AppraisalFilter[] {
  const level = geoLevelForScope(scope)
  return filtersAtLadderStep(filters, step, subjectSqft).map((f) =>
    f.type === 'geo_scope_match' && f.enabled ? { ...f, value: level } : f)
}
