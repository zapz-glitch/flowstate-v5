'use client'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import type { ExistingReport } from '@/lib/client-api'

interface ExistingReportsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  reports: ExistingReport[]
  onNewAnalysis: () => void
}

export function ExistingReportsDialog({ open, onOpenChange, reports, onNewAnalysis }: ExistingReportsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-border">
          <DialogTitle className="text-body font-semibold">Existing Reports Found</DialogTitle>
        </DialogHeader>
        <div className="p-4 space-y-3">
          <p className="text-caption text-foreground-tertiary">
            {reports.length} report{reports.length !== 1 ? 's' : ''} already exist for this address. Open an existing report or create a new analysis.
          </p>
          <div className="space-y-2 max-h-[300px] overflow-y-auto">
            {reports.map((r) => (
              <a
                key={r.id}
                href={`/dashboard/reports/${r.jobId}`}
                className="block border border-border px-4 py-3 hover:bg-muted/40 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-foreground truncate">{r.propertyAddress}</span>
                  <span className="text-[10px] text-foreground-tertiary flex-shrink-0 ml-2">
                    {new Date(r.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-1 text-[10px] text-foreground-tertiary">
                  {r.arv != null && <span>ARV: ${r.arv.toLocaleString()}</span>}
                  {r.maxAllowableOffer != null && <span>MAO: ${r.maxAllowableOffer.toLocaleString()}</span>}
                  {r.estimatedRepairs != null && <span>Rehab: ${r.estimatedRepairs.toLocaleString()}</span>}
                </div>
              </a>
            ))}
          </div>
        </div>
        <DialogFooter className="px-5 pb-4 pt-2 border-t border-border">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => { onOpenChange(false); onNewAnalysis() }}>
            New Analysis
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
