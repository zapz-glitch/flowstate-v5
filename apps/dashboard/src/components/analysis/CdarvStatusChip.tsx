'use client'

import { useEffect, useState } from 'react'
import { FlaskConical } from 'lucide-react'
import { getCdarvReportStatus, type CdarvReportStatus } from '@/app/(dashboard)/dashboard/cdarv/actions'
import { reloadForStaleAction } from '@/lib/server-action'

/**
 * Read-only CDARV presence in the evaluation section. Shows whether this
 * report is in the training queue, corpus size, and the shadow model's
 * pick when one exists. Purely observational — never gates, ranks, or
 * alters the evaluation. Renders nothing while loading or when CDARV is
 * unavailable.
 */
export function CdarvStatusChip({ jobId }: { jobId: string }) {
  const [status, setStatus] = useState<CdarvReportStatus | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let live = true
    getCdarvReportStatus(jobId)
      .then((s) => { if (live) setStatus(s) })
      .catch((err) => { reloadForStaleAction(err) })
      .finally(() => { if (live) setLoaded(true) })
    return () => { live = false }
  }, [jobId])

  if (!loaded || !status) return null

  const snap = status.snapshot
  const pred = status.prediction

  return (
    <div className="flex items-center gap-1.5 text-[10px] text-foreground-tertiary no-print">
      <FlaskConical className="w-3 h-3 flex-shrink-0" />
      <span>
        CDARV learning — {status.corpus} report{status.corpus === 1 ? '' : 's'} collected
        {' · this report: '}
        {snap ? snap.status.replaceAll('_', ' ') : 'not submitted'}
        {snap && ` (v${snap.version})`}
      </span>
      {pred?.status === 'scored' && (
        <span className="text-foreground-secondary">
          · shadow picked {pred.selected_comp_ids.length} comp{pred.selected_comp_ids.length === 1 ? '' : 's'}
          {pred.shadow_arv != null && ` · ARV $${Math.round(pred.shadow_arv).toLocaleString()}`}
          {' '}(observational)
        </span>
      )}
      {pred && pred.status !== 'scored' && (
        <span>· shadow: {pred.status.replaceAll('_', ' ')}</span>
      )}
    </div>
  )
}
