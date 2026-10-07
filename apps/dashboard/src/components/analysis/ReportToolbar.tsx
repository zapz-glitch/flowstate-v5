import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Leading 28px tile · a back link on a saved report, the search mark on Property Search */
export const REPORT_TOOLBAR_TILE = 'w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0'

/**
 * The address bar above a report. One presentational shell for the saved
 * report page and Property Search, so the two headers cannot drift apart.
 * Each page passes its own controls · no behaviour lives here.
 */
export function ReportToolbar({ lead, title, tooltip, subline, children, onClick }: {
  /** Leading tile (use REPORT_TOOLBAR_TILE for its classes) */
  lead: ReactNode
  /** The address line */
  title: ReactNode
  tooltip?: string
  /** Optional status line under the address */
  subline?: ReactNode
  /** Right-hand controls, in order */
  children?: ReactNode
  /** Makes the whole bar a button (Property Search expands its form) */
  onClick?: () => void
}) {
  return (
    <div
      data-surface="card"
      className={cn(
        'w-full border border-border/60 overflow-hidden bg-background shadow-sm corner-accents corner-accents-bottom',
        onClick && 'cursor-pointer hover:border-primary/30 transition-all',
      )}
      onClick={onClick}
    >
      <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
        {lead}
        <div className="flex-1 min-w-0">
          <div className="text-body-sm text-foreground-secondary truncate" title={tooltip}>{title}</div>
          {subline}
        </div>
        {children}
      </div>
    </div>
  )
}
