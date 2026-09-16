'use client'

import { useState, useTransition } from 'react'
import { FlaskConical } from 'lucide-react'
import { submitReportsToCdarv } from '../../cdarv/actions'

/**
 * Send this report to the CDARV review queue. Idempotent upstream —
 * resubmitting an unchanged report is a no-op, never a duplicate.
 */
export function SendToCdarvButton({ jobId }: { jobId: string }) {
  const [pending, startTransition] = useTransition()
  const [state, setState] = useState<'idle' | 'sent' | 'error'>('idle')

  return (
    <button
      type="button"
      disabled={pending || state === 'sent'}
      title={
        state === 'sent'
          ? 'Queued for CDARV review'
          : 'Send to CDARV review queue (does not change this report)'
      }
      onClick={() =>
        startTransition(async () => {
          const r = await submitReportsToCdarv([jobId])
          setState(r.ok ? 'sent' : 'error')
        })
      }
      className="p-1.5 rounded-lg text-foreground-tertiary hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
    >
      <FlaskConical className={`w-3.5 h-3.5 ${state === 'sent' ? 'text-emerald-500' : ''}`} />
    </button>
  )
}
