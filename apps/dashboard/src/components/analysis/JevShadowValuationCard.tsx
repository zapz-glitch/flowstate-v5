'use client'

import type { JevCompClassificationData } from '@/app/(dashboard)/dashboard/analyze/actions'

// ─── Jev v2 Shadow Valuation ─────────────────────────────────────────────────
//
// Counterfactual display for shadow-mode Candidate B: routes B's comp classes
// through the same deterministic valuation math and shows what it would have
// produced — ARV, as-is value, buy price, recommendation — next to the deltas
// vs the production (Baseline A) figures. Read-only; B never touched the real
// numbers.

function fmtUsd(n: number | null | undefined): string {
  if (n == null) return '—'
  return `$${Math.round(n).toLocaleString()}`
}

function fmtDelta(n: number | null | undefined): { text: string; cls: string } {
  if (n == null) return { text: '', cls: '' }
  if (Math.abs(n) < 500) return { text: '±$0', cls: 'text-foreground-tertiary' }
  const sign = n > 0 ? '+' : '−'
  return {
    text: `${sign}$${Math.abs(Math.round(n)).toLocaleString()}`,
    cls: 'text-foreground-tertiary',
  }
}

export function JevShadowValuationCard({ run }: { run: JevCompClassificationData | null | undefined }) {
  if (!run || run.mode !== 'shadow' || run.status !== 'completed') return null

  const counts = run.counts
  const sv = run.shadowValuation

  return (
    <section className="border border-border rounded-sm px-4 py-3 space-y-2 text-foreground">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-body-sm font-semibold">Jev v2 — shadow</h3>
        {run.model && <span className="text-[10px] text-foreground-tertiary">{run.model}</span>}
      </div>

      {counts && (
        <p className="text-[11px] text-foreground-tertiary">
          {counts.arv} ARV · {counts.asIs} as-is · {counts.unidentified} abstained
          {typeof run.eligibleCount === 'number' ? ` of ${run.eligibleCount} eligible` : ''}
          {typeof run.disagreements === 'number' ? ` — ${run.disagreements} differ from A` : ''}
        </p>
      )}

      {sv ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
          <div className="space-y-0.5">
            <p className="text-[10px] text-foreground-tertiary uppercase tracking-wide">v2 ARV</p>
            <p className="text-sm font-medium tabular-nums">{fmtUsd(sv.arv)}</p>
            <p className={`text-[10px] tabular-nums ${fmtDelta(sv.deltas?.arv).cls}`}>
              {fmtDelta(sv.deltas?.arv).text || (sv.arv == null ? 'no pool' : '')}
            </p>
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] text-foreground-tertiary uppercase tracking-wide">v2 as-is</p>
            <p className="text-sm font-medium tabular-nums">{fmtUsd(sv.asIsValue)}</p>
            <p className={`text-[10px] tabular-nums ${fmtDelta(sv.deltas?.asIsValue).cls}`}>
              {fmtDelta(sv.deltas?.asIsValue).text}
            </p>
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] text-foreground-tertiary uppercase tracking-wide">v2 buy price</p>
            <p className="text-sm font-medium tabular-nums">{fmtUsd(sv.buyPrice)}</p>
            <p className={`text-[10px] tabular-nums ${fmtDelta(sv.deltas?.buyPrice).cls}`}>
              {fmtDelta(sv.deltas?.buyPrice).text}
            </p>
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] text-foreground-tertiary uppercase tracking-wide">v2 call</p>
            <p className="text-sm font-medium">{sv.recommendation?.replaceAll('-', ' ') ?? '—'}</p>
            <p className="text-[10px] text-foreground-tertiary tabular-nums">
              {sv.projectedROI != null ? `${sv.projectedROI.toFixed(1)}% ROI` : ''}
            </p>
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-foreground-tertiary">
          Classification recorded — no counterfactual valuation on this run.
        </p>
      )}

      <p className="text-[10px] text-foreground-tertiary">
        Shadow only — did not affect comp selection, ARV, or the recommendation.
      </p>
    </section>
  )
}
