/**
 * Buybox Auto-Derivation
 *
 * Derives rehab level, major items, and deduction parameters from property
 * data and classification signals so callers never have to select them.
 *
 * Every derived value carries a human-readable reason — these feed the
 * justified evaluation report.
 */

import type { NormalizedProperty, NormalizedPermit } from '../property-api/types'
import type { ClassificationResult } from '../vision/types'
import { REHAB_LEVELS, type MajorItem } from '../valuation/types'
import type { DerivedBuybox, DerivedMajorItem } from './types'
import {
  assessMajorItems,
  toValuationMajorItems,
  type MajorItemConfigOverride,
} from './major-items'

// ─── Rehab Level Derivation ───────────────────────────────────────────────────

/**
 * Base rehab level implied by the subject's classification.
 * REHAB_LEVELS indexes 0-4 form the severity progression:
 *   0 Lipstick, 1 Light Cosmetic, 2 Full Cosmetic, 3 Heavy Rehab, 4 Down to Stud
 * (Indexes 5-6 are market-cost variants and are never auto-selected.)
 */
const CLASSIFICATION_BASE_LEVEL: Record<string, number> = {
  after_renovation: 1, // already renovated — light touch-up to resell
  transitional: 2, // partial updates — full cosmetic pass
  as_is: 3, // distressed — heavy rehab
}

/**
 * Rehab level implied by a vision condition score (0-100, higher = better).
 * Conservative: a bad score can only push the level heavier, never lighter
 * (except for a confirmed renovated property in excellent condition).
 */
function levelImpliedByConditionScore(score: number): number {
  if (score <= 25) return 4
  if (score <= 45) return 3
  if (score <= 65) return 2
  return 1
}

function deriveRehabLevel(
  property: NormalizedProperty,
  classification: ClassificationResult | undefined,
  notes: string[]
): { index: number; reason: string } {
  const reasons: string[] = []

  // Base level from classification
  let index: number
  if (classification) {
    index = CLASSIFICATION_BASE_LEVEL[classification.classification] ?? 2
    reasons.push(
      `Subject classified as ${classification.classification} (${classification.confidence}% confidence, ${classification.method})`
    )
    if (classification.confidence < 50) {
      notes.push('Low classification confidence — rehab level is conservative')
    }
  } else {
    index = 2
    reasons.push('No classification available — defaulted to Full Cosmetic')
  }

  // Vision condition score can push heavier
  const conditionScore = classification?.photoAnalysis?.conditionScore
  if (conditionScore != null) {
    const implied = levelImpliedByConditionScore(conditionScore)
    if (implied > index) {
      index = implied
      reasons.push(`Vision condition score ${conditionScore}/100 indicates heavier scope`)
    }
    // Confirmed renovated + excellent condition → lightest touch
    if (classification?.classification === 'after_renovation' && conditionScore >= 85) {
      index = 0
      reasons.push(`Condition score ${conditionScore}/100 confirms near-turnkey condition`)
    }
  }

  // Pre-1960 distressed properties almost always need gut work
  const yearBuilt = property.effectiveYearBuilt ?? property.yearBuilt
  if (yearBuilt && yearBuilt < 1960 && index >= 3 && index < 4) {
    index = 4
    reasons.push(`Built ${yearBuilt} — pre-1960 distressed stock typically requires down-to-stud renovation`)
  }

  return { index, reason: reasons.join('. ') + '.' }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Derive the complete buybox for a hands-off evaluation.
 *
 * Caller-supplied buybox fields still win — this only fills in what was
 * not specified, and records why each derived value was chosen.
 */
export function deriveBuybox(
  property: NormalizedProperty,
  classification: ClassificationResult | undefined,
  callerBuybox?: {
    rehabLevelIndex?: number
    majorItems?: MajorItem[]
    additionPlay?: number
    closingCostsPercent?: number
    carryingCostsPercent?: number
    wholesaleFee?: number
    desiredProfit?: number
  },
  opts?: {
    /** Subject-property permits for the permit-age engine (never comp permits) */
    permits?: NormalizedPermit[] | null
    /** Per-user Evaluation Settings → Major Items overrides (threshold/cost) */
    majorItemConfig?: Record<string, MajorItemConfigOverride> | null
    /** Renovation level index (0-4) from the computer-vision assessment */
    visionLevelIndex?: number | null
    /** Confidence of the vision assessment (0-100) */
    visionConfidence?: number | null
  }
): DerivedBuybox {
  const notes: string[] = []
  const caller = callerBuybox ?? {}

  // Rehab level — precedence: caller override → computer vision →
  // classification-derived → default. Source is always recorded.
  let rehabLevelIndex: number
  let rehabReason: string
  let rehabDerived = false
  let rehabLevelSource: DerivedBuybox['rehabLevelSource']
  if (caller.rehabLevelIndex !== undefined) {
    rehabLevelIndex = caller.rehabLevelIndex
    rehabReason = `Caller-specified rehab level: ${REHAB_LEVELS[caller.rehabLevelIndex] ?? caller.rehabLevelIndex}`
    rehabLevelSource = 'manual_override'
  } else if (opts?.visionLevelIndex != null) {
    rehabLevelIndex = opts.visionLevelIndex
    rehabReason = `Computer-vision renovation assessment: ${REHAB_LEVELS[rehabLevelIndex]} (${opts.visionConfidence ?? '?'}% confidence)`
    rehabLevelSource = 'vision'
    rehabDerived = true
  } else {
    const derived = deriveRehabLevel(property, classification, notes)
    rehabLevelIndex = derived.index
    rehabReason = derived.reason
    rehabDerived = true
    rehabLevelSource = classification ? 'classification' : 'default'
  }

  // Major items — permit-age engine is authoritative. Caller items are
  // manual evidence and deduplicate the permit rule for the same item.
  const assessments = assessMajorItems(
    opts?.permits,
    opts?.majorItemConfig,
    caller.majorItems
  )
  const valuationItems = toValuationMajorItems(assessments, caller.majorItems)
  const assessmentById = new Map(assessments.map((a) => [a.id, a]))

  const majorItems: DerivedMajorItem[] = valuationItems.map((m) => {
    const manual = caller.majorItems?.find((c) => c.id === m.id && c.enabled)
    const assessment = assessmentById.get(m.id)
    return {
      ...m,
      reason: manual
        ? `Caller-specified item${assessment?.deduplicated ? ' (permit rule deduplicated)' : ''}`
        : (assessment?.reason ?? 'Enabled'),
    }
  })

  const unknownCount = assessments.filter(
    (a) => a.evidenceStatus === 'unknown' && !a.deduplicated
  ).length
  if (unknownCount > 0) {
    notes.push(
      `${unknownCount} major item(s) have no permit evidence — UNKNOWN (not charged, flagged for review)`
    )
  }

  return {
    rehabLevelIndex,
    rehabLevelName: REHAB_LEVELS[rehabLevelIndex] ?? 'Full Cosmetic',
    rehabReason,
    rehabLevelSource,
    majorItems,
    majorItemAssessments: assessments,
    additionPlay: caller.additionPlay ?? 0,
    closingCostsPercent: caller.closingCostsPercent ?? 10,
    carryingCostsPercent: caller.carryingCostsPercent ?? 5,
    wholesaleFee: caller.wholesaleFee ?? 10000,
    derived: rehabDerived || caller.majorItems === undefined,
    notes,
  }
}
