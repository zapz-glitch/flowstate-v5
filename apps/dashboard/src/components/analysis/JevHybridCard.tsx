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
        counts.selected != null ? `${counts.selected} selected` : null,
        counts.ineligible ? `${counts.ineligible} ineligible` : (counts.unusable ? `${counts.unusable} unusable` : null),
      ].filter(Boolean).join(' · ')
    : ''

  const fillUsed = sel?.fillUsed === true || sel?.closestOnly === true || (run as { fallbackMode?: boolean }).fallbackMode === true

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
          {run.model && <span className="text-[10px] text-foreground-tertiary tabular-nums">{run.model}</span>}
          <ChevronDown className={cn('w-3.5 h-3.5 text-foreground-tertiary transition-transform', open && 'rotate-180')} />
        </span>
      </button>

      <p className="text-[11px] text-foreground-tertiary mt-1">
        {countLine}
        {fillUsed ? ' — core set filled by score' : ''}
        {run.latencyMs != null ? ` · ${(run.latencyMs / 1000).toFixed(1)}s` : ''}
      </p>

      {open && (
        <p className="text-[10px] text-foreground-tertiary mt-1.5">
          Test 1 checks the raw fields against your appraisal rules; passers get enriched and test 2 checks subdivision, then neighborhood. Every evaluated comp carries a distance score /100 — the closest comp to the subject scores highest.
        </p>
      )}
    </section>
  )
}
