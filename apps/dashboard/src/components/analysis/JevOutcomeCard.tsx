'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { JevOutcomeData, JevOutcomeDimension } from './shared-types'

// ─── Jev Outcome Classification ──────────────────────────────────────────────
//
// Read-only label attached after the v5 pipeline finishes. Jev never
// influenced selection, ARV, or the recommendation — this section shows how
// the model classified the completed outcome. The breakdown expands each
// headline label into the atomic driver checks that fed it (0–1 nouls).

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

// Mirrors the driver keys emitted by the API's Jev service. `favorable`
// drivers read high=good; risk drivers read high=bad.
const DRIVERS: Record<JevOutcomeDimension, Array<{ key: string; label: string; favorable: boolean }>> = {
  evidence_sufficiency: [
    { key: 'enough_comps', label: 'At least 3 enabled comps', favorable: true },
    { key: 'recent_sales', label: 'Recent sales (~12mo)', favorable: true },
    { key: 'condition_verified', label: 'Condition verified', favorable: true },
  ],
  comp_set_quality: [
    { key: 'comps_nearby', label: 'Nearby / same neighborhood', favorable: true },
    { key: 'comps_similar', label: 'Physically similar to subject', favorable: true },
    { key: 'minor_adjustments', label: 'Minor price adjustments', favorable: true },
  ],
  deal_outlook: [
    { key: 'adequate_margin', label: 'Adequate profit margin', favorable: true },
    { key: 'headroom', label: 'ARV headroom over costs', favorable: true },
  ],
  recommendation_agreement: [
    { key: 'numbers_support', label: 'Numbers support it', favorable: true },
    { key: 'evidence_supports', label: 'Evidence supports it', favorable: true },
  ],
  risk_flags: [
    { key: 'thin_evidence', label: 'Thin comp evidence', favorable: false },
    { key: 'stale_sales', label: 'Stale comparable sales', favorable: false },
    { key: 'location_risk', label: 'Location risk', favorable: false },
    { key: 'data_gaps', label: 'Material data gaps', favorable: false },
  ],
}

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

const BAR_CLASSES = {
  good: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
} as const

function driverTone(noul: number, favorable: boolean): keyof typeof TONE_CLASSES {
  const effective = favorable ? noul : 1 - noul
  return effective >= 0.6 ? 'good' : effective >= 0.35 ? 'warn' : 'bad'
}

export function JevOutcomeCard({ outcome }: { outcome: JevOutcomeData | null | undefined }) {
  const [expanded, setExpanded] = useState(false)
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

  const hasDrivers = !!outcome.drivers && Object.values(outcome.drivers).some((d) => d && Object.keys(d).length > 0)

  return (
    <section className="border border-border rounded-sm px-4 py-3 space-y-2 text-foreground break-words">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-body-sm font-semibold">Jev assessment</h3>
        <div className="flex items-center gap-2">
          {hasDrivers && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex items-center gap-1 text-[10px] text-foreground-tertiary hover:text-foreground"
            >
              {expanded ? 'Hide breakdown' : 'Scoring breakdown'}
              <ChevronDown className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`} />
            </button>
          )}
          {outcome.model && (
            <span className="text-[10px] text-foreground-tertiary">{outcome.model}</span>
          )}
        </div>
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
      {expanded && hasDrivers && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 pt-1 border-t border-border/30">
          {DIMENSION_ORDER.map((dimension) => {
            const drivers = outcome.drivers?.[dimension]
            if (!drivers || !Object.keys(drivers).length) return null
            return (
              <div key={dimension} className="space-y-1.5">
                <p className="text-[10px] text-foreground-tertiary uppercase tracking-wide">
                  {DIMENSION_LABELS[dimension]}
                </p>
                {DRIVERS[dimension].map(({ key, label, favorable }) => {
                  const noul = drivers[key]
                  if (typeof noul !== 'number') return null
                  const pct = Math.round(noul * 100)
                  const tone = driverTone(noul, favorable)
                  return (
                    <div key={key} title={`${label}: ${pct}%`}>
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[10px] text-foreground-secondary truncate">{label}</span>
                        <span className="text-[10px] tabular-nums text-foreground-tertiary">{pct}%</span>
                      </div>
                      <div className="h-1 rounded-sm bg-border/50">
                        <div className={`h-1 rounded-sm ${BAR_CLASSES[tone]}`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}
      <p className="text-[10px] text-foreground-tertiary">
        Read-only label — did not affect comp selection, ARV, or the recommendation.
      </p>
    </section>
  )
}
