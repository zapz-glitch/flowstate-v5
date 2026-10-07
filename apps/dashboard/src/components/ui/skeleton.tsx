import { cn } from '@/lib/utils'

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('animate-pulse motion-reduce:animate-none rounded-md bg-muted', className)}
      {...props}
    />
  )
}

// Layout-shaped skeletons. Each one announces itself once (role="status" and a
// screen-reader label) and is sized like the content it stands in for, so the
// page does not jump when the data arrives.

interface SkeletonGroupProps {
  /** Spoken to screen readers, e.g. "Loading tasks" */
  label: string
  className?: string
}

/** Same height as PageHeader (min-h-9) so the title does not move */
function SkeletonPageHeader({ actions = false, className }: { actions?: boolean; className?: string }) {
  return (
    <div className={cn('flex min-h-9 items-center justify-between gap-4', className)} aria-hidden>
      <Skeleton className="h-6 w-44" />
      {actions && <Skeleton className="h-8 w-28" />}
    </div>
  )
}

/** Stacked list rows inside a bordered panel */
function SkeletonRows({ label, rows = 5, className }: SkeletonGroupProps & { rows?: number }) {
  return (
    <div role="status" aria-busy="true" className={cn('rounded-sm border border-border overflow-hidden', className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 border-b border-border/50 px-4 py-3 last:border-0" aria-hidden>
          <Skeleton className="h-4 w-48 max-w-[45%]" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="ml-auto h-4 w-16" />
        </div>
      ))}
    </div>
  )
}

/** A table: header row, then rows. `columns` are Tailwind widths; the first one takes the free space. */
function SkeletonTable({ label, columns, rows = 8, className }: SkeletonGroupProps & { columns: string[]; rows?: number }) {
  return (
    <div role="status" aria-busy="true" className={cn('rounded-sm border border-border overflow-hidden', className)}>
      <span className="sr-only">{label}</span>
      <div className="flex items-center gap-6 border-b border-border px-6 py-3" aria-hidden>
        {columns.map((width, i) => (
          <Skeleton key={i} className={cn('h-3', width, i === 0 && 'mr-auto')} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, row) => (
        <div key={row} className="flex items-center gap-6 border-b border-border/50 px-6 py-4 last:border-0" aria-hidden>
          {columns.map((width, i) => (
            <Skeleton key={i} className={cn('h-4', width, i === 0 && 'mr-auto')} />
          ))}
        </div>
      ))}
    </div>
  )
}

/** A row of stat tiles: small label over a big number */
function SkeletonStat({ label, count = 4, className }: SkeletonGroupProps & { count?: number }) {
  return (
    <div role="status" aria-busy="true" className={cn('grid grid-cols-2 gap-3 lg:grid-cols-4', className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-sm border border-border p-4 space-y-3" aria-hidden>
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  )
}

export { Skeleton, SkeletonPageHeader, SkeletonRows, SkeletonTable, SkeletonStat }
