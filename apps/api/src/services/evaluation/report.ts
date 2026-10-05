/**
 * Evaluation Report Builder
 *
 * Assembles the justified end-to-end evaluation report attached to every
 * completed analysis. Every number in the report carries the reason it
 * exists: which comps drove the ARV, why the rehab level was chosen, and
 * what each deduction is for.
 */

import type { PropertyBundle } from '../property-api'
import type { AppraisalResultWithFallback, WeightedARVResult } from '../appraisal'
import type { ClassificationResult } from '../vision/types'
import type { ValuationResult } from '../valuation/types'
import type { DerivedBuybox, EvaluationReport, ReportArvDriver, ReportDeduction, ReportStep } from './types'

export const EVALUATION_PIPELINE_VERSION = '5.0'

export interface BuildReportInput {
  bundle: PropertyBundle
  appraisalResult: AppraisalResultWithFallback
  subjectClassification: ClassificationResult | undefined
  weightedARVResult: WeightedARVResult | undefined
  derivedBuybox: DerivedBuybox
  /** Null on insufficient-comps runs — the report then carries null money fields */
  valuation: ValuationResult | null
  /** Ordered step log collected during workflow execution */
  steps: ReportStep[]
  /** Fallbacks that fired during this run */
  fallbacksUsed: string[]
  /** Computer-vision renovation assessment (subject photos) */
  renovationAssessment?: import('../vision/renovation').RenovationAssessment | null
}

/**
 * Confidence gate on the comps that actually drive the ARV.
 *
 * HIGH — 3+ selected comps, every one verified on the hard rules plus
 *        style/condition, no expansion fallback, subject condition
 *        verified. Use the ARV normally.
 * MEDIUM — 3 selected comps but weaker dimensions (unverified data,
 *        soft mismatches, expansion tiers used, aging sales).
 * LOW — fewer than 3 selected comps, any selected comp carrying a hard
 *        failure (rescued by a fallback tier), nearest-comps/insufficient
 *        fallback, or stale sales.
 *
 * There is no human reviewer — the formula recommendation always stands;
 * confidence is an advisory signal carried on the report.
 */
function assessConfidence(input: BuildReportInput): {
  level: 'high' | 'medium' | 'low'
  reasons: string[]
  requiresHumanReview: boolean
} {
  const reasons: string[] = []
  const appraisal = input.appraisalResult
  // Evidence grading — the ARV set is verified flip resales.
  //   HIGH   — 3+ flip comps, subject condition verified
  //   MEDIUM — 1-2 flip comps, or stale evidence, or unverified subject
  //   LOW    — zero flip comps (no ARV evidence) or sales older than a year
  {
    const now = Date.now()
    const selectedIds = new Set(appraisal.selectedCompIds ?? [])
    const selectedComps = appraisal.comparables.filter((c) => selectedIds.has(c.id))
    const selectedAgesDays = selectedComps
      .map((c) => (c.saleDate ? (now - new Date(c.saleDate).getTime()) / 86_400_000 : null))
      .filter((d): d is number => d != null && Number.isFinite(d))
    const oldestSaleDays = selectedAgesDays.length ? Math.max(...selectedAgesDays) : null
    const visionVerified =
      input.renovationAssessment?.status === 'ok' ||
      (input.renovationAssessment?.curbAppeal?.source === 'vision' &&
        input.renovationAssessment?.curbAppeal?.condition !== 'unknown')
    const subjectConditionVerified =
      input.subjectClassification != null ||
      input.bundle.property.buildingCondition != null ||
      visionVerified === true

    const flipCount = selectedComps.length
    reasons.unshift(`${flipCount} verified flip resale(s) drive the ARV — transaction evidence`)
    if (flipCount === 0) {
      reasons.push(
        input.valuation?.arv != null
          ? 'No verified flip resales — valuation anchored on modeled value (AVM/assessment), not comp evidence'
          : 'No verified flip resales — ARV is withheld, report is reference-only',
      )
      return { level: 'low', reasons, requiresHumanReview: true }
    }
    if (flipCount < 3) {
      reasons.push(`Only ${flipCount} comp(s) drive the ARV — fewer than 3`)
    }
    if (oldestSaleDays != null && oldestSaleDays > 365) {
      reasons.push(`Stale sale: oldest selected comp sold ${Math.round(oldestSaleDays / 30)} months ago`)
    } else if (oldestSaleDays != null && oldestSaleDays > 180) {
      reasons.push(`Oldest selected comp sold ${Math.round(oldestSaleDays)} days ago (beyond 180-day window)`)
    }
    if (!subjectConditionVerified) {
      reasons.push('Subject condition could not be verified')
    }

    const level =
      (oldestSaleDays != null && oldestSaleDays > 365)
        ? 'low'
        : flipCount >= 3 && subjectConditionVerified
          ? 'high'
          : 'medium'

    if (level === 'medium') {
      reasons.unshift(`${flipCount} ARV comps — thin or partially unverified evidence; reduced confidence`)
    }
    return { level, reasons, requiresHumanReview: level !== 'high' }
  }

}

/**
 * Build the justified evaluation report.
 */
export function buildEvaluationReport(input: BuildReportInput): EvaluationReport {
  const { appraisalResult, weightedARVResult, derivedBuybox, valuation } = input

  // Top ARV drivers by normalized weight
  const compById = new Map(appraisalResult.comparables.map((c) => [c.id, c]))
  const drivers: ReportArvDriver[] = (weightedARVResult?.weightBreakdown ?? [])
    .slice()
    .sort((a, b) => b.normalizedWeight - a.normalizedWeight)
    .slice(0, 5)
    .map((w) => {
      const comp = compById.get(w.compId)
      return {
        compId: w.compId,
        address: comp ? `${comp.address}, ${comp.city}, ${comp.state}` : w.compId,
        price: w.price,
        weight: Math.round(w.normalizedWeight * 1000) / 1000,
        classification: w.classification ?? null,
        tier: w.tier,
      }
    })

  // Itemized deductions between ARV and max buy price — the ARV-derived
  // lines only exist when a valuation was produced.
  const deductions: ReportDeduction[] = []
  if (valuation) {
    deductions.push({
      label: 'Base Rehab',
      amount: -valuation.baseRehabCost,
      reason: `${valuation.rehabLevel} at $${valuation.rehabPerSqft}/sqft — ${derivedBuybox.rehabReason}`,
    })
  }
  for (const item of derivedBuybox.majorItems.filter((m) => m.enabled)) {
    deductions.push({ label: item.id, amount: -item.cost, reason: item.reason })
  }
  if (derivedBuybox.additionPlay > 0) {
    deductions.push({
      label: 'Addition Play',
      amount: -derivedBuybox.additionPlay,
      reason: 'Additional improvement budget',
    })
  }
  if (valuation) {
    deductions.push(
      {
        label: 'Closing Costs',
        amount: -valuation.closingCosts,
        reason: `${valuation.closingCostsPercent}% of ARV — purchase + resale transaction costs`,
      },
      {
        label: 'Carrying Costs',
        amount: -valuation.carryingCosts,
        reason: `${valuation.carryingCostsPercent}% of ARV — holding costs during rehab`,
      },
      {
        label: 'Minimum Profit',
        amount: -valuation.desiredProfit,
        reason: `Required margin for ${valuation.arvTier} price tier`,
      }
    )
  }

  // Renovation cost ledger — every line explains source + dedup status so
  // the same work is never charged twice.
  const ledger: NonNullable<EvaluationReport['rehab']['ledger']> = []
  if (valuation) {
    ledger.push({
      label: `Base ${valuation.rehabLevel}`,
      amount: valuation.baseRehabCost,
      source: 'rehab_tier',
      reason: `${valuation.rehabLevel} at $${valuation.rehabPerSqft}/sqft — ${derivedBuybox.rehabReason}`,
    })
  }
  const manualIds = new Set(
    derivedBuybox.majorItems.filter((m) => m.reason.startsWith('Caller-specified')).map((m) => m.id)
  )
  const noteIds = new Set(
    derivedBuybox.majorItems.filter((m) => m.reason.startsWith('Realtor note:')).map((m) => m.id)
  )
  for (const item of derivedBuybox.majorItems.filter((m) => m.enabled)) {
    const assessment = derivedBuybox.majorItemAssessments?.find((a) => a.id === item.id)
    ledger.push({
      label: item.id,
      amount: item.cost,
      source: manualIds.has(item.id)
        ? 'major_item_manual'
        : noteIds.has(item.id) ? 'seller_note' : 'major_item_permit',
      reason: item.reason,
      deduplicated: assessment?.deduplicated ?? false,
      evidenceStatus: assessment?.evidenceStatus,
    })
  }
  // Deduped/triggered-but-covered items appear at $0 for the audit trail
  for (const a of derivedBuybox.majorItemAssessments ?? []) {
    if (!a.enabled && a.deduplicated) {
      ledger.push({
        label: a.id,
        amount: 0,
        source: 'major_item_permit',
        reason: a.reason,
        deduplicated: true,
        evidenceStatus: a.evidenceStatus,
      })
    }
  }
  if (derivedBuybox.additionPlay > 0) {
    ledger.push({
      label: 'Addition Play',
      amount: derivedBuybox.additionPlay,
      source: 'addition',
      reason: 'Additional improvement budget',
    })
  }

  const confidence = assessConfidence(input)

  return {
    pipelineVersion: EVALUATION_PIPELINE_VERSION,
    generatedAt: new Date().toISOString(),

    steps: input.steps,
    fallbacksUsed: input.fallbacksUsed,

    subject: {
      classification: input.subjectClassification?.classification ?? null,
      confidence: input.subjectClassification?.confidence ?? null,
      method: input.subjectClassification?.method ?? null,
    },

    visionAssessment: input.renovationAssessment
      ? {
          status:
            input.renovationAssessment.status === 'insufficient_photo_evidence'
              ? 'insufficient_photo_evidence'
              : input.renovationAssessment.status === 'needs_review'
                ? 'needs_review'
                : input.renovationAssessment.status === 'ok'
                  ? 'ok'
                  : 'unavailable',
          renovationLevel: input.renovationAssessment.renovationLevel,
          confidence: input.renovationAssessment.confidence,
          photosExamined: input.renovationAssessment.photosExamined,
          majorObservations: input.renovationAssessment.majorObservations,
          evidenceForClassification: input.renovationAssessment.evidenceForClassification,
          limitations: input.renovationAssessment.limitations,
          provider: input.renovationAssessment.provider,
          model: input.renovationAssessment.model,
        }
      : undefined,
    renovationLevelSource: derivedBuybox.rehabLevelSource,

    arv: {
      value: valuation?.arv ?? null,
      methodology: weightedARVResult?.methodology ?? 'Simple average of enabled comps',
      pricePerSqft: valuation?.pricePerSqft ?? null,
      drivers,
      asIsValue: weightedARVResult?.asIsValue ?? null,
      afterRenovationValue: weightedARVResult?.afterRenovationValue ?? null,
      spread: weightedARVResult?.spread ?? null,
      compPool: {
        total: appraisalResult.comparables.length,
        enabled: appraisalResult.enabledCount,
        selected: appraisalResult.selectedCompIds?.length
          ?? appraisalResult.comparables.filter((c) => c.arvStatus === 'selected').length,
        fallbackUsed: appraisalResult.fallbackUsed,
        fallbackReason: appraisalResult.fallbackReason,
      },
    },

    rehab: {
      level: valuation?.rehabLevel ?? null,
      levelIndex: derivedBuybox.rehabLevelIndex,
      perSqft: valuation?.rehabPerSqft ?? null,
      baseCost: valuation?.baseRehabCost ?? null,
      majorItems: derivedBuybox.majorItems
        .filter((m) => m.enabled)
        .map((m) => ({ name: m.id, cost: m.cost, reason: m.reason })),
      majorItemsCost: valuation?.majorItemsCost ?? null,
      additionPlay: derivedBuybox.additionPlay,
      totalCost: valuation?.totalRehabCost ?? null,
      derived: derivedBuybox.derived,
      reason: derivedBuybox.rehabReason,
      levelSource: derivedBuybox.rehabLevelSource,
      ledger,
    },

    deductions,

    outcome: {
      maxBuyPrice: valuation?.buyPrice ?? null,
      buyPricePercent: valuation?.buyPricePercent ?? null,
      wholesalePrice: valuation?.wholesalePrice ?? null,
      projectedProfit: valuation?.projectedProfit ?? null,
      projectedROI: valuation?.projectedROI ?? null,
      totalInvestment: valuation?.totalInvestment ?? null,
      // The formula call always stands — there is no human reviewer, so
      // confidence is communicated via the confidence field + reasons
      // instead of withholding the recommendation.
      recommendation: valuation?.recommendation ?? null,
      recommendationReason: valuation == null
        ? appraisalResult.fallbackReason ?? 'Insufficient comps — no valuation produced'
        : confidence.level === 'low'
          ? `${valuation.recommendationReason} — LOW confidence: comp evidence is thin or stale`
          : confidence.level === 'medium'
            ? `${valuation.recommendationReason} — medium confidence: some dimensions unverified`
            : valuation.recommendationReason,
    },

    confidence: confidence.level,
    confidenceReasons: [...confidence.reasons, ...derivedBuybox.notes],
    requiresHumanReview: confidence.requiresHumanReview,

  }
}
