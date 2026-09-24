import { Skeleton } from '@/components/ui/skeleton'

export default function ReportsLoading() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-9 w-28" />
      </div>
      <p role="status" className="sr-only">Loading reports…</p>
      <div className="border border-border rounded-sm overflow-hidden">
        <div className="border-b border-border px-4 py-3 flex gap-6">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-16 ml-auto" />
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="px-4 py-3.5 flex items-center gap-6 border-b border-border/50 last:border-0">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-14 ml-auto" />
          </div>
        ))}
      </div>
    </div>
  )
}
