import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Leading 28px tile · a back link on a saved report, the search mark on Property Search */
export const REPORT_TOOLBAR_TILE = 'w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0'

/**
 * The address bar above a report. One presentational shell for the saved
 * report page and Property Search, so the two headers cannot drift apart.
 * Each page passes its own controls · no behaviour lives here.
 */
export function ReportToolbar({ lead, title, tooltip, subline, children, onClick, onAddressEnter, onAddressLeave, allowOverflow }: {
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
  /** Pointer over the address side of the bar, never the right-hand controls */
  onAddressEnter?: () => void
  onAddressLeave?: () => void
  /** Live input in the bar — autocomplete menus must escape the card's clip */
  allowOverflow?: boolean
}) {
  return (
    <div
      data-surface="card"
      className={cn(
        'w-full border border-border/60 bg-background shadow-sm corner-accents corner-accents-bottom',
        allowOverflow ? 'overflow-visible' : 'overflow-hidden',
        onClick && 'cursor-pointer hover:border-primary/30 transition-all',
      )}
      onClick={onClick}
    >
      <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-0 flex items-center gap-3" onMouseEnter={onAddressEnter} onMouseLeave={onAddressLeave}>
          {lead}
          <div className="flex-1 min-w-0">
            <div className="text-body-sm text-foreground-secondary truncate" title={tooltip}>{title}</div>
            {subline}
          </div>
        </div>
        {children}
      </div>
    </div>
  )
}
