import { Skeleton } from '@/components/ui/skeleton'

export default function BatchLoading() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-9 w-32" />
      </div>
      <p role="status" className="sr-only">Loading batch import…</p>
      {/* Dropzone */}
      <Skeleton className="h-40 w-full rounded-sm" />
      {/* Confidence buckets */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-sm" />
        ))}
      </div>
      {/* Table */}
      <div className="border border-border rounded-sm overflow-hidden">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="px-4 py-3 flex items-center gap-4 border-b border-border/50 last:border-0">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-16 ml-auto" />
          </div>
        ))}
      </div>
    </div>
  )
}
