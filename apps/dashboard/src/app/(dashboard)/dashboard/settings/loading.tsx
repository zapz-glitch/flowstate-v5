import { Skeleton } from '@/components/ui/skeleton'

export default function SettingsLoading() {
  return (
    <div className="space-y-6 max-w-3xl" aria-busy="true">
      <Skeleton className="h-8 w-28" />
      <p role="status" className="sr-only">Loading settings…</p>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="rounded-xl border border-border p-6 space-y-4">
          <Skeleton className="h-5 w-40" />
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  )
}
