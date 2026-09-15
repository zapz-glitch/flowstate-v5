'use client'

import { useState } from 'react'
import { ChevronDown, Loader2, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { useEvaluation } from '@/hooks/use-evaluation'
import { pullReportPermits } from '@/lib/client-api'
import type { SubjectData } from './shared-types'
import { formatShortDate } from './format-helpers'

export function PropertyPermits({ permits, loading = false }: { permits: SubjectData['permits']; loading?: boolean }) {
  const [open, setOpen] = useState(false)
  const [pulling, setPulling] = useState(false)
  const { feedbackContext, onPermitsPulled } = useEvaluation()
  const jobId = feedbackContext?.jobId
  const items = permits?.items ?? []

  const canPull = !pulling && !!jobId && !!onPermitsPulled
  const pullable = permits?.status === 'not_requested' || permits?.status === 'unavailable' || !permits

  const pull = async () => {
    if (!canPull || !jobId) return
    setPulling(true)
    try {
      const analysis = await pullReportPermits(jobId)
      onPermitsPulled!(analysis)
      const count = analysis.subject?.permits?.items?.length ?? 0
      toast.success(count > 0 ? `${count} permit${count === 1 ? '' : 's'} pulled — valuation updated` : 'No permits on file — valuation updated')
      if (count > 0) setOpen(true)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Permit pull failed')
    } finally {
      setPulling(false)
    }
  }

  if (loading && !permits) {
    return <p className="mt-3 border-t border-border pt-2 text-xs text-foreground-secondary">Permits — loading…</p>
  }

  if (!items.length) {
    return (
      <div className="mt-3 border-t border-border pt-2 text-xs">
        <div className="flex items-center justify-between gap-2">
          <p className="font-medium">Permits — NA</p>
          {pullable && canPull && (
            <button
              type="button"
              onClick={pull}
              className="flex items-center gap-1 px-2 py-1 rounded-sm border border-border text-foreground-secondary hover:text-foreground hover:border-foreground/40 transition-colors"
            >
              <FileText className="w-3 h-3" />
              Permits
            </button>
          )}
          {pulling && <Loader2 className="w-3 h-3 animate-spin text-foreground-tertiary" />}
        </div>
        <p className="text-foreground-secondary">
          {permits?.status === 'empty'
            ? 'No permit records returned by the provider.'
            : permits?.status === 'unavailable'
              ? 'Permit lookup unavailable. This does not confirm that no permits exist.'
              : 'Not pulled during analysis — pull on demand to update major items and buy price.'}
        </p>
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
