'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface BDecision {
  compAddress?: string | null
  stage: string
  rule: string
  verdict: string
  value?: number | string | null
  note?: string
}

const VERDICT_COLOR: Record<string, string> = {
  anchored: 'text-cyan-600 dark:text-cyan-400',
  rescued: 'text-emerald-600 dark:text-emerald-400',
  floored: 'text-emerald-600 dark:text-emerald-400',
  capped: 'text-amber-600 dark:text-amber-400',
  'set-aside': 'text-amber-600 dark:text-amber-400',
  demoted: 'text-amber-600 dark:text-amber-400',
  evicted: 'text-amber-600 dark:text-amber-400',
  bound: 'text-amber-600 dark:text-amber-400',
  dropped: 'text-red-600 dark:text-red-400',
  'median-driver': 'text-foreground-secondary',
}

export function DecisionTrail({ decisions }: { decisions: BDecision[] }) {
  const [open, setOpen] = useState(false)
  if (!decisions?.length) return null

  // Group decisions by comp (answer-level rows first), preserving order
  const byComp = new Map<string, BDecision[]>()
  for (const d of decisions) {
    const key = d.compAddress ?? '— answer —'
    if (!byComp.has(key)) byComp.set(key, [])
    byComp.get(key)!.push(d)
  }
  const comps = [...byComp.entries()].sort((a, b) =>
    (a[0] === '— answer —' ? -1 : 0) - (b[0] === '— answer —' ? -1 : 0))

  return (
    <div className="border border-border rounded-sm overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left bg-surface-secondary hover:bg-surface-tertiary transition-colors"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <span className="text-caption font-semibold text-foreground">Decision trail</span>
        <span className="text-[10px] font-mono text-foreground-tertiary ml-auto">
          {decisions.length} decisions · {comps.length - 1} comps
        </span>
      </button>
      {open && (
        <div className="divide-y divide-border">
          {comps.map(([addr, ds]) => (
            <div key={addr} className="px-3 py-2">
              <div className="text-[11px] font-semibold text-foreground-secondary truncate mb-1">
                {addr}
              </div>
              <table className="w-full text-[10px] font-mono">
                <tbody>
                  {ds.map((d, i) => (
                    <tr key={i} className="align-top">
                      <td className="pr-3 py-0.5 text-foreground-tertiary whitespace-nowrap w-[80px]">{d.stage}</td>
                      <td className="pr-3 py-0.5 text-foreground-secondary whitespace-nowrap w-[130px]">{d.rule}</td>
                      <td className={cn('pr-3 py-0.5 whitespace-nowrap w-[90px]', VERDICT_COLOR[d.verdict] ?? 'text-foreground-secondary')}>
                        {d.verdict}
                      </td>
                      <td className="pr-3 py-0.5 text-foreground-tertiary whitespace-nowrap w-[80px]">
                        {typeof d.value === 'number' ? `$${Math.round(d.value).toLocaleString()}` : (d.value ?? '')}
                      </td>
                      <td className="py-0.5 text-foreground-tertiary break-all">{d.note ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
