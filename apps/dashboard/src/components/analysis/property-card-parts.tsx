import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

// Pieces shared by the comp card and the subject card in the hover panel, so
// the two are built from the same markup and cannot drift apart.

/** Photo stamp · opaque colored chip with white text so it reads on any photo */
export const STAMP = 'h-[22px] px-1.5 rounded-sm flex items-center text-[11px] font-bold tracking-wide shadow-sm'

/** "Label value" pair on one line · gray label, strong value */
export function Pair({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <span className="whitespace-nowrap" title={title}>
      <span className="text-foreground-tertiary">{label}</span>{' '}
      <span className="font-medium text-foreground">{value}</span>
    </span>
  )
}

/** One property fact · the difference from the subject sits on its own line
 *  under the value so it never truncates in a narrow card. */
export function Fact({ label, value, valueClass, title, delta, deltaClass }: {
  label: string
  value: ReactNode
  valueClass?: string
  title?: string
  delta?: string | null
  deltaClass?: string | null
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-foreground-tertiary flex-shrink-0">{label}</span>
        <span className={cn('font-medium tabular-nums truncate', valueClass)} title={title}>{value}</span>
      </div>
      {delta && (
        <div className={cn('text-right whitespace-nowrap leading-tight', deltaClass ?? 'text-foreground-tertiary')}>{delta}</div>
      )}
    </div>
  )
}
