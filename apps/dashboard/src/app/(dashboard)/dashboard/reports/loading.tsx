import { Skeleton, SkeletonPageHeader, SkeletonTable } from '@/components/ui/skeleton'

// Mirrors the Property Reports page: title, search row, then the 8-column table
// (desktop) or the stacked cards (phone).
const COLUMNS = ['w-48', 'w-24', 'w-16', 'w-16', 'w-16', 'w-20', 'w-10', 'w-4']

export default function ReportsLoading() {
  return (
    <div className="space-y-10" aria-busy="true">
      <div className="space-y-4">
        <SkeletonPageHeader />
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 max-w-sm flex-1" />
          <Skeleton className="h-4 w-14" />
        </div>
      </div>
      <SkeletonTable label="Loading reports" columns={COLUMNS} rows={8} className="hidden md:block" />
      <div role="status" className="space-y-3 md:hidden">
        <span className="sr-only">Loading reports</span>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="space-y-2 rounded-sm border border-border p-4" aria-hidden>
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
    </div>
  )
}
