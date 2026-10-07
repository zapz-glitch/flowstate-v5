import { Skeleton, SkeletonPageHeader, SkeletonTable } from '@/components/ui/skeleton'

// Mirrors the API Hub: title, tab strip, the keys table.
export default function ApiHubLoading() {
  return (
    <div className="space-y-8" aria-busy="true">
      <SkeletonPageHeader />
      <div className="space-y-6">
        <Skeleton className="h-10 w-[26rem] max-w-full rounded-md" aria-hidden />
        <SkeletonTable label="Loading API hub" columns={['w-32', 'w-28', 'w-20', 'w-16', 'w-12']} rows={4} />
      </div>
    </div>
  )
}
