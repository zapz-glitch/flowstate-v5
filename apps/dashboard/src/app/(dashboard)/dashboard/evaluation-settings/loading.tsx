import { Skeleton } from '@/components/ui/skeleton'

export default function EvaluationSettingsLoading() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="h-9 w-28" />
      </div>
      <p role="status" className="sr-only">Loading evaluation settings…</p>
      {/* Rule tables — header row + a few rule rows each */}
      {Array.from({ length: 3 }).map((_, t) => (
        <div key={t} className="rounded-lg border border-border overflow-hidden">
          <div className="px-3 py-2 border-b border-border flex gap-6">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-12 ml-auto" />
          </div>
          {Array.from({ length: 4 }).map((_, r) => (
            <div key={r} className="px-3 py-2.5 flex items-center gap-6 border-b border-border/50 last:border-0">
              <Skeleton className="h-4 w-52" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-10 ml-auto" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
