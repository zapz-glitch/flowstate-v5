import { Skeleton, SkeletonPageHeader } from '@/components/ui/skeleton'

// Mirrors Settings: the title, then the stacked setting cards.
export default function SettingsLoading() {
  return (
    <div className="space-y-6 max-w-3xl" aria-busy="true">
      <SkeletonPageHeader />
      <p role="status" className="sr-only">Loading settings…</p>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-xl border border-border p-6 space-y-4" aria-hidden>
          <Skeleton className="h-5 w-40" />
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  )
}
