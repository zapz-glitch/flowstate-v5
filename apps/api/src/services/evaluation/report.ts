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
  valuation: ValuationResult
  /** Ordered step log collected during workflow execution */
  steps: ReportStep[]
  /** Fallbacks that fired during this run */
  fallbacksUsed: string[]
  /** Computer-vision renovation assessment (subject photos) */
  renovationAssessment?: import('../vision/renovation').RenovationAssessment | null
}

/**
 * Overall confidence in the evaluation, based on data quality signals.
 */
function assessConfidence(input: BuildReportInput): {
  level: 'high' | 'medium' | 'low'
  reasons: string[]
} {
  const reasons: string[] = []
  let score = 0

  const enabled = input.appraisalResult.enabledCount
  if (enabled >= 5) {
    score += 2
    reasons.push(`${enabled} comps passed appraisal rules`)
  } else if (enabled >= 3) {
    score += 1
    reasons.push(`${enabled} comps passed appraisal rules`)
  } else {
    reasons.push(`Only ${enabled} comps usable`)
  }

  if (input.appraisalResult.fallbackUsed === 'none') {
    score += 1
  } else {
    reasons.push(`Comp fallback used: ${input.appraisalResult.fallbackUsed}`)
  }

  const conf = input.subjectClassification?.confidence ?? 0
  if (conf >= 70) {
    score += 1
    reasons.push(`Subject classified with ${conf}% confidence`)
  } else if (!input.subjectClassification) {
    score -= 1
    reasons.push('Subject could not be classified')
  } else {
    reasons.push(`Low classification confidence (${conf}%)`)
  }

  if (input.weightedARVResult) {
    score += 1
    reasons.push('Classification-weighted ARV computed')
  } else {
    score -= 1
    reasons.push('ARV computed without condition weighting')
  }

  if (input.fallbacksUsed.length > 0) score -= 1

  const level = score >= 3 ? 'high' : score >= 1 ? 'medium' : 'low'
  return { level, reasons }
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

  // Itemized deductions between ARV and max buy price
  const deductions: ReportDeduction[] = [
    {
      label: 'Base Rehab',
      amount: -valuation.baseRehabCost,
      reason: `${valuation.rehabLevel} at $${valuation.rehabPerSqft}/sqft — ${derivedBuybox.rehabReason}`,
    },
  ]
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

  // Renovation cost ledger — every line explains source + dedup status so
  // the same work is never charged twice.
  const ledger: NonNullable<EvaluationReport['rehab']['ledger']> = [
    {
      label: `Base ${valuation.rehabLevel}`,
      amount: valuation.baseRehabCost,
      source: 'rehab_tier',
      reason: `${valuation.rehabLevel} at $${valuation.rehabPerSqft}/sqft — ${derivedBuybox.rehabReason}`,
    },
  ]
  const manualIds = new Set(
    derivedBuybox.majorItems.filter((m) => m.reason.startsWith('Caller-specified')).map((m) => m.id)
  )
  for (const item of derivedBuybox.majorItems.filter((m) => m.enabled)) {
    const assessment = derivedBuybox.majorItemAssessments?.find((a) => a.id === item.id)
    ledger.push({
      label: item.id,
      amount: item.cost,
      source: manualIds.has(item.id) ? 'major_item_manual' : 'major_item_permit',
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
      value: valuation.arv,
      methodology: weightedARVResult?.methodology ?? 'Simple average of enabled comps',
      pricePerSqft: valuation.pricePerSqft,
      drivers,
      asIsValue: weightedARVResult?.asIsValue ?? null,
      afterRenovationValue: weightedARVResult?.afterRenovationValue ?? null,
      spread: weightedARVResult?.spread ?? null,
      compPool: {
        total: appraisalResult.comparables.length,
        enabled: appraisalResult.enabledCount,
        fallbackUsed: appraisalResult.fallbackUsed,
        fallbackReason: appraisalResult.fallbackReason,
      },
    },

    rehab: {
      level: valuation.rehabLevel,
      levelIndex: derivedBuybox.rehabLevelIndex,
      perSqft: valuation.rehabPerSqft,
      baseCost: valuation.baseRehabCost,
      majorItems: derivedBuybox.majorItems
        .filter((m) => m.enabled)
        .map((m) => ({ name: m.id, cost: m.cost, reason: m.reason })),
      majorItemsCost: valuation.majorItemsCost,
      additionPlay: derivedBuybox.additionPlay,
      totalCost: valuation.totalRehabCost,
      derived: derivedBuybox.derived,
      reason: derivedBuybox.rehabReason,
      levelSource: derivedBuybox.rehabLevelSource,
      ledger,
    },

    deductions,

    outcome: {
      maxBuyPrice: valuation.buyPrice,
      buyPricePercent: valuation.buyPricePercent,
      wholesalePrice: valuation.wholesalePrice,
      projectedProfit: valuation.projectedProfit,
      projectedROI: valuation.projectedROI,
      totalInvestment: valuation.totalInvestment,
      recommendation: valuation.recommendation,
      recommendationReason: valuation.recommendationReason,
    },

    confidence: confidence.level,
    confidenceReasons: [...confidence.reasons, ...derivedBuybox.notes],
  }
}
