'use client'

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SubjectData } from './shared-types'
import { formatShortDate } from './format-helpers'

export function PropertyPermits({ permits, loading = false }: { permits: SubjectData['permits']; loading?: boolean }) {
  const [open, setOpen] = useState(false)
  const items = permits?.items ?? []

  if (loading && !permits) {
    return <p className="mt-3 border-t border-border pt-2 text-xs text-foreground-secondary">Permits — loading…</p>
  }

  if (!items.length) {
    return (
      <div className="mt-3 border-t border-border pt-2 text-xs">
        <p className="font-medium">Permits — NA</p>
        <p className="text-foreground-secondary">{permits?.status === 'empty' ? 'No permit records returned by the provider.' : permits?.status === 'unavailable' ? 'Permit lookup unavailable. This does not confirm that no permits exist.' : 'Permit details were not saved in this report. Run a new evaluation to retrieve them.'}</p>
      </div>
    )
  }

  const totalValue = items.reduce((sum, p) => sum + (p.jobValue ?? 0), 0)

  return (
    <section aria-label="Property permits" className="mt-3 border-t border-border pt-2 text-xs break-words">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-left"
        aria-expanded={open}
      >
        <span className="font-semibold">
          Permits ({items.length})
          {totalValue > 0 && <span className="font-normal text-foreground-secondary"> · ${totalValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}</span>}
        </span>
        <ChevronDown className={cn('w-3.5 h-3.5 text-foreground-tertiary transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ul className="mt-1.5 divide-y divide-border max-h-44 overflow-y-auto">
          {items.map((permit, index) => (
            <li key={`${permit.permitId}-${index}`} className="py-1 first:pt-0 last:pb-0">
              <p className="font-medium truncate">{permit.projectType || 'Permit'}{permit.permitNumber ? ` · #${permit.permitNumber}` : ''}</p>
              <p className="text-foreground-secondary truncate">
                {permit.status || 'Status unavailable'}
                {permit.effectiveDate ? ` · ${formatShortDate(permit.effectiveDate)}` : ''}
                {permit.jobValue != null ? ` · $${permit.jobValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
