/**
 * Major Item Permit-Age Engine
 *
 * Evaluates each major item (roof, HVAC, water heater, electrical panel,
 * plumbing, rewiring, ...) against SUBJECT-property permit/install
 * evidence. Comparable-property permits are never used for the subject's
 * renovation cost.
 *
 * Evidence semantics:
 * - VERIFIED:    permit record shows completed/finaled work with a usable date
 * - SUPPORTED:   permit record exists with a usable date but completion is
 *                unverified (issued/active/unknown status)
 * - CONFLICTING: records exist but the newest evidence contradicts itself
 *                (e.g. newest permit cancelled/expired while older work stands)
 * - UNKNOWN:     no usable permit/install evidence — an age is never invented
 *
 * Charging rule: only when evidence age is at-or-past the configured age
 * threshold is the configured replacement cost added. UNKNOWN items are
 * never charged automatically — they are flagged for review.
 *
 * EXCEPTION (product spec): the "big four" wear items — roof, HVAC, water
 * heater, electric panel — are assumed to need replacement when there is no
 * permit evidence at all and the house is at-or-past the item's age
 * threshold (no permit pulled = original install = house age). All other
 * items (plumbing, foundation, etc.) stay evidence-gated: no evidence of
 * issues → not factored in.
 */

import type { NormalizedPermit } from '../property-api/types'
import { MAJOR_ITEMS, type MajorItem, type MajorItemId } from '../valuation/types'

// ─── Types ────────────────────────────────────────────────────────────────────

export type EvidenceStatus = 'verified' | 'supported' | 'conflicting' | 'unknown'

export interface MajorItemAssessment {
  id: MajorItemId
  name: string
  /** Evidence classification for the latest usable record */
  evidenceStatus: EvidenceStatus
  /** Where the evidence came from */
  evidenceSource: 'permit' | 'none'
  /** ISO date of the latest supported permit/install evidence */
  evidenceDate: string | null
  /** Permit IDs backing this assessment */
  evidencePermitIds: string[]
  /** Calculated age in years from the latest supported evidence */
  ageYears: number | null
  /** Configured age threshold (null = item has no age rule) */
  thresholdYears: number | null
  /** Configured replacement cost */
  configuredCost: number
  /** Whether the threshold rule added this item's cost */
  enabled: boolean
  /** Cost actually applied to the renovation ledger (0 when deduplicated/not triggered) */
  cost: number
  /** True when a caller/manual item already covers this — charged once only */
  deduplicated: boolean
  /** Human-readable justification for the audit trail */
  reason: string
}

/** Per-user configurable threshold/cost (Evaluation Settings → Major Items) */
export interface MajorItemConfigOverride {
  enabled?: boolean
  cost?: number
  ageThreshold?: number | null
}

// ─── Permit → Item Matching ───────────────────────────────────────────────────

/**
 * Keyword patterns mapping permit projectType/category/description to
 * major items. A single permit may support multiple items (e.g. a generic
 * "electrical" permit supports both panel and rewiring evidence at
 * SUPPORTED strength).
 */
const ITEM_PERMIT_PATTERNS: Record<MajorItemId, RegExp> = {
  roof: /roof|re-?roof/i,
  hvac: /hvac|air.?condition|furnace|\ba\/?c\b|mechanical|mini.?split/i,
  water_heater: /water.?heat|hot.?water|water.?tank/i,
  electric_panel: /electrical|panel|service.?upgrade|meter|sub.?panel/i,
  replumb: /replumb|re-?plumb|repipe|re-?pipe|plumb|sewer|water.?line|gas.?line/i,
  rewire: /rewire|re-?wire|wiring|electrical/i,
  pool_plaster: /pool|plaster/i,
  pool_redone: /pool/i,
  septic: /septic/i,
  new_septic: /septic/i,
  well_pump: /well|pump/i,
  foundation: /foundation|structural|sinkhole/i,
  sinkhole: /sinkhole/i,
  asbestos: /asbestos|abatement|demolition/i,
  vinyl: /vinyl|siding|stucco|exterior.?wall/i,
  termite: /termite|fumigation|pest/i,
  mold: /mold|mould|remediation/i,
}

/**
 * Items assumed to need replacement when no permit was ever pulled and the
 * house is past the age threshold — original install age = house age.
 */
const ASSUME_REPLACE_WHEN_NO_PERMIT: ReadonlySet<MajorItemId> = new Set([
  'roof',
  'hvac',
  'water_heater',
  'electric_panel',
])

/** Permit statuses that do NOT constitute install/replacement evidence */
const INVALID_PERMIT_STATUS = /cancel|expired|withdrawn|denied|void|reject|abandon/i
/** Permit statuses that confirm completed work */
const VERIFIED_PERMIT_STATUS = /complete|final|closed|finaled|certificate|occupanc/i

function permitText(p: NormalizedPermit): string {
  return [
    p.projectType,
    p.projectCategory,
    ...(p.classificationTypes ?? []),
    p.description,
  ]
    .filter(Boolean)
    .join(' ')
}

function permitYear(p: NormalizedPermit): number | null {
  if (!p.effectiveDate) return null
  const d = new Date(p.effectiveDate)
  return isNaN(d.getTime()) ? null : d.getFullYear()
}

// ─── Assessment ───────────────────────────────────────────────────────────────

/**
 * Assess one major item against subject-property permit evidence.
 */
function assessItem(
  itemId: MajorItemId,
  name: string,
  configuredCost: number,
  thresholdYears: number | null,
  permits: NormalizedPermit[],
  manualCovered: boolean,
  currentYear: number,
  subjectYearBuilt?: number | null
): MajorItemAssessment {
  const pattern = ITEM_PERMIT_PATTERNS[itemId]
  const base: Omit<MajorItemAssessment, 'reason'> = {
    id: itemId,
    name,
    evidenceStatus: 'unknown',
    evidenceSource: 'none',
    evidenceDate: null,
    evidencePermitIds: [],
    ageYears: null,
    thresholdYears,
    configuredCost,
    enabled: false,
    cost: 0,
    deduplicated: manualCovered,
  }

  const matching = pattern ? permits.filter((p) => pattern.test(permitText(p))) : []

  if (matching.length === 0) {
    if (manualCovered) {
      return {
        ...base,
        reason: 'Already provided manually — no additional permit-evidence charge',
      }
    }
    // Big-four rule: no permit was ever pulled → original install → the
    // item's age is the house age. Charge when the house is at-or-past the
    // threshold; when the build year is unknown, assume replacement (per
    // product spec — no permits means we ARE replacing the big items).
    if (ASSUME_REPLACE_WHEN_NO_PERMIT.has(itemId)) {
      const houseAge = subjectYearBuilt != null ? currentYear - subjectYearBuilt : null
      const due = houseAge == null || (thresholdYears !== null && houseAge >= thresholdYears)
      return {
        ...base,
        evidenceStatus: 'unknown',
        ageYears: houseAge,
        enabled: due,
        cost: due ? configuredCost : 0,
        reason: due
          ? houseAge == null
            ? 'No permit evidence and build year unknown — assumed due for replacement (no permits pulled)'
            : `No permit evidence — assumed original install (${houseAge}y old ≥ threshold ${thresholdYears}y) — replacement cost added`
          : `No permit evidence — assumed original install (${houseAge}y old < threshold ${thresholdYears}y) — not charged`,
      }
    }
    return {
      ...base,
      reason: 'No permit/install evidence — age UNKNOWN, not charged',
    }
  }

  // Split usable vs non-evidence permits
  const usable = matching.filter((p) => !INVALID_PERMIT_STATUS.test(p.status ?? ''))
  const unusable = matching.filter((p) => INVALID_PERMIT_STATUS.test(p.status ?? ''))

  // Latest usable permit with a parseable date
  const dated = usable
    .map((p) => ({ permit: p, year: permitYear(p) }))
    .filter((x): x is { permit: NormalizedPermit; year: number } => x.year !== null)
    .sort((a, b) => b.year - a.year)

  if (dated.length === 0) {
    return {
      ...base,
      evidenceStatus: 'unknown',
      evidenceSource: 'permit',
      evidencePermitIds: matching.map((p) => p.permitId),
      reason: `${matching.length} related permit(s) found but none carry a usable date — age UNKNOWN`,
    }
  }

  const latest = dated[0]
  const ageYears = currentYear - latest.year

  // Status: verified completion, or conflicting when the newest record is
  // a cancelled/expired permit that post-dates the usable evidence
  let status: EvidenceStatus = VERIFIED_PERMIT_STATUS.test(latest.permit.status ?? '')
    ? 'verified'
    : 'supported'

  const newestUnusable = unusable
    .map((p) => ({ permit: p, year: permitYear(p) }))
    .filter((x): x is { permit: NormalizedPermit; year: number } => x.year !== null)
    .sort((a, b) => b.year - a.year)[0]

  if (newestUnusable && newestUnusable.year > latest.year) {
    status = 'conflicting'
  }

  // Threshold rule: charge when age is at-or-past the configured threshold
  const triggered = thresholdYears !== null && ageYears >= thresholdYears
  const appliedCost = triggered && !manualCovered ? configuredCost : 0

  const evidenceDesc = `${latest.permit.effectiveDate} permit (${latest.permit.status ?? 'status unknown'})`
  let reason: string
  if (manualCovered && triggered) {
    reason = `Latest evidence ${evidenceDesc} → ${ageYears}y ≥ threshold ${thresholdYears}y — already covered by manual item (deduplicated)`
  } else if (manualCovered) {
    reason = 'Already provided manually — permit evidence recorded, not charged again'
  } else if (triggered) {
    reason = `Latest evidence ${evidenceDesc} → ${ageYears}y ≥ threshold ${thresholdYears}y — replacement cost added`
  } else if (thresholdYears === null) {
    reason = `Evidence ${evidenceDesc} → ${ageYears}y — item has no age-threshold rule, not charged`
  } else {
    reason = `Latest evidence ${evidenceDesc} → ${ageYears}y < threshold ${thresholdYears}y — not charged`
  }
  if (status === 'conflicting') {
    reason += ` (CONFLICTING: newer ${newestUnusable.permit.status} permit ${newestUnusable.permit.effectiveDate})`
  }

  return {
    ...base,
    evidenceStatus: status,
    evidenceSource: 'permit',
    evidenceDate: latest.permit.effectiveDate,
    evidencePermitIds: matching.map((p) => p.permitId),
    ageYears,
    enabled: triggered && !manualCovered,
    cost: appliedCost,
    reason,
  }
}

/**
 * Assess all major items against subject permits + optional per-user
 * configuration (Evaluation Settings → Major Items) + manual caller items.
 *
 * @param permits Subject-property permits ONLY — never comp permits.
 * @param config  Per-user threshold/cost overrides keyed by item id.
 * @param manualItems Caller-supplied major items — these win and dedupe.
 * @param subjectYearBuilt Subject build year — lets the big-four no-permit
 *   rule treat the item's age as the house age.
 */
export function assessMajorItems(
  permits: NormalizedPermit[] | null | undefined,
  config?: Record<string, MajorItemConfigOverride> | null,
  manualItems?: MajorItem[] | null,
  currentYear: number = new Date().getFullYear(),
  subjectYearBuilt?: number | null
): MajorItemAssessment[] {
  const permitList = permits ?? []
  const manualById = new Map((manualItems ?? []).filter((m) => m.enabled).map((m) => [m.id, m]))

  return MAJOR_ITEMS.map((item) => {
    const id = item.id as MajorItemId
    const override = config?.[id]

    // Owner-disabled item → never auto-charged
    if (override && override.enabled === false) {
      const manual = manualById.get(id)
      return {
        id,
        name: item.name,
        evidenceStatus: 'unknown' as const,
        evidenceSource: 'none' as const,
        evidenceDate: null,
        evidencePermitIds: [],
        ageYears: null,
        thresholdYears:
          override.ageThreshold === undefined ? item.ageThreshold : override.ageThreshold,
        configuredCost: manual?.cost ?? override.cost ?? item.defaultCost,
        enabled: false,
        cost: 0,
        deduplicated: !!manual,
        reason: manual
          ? 'Rule disabled in Evaluation Settings — manual item retained'
          : 'Item disabled in Evaluation Settings',
      }
    }

    // `undefined` = inherit default; explicit `null` = owner removed the age rule
    const threshold =
      override?.ageThreshold === undefined ? item.ageThreshold : override.ageThreshold
    const cost = override?.cost ?? item.defaultCost

    return assessItem(id, item.name, cost, threshold, permitList, manualById.has(id), currentYear, subjectYearBuilt)
  })
}

/**
 * Merge permit-derived major items with manual caller items into the
 * `MajorItem[]` the valuation service consumes — each item charged once.
 */
export function toValuationMajorItems(
  assessments: MajorItemAssessment[],
  manualItems?: MajorItem[] | null
): MajorItem[] {
  const items: MajorItem[] = []

  // Manual items first (authoritative cost)
  for (const m of manualItems ?? []) {
    if (m.enabled) items.push({ id: m.id, enabled: true, cost: m.cost })
  }

  const manualIds = new Set(items.map((i) => i.id))
  for (const a of assessments) {
    if (a.enabled && a.cost > 0 && !manualIds.has(a.id)) {
      items.push({ id: a.id, enabled: true, cost: a.cost })
    }
  }

  return items
}
