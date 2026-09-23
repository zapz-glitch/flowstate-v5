'use client'

import type { JevAttributeScreenData } from '@/app/(dashboard)/dashboard/analyze/actions'

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

export function JevAttributeScreenCard({ run }: { run: JevAttributeScreenData | null | undefined }) {
  if (!run || run.mode !== 'shadow' || run.status !== 'completed') return null

  const counts = run.counts
  const anchors = run.anchors
  const sv = run.shadowValuation

  return (
    <section className="border border-border rounded-sm px-4 py-3 space-y-2 text-foreground">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-body-sm font-semibold">Jev v3 — attribute screen shadow</h3>
        {run.model && <span className="text-[10px] text-foreground-tertiary">{run.model}</span>}
      </div>

      <p className="text-[11px] text-foreground-tertiary">
        {typeof run.scoredCount === 'number' ? `${run.scoredCount} scored` : ''}
        {typeof run.poolCount === 'number' ? ` · ${run.poolCount} in pool` : ''}
        {counts ? ` · ${counts.arv} ARV band · ${counts.asIs} as-is band` : ''}
        {anchors && (anchors.arvAnchor != null || anchors.asIsAnchor != null)
          ? ` — anchors ${fmtUsd(anchors.arvAnchor)} / ${fmtUsd(anchors.asIsAnchor)}`
          : ''}
      </p>

      {sv ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
          <div className="space-y-0.5">
            <p className="text-[10px] text-foreground-tertiary uppercase tracking-wide">v3 ARV</p>
            <p className="text-sm font-medium tabular-nums">{fmtUsd(sv.arv)}</p>
            <p className={`text-[10px] tabular-nums ${fmtDelta(sv.deltas?.arv).cls}`}>
              {fmtDelta(sv.deltas?.arv).text || (sv.arv == null ? 'no pool' : '')}
            </p>
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] text-foreground-tertiary uppercase tracking-wide">v3 as-is</p>
            <p className="text-sm font-medium tabular-nums">{fmtUsd(sv.asIsValue)}</p>
            <p className={`text-[10px] tabular-nums ${fmtDelta(sv.deltas?.asIsValue).cls}`}>
              {fmtDelta(sv.deltas?.asIsValue).text}
            </p>
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] text-foreground-tertiary uppercase tracking-wide">v3 buy price</p>
            <p className="text-sm font-medium tabular-nums">{fmtUsd(sv.buyPrice)}</p>
            <p className={`text-[10px] tabular-nums ${fmtDelta(sv.deltas?.buyPrice).cls}`}>
              {fmtDelta(sv.deltas?.buyPrice).text}
            </p>
          </div>
          <div className="space-y-0.5">
            <p className="text-[10px] text-foreground-tertiary uppercase tracking-wide">v3 call</p>
            <p className="text-sm font-medium">{sv.recommendation?.replaceAll('-', ' ') ?? '—'}</p>
            <p className="text-[10px] text-foreground-tertiary tabular-nums">
              {sv.projectedROI != null ? `${sv.projectedROI.toFixed(1)}% ROI` : ''}
            </p>
          </div>
        </div>
      ) : (
        <p className="text-[11px] text-foreground-tertiary">
          Screen recorded — no counterfactual valuation on this run.
        </p>
      )}

      <p className="text-[10px] text-foreground-tertiary">
        Shadow only — did not affect comp selection, ARV, or the recommendation.
      </p>
    </section>
  )
}
