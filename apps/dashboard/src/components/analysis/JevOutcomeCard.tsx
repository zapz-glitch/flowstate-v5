'use client'

import type { JevOutcomeData, JevOutcomeDimension } from './shared-types'

// ─── Jev Outcome Classification ──────────────────────────────────────────────
//
// Read-only label attached after the v5 pipeline finishes. Jev never
// influenced selection, ARV, or the recommendation — this section shows how
// the model classified the completed outcome.

const DIMENSION_LABELS: Record<JevOutcomeDimension, string> = {
  evidence_sufficiency: 'Evidence',
  comp_set_quality: 'Comp set',
  deal_outlook: 'Deal outlook',
  recommendation_agreement: 'Recommendation',
  risk_flags: 'Risk flags',
}

const DIMENSION_ORDER: JevOutcomeDimension[] = [
  'evidence_sufficiency',
  'comp_set_quality',
  'deal_outlook',
  'recommendation_agreement',
  'risk_flags',
]

const TONE: Record<string, 'good' | 'warn' | 'bad'> = {
  sufficient: 'good', limited: 'warn', insufficient: 'bad',
  strong: 'good', adequate: 'warn', weak: 'bad',
  favorable: 'good', marginal: 'warn', unfavorable: 'bad',
  agree: 'good', uncertain: 'warn', disagree: 'bad',
  none: 'good', minor: 'warn', material: 'bad',
}

const TONE_CLASSES = {
  good: 'bg-emerald-500/15 text-emerald-500',
  warn: 'bg-amber-500/15 text-amber-500',
  bad: 'bg-red-500/15 text-red-500',
} as const

export function JevOutcomeCard({ outcome }: { outcome: JevOutcomeData | null | undefined }) {
  if (!outcome) return null

  if (outcome.status !== 'completed' || !outcome.classifications) {
    return (
      <section className="border border-border rounded-sm px-4 py-3 text-foreground">
        <h3 className="text-body-sm font-semibold">Jev assessment</h3>
        <p className="text-[11px] text-foreground-tertiary">
          {outcome.status === 'skipped' ? 'Jev classification not configured' : 'Jev classification unavailable for this run'}
        </p>
      </section>
    )
  }

  return (
    <section className="border border-border rounded-sm px-4 py-3 space-y-2 text-foreground break-words">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-body-sm font-semibold">Jev assessment</h3>
        {outcome.model && (
          <span className="text-[10px] text-foreground-tertiary">{outcome.model}</span>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {DIMENSION_ORDER.map((dimension) => {
          const signal = outcome.classifications?.[dimension]
          if (!signal) return null
          const tone = TONE[signal.choice] ?? 'warn'
          return (
            <div key={dimension} className="space-y-1">
              <p className="text-[10px] text-foreground-tertiary uppercase tracking-wide">
                {DIMENSION_LABELS[dimension]}
              </p>
              <span
                className={`inline-block px-2 py-0.5 rounded-sm text-[11px] font-medium ${TONE_CLASSES[tone]}`}
                title={`confidence ${(signal.confidence * 100).toFixed(0)}%`}
              >
                {signal.choice.replaceAll('_', ' ')}
              </span>
            </div>
          )
        })}
      </div>
      <p className="text-[10px] text-foreground-tertiary">
        Read-only label — did not affect comp selection, ARV, or the recommendation.
      </p>
    </section>
  )
}
