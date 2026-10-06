import { Skeleton, SkeletonPageHeader, SkeletonRows } from '@/components/ui/skeleton'

// Mirrors the Offers page: the header band, the category tiles, the queue list.
export default function OffersLoading() {
  return (
    <div className="playground-bg -m-4 sm:-m-6 lg:-m-8 min-h-screen lg:h-[100dvh] flex flex-col lg:overflow-hidden" aria-busy="true">
      <div className="px-4 sm:px-6 lg:px-4 pt-3 pb-3 lg:pt-4 lg:pb-0 lg:h-20 lg:flex lg:items-center lg:border-b lg:border-border flex-shrink-0">
        <SkeletonPageHeader actions className="w-full" />
      </div>
      <div className="flex-1 min-h-0 px-4 sm:px-6 lg:px-4 pt-3 pb-6 space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2" aria-hidden>
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[62px] rounded-md" />
          ))}
        </div>
        <SkeletonRows label="Loading offers" rows={6} />
      </div>
    </div>
  )
}
