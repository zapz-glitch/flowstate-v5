'use client'

import { useState } from 'react'
import { useAtomValue } from 'jotai'
import { ChevronDown, Loader2, FileText, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { useEvaluation } from '@/hooks/use-evaluation'
import { pullReportPermits } from '@/lib/client-api'
import { permitProgressAtom } from '@/atoms/analysis'
import { PERMIT_STAGES, permitProgressDone, permitStep, pullApplied, pullReceived, pullRequesting, type PermitProgress } from '@/lib/permit-progress'
import type { SubjectData } from './shared-types'
import { formatShortDate } from './format-helpers'

/**
 * Where the permit lookup is, drawn like the comp stages: one label that updates in place with a
 * spinner while it works, and a small three-step marker. A check replaces the spinner when nothing
 * more is coming.
 */
function PermitStageLine({ progress }: { progress: PermitProgress }) {
  const done = permitProgressDone(progress)
  const step = permitStep(progress)
  return (
    <span role="status" aria-live="polite" className="inline-flex items-center gap-1.5 text-foreground-secondary">
      {done ? <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" /> : <Loader2 className="h-3 w-3 animate-spin text-primary" />}
      <span key={progress.message} className="animate-in fade-in duration-300">{progress.message}</span>
      <span className="ml-1 inline-flex items-center gap-0.5" aria-label={`Step ${step} of ${PERMIT_STAGES.length}`}>
        {PERMIT_STAGES.map((stage, i) => (
          <span key={stage} className={cn('h-1 w-3 rounded-full transition-colors duration-300', i < step ? 'bg-foreground-secondary' : 'bg-border')} />
        ))}
      </span>
    </span>
  )
}

/** How long a stage of an on-demand pull stays up before the next replaces it */
const STAGE_READ_MS = 800

export function PropertyPermits({ permits, loading = false }: { permits: SubjectData['permits']; loading?: boolean }) {
  const [open, setOpen] = useState(false)
  const [pulling, setPulling] = useState(false)
  // Stages of an on-demand pull (what the browser can see) · during an analysis the server's stages come in on the atom
  const [pullProgress, setPullProgress] = useState<PermitProgress | null>(null)
  const serverProgress = useAtomValue(permitProgressAtom)
  const { feedbackContext, onPermitsPulled } = useEvaluation()
  const jobId = feedbackContext?.jobId
  const items = permits?.items ?? []

  const canPull = !pulling && !!jobId && !!onPermitsPulled
  const pullable = permits?.status === 'not_requested' || permits?.status === 'unavailable' || !permits

  const pull = async () => {
    if (!canPull || !jobId) return
    setPulling(true)
    setPullProgress(pullRequesting())
    try {
      const analysis = await pullReportPermits(jobId)
      const count = analysis.subject?.permits?.items?.length ?? 0
      // Each stage stays up long enough to read: records received, then the valuation updated from them
      setPullProgress(pullReceived(count))
      await new Promise((resolve) => setTimeout(resolve, STAGE_READ_MS))
      onPermitsPulled!(analysis)
      setPullProgress(pullApplied())
      await new Promise((resolve) => setTimeout(resolve, STAGE_READ_MS))
      toast.success(count > 0 ? `${count} permit${count === 1 ? '' : 's'} pulled. Valuation updated` : 'No permits on file. Valuation updated')
      if (count > 0) setOpen(true)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Permit pull failed')
    } finally {
      setPulling(false)
      setPullProgress(null)
    }
  }

  if (loading && !permits) {
    return (
      <p className="mt-2 border-t border-border pt-1.5 text-xs font-medium">
        <span className="text-foreground-tertiary">Permits</span>{' '}
        {serverProgress ? <PermitStageLine progress={serverProgress} /> : <span className="text-foreground-secondary">Loading…</span>}
      </p>
    )
  }

  if (!items.length) {
    return (
      <div className="mt-2 border-t border-border pt-1.5 text-xs">
        <div className="flex items-center justify-between gap-2">
          <p className="font-medium"><span className="text-foreground-tertiary">Permits</span>{' '}<span className="text-foreground">NA</span></p>
          {pullable && canPull && !pullProgress && (
            <button
              type="button"
              onClick={pull}
              className="flex items-center gap-1 px-2 py-1 rounded-sm border border-border text-foreground-secondary hover:text-foreground hover:bg-secondary transition-colors"
            >
              <FileText className="w-3 h-3" />
              Pull
            </button>
          )}
        </div>
        <p className="text-foreground-secondary">
          {pullProgress ? <PermitStageLine progress={pullProgress} /> : permits?.status === 'empty'
            ? 'No permit records returned by the provider.'
            : permits?.status === 'unavailable'
              ? 'Permit lookup unavailable. This does not confirm that no permits exist.'
              : 'Not pulled during analysis. Pull on demand to update major items and buy price.'}
        </p>
      </div>
    )
  }

  const totalValue = items.reduce((sum, p) => sum + (p.jobValue ?? 0), 0)

  return (
    <section aria-label="Property permits" className="mt-2 border-t border-border pt-1.5 text-xs break-words">
      {pullProgress && <p className="mb-1"><PermitStageLine progress={pullProgress} /></p>}
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
