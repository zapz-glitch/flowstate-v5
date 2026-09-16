'use client'

import { useState, useTransition } from 'react'
import { FlaskConical, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { submitReportsToCdarv } from '@/app/(dashboard)/dashboard/cdarv/actions'

/**
 * Send this report to the CDARV review queue. The snapshot carries the
 * full report — subject, comp pool, applied rules, the saved comp
 * selection, and the operator-edit trail — for human-curated training.
 * Idempotent upstream: resubmitting an unchanged report is a no-op.
 * Read-only on this report — nothing here changes the evaluation.
 */
export function SendToCdarvButton({
  jobId,
  variant = 'icon',
}: {
  jobId: string
  variant?: 'icon' | 'inline'
}) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [sent, setSent] = useState(false)

  const confirm = () =>
    startTransition(async () => {
      const r = await submitReportsToCdarv([jobId])
      setOpen(false)
      if (r.ok) {
        setSent(true)
        toast.success(r.message ?? 'Sent to CDARV')
      } else {
        toast.error(r.message ?? 'CDARV submission failed')
      }
    })

  return (
    <>
      {variant === 'icon' ? (
        <button
          type="button"
          disabled={pending || sent}
          title={sent ? 'Queued for CDARV review' : 'Send to CDARV review queue (does not change this report)'}
          onClick={() => setOpen(true)}
          className="p-1.5 rounded-lg text-foreground-tertiary hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
        >
          <FlaskConical className={`w-3.5 h-3.5 ${sent ? 'text-emerald-500' : ''}`} />
        </button>
      ) : (
        <button
          type="button"
          disabled={pending || sent}
          onClick={() => setOpen(true)}
          className="flex items-center gap-1 text-caption text-foreground-tertiary hover:text-foreground font-medium transition-colors no-print disabled:opacity-50"
          title={sent ? 'Queued for CDARV review' : 'Send this report to CDARV for ML training review'}
        >
          <FlaskConical className={`w-3 h-3 ${sent ? 'text-emerald-500' : ''}`} />
          {sent ? 'CDARV ✓' : 'CDARV'}
        </button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Submit this report to CDARV?</DialogTitle>
            <DialogDescription>
              The full report — subject, comp pool, applied rules, and your comp
              selection — goes to the CDARV training-review queue. This does not
              change the report or its evaluation.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button size="sm" onClick={confirm} disabled={pending} className="gap-1.5">
              {pending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Yes, submit
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
