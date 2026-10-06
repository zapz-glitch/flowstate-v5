import { Skeleton, SkeletonPageHeader, SkeletonRows } from '@/components/ui/skeleton'

// Mirrors Evaluation Settings: the title, the five-tab strip, the first tab's panels.
export default function EvaluationSettingsLoading() {
  return (
    <div className="space-y-6" aria-busy="true">
      <SkeletonPageHeader />
      <Skeleton className="h-9 w-[40rem] max-w-full rounded-md" aria-hidden />
      <SkeletonRows label="Loading evaluation settings" rows={3} />
      <SkeletonRows label="Loading evaluation settings" rows={4} />
    </div>
  )
}
