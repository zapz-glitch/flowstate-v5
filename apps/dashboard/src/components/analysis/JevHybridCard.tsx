'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { JevHybridData } from '@/app/(dashboard)/dashboard/analyze/actions'

export function JevHybridCard({ run }: { run: JevHybridData | null | undefined }) {
  const [open, setOpen] = useState(false)
  if (!run || run.status !== 'completed') return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const counts = run.counts as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sel = run.selection as any

  // Older saved reports carry the pre-two-test counts shape — render what exists.
  const countLine = counts
    ? [
        counts.pool != null ? `${counts.pool} tested` : (counts.screened != null ? `${counts.screened} screened` : null),
        counts.test1Passed != null ? `${counts.test1Passed} passed test 1` : null,
        counts.examined != null ? `${counts.examined} enriched + examined` : (counts.enriched != null ? `${counts.enriched} enriched` : null),
        counts.test2Passed != null ? `${counts.test2Passed} passed test 2` : (counts.fullMatch != null ? `${counts.fullMatch} matched every question` : null),
        counts.arv != null ? `${counts.arv} ARV` : null,
        counts.asIs != null ? `${counts.asIs} as-is` : null,
        counts.selected != null && counts.arv == null ? `${counts.selected} selected` : null,
        counts.ineligible ? `${counts.ineligible} ineligible` : (counts.unusable ? `${counts.unusable} unusable` : null),
      ].filter(Boolean).join(' · ')
    : ''

  const humanHandoff = sel?.humanHandoff === true

  return (
    <section className="border border-border rounded-sm px-4 py-2.5 text-foreground">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-left"
        aria-expanded={open}
      >
        <span className="text-body-sm font-semibold">Jev evaluation</span>
        <span className="flex items-center gap-2 min-w-0">
          {humanHandoff && (
            <span className="rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-500">
              Human handoff
            </span>
          )}
          {run.model && <span className="text-[10px] text-foreground-tertiary tabular-nums">{run.model}</span>}
          <ChevronDown className={cn('w-3.5 h-3.5 text-foreground-tertiary transition-transform', open && 'rotate-180')} />
        </span>
      </button>

      <p className="text-[11px] text-foreground-tertiary mt-1">
        {countLine}
        {humanHandoff ? ' — zero comps passed test 2' : ''}
        {run.latencyMs != null ? ` · ${(run.latencyMs / 1000).toFixed(1)}s` : ''}
      </p>

      {open && (
        <div className="text-[10px] text-foreground-tertiary mt-1.5 space-y-1">
          <p>
            Test 1 checks the raw fields against your appraisal rules — size, lot, year built, sale price, sale date — and scores each passer on proximity plus match strength. The ten highest scorers get enriched; test 2 needs the same subdivision or neighborhood, and matched style/materials/foundation lift a pass from 90 toward 100. Passers split by price — the top 15% are the ARV comps, the rest as-is reference. No fill: a short passer set stays short.
          </p>
          {humanHandoff && (
            <p className="text-amber-500/90">
              Human handoff — no comp cleared test 2, so this ARV is unexamined reference. Review the comps manually before relying on it.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
