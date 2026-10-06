import * as React from 'react'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

// One look for loading, empty, error and status text across the dashboard.
// Plain words, no apology, no decoration: say what happened and what to do.

interface StateAction {
  label: string
  onClick?: () => void
  href?: string
}

function ActionButton({ action }: { action: StateAction }) {
  if (action.href) {
    return (
      <Button asChild variant="outline" size="sm">
        <Link href={action.href}>{action.label}</Link>
      </Button>
    )
  }
  return (
    <Button type="button" variant="outline" size="sm" onClick={action.onClick}>
      {action.label}
    </Button>
  )
}

/** A small spinner with a visible label. Use only where a skeleton does not fit. */
function LoadingState({ label = 'Loading', block = false, className }: { label?: string; block?: boolean; className?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      // The size class stays outside cn(): the merge helper would drop text-caption next to a text color
      className={`text-caption ${cn('flex items-center gap-2 text-foreground-tertiary', block && 'justify-center py-10', className)}`}
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
      <span>{label}</span>
    </div>
  )
}

/** Nothing here yet. Say what, and offer the next step. */
function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string
  description?: string
  action?: StateAction
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center gap-1 px-4 py-8 text-center', className)}>
      <p className="text-body-sm font-medium text-foreground-secondary">{title}</p>
      {description && <p className="max-w-md text-caption text-foreground-tertiary">{description}</p>}
      {action && <div className="mt-2"><ActionButton action={action} /></div>}
    </div>
  )
}

/**
 * Something failed. `title` says what ("Couldn't load reports"), `detail` says
 * why or how to fix it. Always offer a retry when the caller can retry.
 */
function ErrorState({
  title,
  detail,
  action,
  variant = 'panel',
  className,
}: {
  title: string
  detail?: string
  action?: StateAction
  variant?: 'page' | 'panel' | 'inline'
  className?: string
}) {
  return (
    <div
      role="alert"
      className={cn(
        variant === 'page' && 'flex flex-col items-center gap-1 px-4 py-16 text-center',
        variant === 'panel' && 'flex flex-col items-start gap-1 rounded-sm border border-destructive/30 px-4 py-3',
        variant === 'inline' && 'flex flex-col items-start gap-0.5',
        className,
      )}
    >
      <p className="text-body-sm font-medium text-destructive">{title}</p>
      {detail && <p className="max-w-lg text-caption text-foreground-secondary">{detail}</p>}
      {action && <div className={cn(variant === 'page' ? 'mt-3' : 'mt-1.5')}><ActionButton action={action} /></div>}
    </div>
  )
}

type StatusKind = 'saving' | 'saved' | 'error' | 'info'

/** A short status line: saving, saved, copied, failed. Text only, no pill. */
function InlineStatus({ kind, children, className }: { kind: StatusKind; children: React.ReactNode; className?: string }) {
  return (
    <span
      role={kind === 'error' ? 'alert' : 'status'}
      // The size class stays outside cn(): the merge helper would drop text-caption next to a text color
      className={`text-caption ${cn(
        kind === 'error' ? 'text-destructive' : kind === 'saved' ? 'text-foreground' : 'text-foreground-tertiary',
        className,
      )}`}
    >
      {children}
    </span>
  )
}

export { LoadingState, EmptyState, ErrorState, InlineStatus }
export type { StateAction }
