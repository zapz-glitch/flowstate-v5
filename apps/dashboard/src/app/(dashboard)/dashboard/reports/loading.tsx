import { Skeleton } from '@/components/ui/skeleton'

// Mirrors the Property Reports page: eyebrow, title, search, then the 8-column table.
const COLUMNS = ['w-48', 'w-24', 'w-16', 'w-16', 'w-16', 'w-20', 'w-10', 'w-4']

export default function ReportsLoading() {
  return (
    <div className="space-y-10" aria-busy="true">
      <div className="space-y-4">
        <div className="space-y-1">
          <Skeleton className="h-3 w-48 mb-3" />
          <Skeleton className="h-7 w-44" />
        </div>
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 max-w-sm flex-1" />
          <Skeleton className="h-4 w-14" />
        </div>
      </div>
      <p role="status" className="sr-only">Loading reports…</p>
      <div className="border border-border rounded-sm overflow-hidden">
        <div className="border-b border-border px-6 py-3 flex items-center gap-6">
          {COLUMNS.map((width, i) => (
            <Skeleton key={i} className={`h-3 ${width} ${i === 0 ? 'mr-auto' : ''}`} />
          ))}
        </div>
        {Array.from({ length: 8 }).map((_, row) => (
          <div key={row} className="px-6 py-4 flex items-center gap-6 border-b border-border/50 last:border-0">
            {COLUMNS.map((width, i) => (
              <Skeleton key={i} className={`h-4 ${width} ${i === 0 ? 'mr-auto' : ''}`} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
